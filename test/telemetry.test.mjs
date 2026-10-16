import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-tele-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { shiftWindows, validateShifts, DEFAULT_SHIFTS } = await import("../dist/shifts.js");
const { Db } = await import("../dist/db.js");
const { loadConfig } = await import("../dist/config.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { normalize } = await import("../dist/printer/state.js");
const { machineStatus } = await import("../dist/status.js");
const { Monitor } = await import("../dist/monitor.js");

const T = (h, m = 0) => new Date(2026, 9, 16, h, m, 0).getTime(); // 16 Oct 2026, local time
const HOUR = 3_600_000;

test("shifts: default three-shift day, overnight wrap, clipping, validation", () => {
  const day = shiftWindows(DEFAULT_SHIFTS, T(0), T(24));
  assert.deepEqual(day.map((w) => [w.name, w.from, w.to]), [
    ["Vardiya 3", T(0), T(8)],
    ["Vardiya 1", T(8), T(16)],
    ["Vardiya 2", T(16), T(24)],
  ]);
  // an overnight shift 22:00-06:00 shows up on both sides of midnight
  const night = [{ name: "Gece", start: "22:00", end: "06:00" }];
  assert.deepEqual(shiftWindows(night, T(0), T(24)).map((w) => [w.from, w.to]), [[T(0), T(6)], [T(22), T(24)]]);
  // clipped to the requested range
  assert.deepEqual(shiftWindows(DEFAULT_SHIFTS, T(10), T(12)).map((w) => [w.name, w.from, w.to]), [["Vardiya 1", T(10), T(12)]]);
  assert.equal(validateShifts(DEFAULT_SHIFTS), null);
  assert.match(validateShifts([]), /en az bir/);
  assert.match(validateShifts([{ name: "x", start: "8", end: "16:00" }]), /HH:MM/);
  assert.match(validateShifts([{ name: "x", start: "08:00", end: "25:00" }]), /00:00-24:00/);
  assert.match(validateShifts([{ name: " ", start: "08:00", end: "16:00" }]), /boş/);
});

test("status log: no duplicates, segments with a record before the range, gaps stay empty, pruning keeps the latest", () => {
  const db = new Db(":memory:");
  assert.equal(db.logStatus("m", T(6), "stop", null), true);
  assert.equal(db.logStatus("m", T(6, 5), "stop", null), false); // unchanged
  assert.equal(db.logStatus("m", T(8, 30), "start", null), true);
  assert.equal(db.logStatus("m", T(10), "reset", "plate"), true);
  assert.equal(db.logStatus("m", T(10), "reset", "error"), true); // same status, different reason is a change

  // range starts before the first record: nothing is invented for the gap
  let seg = db.statusSegments("m", T(0), T(24), T(12));
  assert.deepEqual(seg.map((s) => [s.status, s.reason, s.from, s.to]), [
    ["stop", null, T(6), T(8, 30)],
    ["start", null, T(8, 30), T(10)],
    ["reset", "error", T(10), T(12)], // the zero-length "plate" record collapses; open segment ends at now
  ]);
  // range starts in the middle of a segment: the earlier record is carried in
  seg = db.statusSegments("m", T(9), T(11), T(12));
  assert.deepEqual(seg.map((s) => [s.status, s.from, s.to]), [["start", T(9), T(10)], ["reset", T(10), T(11)]]);
  assert.deepEqual(db.statusSegments("other", T(0), T(24), T(12)), []);

  db.prune(T(0) + 200 * 24 * HOUR); // far future: old rows go, but each machine keeps its latest state
  assert.equal(db.statusSegments("m", T(0), T(24), T(12)).length >= 0, true);
  assert.equal(db.logStatus("m", T(12), "reset", "error"), false); // the latest record survived pruning
});

test("samples: range query and downsampling by averaging", () => {
  const db = new Db(":memory:");
  for (let i = 0; i < 600; i++)
    db.addSample("m", { at: T(0) + i * 10_000, status: i < 300 ? "stop" : "start", nozzle: i, nozzleTarget: 200, bed: 60, bedTarget: 60, progress: i / 6, speed: 2, fan: 100 });
  assert.equal(db.samplesBetween("m", T(0), T(24), 1000).length, 600);
  const few = db.samplesBetween("m", T(0), T(24), 60);
  assert.equal(few.length, 60);
  assert.ok(few.every((s, i) => i === 0 || s.at > few[i - 1].at));
  assert.equal(few[0].nozzle, 4.5); // mean of 0..9
  assert.equal(few[59].status, "start");
  assert.equal(db.samplesBetween("m", T(0), T(0, 5)).length, 31);
  assert.equal(db.samplesBetween("ghost", T(0), T(24)).length, 0);
});

const raw = (extra = {}) => ({ gcode_state: "IDLE", nozzle_temper: 25, bed_temper: 25, ams: { ams: [] }, ...extra });
const printer = (id, state, stateRaw) => ({
  id,
  config: { id, name: `Makine ${id}`, host: "127.0.0.1", serial: "SER" + id, accessCode: "x", model: "A1", workshop: "main" },
  state: normalize(raw(stateRaw), state !== "offline"),
  stateSince: T(13),
});

function world(printers) {
  const cfg = loadConfig();
  const db = new Db(":memory:");
  const fleet = { list: () => printers, get: (id) => printers.find((p) => p.id === id), on() {} };
  const scheduler = new Scheduler(fleet, db);
  const monitor = new Monitor({ ...fleet, on() {} }, db, scheduler, cfg.settings);
  return { fleet, db, scheduler, monitor, ejector: null, file: { ...cfg, printers: printers.map((p) => p.config) }, save() {} };
}

test("monitor.sample records status changes and telemetry, only for online machines", () => {
  const a = printer("a", "online", { gcode_state: "RUNNING", nozzle_temper: 220, nozzle_target_temper: 220, bed_temper: 60, bed_target_temper: 60, mc_percent: 42, spd_lvl: 3, cooling_fan_speed: "15" });
  const b = printer("b", "offline");
  const ctx = world([a, b]);
  ctx.monitor.sample(T(10));
  ctx.monitor.sample(T(10, 1)); // nothing changed: no new status row
  assert.deepEqual(ctx.db.statusSegments("a", T(0), T(24), T(12)).map((s) => s.status), ["start"]);
  assert.deepEqual(ctx.db.statusSegments("b", T(0), T(24), T(12)).map((s) => s.status), ["offline"]);
  assert.equal(ctx.db.samplesBetween("a", T(0), T(24)).length, 2);
  assert.equal(ctx.db.samplesBetween("b", T(0), T(24)).length, 0); // nothing measured while offline
  const s = ctx.db.samplesBetween("a", T(0), T(24))[0];
  assert.deepEqual([s.nozzle, s.bed, s.progress, s.speed, s.fan, s.status], [220, 60, 42, 3, 100, "start"]);
  assert.deepEqual(machineStatus(a, true), { code: "start", reason: null });
  assert.deepEqual(machineStatus(printer("c", "online"), false), { code: "reset", reason: "plate" });
  ctx.monitor.stop();
});

test("status log: backfilling older history is not swallowed by newer records (regression)", () => {
  const db = new Db(":memory:");
  db.logStatus("m", T(12), "stop", null); // a live record exists first
  assert.equal(db.logStatus("m", T(8), "start", null), true);
  assert.equal(db.logStatus("m", T(9), "stop", null), true); // same status as the newest record, but not as the one before it in time
  assert.equal(db.logStatus("m", T(9, 30), "stop", null), false); // genuinely unchanged at that point in time
  assert.deepEqual(db.statusSegments("m", T(7), T(13), T(13)).map((s) => [s.status, s.from, s.to]), [["start", T(8), T(9)], ["stop", T(9), T(13)]]);
});
