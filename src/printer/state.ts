import type { GcodeState, PrinterState, Tray } from "../types.js";

const STATES = new Set(["IDLE", "PREPARE", "RUNNING", "PAUSE", "FINISH", "FAILED", "SLICING"]);

export function emptyState(): PrinterState {
  return {
    online: false,
    gcodeState: "UNKNOWN",
    progress: 0,
    remainingMin: 0,
    layer: 0,
    totalLayers: 0,
    jobName: "",
    file: "",
    nozzle: { temp: 0, target: 0 },
    bed: { temp: 0, target: 0 },
    speedLevel: 2,
    fans: { part: 0, aux: 0, chamber: 0, heatbreak: 0 },
    wifiSignal: "",
    light: false,
    printError: 0,
    hms: [],
    trays: [],
    activeTray: "",
    updatedAt: 0,
  };
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : d;
};

/** Fan values arrive as 0-15 strings; convert to percent. */
const fanPct = (v: unknown): number => Math.round((num(v) / 15) * 100);

function parseTrays(raw: any): Tray[] {
  const trays: Tray[] = [];
  for (const ams of raw?.ams?.ams ?? []) {
    const amsId = num(ams.id);
    for (const t of ams.tray ?? []) {
      const trayId = num(t.id);
      trays.push({
        slot: amsId * 4 + trayId,
        amsId,
        trayId,
        type: String(t.tray_type ?? ""),
        color: String(t.tray_color ?? "").slice(0, 6).toUpperCase(),
        remain: num(t.remain, -1),
        brand: String(t.tray_sub_brands ?? ""),
      });
    }
  }
  const vt = raw?.vt_tray;
  if (vt && (vt.tray_type || vt.tray_color)) {
    trays.push({
      slot: 254,
      amsId: 254,
      trayId: 0,
      type: String(vt.tray_type ?? ""),
      color: String(vt.tray_color ?? "").slice(0, 6).toUpperCase(),
      remain: num(vt.remain, -1),
      brand: String(vt.tray_sub_brands ?? ""),
    });
  }
  return trays;
}

/** Build the normalized state from the merged raw `print` report. */
export function normalize(raw: any, online: boolean, now = Date.now()): PrinterState {
  const gs = String(raw?.gcode_state ?? "UNKNOWN").toUpperCase();
  const light = (raw?.lights_report ?? []).find((l: any) => l.node === "chamber_light");
  return {
    online,
    gcodeState: (STATES.has(gs) ? gs : "UNKNOWN") as GcodeState,
    progress: num(raw?.mc_percent),
    remainingMin: num(raw?.mc_remaining_time),
    layer: num(raw?.layer_num),
    totalLayers: num(raw?.total_layer_num),
    jobName: String(raw?.subtask_name ?? ""),
    file: String(raw?.gcode_file ?? ""),
    nozzle: { temp: num(raw?.nozzle_temper), target: num(raw?.nozzle_target_temper) },
    bed: { temp: num(raw?.bed_temper), target: num(raw?.bed_target_temper) },
    speedLevel: num(raw?.spd_lvl, 2),
    fans: {
      part: fanPct(raw?.cooling_fan_speed),
      aux: fanPct(raw?.big_fan1_speed),
      chamber: fanPct(raw?.big_fan2_speed),
      heatbreak: fanPct(raw?.heatbreak_fan_speed),
    },
    wifiSignal: String(raw?.wifi_signal ?? ""),
    light: light?.mode === "on",
    printError: num(raw?.print_error),
    hms: (raw?.hms ?? []).map((h: any) => ({ attr: num(h.attr), code: num(h.code) })),
    trays: parseTrays(raw),
    activeTray: String(raw?.ams?.tray_now ?? ""),
    updatedAt: now,
  };
}

const ACTIVE = new Set<GcodeState>(["PREPARE", "RUNNING", "PAUSE", "SLICING"]);
export const isActive = (s: GcodeState): boolean => ACTIVE.has(s);
export const isFree = (s: GcodeState): boolean => s === "IDLE" || s === "FINISH" || s === "FAILED";
