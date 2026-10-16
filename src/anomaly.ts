import { limitsFor } from "./safety.js";
import type { PrinterState } from "./types.js";

export interface Alert {
  key: string;
  severity: "warning" | "critical";
  message: string;
}

const NOZZLE_DRIFT = 15;
const BED_DRIFT = 10;
const REACHED_BAND = 8;
const NOZZLE_DRIFT_MS = 90_000;
const BED_DRIFT_MS = 180_000;
const STALL_MS = 20 * 60_000;

interface HeaterTrack {
  target: number;
  reached: boolean;
  driftSince: number;
}

/**
 * Telemetry-only failure heuristics for one printer. Stateful: call `check` on every watch tick.
 * Heater drift only counts after the heater has first reached its target, so normal warm-up
 * never trips it.
 */
export class AnomalyDetector {
  private nozzle: HeaterTrack = { target: 0, reached: false, driftSince: 0 };
  private bed: HeaterTrack = { target: 0, reached: false, driftSince: 0 };
  private progressSig = "";
  private progressSince = 0;

  constructor(private model: string) {}

  reset(): void {
    this.nozzle = { target: 0, reached: false, driftSince: 0 };
    this.bed = { target: 0, reached: false, driftSince: 0 };
    this.progressSig = "";
  }

  private heater(
    t: HeaterTrack,
    name: string,
    temp: number,
    target: number,
    drift: number,
    driftMs: number,
    now: number,
  ): Alert[] {
    const out: Alert[] = [];
    if (target !== t.target) Object.assign(t, { target, reached: false, driftSince: 0 });
    if (target <= 0) return out;
    const diff = Math.abs(temp - target);
    if (diff <= REACHED_BAND) t.reached = true;
    if (t.reached && diff > drift) {
      t.driftSince ||= now;
      if (now - t.driftSince > driftMs)
        out.push({
          key: `${name}_drift`,
          severity: "warning",
          message: `${name} temperature ${temp.toFixed(0)}°C is ${diff.toFixed(0)}°C away from target ${target}°C`,
        });
    } else {
      t.driftSince = 0;
    }
    return out;
  }

  check(s: PrinterState, now: number): Alert[] {
    if (s.gcodeState !== "RUNNING") {
      this.progressSig = "";
      return [];
    }
    const limits = limitsFor(this.model);
    const alerts: Alert[] = [];

    if (s.nozzle.temp > limits.nozzleMax + 10 || (s.nozzle.target > 0 && s.nozzle.temp > s.nozzle.target + 30))
      alerts.push({ key: "nozzle_overtemp", severity: "critical", message: `nozzle at ${s.nozzle.temp.toFixed(0)}°C (target ${s.nozzle.target}°C)` });
    if (s.bed.temp > limits.bedMax + 10)
      alerts.push({ key: "bed_overtemp", severity: "critical", message: `bed at ${s.bed.temp.toFixed(0)}°C (limit ${limits.bedMax}°C)` });

    alerts.push(...this.heater(this.nozzle, "nozzle", s.nozzle.temp, s.nozzle.target, NOZZLE_DRIFT, NOZZLE_DRIFT_MS, now));
    alerts.push(...this.heater(this.bed, "bed", s.bed.temp, s.bed.target, BED_DRIFT, BED_DRIFT_MS, now));

    if (s.printError !== 0)
      alerts.push({ key: "print_error", severity: "warning", message: `printer reports error code ${s.printError}` });

    const sig = `${s.progress}|${s.layer}`;
    if (sig !== this.progressSig) {
      this.progressSig = sig;
      this.progressSince = now;
    } else if ((s.layer > 0 || s.progress > 0) && now - this.progressSince > STALL_MS) {
      alerts.push({
        key: "progress_stall",
        severity: "warning",
        message: `no progress for ${Math.round((now - this.progressSince) / 60_000)} min (${s.progress}% layer ${s.layer}/${s.totalLayers})`,
      });
    }
    return alerts;
  }
}
