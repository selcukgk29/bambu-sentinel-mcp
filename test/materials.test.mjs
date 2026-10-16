import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-mat-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator } = await import("../dist/sim/simulator.js");
const { loadConfig, saveConfig } = await import("../dist/config.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { Ejector } = await import("../dist/eject.js");
const admin = await import("../dist/admin.js");

const until = async (fn, ms = 12000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

let sim, ctx, printer, file;

before(async () => {
  sim = await PrinterSimulator.start({ speed: 600, tickMs: 50 });
  const cfg = loadConfig();
  const fleet = new Fleet();
  const db = new Db(":memory:");
  const scheduler = new Scheduler(fleet, db);
  const monitor = new Monitor(fleet, db, scheduler, cfg.settings);
  ctx = { fleet, db, scheduler, monitor, ejector: new Ejector(scheduler, db), file: cfg, save: () => saveConfig(cfg) };
  printer = fleet.add(sim.config);
  file = path.join(home, "part.3mf");
  fs.writeFileSync(file, "x");
  await until(() => printer.state.online && printer.state.trays.length === 3, 8000, "online");
});
after(async () => {
  ctx.monitor.stop();
  ctx.fleet.shutdown();
  await sim.stop();
  ctx.db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("spools: validation, defaults, loading into a slot, updating, archiving", () => {
  assert.throws(() => admin.addSpool(ctx, { type: "", weightG: 1000 }), /Malzeme türü/);
  assert.throws(() => admin.addSpool(ctx, { type: "PLA", weightG: 0 }), /Ağırlık/);
  assert.throws(() => admin.addSpool(ctx, { type: "PLA", weightG: 1000, remainingG: -5 }), /Kalan/);
  assert.throws(() => admin.addSpool(ctx, { type: "PLA", weightG: 1000, pricePerKg: -1 }), /Fiyat/);
  assert.throws(() => admin.addSpool(ctx, { type: "PLA", weightG: 1000, color: "red" }), /Renk/);
  assert.throws(() => admin.addSpool(ctx, { type: "PLA", weightG: 1000, printerId: "ghost", slot: 0 }), /Makine bulunamadı/);
  assert.throws(() => admin.addSpool(ctx, { type: "PLA", weightG: 1000, printerId: "sim", slot: 99 }), /Slot/);

  const a = admin.addSpool(ctx, { type: "pla", weightG: "1000", color: "#ff0000", brand: "Bambu", pricePerKg: "30", printerId: "sim", slot: 1 });
  assert.deepEqual([a.type, a.name, a.color, a.initialG, a.remainingG, a.pricePerKg, a.printerId, a.slot], ["PLA", "Bambu PLA #FF0000", "FF0000", 1000, 1000, 30, "sim", 1]);
  const b = admin.addSpool(ctx, { type: "PETG", weightG: 750, remainingG: 200, name: "Siyah" });
  assert.deepEqual([b.name, b.remainingG, b.printerId], ["Siyah", 200, null]);

  assert.equal(admin.updateSpool(ctx, b.id, { remainingG: 180, pricePerKg: 25 }).remainingG, 180);
  assert.throws(() => admin.updateSpool(ctx, 9999, { remainingG: 1 }), /bulunamadı/);
  assert.equal(admin.assignSpool(ctx, b.id, "sim", 1).slot, 1); // takes slot 1 from spool a
  assert.equal(ctx.db.getSpool(a.id).printerId, null);
  assert.equal(admin.assignSpool(ctx, b.id, null, null).printerId, null);
  assert.equal(admin.updateSpool(ctx, b.id, { archived: true }).archived, true);
  assert.deepEqual(ctx.db.listSpools().map((s) => s.id), [a.id]);
  admin.assignSpool(ctx, a.id, "sim", 1); // restore for the next tests
});

test("cost settings: validated, the filament table is replaced as a whole, persisted", () => {
  assert.throws(() => admin.setCostSettings(ctx, { electricityPerKwh: -1 }), /Elektrik/);
  assert.throws(() => admin.setCostSettings(ctx, { printingWatts: 0 }), /Yazıcı gücü/);
  assert.throws(() => admin.setCostSettings(ctx, { currency: "" }), /Para birimi/);
  assert.throws(() => admin.setCostSettings(ctx, { filamentPricePerKg: { "": 5 } }), /Malzeme türü/);
  assert.throws(() => admin.setCostSettings(ctx, { filamentPricePerKg: { PLA: -2 } }), /fiyatı/);
  const c = admin.setCostSettings(ctx, { currency: "TRY", electricityPerKwh: 3.2, printingWatts: 110, machineWearPerHour: 4, perPrint: 1.5, filamentPricePerKg: { PLA: 650, "petg-cf": 900, Diğer: 700 } });
  assert.deepEqual([c.currency, c.electricityPerKwh, c.printingWatts, c.machineWearPerHour, c.perPrint], ["TRY", 3.2, 110, 4, 1.5]);
  assert.deepEqual(c.filamentPricePerKg, { PLA: 650, "PETG-CF": 900, default: 700 }); // PETG, ABS... are gone: the table was replaced
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).settings.cost.currency, "TRY");
  assert.equal(admin.setCostSettings(ctx, { printingWatts: 95 }).filamentPricePerKg.PLA, 650); // a partial update keeps the table
});

test("a finished print takes material from the loaded spool, logs it, and counts the parts on the plate", async () => {
  admin.setCostSettings(ctx, { filamentPricePerKg: { PLA: 20, default: 25 }, currency: "USD", electricityPerKwh: 0.15, printingWatts: 95 });
  const spool = ctx.db.listSpools().find((s) => s.printerId === "sim" && s.slot === 1);
  ctx.db.updateSpool(spool.id, { remaining_g: 500, price_per_kg: 40 });
  ctx.db.setFlag("plate_clear:sim", true);
  const layout = Array.from({ length: 6 }, (_, i) => ({ name: `o${i}`, bbox: [10 + i * 20, 10, 25 + i * 20, 25] }));
  const job = ctx.db.addJob({ name: "six-pack", filePath: file, filaments: [{ id: 1, type: "PLA", color: "FF0000", usedG: 30 }], layout });
  await ctx.scheduler.dispatch();
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  await until(() => printer.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => ctx.db.getJob(job.id).status === "done", 3000, "job done");

  const h = ctx.db.history({ printerId: "sim" })[0];
  assert.deepEqual([h.outcome, h.parts, h.grams], ["finished", 6, 30]);
  assert.equal(ctx.db.getSpool(spool.id).remainingG, 470); // deducted automatically

  const log = ctx.db.consumptionSince(0);
  assert.deepEqual([log.length, log[0].type, log[0].grams, log[0].spoolId, log[0].outcome], [1, "PLA", 30, spool.id, "finished"]);

  assert.equal(ctx.db.historyBetween(0).reduce((n, r) => n + (r.parts ?? 0), 0), 6);
});

test("a failed print produces no parts and consumes the share printed; unknown layouts count as one part", async () => {
  ctx.db.setFlag("plate_clear:sim", true);
  const j = ctx.db.addJob({ name: "fails-halfway", filePath: file, filaments: [{ id: 1, type: "PLA", color: "FF0000", usedG: 40 }], maxAttempts: 1 });
  sim.setSpeed(120); // slow enough that the half-way window cannot be missed on a busy machine
  await ctx.scheduler.dispatch();
  await until(() => printer.state.progress >= 40 && printer.state.progress <= 70, 15000, "half way");
  sim.failNow();
  sim.setSpeed(600);
  await until(() => ctx.db.getJob(j.id).status === "failed", 3000);
  const h = ctx.db.history({ printerId: "sim" })[0];
  assert.deepEqual([h.outcome, h.parts], ["failed", 0]);
  const last = ctx.db.consumptionSince(0)[0];
  assert.equal(last.outcome, "failed");
  assert.ok(last.grams > 10 && last.grams < 32);

  ctx.db.setFlag("plate_clear:sim", true);
  sim.clearFaults();
  ctx.db.addJob({ name: "no-layout", filePath: file, filaments: [] });
  await ctx.scheduler.dispatch();
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  await until(() => printer.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => ctx.db.history({ printerId: "sim" })[0].outcome === "finished", 3000);
  assert.equal(ctx.db.history({ printerId: "sim" })[0].parts, 1);
});
