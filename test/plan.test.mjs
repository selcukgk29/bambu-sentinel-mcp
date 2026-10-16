import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-plan-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { readThreeMf, readJobInfo } = await import("../dist/threemf.js");
const { normalize } = await import("../dist/printer/state.js");
const { matchFilaments, Scheduler } = await import("../dist/scheduler.js");
const { buildPlan } = await import("../dist/plan.js");
const { Db } = await import("../dist/db.js");

const SLICE = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="3016"/>
    <metadata key="weight" value="12.5"/>
    <object identify_id="1" name="Benchy" skipped="false" />
    <filament id="2" tray_info_idx="GFA00" type="PLA" color="#FF0000" used_m="3.05" used_g="9.19" />
    <filament id="4" tray_info_idx="GFG00" type="PETG" color="#00FF00" used_m="1.0" used_g="3.31" />
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="600"/>
    <filament id="1" type="PLA" color="#FFFFFF" used_g="1.5" />
  </plate>
</config>`;
const PLATE1_JSON = JSON.stringify({ bbox_objects: [{ name: "Benchy", bbox: [100, 90, 140, 130], id: 1 }, { name: "bad", bbox: ["x"] }] });

function make3mf(name) {
  const f = path.join(home, name);
  fs.writeFileSync(f, zipSync({
    "Metadata/slice_info.config": strToU8(SLICE),
    "Metadata/plate_1.json": strToU8(PLATE1_JSON),
    "Metadata/plate_1.gcode": strToU8("G1"),
  }));
  return f;
}

test("3mf: plates, estimate, weights, filament ids and object boxes", () => {
  const f = make3mf("a.3mf");
  const info = readThreeMf(f);
  assert.equal(info.hasGcode, true);
  assert.equal(info.plates.length, 2);
  assert.deepEqual(info.plates[0].objects, [{ name: "Benchy", bbox: [100, 90, 140, 130] }]);  // malformed box dropped
  assert.deepEqual(info.plates[1].objects, []);
  const j = readJobInfo(f, 1);
  assert.equal(j.estimateSec, 3016);
  assert.equal(j.weightG, 12.5);
  assert.deepEqual(j.filaments, [
    { id: 2, type: "PLA", color: "FF0000", usedG: 9.19 },
    { id: 4, type: "PETG", color: "00FF00", usedG: 3.31 },
  ]);
  assert.equal(readJobInfo(f, 2).estimateSec, 600);
  assert.deepEqual(readJobInfo(path.join(home, "x.gcode"), 1).filaments, []);
});

const raw = (trays, extra = {}) => ({
  gcode_state: "IDLE",
  ams: { ams: [{ id: "0", tray: trays.map((t, i) => ({ id: String(i), tray_type: t[0], tray_color: t[1] + "FF", remain: 100 })) }] },
  ...extra,
});

test("ams_mapping follows the slicer's filament numbers (unused filaments are -1)", () => {
  const trays = normalize(raw([["PLA", "FFFFFF"], ["PLA", "FF0000"], ["PETG", "00FF00"]]), true).trays;
  const m = matchFilaments([{ id: 2, type: "PLA", color: "FF0000" }, { id: 4, type: "PETG" }], trays);
  assert.deepEqual(m.match.amsMapping, [-1, 1, -1, 2]);
  // without ids: order of listing (as before)
  assert.deepEqual(matchFilaments([{ type: "PETG" }], trays).match.amsMapping, [2]);
});

const printer = (id, trays, state = {}) => ({ id, config: { model: "A1" }, state: normalize(raw(trays, state), true) });

test("plan: assigns each job to the printer that frees first and has the filament", () => {
  const db = new Db(":memory:");
  const now = 1_000_000_000_000;
  const A = printer("A", [["PLA", "FFFFFF"]], { gcode_state: "RUNNING", mc_remaining_time: 20 });   // busy 20 min
  const B = printer("B", [["PETG", "000000"]]);                                                       // free now
  const fleet = { list: () => [A, B] };
  const scheduler = new Scheduler(fleet, db);

  const j1 = db.addJob({ name: "j1", filePath: "x", filaments: [{ type: "PLA" }], estimateSec: 3600 });
  const j2 = db.addJob({ name: "j2", filePath: "x", filaments: [{ type: "PETG" }], estimateSec: 1800 });
  const j3 = db.addJob({ name: "j3", filePath: "x", filaments: [{ type: "PLA" }] });                  // no estimate: default 60 min
  const j4 = db.addJob({ name: "j4", filePath: "x", filaments: [{ type: "TPU" }], estimateSec: 60 });  // nobody has TPU

  const rows = buildPlan(fleet, db, scheduler, { now });
  const by = Object.fromEntries(rows.map((r) => [r.jobId, r]));
  const min = (t) => (t - now) / 60_000;
  assert.deepEqual([by[j1.id].printerId, min(by[j1.id].startAt), min(by[j1.id].endAt)], ["A", 20, 80]);
  assert.deepEqual([by[j2.id].printerId, min(by[j2.id].startAt), min(by[j2.id].endAt)], ["B", 0, 30]);
  assert.deepEqual([by[j3.id].printerId, min(by[j3.id].startAt), by[j3.id].durationSource], ["A", 80, "default"]);
  assert.equal(by[j4.id].printerId, null);
  assert.match(by[j4.id].note, /no loaded TPU/);

  // changeover between jobs, history-based estimate, hold
  db.openHistory("A", "j3", null, 0);
  db.closeHistory("A", "finished", 45 * 60_000, 10);
  db.setPriority(j3.id, 5);
  db.failStart(j1.id, "boom", 90 * 60_000);
  const rows2 = buildPlan(fleet, db, scheduler, { now, changeoverSec: 300 });
  const r3 = rows2.find((r) => r.jobId === j3.id);
  assert.deepEqual([r3.printerId, r3.durationSource, r3.durationSec], ["A", "history", 2700]);
  assert.equal(min(r3.startAt), 25);                             // A is free after 20 min + 5 min changeover
  const r1 = rows2.find((r) => r.jobId === j1.id);
  assert.ok(min(r1.startAt) >= 90);                              // held until the backoff ends
  assert.match(r1.note, /held/);
});

test("plan: a printer whose plate is unconfirmed is flagged, an offline one is skipped", () => {
  const db = new Db(":memory:");
  const A = printer("A", [["PLA", "FFFFFF"]]);
  const off = { id: "O", config: { model: "A1" }, state: normalize(raw([["PLA", "FFFFFF"]]), false) };
  const fleet = { list: () => [off, A] };
  const scheduler = new Scheduler(fleet, db);
  db.setFlag("plate_clear:A", false);
  const j = db.addJob({ name: "j", filePath: "x", filaments: [{ type: "PLA" }], estimateSec: 60 });
  const [row] = buildPlan(fleet, db, scheduler, { now: 0 });
  assert.equal(row.printerId, "A");
  assert.match(row.note, /confirm_plate_cleared/);
  assert.equal(j.id, row.jobId);
});
