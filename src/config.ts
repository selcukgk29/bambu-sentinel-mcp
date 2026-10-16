import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_COST, resolveCost, type CostSettings } from "./cost.js";
import { DEFAULT_SHIFTS, type ShiftDef } from "./shifts.js";
import type { PrinterConfig } from "./types.js";

export const DATA_DIR = process.env.BAMBU_SENTINEL_HOME || path.join(os.homedir(), ".bambu-sentinel");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

/** How the toolhead sweeps a finished part off the plate. Coordinates are bed coordinates in mm. */
export interface EjectProfile {
  /** Bed must be at or below this before sweeping (parts release when cool). */
  bedMaxC: number;
  nozzleMaxC: number;
  /** Nozzle height while pushing. Never below 1 mm. */
  zPush: number;
  /** Minimum clearance height for travel moves; raised automatically above the part. */
  zTravelMin: number;
  /** Y where each pass starts and ends; the push is yStart -> yEnd. Calibrate for your enclosure/bin. */
  yStart: number;
  yEnd: number;
  /** X range covered and the width of what touches the part (bare nozzle ~2, a clip-on scraper more). */
  xMin: number;
  xMax: number;
  sweeperWidth: number;
  /** Explicit X passes; overrides xMin/xMax/sweeperWidth when set. */
  xPositions?: number[];
  /** Sweep only the X strips where the 3MF says parts sit (needs the plate layout; verify with a rehearsal). */
  useLayout: boolean;
  /** Extra margin around each part's footprint when using the layout, mm. */
  layoutMarginMm: number;
  /** Push speed, mm/min. */
  feed: number;
  cooldownTimeoutS: number;
}

export const DEFAULT_EJECT: EjectProfile = {
  bedMaxC: 35,
  nozzleMaxC: 50,
  zPush: 3,
  zTravelMin: 40,
  yStart: 10,
  yEnd: 240,
  xMin: 30,
  xMax: 226,
  sweeperWidth: 20,
  useLayout: false,
  layoutMarginMm: 5,
  feed: 1500,
  cooldownTimeoutS: 1200,
};

export interface Settings {
  /** Seconds between telemetry/snapshot checks while a print is running. */
  watchIntervalSec: number;
  /** Pause automatically on critical anomalies. */
  autoPause: boolean;
  /** Ask the MCP client's model (sampling) to judge snapshots. */
  visionSampling: boolean;
  /** Start queued jobs without being asked, when a printer is free and its plate is cleared. */
  autoDispatch: boolean;
  /** Sweep the plate automatically after every successful print. */
  autoEject: boolean;
  eject: EjectProfile;
  /** Default number of print attempts per queued job (1 = never reprint automatically). */
  defaultMaxAttempts: number;
  cost: CostSettings;
  /** Work shifts used for the factory timeline and shift reports (local time). */
  shifts: ShiftDef[];
}


export interface WorkshopRecord {
  id: string;
  name: string;
  description?: string;
}

export interface ConfigFile {
  printers: PrinterConfig[];
  workshops: WorkshopRecord[];
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  watchIntervalSec: 60,
  autoPause: false,
  visionSampling: false,
  autoDispatch: false,
  autoEject: false,
  eject: DEFAULT_EJECT,
  defaultMaxAttempts: 2,
  cost: DEFAULT_COST,
  shifts: DEFAULT_SHIFTS,
};

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadConfig(): ConfigFile {
  let file: Partial<ConfigFile> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* first run */
  }
  const printers = [...(file.printers ?? [])];

  // Env shortcut for a single printer, handy in MCP client config.
  const { BAMBU_HOST, BAMBU_SERIAL, BAMBU_ACCESS_CODE } = process.env;
  if (BAMBU_HOST && BAMBU_SERIAL && BAMBU_ACCESS_CODE) {
    const id = process.env.BAMBU_ID || "a1";
    if (!printers.some((p) => p.id === id)) {
      printers.push({
        id,
        name: process.env.BAMBU_NAME || id,
        host: BAMBU_HOST,
        serial: BAMBU_SERIAL,
        accessCode: BAMBU_ACCESS_CODE,
        model: process.env.BAMBU_MODEL || "A1",
        ...(process.env.BAMBU_MQTT_PORT || process.env.BAMBU_FTP_PORT || process.env.BAMBU_CAMERA_PORT
          ? {
              ports: {
                mqtt: Number(process.env.BAMBU_MQTT_PORT) || undefined,
                ftp: Number(process.env.BAMBU_FTP_PORT) || undefined,
                camera: Number(process.env.BAMBU_CAMERA_PORT) || undefined,
              },
            }
          : {}),
      });
    }
  }
  const settings = { ...DEFAULT_SETTINGS, ...(file.settings ?? {}) };
  settings.eject = { ...DEFAULT_EJECT, ...(file.settings?.eject ?? {}) };
  settings.cost = resolveCost(file.settings?.cost);
  if (!file.settings?.shifts?.length) settings.shifts = DEFAULT_SHIFTS;
  const workshops = file.workshops?.length ? file.workshops : [{ id: "main", name: "Ana Atölye" }];
  return { printers, workshops, settings };
}

export function saveConfig(cfg: ConfigFile): void {
  ensureDataDir();
  // Never persist env-provided printers' secrets differently; keep file simple.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
