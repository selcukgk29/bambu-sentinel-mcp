import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ack-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator } = await import("../dist/sim/simulator.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");

const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

let sim, fleet, db, scheduler, p, file;

before(async () => {
  sim = await PrinterSimulator.start({ speed: 600, tickMs: 50 });
  fleet = new Fleet();
  db = new Db(":memory:");
  scheduler = new Scheduler(fleet, db, 800);
  p = fleet.add(sim.config);
  p.ackTimeoutMs = 300;
  file = path.join(home, "x.3mf");
  fs.writeFileSync(file, "x");
  await until(() => p.state.online && p.state.trays.length > 0, 8000, "online");
});

after(async () => {
  fleet.shutdown();
  await sim.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("commands are acknowledged by the printer", async () => {
  assert.deepEqual(await p.setSpeed(3), { acked: true, result: "success", reason: undefined });
  assert.equal((await p.setLight(false)).acked, true);          // system-channel ack
  assert.equal((await p.sendGcode("M104 S0")).acked, true);
});

test("an unanswered command resolves acked:false instead of hanging or lying", async () => {
  sim.injectFault("no_ack");
  const t0 = Date.now();
  const a = await p.setSpeed(2);
  assert.equal(a.acked, false);
  assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 2000);
  sim.clearFaults();
});

test("an explicit rejection throws with the printer's reason", async () => {
  sim.injectFault("reject_start");
  await assert.rejects(() => p.startPrint({ file: "x.3mf" }), /printer rejected project_file: rejected by simulator/);
  sim.clearFaults();
});

test("start that is acknowledged but never begins is detected (timeout)", async () => {
  sim.dropFile("x.3mf");
  sim.injectFault("no_start");
  await assert.rejects(() => p.startAndConfirm({ file: "x.3mf" }, 500), /did not start the print within 1s \(command acknowledged/);
  sim.clearFaults();
});

test("failed start: job returns to the queue with a backoff, plate flag restored, 3 strikes = failed", async () => {
  db.setFlag("plate_clear:sim", true);
  const job = db.addJob({ name: "flaky", filePath: file });

  sim.injectFault("reject_start");
  let log = await scheduler.dispatch();
  assert.match(log.join(), /failed to start on sim: printer rejected project_file.*\(job requeued\)/);
  let j = db.getJob(job.id);
  assert.equal(j.status, "queued");
  assert.equal(j.startFailures, 1);
  assert.match(j.lastError, /rejected/);
  assert.ok(j.holdUntil > Date.now());
  assert.equal(scheduler.plateCleared("sim"), true);            // untouched by the failed attempt
  assert.equal(db.activeJobFor("sim"), null);                   // not left "printing"

  log = await scheduler.dispatch();
  assert.match(log.join(), /held until .* after a failed start/);

  db.clearHold(job.id);
  await scheduler.dispatch();                                    // 2nd strike
  db.clearHold(job.id);
  log = await scheduler.dispatch();                              // 3rd strike
  assert.match(log.join(), /\(job failed\)/);
  assert.equal(db.getJob(job.id).status, "failed");
  sim.clearFaults();
});

test("a healthy start is confirmed and the job is printing", async () => {
  const job = db.addJob({ name: "good", filePath: file });
  const log = await scheduler.dispatch();
  assert.match(log.join(), /good: started on sim/);
  assert.equal(db.getJob(job.id).status, "printing");
  assert.equal(p.state.gcodeState === "PREPARE" || p.state.gcodeState === "RUNNING", true);
  assert.equal(scheduler.plateCleared("sim"), false);
});
