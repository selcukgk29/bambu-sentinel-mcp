import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-fail-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator } = await import("../dist/sim/simulator.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const hms = await import("../dist/hms.js");

const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

test("hms: key formats, builtin/unknown lookup, strictest policy wins", () => {
  assert.equal(hms.normalizeKey("0700800000020001"), "0700_8000_0002_0001");
  assert.equal(hms.normalizeKey("0700_8000_0002_0001"), "0700_8000_0002_0001");
  assert.equal(hms.normalizeKey("0300400c"), "0300400C");
  assert.equal(hms.normalizeKey("xyz"), null);
  assert.equal(hms.describePrintError(0x0300400c).cancelled, true);
  const unknown = hms.describeHms(0x0a000000, 0x00010001);
  assert.equal(unknown.source, "unknown");
  assert.equal(unknown.severity, "unknown");
  assert.equal(unknown.retry, "retry");                       // unknown errors may be retried once
  const heater = hms.summarizeFailure(0, [{ attr: 0x03000100, code: 0x00010001 }, { attr: 0x0a000000, code: 1 }]);
  assert.equal(heater.retry, "never");
  assert.equal(hms.summarizeFailure(0, []).retry, "retry");
});

test("hms: import plain map and Bambu-style document", () => {
  const file = path.join(home, "hms.json");
  assert.equal(hms.importDictionary({ "1111_2222_3333_4444": { text: "Custom thing", severity: "error", retry: "human" } }, file), 1);
  assert.deepEqual(
    { ...hms.describeKey("1111222233334444") },
    { code: "1111_2222_3333_4444", text: "Custom thing", severity: "error", retry: "human", cancelled: false, source: "user" },
  );
  const bambu = { data: { device_hms: { en: [{ ecode: "0C00030000020001", intro: "Spaghetti detected" }] }, device_error: { en: [{ ecode: "0300400D", intro: "Something else" }] } } };
  assert.equal(hms.importDictionary(bambu, file), 2);
  assert.equal(hms.describeHms(0x0c000300, 0x00020001).text, "Spaghetti detected");
  assert.equal(hms.describePrintError(0x0300400d).text, "Something else");
  // persisted and reloadable
  assert.equal(hms.loadUserDictionary(file), 3);
});

let sim, fleet, db, scheduler, monitor, p, file;
const settings = { watchIntervalSec: 60, autoPause: false, visionSampling: false, autoDispatch: false, autoEject: false, eject: {} };

before(async () => {
  sim = await PrinterSimulator.start({ speed: 600, tickMs: 50 });
  fleet = new Fleet();
  db = new Db(":memory:");
  scheduler = new Scheduler(fleet, db);
  monitor = new Monitor(fleet, db, scheduler, settings);
  p = fleet.add(sim.config);
  file = path.join(home, "part.3mf");
  fs.writeFileSync(file, "x");
  await until(() => p.state.online && p.state.trays.length > 0, 8000, "online");
});
after(async () => {
  monitor.stop();
  fleet.shutdown();
  await sim.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const startAndRun = async (job) => {
  db.setFlag("plate_clear:sim", true);
  const log = await scheduler.dispatch();
  assert.match(log.join(), new RegExp(`#${job.id} .*started on sim`));
  await until(() => p.state.gcodeState === "RUNNING", 15000, "RUNNING");
};

test("failed print is recorded with a reason and retried once; retry waits for the plate", async () => {
  const job = db.addJob({ name: "retry-me", filePath: file, maxAttempts: 2 });
  await startAndRun(job);
  sim.failNow(0x0500c010, [{ attr: 0x0a000000, code: 0x00010001 }]);
  await until(() => db.getJob(job.id).attempts === 1, 3000, "retry scheduled");

  const j = db.getJob(job.id);
  assert.equal(j.status, "queued");
  assert.match(j.lastError, /unknown code 0500C010/);
  const h = db.history({ printerId: "sim" })[0];
  assert.equal(h.outcome, "failed");
  assert.equal(h.error_code, "0500C010");
  assert.match(h.reason, /0A00_0000_0001_0001/);
  const ev = db.recentEvents({ types: ["job_retry"] })[0];
  assert.deepEqual([ev.data.attempt, ev.data.of], [1, 2]);

  // The failed plate has spaghetti on it: nothing starts until someone confirms it is clear.
  assert.match((await scheduler.dispatch()).join(), /plate not confirmed clear/);
  sim.clearFaults();
  db.setFlag("plate_clear:sim", true);
  await startAndRun(job);
  sim.failNow();                                              // second failure: attempts exhausted
  await until(() => db.getJob(job.id).status === "failed", 3000, "final failure");
  assert.equal(db.getJob(job.id).attempts, 1);                // no further retry was scheduled
  assert.match(db.getJob(job.id).lastError, /0500C010/);
  assert.equal(db.history({ printerId: "sim" }).filter((r) => r.outcome === "failed").length, 2);
});

test("maxAttempts=1 never retries", async () => {
  const job = db.addJob({ name: "once", filePath: file, maxAttempts: 1 });
  await startAndRun(job);
  sim.failNow();
  await until(() => db.getJob(job.id).status === "failed", 3000);
  assert.equal(db.getJob(job.id).attempts, 0);
});

test("errors marked 'never' or 'human' are not retried, with the reason on the job", async () => {
  hms.importDictionary({ "0500C011": { text: "Nozzle clogged", severity: "error", retry: "human" }, "0500C012": { text: "Heater fault", retry: "never" } }, path.join(home, "h2.json"));
  for (const [code, expect] of [[0x0500c011, /needs attention first/], [0x0500c012, /must not be repeated/]]) {
    const job = db.addJob({ name: `x${code}`, filePath: file, maxAttempts: 3 });
    await startAndRun(job);
    sim.failNow(code);
    await until(() => db.getJob(job.id).status === "failed", 3000, "failed");
    assert.match(db.getJob(job.id).lastError, expect);
    assert.equal(db.getJob(job.id).attempts, 0);
  }
});

test("cancelled on the printer's own screen is a cancel, not a failure, and is not retried", async () => {
  const job = db.addJob({ name: "panel-cancel", filePath: file, maxAttempts: 3 });
  await startAndRun(job);
  sim.failNow(0x0300400c);
  await until(() => db.getJob(job.id).status === "cancelled", 3000, "cancelled");
  assert.equal(db.history({ printerId: "sim" })[0].outcome, "cancelled");
  assert.equal(db.getJob(job.id).attempts, 0);
});
