import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-eject-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator, frameLabel } = await import("../dist/sim/simulator.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { Ejector, planSweep } = await import("../dist/eject.js");
const { DEFAULT_EJECT } = await import("../dist/config.js");

const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};
const fastSleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));

test("planSweep: pass layout and validation", () => {
  const plan = planSweep(DEFAULT_EJECT, "A1");
  assert.equal(plan.passes.length, 11);                       // 30..226 step 18
  assert.deepEqual(plan.passes[0], ["G90", "G1 Z40 F600", "G1 X30 Y10 F6000", "G1 Z3 F600", "G1 Y240 F1500", "G1 Z40 F600", "M400"]);
  assert.equal(planSweep(DEFAULT_EJECT, "A1", { partHeightMm: 80 }).zTravel, 90);
  assert.equal(planSweep(DEFAULT_EJECT, "A1", { rehearsal: true }).zPush, 28);
  assert.deepEqual(planSweep(DEFAULT_EJECT, "A1", { xPositions: [100, 140] }).xPositions, [100, 140]);
  assert.throws(() => planSweep({ ...DEFAULT_EJECT, zPush: 0.2 }, "A1"), /at least 1 mm/);
  assert.throws(() => planSweep({ ...DEFAULT_EJECT, yEnd: 300 }, "A1"), /Y 300 outside/);
  assert.throws(() => planSweep(DEFAULT_EJECT, "A1 Mini", { xPositions: [200] }), /X 200 outside/);
  assert.throws(() => planSweep({ ...DEFAULT_EJECT, sweeperWidth: 1 }, "A1"), /too many/);
  assert.throws(() => planSweep(DEFAULT_EJECT, "A1", { partHeightMm: 235 }), /Z range/);
});

let sim, fleet, db, scheduler, monitor, ejector, p, file;
const settings = { watchIntervalSec: 60, autoPause: false, visionSampling: false, autoDispatch: false, autoEject: false, eject: { ...DEFAULT_EJECT } };

before(async () => {
  sim = await PrinterSimulator.start({ speed: 600, tickMs: 50, printMinutes: 30 });
  fleet = new Fleet();
  db = new Db(":memory:");
  scheduler = new Scheduler(fleet, db);
  monitor = new Monitor(fleet, db, scheduler, settings);
  ejector = new Ejector(scheduler, db, fastSleep);
  monitor.ejector = ejector;
  // Stand-in for the client's vision model: reads the simulator's scene label.
  ejector.plateCheck = async (jpeg) => {
    const label = frameLabel(jpeg);
    const empty = /plate=empty/.test(label);
    return { empty, confidence: 0.95, reason: label };
  };
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

const printToFinish = async (name) => {
  db.addJob({ name, filePath: file });
  db.setFlag("plate_clear:sim", true);
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000, "RUNNING");
  await until(() => p.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => sim.part !== null, 2000, "part on plate");
};

test("rehearsal runs the whole path without touching the part", async () => {
  await printToFinish("a");
  const r = await ejector.run(p, settings.eject, { rehearsal: true });
  assert.ok(r.ok, r.error);
  assert.equal(sim.part.y, 128);                // untouched
  assert.equal(sim.crashes, 0);
  assert.equal(r.plateCleared, false);
  assert.match(r.steps.at(-1), /rehearsal done/);
});

test("real sweep: cools, pushes the part off, verifies the plate, sets the flag", async () => {
  assert.equal(scheduler.plateCleared("sim"), false);
  const r = await ejector.run(p, settings.eject, { partHeightMm: 20 });
  assert.ok(r.ok, r.error);
  assert.equal(sim.part, null);
  assert.equal(sim.ejected, 1);
  assert.equal(sim.crashes, 0);
  assert.equal(r.plateCleared, true);
  assert.equal(scheduler.plateCleared("sim"), true);
  assert.equal(scheduler.isHeld("sim"), false);
  assert.ok(db.recentEvents({ types: ["eject"] }).length >= 2);
  assert.ok(r.steps.some((s) => /pass 11\/11/.test(s)));
});

test("a part that sticks is detected: plate is NOT marked clear", async () => {
  sim.injectFault("stuck_part");
  await printToFinish("b");
  const r = await ejector.run(p, settings.eject);
  assert.ok(r.ok);
  assert.ok(sim.part);                          // still there
  assert.equal(r.verdict.empty, false);
  assert.equal(r.plateCleared, false);
  assert.equal(scheduler.plateCleared("sim"), false);
  assert.match(r.steps.at(-1), /NOT verified/);
  sim.clearFaults();
  await ejector.run(p, settings.eject);          // retry now works
  assert.equal(sim.part, null);
});

test("refuses while printing and while the printer is held", async () => {
  db.setFlag("plate_clear:sim", true);
  db.addJob({ name: "c", filePath: file });
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000);
  const r = await ejector.run(p, settings.eject);
  assert.equal(r.ok, false);
  assert.match(r.error, /RUNNING/);
  await p.stop();
  await until(() => p.state.gcodeState === "FAILED");
  await until(() => db.activeJobFor("sim") === null, 2000, "job closed");
  scheduler.hold("sim");
  assert.match((await ejector.run(p, settings.eject)).error, /already running/);
  scheduler.release("sim");
});

test("scheduler skips a printer while a sweep holds it", async () => {
  db.setFlag("plate_clear:sim", true);
  const j = db.addJob({ name: "held", filePath: file });
  scheduler.hold("sim");
  assert.match((await scheduler.dispatch()).join(), /busy \(plate sweep\)/);
  scheduler.release("sim");
  db.finishJob(j.id, "cancelled");
});

test("auto-eject + auto-dispatch: finished print is swept and the next job starts on its own", async () => {
  sim.part = null;
  Object.assign(settings, { autoEject: true, autoDispatch: true });
  const first = db.addJob({ name: "first", filePath: file });
  const second = db.addJob({ name: "second", filePath: file });
  db.setFlag("plate_clear:sim", true);
  const log = await scheduler.dispatch();        // starts "first" only: one printer
  assert.equal(db.getJob(first.id).status, "printing", log.join(" | "));
  await until(() => db.getJob(first.id).status === "done", 12000, "first done");
  await until(() => db.getJob(second.id).status === "printing", 15000, "second auto-started");
  assert.equal(sim.crashes, 0);
  assert.ok(sim.ejected >= 3);
  // Leave nothing running behind us: no automation, cancel the second print.
  Object.assign(settings, { autoEject: false, autoDispatch: false });
  await until(() => p.state.gcodeState === "RUNNING", 8000, "second print running");
  monitor.markCancelled("sim");
  await p.stop();
  await until(() => p.state.gcodeState === "FAILED", 15000, `stopped (state ${p.state.gcodeState}, sim ${sim.gcodeState}, progress ${sim.progressPct})`);
});

const { coverRanges } = await import("../dist/eject.js");

test("coverRanges: padding, merging, clamping, spacing never above the step", () => {
  assert.deepEqual(coverRanges([[108, 148]], 18, 5, 256).map(Math.round), [103, 120, 136, 153]);
  // two objects far apart stay separate; two close ones merge
  const far = coverRanges([[20, 30], [200, 210]], 18, 5, 256);
  assert.ok(far.some((x) => x <= 25) && far.some((x) => x >= 205) && !far.some((x) => x > 60 && x < 190));
  assert.equal(coverRanges([[100, 110], [112, 120]], 18, 0, 256).length, coverRanges([[100, 120]], 18, 0, 256).length);
  // clamped to the bed
  const edge = coverRanges([[0, 4], [250, 256]], 18, 10, 256);
  assert.equal(Math.min(...edge), 0);
  assert.equal(Math.max(...edge), 256);
  for (const xs of [coverRanges([[10, 200]], 18, 5, 256)]) for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] <= 18 + 1e-9);
  assert.deepEqual(coverRanges([[50, 50]], 18, 0, 256), [50]);
});

test("planSweep with a layout: strips only where parts are; explicit X wins; off by default", () => {
  const layout = [{ name: "p", bbox: [108, 108, 148, 148] }];
  assert.equal(planSweep(DEFAULT_EJECT, "A1", { layout }).passes.length, 11);                       // useLayout is off
  const on = { ...DEFAULT_EJECT, useLayout: true };
  assert.equal(planSweep(on, "A1", { layout }).passes.length, 4);
  assert.equal(planSweep(on, "A1", { layout: [] }).passes.length, 11);                               // no layout: full sweep
  assert.deepEqual(planSweep(on, "A1", { layout, xPositions: [10] }).xPositions, [10]);
});

test("targeted sweep: only the strips with parts are swept and the plate still verifies empty", async () => {
  await printToFinish("targeted");
  assert.ok(sim.part);
  const r = await ejector.run(p, { ...settings.eject, useLayout: true }, { layout: [{ name: "part", bbox: [108, 108, 148, 148] }] });
  assert.ok(r.ok, r.error);
  assert.match(r.steps.join("\n"), /pass 4\/4/);
  assert.equal(sim.part, null);
  assert.equal(sim.crashes, 0);
  assert.equal(r.plateCleared, true);
});
