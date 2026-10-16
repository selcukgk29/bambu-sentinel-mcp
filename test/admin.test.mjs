import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-admin-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator } = await import("../dist/sim/simulator.js");
const { loadConfig, saveConfig } = await import("../dist/config.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { Ejector } = await import("../dist/eject.js");
const admin = await import("../dist/admin.js");
const { machineStatus } = await import("../dist/status.js");

const until = async (fn, ms = 10000, what = "condition") => {
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
  const ejector = new Ejector(scheduler, db);
  ctx = { fleet, db, scheduler, monitor, ejector, file: cfg, save: () => saveConfig(cfg) };
  printer = fleet.add(sim.config);
  file = path.join(home, "part.3mf");
  fs.writeFileSync(file, "x");
  await until(() => printer.state.online && printer.state.trays.length === 3, 8000, "printer online");
});

after(async () => {
  ctx.monitor.stop();
  ctx.fleet.shutdown();
  await sim.stop();
  ctx.db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("slug folds Turkish letters", () => {
  assert.equal(admin.slug("Şişli Atölyesi İstanbul"), "sisli-atolyesi-istanbul");
  assert.equal(admin.slug("ığüöç"), "iguoc");
  assert.equal(admin.slug("!!!"), "x");
});

test("workshops: create, duplicate (Turkish case-insensitive), rename, delete moves machines", () => {
  assert.deepEqual(ctx.file.workshops.map((w) => w.id), ["main"]);
  const a = admin.createWorkshop(ctx, { name: "  Prototip   Atölyesi ", description: "Hızlı denemeler" });
  assert.deepEqual([a.id, a.name, a.description], ["prototip-atolyesi", "Prototip Atölyesi", "Hızlı denemeler"]);
  assert.throws(() => admin.createWorkshop(ctx, { name: "PROTOTİP ATÖLYESİ" }), /zaten var/);
  assert.throws(() => admin.createWorkshop(ctx, { name: "   " }), /boş olamaz/);
  const b = admin.createWorkshop(ctx, { name: "Prototip Atölyesi 2" });
  assert.equal(b.id, "prototip-atolyesi-2");
  assert.equal(admin.updateWorkshop(ctx, a.id, { name: "Ar-Ge" }).name, "Ar-Ge");
  assert.throws(() => admin.updateWorkshop(ctx, a.id, { name: "Ana atölye" }), /zaten var/);
  assert.throws(() => admin.updateWorkshop(ctx, "yok", { name: "x" }), /bulunamadı/);

  admin.updateDevice(ctx, "sim", { workshop: a.id });
  assert.equal(admin.workshopOf(ctx, printer.config), a.id);
  const r = admin.deleteWorkshop(ctx, a.id);
  assert.deepEqual(r, { moved: 1, movedTo: "main" });
  assert.equal(admin.workshopOf(ctx, printer.config), "main");
  admin.deleteWorkshop(ctx, b.id);
  assert.throws(() => admin.deleteWorkshop(ctx, "main"), /Son atölye silinemez/);
});

test("devices: validation, duplicates, no secrets out, reconnect only on connection changes", () => {
  const ok = { name: "Yeni A1", host: "192.168.1.60", serial: "01P00A000000009", accessCode: "ab12CD34", model: "A1" };
  for (const [bad, msg] of [
    [{ ...ok, host: "http://evil" }, /IP adresi/],
    [{ ...ok, host: "999.1.1.1" }, /Geçersiz IP/],
    [{ ...ok, serial: "no" }, /Seri numarası/],
    [{ ...ok, accessCode: "has space" }, /Erişim kodu/],
    [{ ...ok, accessCode: "" }, /Erişim kodu/],
    [{ ...ok, id: "bad id!" }, /Kimlik/],
    [{ ...ok, id: "sim" }, /zaten kullanılıyor/],
    [{ ...ok, serial: sim.config.serial }, /seri numarası zaten ekli/],
    [{ ...ok, workshop: "yok" }, /Atölye bulunamadı/],
  ]) assert.throws(() => admin.addDevice(ctx, bad), msg);

  const d = admin.addDevice(ctx, ok);
  assert.deepEqual([d.id, d.name, d.workshop, d.model], ["yeni-a1", "Yeni A1", "main", "A1"]);
  assert.equal("accessCode" in d, false);
  assert.ok(ctx.file.printers.some((p) => p.id === "yeni-a1" && p.accessCode === "ab12CD34")); // stored, never returned
  const added = ctx.fleet.list().find((p) => p.id === "yeni-a1");
  assert.equal(admin.addDevice(ctx, { ...ok, serial: "01P00A000000010" }).id, "yeni-a1-2"); // id made unique

  admin.updateDevice(ctx, "yeni-a1", { name: "Renamed" });
  assert.equal(ctx.fleet.list().find((p) => p.id === "yeni-a1"), added); // same Printer object: no reconnect
  admin.updateDevice(ctx, "yeni-a1", { host: "192.168.1.61" });
  const re = ctx.fleet.list().find((p) => p.id === "yeni-a1");
  assert.notEqual(re, added); // reconnected with the new address
  assert.equal(re.config.host, "192.168.1.61");
  assert.equal(re.config.name, "Renamed");
  assert.throws(() => admin.updateDevice(ctx, "yeni-a1", { serial: sim.config.serial }), /zaten ekli/);
  assert.throws(() => admin.updateDevice(ctx, "ghost", { name: "x" }), /bulunamadı/);

  admin.removeDevice(ctx, "yeni-a1");
  admin.removeDevice(ctx, "yeni-a1-2");
  assert.ok(!ctx.fleet.list().some((p) => p.id.startsWith("yeni")));
  assert.ok(!ctx.file.printers.some((p) => p.id.startsWith("yeni")));
  assert.throws(() => admin.removeDevice(ctx, "yeni-a1"), /bulunamadı/);
});

test("machine status: stop -> start -> reset(plate) -> stop, and reset on errors, but not on a cancel", async () => {
  const status = () => { const st = machineStatus(printer, ctx.scheduler.plateCleared("sim")); return { status: st.code, statusReason: st.reason }; };
  ctx.db.setFlag("plate_clear:sim", true);
  assert.deepEqual([status().status, status().statusReason], ["stop", null]);

  ctx.db.addJob({ name: "cycle", filePath: file, filaments: [{ id: 1, type: "PLA", color: "FF0000", usedG: 30 }] });
  await ctx.scheduler.dispatch();
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  assert.equal(status().status, "start");
  await printer.pause();
  await until(() => printer.state.gcodeState === "PAUSE", 15000);
  assert.equal(status().status, "pause");
  await printer.resume();
  await until(() => printer.state.gcodeState === "FINISH", 12000, "FINISH");
  assert.deepEqual([status().status, status().statusReason], ["reset", "plate"]); // done, waiting for the plate
  ctx.db.setFlag("plate_clear:sim", true);
  assert.equal(status().status, "stop");

  sim.injectFault("hms");
  await until(() => printer.state.hms.length === 1, 3000);
  assert.deepEqual([status().status, status().statusReason], ["reset", "hms"]);
  sim.clearFaults();
  await until(() => printer.state.hms.length === 0, 3000);

  ctx.db.addJob({ name: "fails", filePath: file, filaments: [], maxAttempts: 1 });
  await ctx.scheduler.dispatch();
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  sim.failNow(0x0500c010);
  await until(() => printer.state.gcodeState === "FAILED", 15000);
  assert.deepEqual([status().status, status().statusReason], ["reset", "error"]);

  ctx.db.setFlag("plate_clear:sim", true);
  ctx.db.addJob({ name: "cancel", filePath: file, filaments: [], maxAttempts: 1 });
  await ctx.scheduler.dispatch();
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  sim.failNow(0x0300400c); // cancelled on the printer's screen
  await until(() => printer.state.printError === 0x0300400c, 3000);
  ctx.db.setFlag("plate_clear:sim", true);
  assert.equal(status().status, "stop"); // a cancel is not a fault

});

test("a machine that is printing cannot be removed or re-addressed without force", async () => {
  ctx.db.setFlag("plate_clear:sim", true);
  ctx.db.addJob({ name: "busy", filePath: file, filaments: [], maxAttempts: 1 });
  await ctx.scheduler.dispatch();
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  assert.throws(() => admin.removeDevice(ctx, "sim"), /basıyor/);
  assert.throws(() => admin.updateDevice(ctx, "sim", { host: "10.0.0.9" }), /basıyor/);
  assert.equal(admin.updateDevice(ctx, "sim", { name: "Yeniden adlandırıldı" }).name, "Yeniden adlandırıldı"); // names are safe mid-print
  admin.removeDevice(ctx, "sim", true);
  assert.equal(ctx.fleet.list().length, 0);
});
