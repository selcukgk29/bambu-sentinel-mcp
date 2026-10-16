import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-inv-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator } = await import("../dist/sim/simulator.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler, matchFilaments } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { planUsage, settleUsage, rememberUsage, needGrams } = await import("../dist/inventory.js");
const { normalize } = await import("../dist/printer/state.js");

const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

test("spools: assign replaces the previous occupant, archive unloads, deduct never goes negative", () => {
  const db = new Db(":memory:");
  const a = db.addSpool({ name: "a", type: "PLA", initialG: 1000, remainingG: 1000 });
  const b = db.addSpool({ name: "b", type: "PLA", initialG: 1000, remainingG: 10 });
  db.assignSpool(a.id, "p", 1);
  assert.equal(db.spoolAt("p", 1).id, a.id);
  db.assignSpool(b.id, "p", 1); // b replaces a in the slot
  assert.equal(db.spoolAt("p", 1).id, b.id);
  assert.equal(db.getSpool(a.id).printerId, null);
  assert.equal(db.deductSpool(b.id, 50), 0);
  db.updateSpool(b.id, { archived: true });
  assert.equal(db.spoolAt("p", 1), null);
  assert.deepEqual(db.listSpools().map((s) => s.name), ["a"]);
  assert.equal(db.listSpools(true).length, 2);
  const unknown = db.addSpool({ name: "u", type: "PLA" }); // weight unknown: left alone
  assert.equal(db.deductSpool(unknown.id, 5), null);
});

const trays = normalize(
  {
    gcode_state: "IDLE",
    ams: {
      ams: [
        {
          id: "0",
          tray: [
            { id: "0", tray_type: "PLA", tray_color: "FF0000FF", remain: 100 },
            { id: "1", tray_type: "PLA", tray_color: "FF0000FF", remain: 100 },
          ],
        },
      ],
    },
  },
  true,
).trays;

test("matching skips a spool that is too light and says so when none is enough", () => {
  const need = needGrams(30); // 33.5 g
  assert.ok(Math.abs(need - 33.5) < 1e-9);
  const job = [{ type: "PLA", color: "FF0000", usedG: 30 }];
  assert.deepEqual(matchFilaments(job, trays, 60, new Map([[0, 20], [1, 500]])).match.amsMapping, [1]);
  assert.deepEqual(matchFilaments(job, trays, 60, new Map([[0, 500], [1, 20]])).match.amsMapping, [0]);
  assert.match(matchFilaments(job, trays, 60, new Map([[0, 20], [1, 10]])).reason, /spool in slot 0 has 20 g left, the job needs about 34 g/);
  assert.ok(matchFilaments(job, trays, 60, new Map()).match); // unknown weights never block
});

test("usage: planned per filament via the mapping, settled by fraction, low-stock reported", () => {
  const db = new Db(":memory:");
  const s = db.addSpool({ name: "red", type: "PLA", initialG: 100, remainingG: 100 });
  db.assignSpool(s.id, "p", 1);
  const filaments = [
    { id: 2, type: "PLA", color: "FF0000", usedG: 40 },
    { id: 4, type: "PETG", usedG: 5 },
  ];
  const entries = planUsage(db, "p", filaments, [-1, 1, -1, 2]);
  assert.deepEqual(entries, [
    { type: "PLA", color: "FF0000", grams: 40, spoolId: s.id },
    { type: "PETG", grams: 5, spoolId: null }, // no spool registered: still counted for cost
  ]);
  rememberUsage(db, "p", entries);
  const r = settleUsage(db, "p", 0.5); // half a failed print
  assert.equal(r.grams, 22.5);
  assert.equal(db.getSpool(s.id).remainingG, 80);
  assert.deepEqual(settleUsage(db, "p", 1), { entries: [], grams: 0, low: [] }); // nothing left to settle twice
  rememberUsage(db, "p", entries);
  assert.deepEqual(settleUsage(db, "p", 1).low, [{ spoolId: s.id, name: "red", remainingG: 40 }]);
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
  await until(() => p.state.online && p.state.trays.length === 3, 8000, "online");
});
after(async () => {
  monitor.stop();
  fleet.shutdown();
  await sim.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const red = { id: 1, type: "PLA", color: "FF0000", usedG: 30 };

test("a job that does not fit the spool stays queued with the reason", async () => {
  const spool = db.addSpool({ name: "red", type: "PLA", initialG: 1000, remainingG: 20 });
  db.assignSpool(spool.id, "sim", 1);
  db.setFlag("plate_clear:sim", true);
  const job = db.addJob({ name: "big", filePath: file, filaments: [red] });
  const log = await scheduler.dispatch();
  assert.match(log.join(), /PLA spool in slot 1 has 20 g left/);
  assert.equal(db.getJob(job.id).status, "queued");
  db.finishJob(job.id, "cancelled");
  db.updateSpool(spool.id, { archived: true });
});

test("a finished print subtracts its grams from the spool and records them in history", async () => {
  const spool = db.addSpool({ name: "red2", type: "PLA", initialG: 1000, remainingG: 120 });
  db.assignSpool(spool.id, "sim", 1);
  db.setFlag("plate_clear:sim", true);
  db.addJob({ name: "ok", filePath: file, filaments: [red] });
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000);
  await until(() => p.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => db.getSpool(spool.id).remainingG === 90, 3000, "spool deducted");
  assert.equal(db.history({ printerId: "sim" })[0].grams, 30);
});

test("a failed print at about half progress consumes about half, and a low spool raises an alert", async () => {
  const spool = db.listSpools().at(-1);
  db.updateSpool(spool.id, { remaining_g: 70 });
  db.setFlag("plate_clear:sim", true);
  const job = db.addJob({ name: "half", filePath: file, filaments: [{ ...red, usedG: 40 }], maxAttempts: 1 });
  sim.setSpeed(120); // slow enough that the half-way window cannot be missed on a busy machine
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000);
  await until(() => p.state.progress >= 40 && p.state.progress <= 70, 20000, "about half way");
  const at = p.state.progress;
  sim.failNow();
  sim.setSpeed(600);
  await until(() => db.getJob(job.id).status === "failed", 3000, "failed");
  const h = db.history({ printerId: "sim" })[0];
  assert.ok(Math.abs(h.grams - 40 * (at / 100)) <= 40 * 0.15, `grams ${h.grams} for progress ${at}`);
  const left = db.getSpool(spool.id).remainingG;
  assert.ok(Math.abs(left - (70 - h.grams)) < 0.01);
  assert.ok(left < 70 && left > 40);

  db.updateSpool(spool.id, { remaining_g: 60 }); // one more 30 g print crosses the 50 g line
  db.setFlag("plate_clear:sim", true);
  sim.clearFaults();
  db.addJob({ name: "last", filePath: file, filaments: [{ ...red, usedG: 30 }] });
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000);
  await until(() => p.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => db.recentEvents({ types: ["alert"] }).some((e) => /is down to 30 g/.test(e.data.message)), 3000, "low alert");
});
