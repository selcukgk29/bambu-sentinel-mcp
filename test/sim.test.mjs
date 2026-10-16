import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-test-"));
process.env.BAMBU_SENTINEL_HOME = home; // before importing config.js

const { PrinterSimulator, frameLabel } = await import("../dist/sim/simulator.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { Printer } = await import("../dist/printer/printer.js");

const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

let sim, fleet, db, scheduler, monitor, p, job3mf;
const settings = { watchIntervalSec: 60, autoPause: true, visionSampling: false, autoDispatch: false };

before(async () => {
  sim = await PrinterSimulator.start({ speed: 600, tickMs: 50, printMinutes: 30 });
  fleet = new Fleet();
  db = new Db(":memory:");
  scheduler = new Scheduler(fleet, db);
  monitor = new Monitor(fleet, db, scheduler, settings);
  p = fleet.add(sim.config);
  job3mf = path.join(home, "benchy.3mf");
  fs.writeFileSync(job3mf, "not really a 3mf");
  await until(() => p.state.online && p.state.trays.length === 3, 8000, "printer online with trays");
});

after(async () => {
  monitor.stop();
  fleet.shutdown();
  await sim.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("state: idle printer with AMS trays", () => {
  assert.equal(p.state.gcodeState, "IDLE");
  assert.deepEqual(p.state.trays.map((t) => `${t.slot}:${t.type}:${t.color}`), ["0:PLA:FFFFFF", "1:PLA:FF0000", "2:PETG:000000"]);
});

test("wrong access code never comes online", async () => {
  const bad = new Printer({ ...sim.config, id: "bad", accessCode: "00000000" });
  const origError = console.error;
  console.error = () => {};
  bad.connect();
  await new Promise((r) => setTimeout(r, 1200));
  console.error = origError;
  assert.equal(bad.state.online, false);
  bad.disconnect();
});

test("commands: light, speed, gcode", async () => {
  await p.setLight(false);
  await p.setSpeed(3);
  await p.sendGcode("M104 S180");
  await until(() => p.state.speedLevel === 3 && p.state.nozzle.target === 180 && p.state.light === false, 3000, "command effects");
  assert.deepEqual(sim.gcodeLog, ["M104 S180"]);
  await p.sendGcode("M104 S0");
  await until(() => p.state.nozzle.target === 0);
});

test("camera snapshot shows scene, reflects spaghetti fault", async () => {
  assert.match(frameLabel(await p.snapshot()), /scene=ok/);
  sim.injectFault("spaghetti");
  assert.match(frameLabel(await p.snapshot()), /scene=spaghetti/);
  sim.clearFaults();
});

test("ftp upload/list/delete", async () => {
  const dest = await p.uploadFile(job3mf, "/cache/up.3mf");
  assert.equal(dest, "/cache/up.3mf");
  const names = (await p.listFiles("/cache")).map((f) => f.name);
  assert.ok(names.includes("up.3mf"));
  await p.deleteFile("/cache/up.3mf");
  assert.ok(!(await p.listFiles("/cache")).some((f) => f.name === "up.3mf"));
});

test("queue: filament-aware dispatch, full print, history, plate gate", async () => {
  const job = db.addJob({ name: "benchy", filePath: job3mf, filaments: [{ type: "PLA", color: "FF2020" }] });
  const wrong = db.addJob({ name: "needs-tpu", filePath: job3mf, filaments: [{ type: "TPU" }], priority: 9 });

  const log = await scheduler.dispatch(2);
  assert.match(log.join("\n"), /needs-tpu: waiting \(sim: no loaded TPU/);   // higher priority but impossible
  assert.match(log.join("\n"), /benchy: started on sim/);
  assert.equal(sim.startRequests.length, 1);
  assert.deepEqual(sim.startRequests[0].ams_mapping, [1]);                   // red PLA is slot 1
  assert.equal(sim.startRequests[0].use_ams, true);
  assert.equal(sim.startRequests[0].url, "file:///sdcard/cache/benchy.3mf");

  await until(() => p.state.gcodeState === "RUNNING", 15000, "RUNNING");
  assert.equal(db.getJob(job.id).status, "printing");
  await until(() => p.state.gcodeState === "FINISH", 10000, "FINISH");
  await until(() => db.getJob(job.id).status === "done", 2000, "job done");

  const types = db.recentEvents({ printerId: "sim" }).map((e) => e.type);
  assert.ok(types.includes("print_started") && types.includes("print_finished"), types.join());
  const h = db.history({ printerId: "sim" })[0];
  assert.equal(h.outcome, "finished");
  assert.equal(h.job_id, job.id);

  // Printer is free but plate not confirmed → scheduler must refuse.
  assert.equal(scheduler.plateCleared("sim"), false);
  assert.match((await scheduler.dispatch()).join(), /plate not confirmed clear/);
  db.setFlag("plate_clear:sim", true);
  db.finishJob(wrong.id, "cancelled");
});

test("pause / resume / stop is recorded as cancelled", async () => {
  const job = db.addJob({ name: "cancelme", filePath: job3mf, filaments: [] });
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000, "RUNNING");
  await p.pause();
  await until(() => p.state.gcodeState === "PAUSE");
  await p.resume();
  await until(() => p.state.gcodeState === "RUNNING");
  monitor.markCancelled("sim");
  await p.stop();
  await until(() => p.state.gcodeState === "FAILED");
  await until(() => db.history({ printerId: "sim" })[0].outcome === "cancelled", 2000, "cancelled history");
  assert.equal(db.getJob(job.id).status, "cancelled");
  const types = db.recentEvents({ printerId: "sim" }).map((e) => e.type);
  assert.ok(types.includes("print_paused") && types.includes("print_resumed"));
  db.setFlag("plate_clear:sim", true);
});

test("busy printer rejects a second start", async () => {
  db.addJob({ name: "first", filePath: job3mf });
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000);
  db.addJob({ name: "second", filePath: job3mf });
  assert.match((await scheduler.dispatch()).join(), /second: waiting \(sim: busy/);
});

test("monitor: overtemp triggers auto-pause with an event and a saved snapshot", async () => {
  assert.equal(p.state.gcodeState, "RUNNING");
  sim.injectFault("overtemp");
  await until(() => p.state.nozzle.temp > 250, 3000, "overtemp visible");
  await monitor.tick();
  await until(() => p.state.gcodeState === "PAUSE", 15000, "auto pause");
  const evs = db.recentEvents({ printerId: "sim", types: ["alert", "auto_pause"] });
  assert.ok(evs.some((e) => e.type === "alert" && e.data.key === "nozzle_overtemp"));
  assert.ok(evs.some((e) => e.type === "auto_pause"));
  assert.ok(monitor.recentSnapshots("sim", 5).length >= 1); // tick saved a frame while the print was still RUNNING
});

test("HMS fault produces an hms_error event", async () => {
  sim.clearFaults();
  sim.injectFault("hms");
  await until(() => db.recentEvents({ types: ["hms_error"] }).length > 0, 3000, "hms event");
  assert.equal(db.recentEvents({ types: ["hms_error"] })[0].data.hex, "0700_8000_0002_0001");
});
