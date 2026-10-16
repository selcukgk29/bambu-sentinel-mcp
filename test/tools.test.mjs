// MCP-level integration test: every layer from the client call down to a simulated printer.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-tools-"));
process.env.BAMBU_SENTINEL_HOME = home;

const { PrinterSimulator, frameLabel } = await import("../dist/sim/simulator.js");
const { loadConfig, saveConfig } = await import("../dist/config.js");
const { Fleet } = await import("../dist/fleet.js");
const { Db } = await import("../dist/db.js");
const { Scheduler } = await import("../dist/scheduler.js");
const { Monitor } = await import("../dist/monitor.js");
const { Ejector } = await import("../dist/eject.js");
const { buildServer } = await import("../dist/server.js");

const until = async (fn, ms = 10000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
};

let sim, fleet, db, scheduler, monitor, ejector, client, ctx, printer, threemf;

/** Call a tool; return the parsed JSON (or raw text) plus the error flag. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const t = res.content.find((c) => c.type === "text")?.text ?? "";
  let json;
  try {
    json = JSON.parse(t);
  } catch {
    json = undefined;
  }
  return { isError: !!res.isError, text: t, json, content: res.content };
}

before(async () => {
  sim = await PrinterSimulator.start({ speed: 600, tickMs: 50 });
  const file = loadConfig();
  fleet = new Fleet();
  db = new Db(":memory:");
  scheduler = new Scheduler(fleet, db);
  monitor = new Monitor(fleet, db, scheduler, file.settings);
  ejector = new Ejector(scheduler, db, (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))));
  monitor.ejector = ejector;
  ctx = { fleet, db, scheduler, monitor, ejector, file, save: () => saveConfig(file) };
  const server = buildServer(ctx);
  // Stand-in for the client's vision model: reads the simulator's scene label.
  ejector.plateCheck = async (jpeg) => ({ empty: /plate=empty/.test(frameLabel(jpeg)), confidence: 0.95, reason: frameLabel(jpeg) });

  printer = fleet.add(sim.config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  threemf = path.join(home, "benchy.3mf");
  fs.writeFileSync(
    threemf,
    zipSync({
      "Metadata/slice_info.config": strToU8(`<config><plate>
        <metadata key="index" value="1"/><metadata key="prediction" value="3016"/><metadata key="weight" value="30"/>
        <filament id="1" type="PLA" color="#FF0000" used_g="30" /></plate></config>`),
      "Metadata/plate_1.json": strToU8(JSON.stringify({ bbox_objects: [{ name: "Benchy", bbox: [108, 108, 148, 148] }] })),
      "Metadata/plate_1.gcode": strToU8("G1"),
    }),
  );
  await until(() => printer.state.online && printer.state.trays.length === 3, 8000, "printer online");
});

after(async () => {
  await client.close();
  monitor.stop();
  fleet.shutdown();
  await sim.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("catalogue: every tool is listed with a schema", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["fleet_overview", "start_print", "queue_add", "queue_eta", "eject_plate", "estimate_cost", "cost_report", "spool_add", "check_filament", "hms_lookup", "discover_printers", "configure_watch"])
    assert.ok(names.includes(n), `missing tool ${n}`);
  assert.ok(tools.length >= 40, `only ${tools.length} tools`);
  for (const t of tools) assert.ok(t.description && t.inputSchema, `${t.name} lacks description/schema`);
});

test("status and safety guards", async () => {
  const o = (await call("fleet_overview")).json;
  assert.equal(o.length, 1);
  assert.deepEqual([o[0].id, o[0].online, o[0].state], ["sim", true, "IDLE"]);
  assert.equal((await call("printer_status")).json.trays.length, 3);

  assert.match((await call("send_gcode", { gcode: "M502" })).text, /rejected: command not allowed: M502/);
  assert.match((await call("set_temperature", { target: "nozzle", celsius: 999 })).text, /nozzle temp must be 0-300/);
  assert.match((await call("stop_print", { confirm: false })).text, /needs confirm=true/);
  const ok = await call("set_temperature", { target: "bed", celsius: 40 });
  assert.match(ok.text, /acknowledged by printer/);
  await call("set_temperature", { target: "bed", celsius: 0 });
  assert.match((await call("start_print", { local_path: threemf, plate_cleared: false })).text, /plate_cleared=true/);
});

test("filament check, spools and cost estimate", async () => {
  let r = (await call("check_filament", { file_path: threemf })).json;
  assert.deepEqual(r.needs, [{ type: "PLA", color: "FF0000", needs_g: 34 }]);
  assert.deepEqual(r.printers, [{ printer: "sim", fits: true, ams_mapping: [1] }]);

  const spool = (await call("spool_add", { type: "PLA", color: "FF0000", weight_g: 1000, remaining_g: 10, price_per_kg: 30, printer_id: "sim", slot: 1 })).json;
  assert.equal(spool.slot, 1);
  r = (await call("check_filament", { file_path: threemf })).json;
  assert.equal(r.printers[0].fits, false);
  assert.match(r.printers[0].why, /spool in slot 1 has 10 g left/);

  await call("spool_update", { spool_id: spool.id, remaining_g: 500 });
  r = (await call("check_filament", { file_path: threemf })).json;
  assert.equal(r.printers[0].fits, true);

  const est = (await call("estimate_cost", { file_path: threemf, quantity: 3 })).json;
  assert.equal(est.print_minutes, 50);
  assert.equal(est.per_print.filament, 0.9); // 30 g at the spool's 30/kg
  assert.deepEqual(est.priced_with, [`spool #${spool.id}`]);
  assert.equal(est.total_for_quantity, Math.round(est.per_print.total * 3 * 100) / 100);
  assert.match(String(est.success_rate), /not enough history/);
  assert.equal(est.parts_on_plate, 1); // benchy.3mf lists one object
  assert.equal(est.cost_per_part, est.per_print.total);

  assert.match((await call("spool_assign", { spool_id: spool.id })).text, /printer_id and slot are required/);
  assert.equal((await call("spool_list")).json.length, 1);
});

test("queue: add reads the 3MF, ETA forecasts, dispatch starts it and the start is confirmed", async () => {
  const job = (await call("queue_add", { file_path: threemf, priority: 5 })).json;
  assert.equal(job.estimateSec, 3016);
  assert.deepEqual(job.filaments, [{ id: 1, type: "PLA", color: "FF0000", usedG: 30 }]);
  assert.deepEqual(job.layout, [{ name: "Benchy", bbox: [108, 108, 148, 148] }]);
  assert.equal(job.maxAttempts, 2);

  const eta = (await call("queue_eta")).json;
  assert.equal(eta.jobs[0].printer, "sim");
  assert.equal(eta.jobs[0].minutes, 50);
  assert.equal(eta.jobs[0].estimate_from, "3mf");
  assert.ok(eta.all_done_at);
  assert.equal((await call("queue_eta", { job_id: 999 })).isError, true);

  const dry = (await call("queue_dispatch")).json; // dry run is the default
  assert.deepEqual(dry[0].would_run_on, [{ printer: "sim", ams_mapping: [1] }]);

  const log = (await call("queue_dispatch", { dry_run: false })).json;
  assert.match(log.join(), /started on sim/);
  assert.equal((await call("queue_list")).json[0].status, "printing");
  await until(() => printer.state.gcodeState === "RUNNING", 15000);
  assert.match((await call("start_print", { local_path: threemf, plate_cleared: true })).text, /busy \(RUNNING\)/);
  assert.match((await call("pause_print")).text, /acknowledged by printer/);
  await until(() => printer.state.gcodeState === "PAUSE", 15000);
  assert.match((await call("resume_print")).text, /acknowledged/);
});

test("finished print: history carries grams and cost, spool is debited, report adds up", async () => {
  await until(() => printer.state.gcodeState === "FINISH", 12000, "FINISH");
  await until(() => db.history({})[0]?.cost != null, 3000, "costed");
  const h = (await call("get_history")).json;
  assert.equal(h.summary.finished, 1);
  assert.equal(h.prints[0].grams, 30);
  assert.ok(h.prints[0].cost >= 0.9);
  assert.equal((await call("spool_list")).json[0].remainingG, 470);

  const rep = (await call("cost_report", { since_days: 1 })).json;
  assert.equal(rep.finished, 1);
  assert.equal(rep.wasted_cost, 0);
  assert.ok(rep.total_cost >= 0.9 && rep.total_cost < 1);
  assert.equal(rep.avg_cost_per_finished, rep.total_cost);

  const cfg = (await call("configure_cost", { currency: "TRY", filament_price_per_kg: { PLA: 500, default: 600 }, electricity_per_kwh: 3 })).json;
  assert.deepEqual([cfg.currency, cfg.filamentPricePerKg.PLA, cfg.filamentPricePerKg.default, cfg.filamentPricePerKg.PETG], ["TRY", 500, 600, 22]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).settings.cost.currency === "TRY"); // persisted
});

test("plate sweep through the tool: guards, dry run, targeted by the queued job's layout, verified", async () => {
  assert.equal(sim.part !== null, true);
  assert.match((await call("eject_plate", {})).text, /needs confirm=true/);

  const dry = (await call("eject_plate", { dry_run: true })).json;
  assert.equal(dry.passes, 11);
  const targeted = (await call("eject_plate", { dry_run: true, use_layout: true })).json; // layout of the last job on this printer
  assert.equal(targeted.passes, 4);
  assert.match((await call("eject_plate", { dry_run: true, use_layout: true, job_id: 12345 })).text, /no plate layout known/);

  const cfg = (await call("configure_eject", { y_end: 400 }));
  assert.equal(cfg.isError, true); // validated against the bed before saving
  assert.match(cfg.text, /Y 400 outside/);
  assert.equal(ctx.file.settings.eject.yEnd, 240); // the rejected edit left the profile untouched
  assert.equal((await call("configure_eject", { y_end: 200 })).json.yEnd, 200);
  await call("configure_eject", { y_end: 240 });

  await call("save_empty_plate_reference", { plate_is_empty: true });
  const r = await call("eject_plate", { confirm: true, use_layout: true, part_height_mm: 20 });
  assert.equal(r.isError, false, r.text);
  const summary = JSON.parse(r.content[0].text);
  assert.equal(summary.plate_cleared, true);
  assert.ok(summary.steps.some((s) => /pass 4\/4/.test(s)));
  assert.ok(r.content.some((c) => c.type === "image"));
  assert.equal(sim.part, null);
  assert.equal(sim.crashes, 0);
});

test("hms tools decode, import and list active codes", async () => {
  assert.equal((await call("hms_lookup", { code: "0300400C" })).json.cancelled, true);
  assert.match((await call("hms_lookup", { code: "nope" })).text, /expected 16 hex digits/);
  const dict = path.join(home, "dict.json");
  fs.writeFileSync(dict, JSON.stringify({ data: { device_hms: { en: [{ ecode: "0700800000020001", intro: "AMS filament runout" }] } } }));
  assert.match((await call("hms_import", { file_path: dict })).text, /imported 1 entries/);
  assert.equal((await call("hms_lookup", { code: "0700_8000_0002_0001" })).json.text, "AMS filament runout");
  sim.injectFault("hms");
  await until(() => printer.state.hms.length === 1, 3000);
  const a = (await call("hms_active")).json;
  assert.equal(a.hms[0].text, "AMS filament runout");
  sim.clearFaults();
});

test("watch/eject settings, discovery, resources and prompts", async () => {
  const w = (await call("configure_watch", { auto_eject: true, auto_dispatch: true, auto_pause: true })).json;
  assert.deepEqual([w.autoEject, w.autoDispatch, w.autoPause], [true, true, true]);
  assert.equal((await call("configure_watch", { vision_sampling: true })).isError, false); // vision hook is installed even if the client cannot sample

  const d = await call("discover_printers", { timeout_sec: 1, scan: "never" }); // never probe the real network from a test
  assert.equal(d.isError, false);
  assert.ok(d.json?.printers ? Array.isArray(d.json.printers) : /no printers answered/.test(d.text));

  const fleetRes = await client.readResource({ uri: "bambu://fleet" });
  assert.equal(JSON.parse(fleetRes.contents[0].text)[0].id, "sim");
  const events = JSON.parse((await client.readResource({ uri: "bambu://events" })).contents[0].text);
  assert.ok(events.some((e) => e.type === "print_finished"));
  assert.ok(events.every((e) => typeof e.summary === "string"));
  const prompt = await client.getPrompt({ name: "supervise_print", arguments: { printer_id: "sim" } });
  assert.match(prompt.messages[0].content.text, /inspect_print/);
});

test("estimate_cost: average cost of one part when the plate holds several objects", async () => {
  const four = path.join(home, "four.3mf");
  const box = (w, h, x) => ({ name: `p${x}`, bbox: [x, 0, x + w, h] }); // footprints 100, 100, 200, 400 mm2
  fs.writeFileSync(four, zipSync({
    "Metadata/slice_info.config": strToU8(`<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="7200"/>
      <filament id="1" type="PLA" color="#FF0000" used_g="60" /></plate></config>`),
    "Metadata/plate_1.json": strToU8(JSON.stringify({ bbox_objects: [box(10, 10, 0), box(10, 10, 20), box(20, 10, 40), box(20, 20, 70)] })),
    "Metadata/plate_1.gcode": strToU8("G1"),
  }));
  const est = (await call("estimate_cost", { file_path: four })).json;
  const total = est.per_print.total;
  assert.equal(est.parts_on_plate, 4);
  assert.equal(est.cost_per_part, Math.round((total / 4) * 100) / 100);
  const by = est.cost_per_part_by_footprint;
  assert.deepEqual(by.map((p) => p.share), [0.125, 0.125, 0.25, 0.5]);
  assert.ok(Math.abs(by.reduce((a, p) => a + p.cost, 0) - total) < 0.03); // the split adds back up to the plate cost
  assert.match(est.note, /approximate/);
  const h = (await call("get_history")).json.prints.find((p) => p.parts);
  assert.ok(h === undefined || h.cost_per_part === Math.round((h.cost / h.parts) * 100) / 100);
});

test("discover_printers: subnet scan validates the range and reports what it scanned", async () => {
  const pub = await call("discover_printers", { timeout_sec: 1, scan: "always", subnet: "8.8.8.0/24" });
  assert.equal(pub.isError, true);
  assert.match(pub.text, /özel ağ aralıkları/); // public ranges are refused
  assert.equal((await call("discover_printers", { timeout_sec: 1, scan: "always", subnet: "192.168.0.0/16" })).isError, true); // too big

  const r = await call("discover_printers", { timeout_sec: 1, scan: "always", subnet: "192.168.254.252/30" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.scanned, { ranges: ["192.168.254.252/30"], candidates: 0 });
  assert.match(r.json.next, /nothing found/);
});
