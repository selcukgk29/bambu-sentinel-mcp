export interface PrinterConfig {
  id: string;
  name: string;
  host: string;
  serial: string;
  accessCode: string;
  model: string;
  /** Override default ports (8883 MQTT, 990 FTPS, 6000 camera); used by the simulator. */
  ports?: { mqtt?: number; ftp?: number; camera?: number };
  /** Workshop (group) the machine belongs to; see admin.ts. */
  workshop?: string;
}

export type GcodeState =
  | "IDLE"
  | "PREPARE"
  | "RUNNING"
  | "PAUSE"
  | "FINISH"
  | "FAILED"
  | "SLICING"
  | "UNKNOWN";

export interface Tray {
  /** Global slot: amsId*4+trayId, or 254 for the external spool. */
  slot: number;
  amsId: number;
  trayId: number;
  type: string;
  /** RRGGBB (alpha stripped). */
  color: string;
  /** Remaining percent, -1 when unknown. */
  remain: number;
  brand: string;
}

export interface HmsEntry {
  attr: number;
  code: number;
}

export interface PrinterState {
  online: boolean;
  gcodeState: GcodeState;
  progress: number;
  remainingMin: number;
  layer: number;
  totalLayers: number;
  jobName: string;
  file: string;
  nozzle: { temp: number; target: number };
  bed: { temp: number; target: number };
  speedLevel: number;
  fans: { part: number; aux: number; chamber: number; heatbreak: number };
  wifiSignal: string;
  light: boolean;
  printError: number;
  hms: HmsEntry[];
  trays: Tray[];
  activeTray: string;
  updatedAt: number;
}

export type PrinterEventType =
  | "connected"
  | "disconnected"
  | "print_started"
  | "print_finished"
  | "print_failed"
  | "print_paused"
  | "print_resumed"
  | "hms_error"
  | "alert"
  | "auto_pause"
  | "vision"
  | "eject"
  | "job_retry";

export interface PrinterEvent {
  printerId: string;
  type: PrinterEventType;
  at: number;
  data: Record<string, unknown>;
}

export interface FilamentRequirement {
  /** 1-based filament number in the slicer project; decides the ams_mapping position. */
  id?: number;
  type: string;
  /** RRGGBB, optional. */
  color?: string;
  /** Grams the plate uses of this filament, when known. */
  usedG?: number;
}

/** An object's footprint on the plate: [minX, minY, maxX, maxY] in mm. */
export interface PlateObject {
  name: string;
  bbox: [number, number, number, number];
}

export type JobStatus = "queued" | "printing" | "done" | "failed" | "cancelled";

export interface Job {
  id: number;
  name: string;
  filePath: string;
  plate: number;
  status: JobStatus;
  /** Pin to a printer id; null lets the scheduler choose. */
  printerId: string | null;
  assignedPrinter: string | null;
  priority: number;
  filaments: FilamentRequirement[];
  options: Record<string, unknown>;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  notes: string;
  lastError: string | null;
  /** Do not try to start before this time (backoff after a failed start). */
  holdUntil: number | null;
  startFailures: number;
  /** Prints of this job that actually started and then failed. */
  attempts: number;
  maxAttempts: number;
  /** Slicer's print time estimate. */
  estimateSec: number | null;
  /** Where the parts sit on the plate (from the 3MF), used for targeted sweeps. */
  layout: PlateObject[] | null;
}
