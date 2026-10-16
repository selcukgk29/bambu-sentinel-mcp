import test from "node:test";
import assert from "node:assert/strict";
import { checkGcode, checkTemperature } from "../dist/safety.js";
import { normalize } from "../dist/printer/state.js";
import { matchFilaments } from "../dist/scheduler.js";
import { AnomalyDetector } from "../dist/anomaly.js";
import { Db } from "../dist/db.js";
import { hmsHex } from "../dist/printer/printer.js";

test("gcode allowlist and limits", () => {
  assert.equal(checkGcode("M104 S200", "A1").ok, true);
  assert.equal(checkGcode("M104 S350", "A1").ok, false);
  assert.equal(checkGcode("M140 S120", "A1").ok, false);
  assert.equal(checkGcode("M502", "A1").ok, false);
  assert.equal(checkGcode("M92 X80", "A1").ok, false);
  assert.equal(checkGcode("G28 ; home\nG1 Z10 F600", "A1").ok, true);
  assert.equal(checkGcode("", "A1").ok, false);
  assert.ok(checkTemperature("bed", 200, "A1"));
  assert.equal(checkTemperature("nozzle", 220, "A1"), null);
});

const raw = {
  gcode_state: "RUNNING", mc_percent: 42, layer_num: 10, total_layer_num: 100,
  nozzle_temper: 219.6, nozzle_target_temper: 220, bed_temper: 60, bed_target_temper: 60,
  cooling_fan_speed: "15", lights_report: [{ node: "chamber_light", mode: "on" }],
  hms: [{ attr: 0x07008000, code: 0x00020001 }],
  ams: { tray_now: "0", ams: [{ id: "0", tray: [
    { id: "0", tray_type: "PLA", tray_color: "FF0000FF", remain: 80 },
    { id: "1", tray_type: "PETG", tray_color: "00FF00FF", remain: 0 } ] }] },
  vt_tray: { tray_type: "TPU", tray_color: "000000FF" },
};

test("normalize report", () => {
  const s = normalize(raw, true, 1);
  assert.equal(s.gcodeState, "RUNNING");
  assert.equal(s.fans.part, 100);
  assert.equal(s.light, true);
  assert.deepEqual(s.trays.map((t) => t.slot), [0, 1, 254]);
  assert.equal(s.trays[0].color, "FF0000");
  assert.equal(hmsHex(0x07008000, 0x00020001), "0700_8000_0002_0001");
});

test("filament matching", () => {
  const trays = normalize(raw, true).trays;
  assert.deepEqual(matchFilaments([{ type: "PLA", color: "FF1010" }], trays).match.amsMapping, [0]);
  assert.ok(matchFilaments([{ type: "PLA", color: "0000FF" }], trays).reason);   // wrong colour
  assert.ok(matchFilaments([{ type: "PETG" }], trays).reason);                    // empty spool
  assert.deepEqual(matchFilaments([{ type: "TPU" }], trays).match, { amsMapping: [254], useAms: false });
  assert.deepEqual(matchFilaments([], trays).match.useAms, false);
  assert.ok(matchFilaments([{ type: "PLA" }, { type: "PLA" }], trays).reason);   // only one PLA tray
});

test("anomaly: warm-up is not drift, later drift is", () => {
  const d = new AnomalyDetector("A1");
  const s = (temp, t0) => ({ ...normalize({ ...raw, nozzle_temper: temp, mc_percent: t0, layer_num: t0 }, true) });
  let t = 0;
  assert.equal(d.check(s(100, 1), t).length, 0);            // heating, never reached
  t += 200_000; assert.equal(d.check(s(100, 2), t).length, 0);
  t += 1000; d.check(s(220, 3), t);                         // reached
  t += 1000; d.check(s(190, 4), t);                         // drifts 30°C
  t += 100_000;
  const a = d.check(s(190, 5), t);
  assert.ok(a.some((x) => x.key === "nozzle_drift"));
  assert.ok(d.check(s(260, 6), t + 1).some((x) => x.key === "nozzle_overtemp" && x.severity === "critical"));
});

test("anomaly: stall", () => {
  const d = new AnomalyDetector("A1");
  const s = normalize(raw, true);
  d.check(s, 0);
  assert.ok(d.check(s, 21 * 60_000).some((x) => x.key === "progress_stall"));
});

test("queue + history in sqlite", () => {
  const db = new Db(":memory:");
  const a = db.addJob({ name: "a", filePath: "a.3mf", priority: 0 });
  const b = db.addJob({ name: "b", filePath: "b.3mf", priority: 5 });
  assert.deepEqual(db.listJobs(["queued"]).map((j) => j.name), ["b", "a"]);
  db.markJobStarted(b.id, "a1");
  assert.equal(db.activeJobFor("a1").id, b.id);
  db.openHistory("a1", "b", b.id, 1000);
  db.closeHistory("a1", "finished", 5000, 80);
  assert.equal(db.history({}).at(0).outcome, "finished");
  db.finishJob(b.id, "done");
  assert.equal(db.activeJobFor("a1"), null);
  assert.equal(db.getFlag("plate_clear:a1", true), true);
  db.setFlag("plate_clear:a1", false);
  assert.equal(db.getFlag("plate_clear:a1", true), false);
  void a;
});
