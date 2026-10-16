import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cost-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator } = await import("../dist/sim/simulator.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { computeCost, costReport, DEFAULT_COST } = await import("../dist/cost.js");

const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

test("cost: filament + electricity + wear, with the exact arithmetic", () => {
  // 100 g PLA @ 20/kg = 2.00 ; 2 h @ 95 W = 0.19 kWh * 0.15 = 0.0285 ; wear 2 h * 0.15 = 0.30
  const c = computeCost(undefined, { durationSec: 7200, entries: [{ type: "PLA", grams: 100, spoolId: null }] });
  assert.deepEqual(c, {
    currency: "USD", grams: 100, filament: 2, electricity: 0.03, wear: 0.3, perPrint: 0, total: 2.33, energyKwh: 0.19,
  });
});

test("cost: a spool's own price beats the table, unknown types use default, settings merge", () => {
  const entries = [
    { type: "PLA", grams: 100, spoolId: 7 },
    { type: "Wood", grams: 100, spoolId: null },
  ];
  const c = computeCost(
    { filamentPricePerKg: { WOOD: 50 }, electricityPerKwh: 0, machineWearPerHour: 0, perPrint: 1 },
    { durationSec: 3600, entries, priceOf: (id) => (id === 7 ? 40 : null) },
  );
  assert.equal(c.filament, 9); // 100 g * 40/kg + 100 g * 50/kg
  assert.equal(c.total, 10); // + 1 handling
  const d = computeCost({ currency: "TRY" }, { durationSec: 0, entries: [{ type: "ZZZ", grams: 1000, spoolId: null }] });
  assert.equal(d.filament, DEFAULT_COST.filamentPricePerKg.default); // 1 kg at the default price
  assert.equal(d.currency, "TRY");
  assert.equal(computeCost(undefined, { durationSec: -5, entries: [] }).total, 0);
});

test("report: totals, waste, success rate (cancels are not failures), per printer", () => {
  const t = 3_600_000;
  const row = (printer_id, outcome, cost, hours = 1, grams = 10, kwh = 0.1) => ({
    printer_id, outcome, cost, grams, energy_kwh: kwh, started_at: 0, ended_at: hours * t, parts: outcome === "finished" ? 5 : 0,
  });
  const r = costReport(
    [row("a", "finished", 2), row("a", "finished", 3), row("b", "failed", 1.5), row("b", "cancelled", 0.5), row("a", "unknown", 99), { ...row("a", "finished", 5), ended_at: null }],
    "USD",
  );
  assert.equal(r.prints, 4); // the 'unknown' and the still-open row are ignored
  assert.deepEqual([r.finished, r.failed, r.cancelled], [2, 1, 1]);
  assert.equal(r.total_cost, 7);
  assert.equal(r.wasted_cost, 2);
  assert.equal(r.success_rate, 0.67);
  assert.equal(r.avg_cost_per_finished, 2.5);
  assert.equal(r.avg_cost_per_good_print_incl_waste, 3.5);
  assert.equal(r.parts, 10); // two finished plates of 5 parts; failed and cancelled give none
  assert.equal(r.avg_cost_per_part, 0.5); // (7 - 2 wasted) / 10 parts
  assert.equal(r.avg_cost_per_part_incl_waste, 0.7); // 7 / 10 parts
  assert.equal(r.grams, 40);
  assert.equal(r.print_hours, 4);
  assert.deepEqual(r.by_printer, { a: { prints: 2, cost: 5, wasted: 0 }, b: { prints: 2, cost: 2, wasted: 2 } });
  assert.equal(costReport([], "USD").avg_cost_per_finished, null);
  assert.equal(costReport([], "USD").avg_cost_per_part, null);
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

test("a finished print is costed when it ends (spool price wins), a failed one is costed by the share printed", async () => {
  const spool = db.addSpool({ name: "pricey", type: "PLA", initialG: 1000, remainingG: 1000, pricePerKg: 40 });
  db.assignSpool(spool.id, "sim", 1);
  db.setFlag("plate_clear:sim", true);
  db.addJob({ name: "paid", filePath: file, filaments: [red] });
  await scheduler.dispatch();
  await until(() => p.state.gcodeState === "RUNNING", 15000);
  await until(() => p.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => db.history({ printerId: "sim" })[0].cost != null, 3000, "costed");
  const h = db.history({ printerId: "sim" })[0];
  assert.equal(h.grams, 30);
  assert.ok(h.cost >= 1.2 && h.cost < 1.25, `cost ${h.cost}`); // 30 g * 40/kg = 1.20 + seconds of power and wear
  assert.ok(h.energy_kwh >= 0 && h.energy_kwh < 0.01); // a 3 s simulated run rounds to 0.000 kWh

  db.setFlag("plate_clear:sim", true);
  const job = db.addJob({ name: "waste", filePath: file, filaments: [red], maxAttempts: 1 });
  sim.setSpeed(120); // slow enough that the half-way window cannot be missed on a busy machine
  await scheduler.dispatch();
  await until(() => p.state.progress >= 40 && p.state.progress <= 70, 20000, "about half");
  sim.failNow();
  sim.setSpeed(600);
  await until(() => db.getJob(job.id).status === "failed", 3000);
  const f = db.history({ printerId: "sim" })[0];
  assert.ok(f.cost > 0.4 && f.cost < 1.0, `failed cost ${f.cost}`); // roughly half of 1.20

  const rep = costReport(db.historyBetween(0), "USD");
  assert.equal(rep.finished, 1);
  assert.equal(rep.failed, 1);
  assert.ok(Math.abs(rep.wasted_cost - f.cost) < 0.01);
  assert.ok(rep.avg_cost_per_good_print_incl_waste > rep.avg_cost_per_finished);
});
