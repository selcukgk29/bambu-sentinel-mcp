import * as fs from "node:fs";
import * as path from "node:path";
import { AnomalyDetector, type Alert } from "./anomaly.js";
import { DATA_DIR, type Settings } from "./config.js";
import type { Db } from "./db.js";
import type { Ejector } from "./eject.js";
import { summarizeFailure, type FailureSummary } from "./hms.js";
import { computeCost } from "./cost.js";
import { settleUsage } from "./inventory.js";
import { machineStatus } from "./status.js";
import type { Fleet } from "./fleet.js";
import type { Scheduler } from "./scheduler.js";
import type { Job, PlateObject, PrinterEvent } from "./types.js";

export interface VisionVerdict {
  status: "ok" | "suspect" | "failure";
  confidence: number;
  reason: string;
}

/** Ask a vision model about one frame. Returns null when unavailable. */
export type VisionFn = (jpeg: Buffer, context: string) => Promise<VisionVerdict | null>;

const SNAP_KEEP = 30;
const SAMPLE_MS = 10_000;
const ALERT_COOLDOWN_MS = 10 * 60_000;
const OFFLINE_GRACE_MS = 2 * 60_000;

export class Monitor {
  private detectors = new Map<string, AnomalyDetector>();
  private lastAlert = new Map<string, number>();
  private cancelled = new Set<string>();
  private offlineSince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private sampleTimer: NodeJS.Timeout | null = null;
  private lastPrune = 0;
  vision: VisionFn | null = null;
  ejector: Ejector | null = null;

  constructor(
    private fleet: Fleet,
    private db: Db,
    private scheduler: Scheduler,
    readonly settings: Settings,
  ) {
    fleet.on("event", (e: PrinterEvent) => this.onEvent(e));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.settings.watchIntervalSec * 1000);
    this.timer.unref();
    this.sample();
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_MS);
    this.sampleTimer.unref();
  }

  /**
   * Record each machine's status (when it changes) and, while it is online, a telemetry sample.
   * Keeps a status history and telemetry samples; called on a timer and after state-changing events.
   */
  sample(now = Date.now()): void {
    for (const p of this.fleet.list()) {
      const st = machineStatus(p, this.scheduler.plateCleared(p.id));
      this.db.logStatus(p.id, now, st.code, st.reason);
      const s = p.state;
      if (s.online)
        this.db.addSample(p.id, {
          at: now,
          status: st.code,
          nozzle: s.nozzle.temp,
          nozzleTarget: s.nozzle.target,
          bed: s.bed.temp,
          bedTarget: s.bed.target,
          progress: s.progress,
          speed: s.speedLevel,
          fan: s.fans.part,
        });
    }
    if (now - this.lastPrune > 3_600_000) {
      this.lastPrune = now;
      this.db.prune(now);
    }
  }

  restart(): void {
    if (this.timer) clearInterval(this.timer);
    this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.timer = null;
    this.sampleTimer = null;
  }

  /** Called by stop_print so the resulting FAILED state is recorded as a cancel. */
  markCancelled(printerId: string): void {
    this.cancelled.add(printerId);
    const job = this.db.activeJobFor(printerId);
    if (job) this.db.finishJob(job.id, "cancelled");
  }

  // ---- events -----------------------------------------------------------

  private onEvent(e: PrinterEvent): void {
    this.db.addEvent(e);
    const state = this.fleet.get(e.printerId).state;
    switch (e.type) {
      case "print_started": {
        this.detectors.get(e.printerId)?.reset();
        const job = this.db.activeJobFor(e.printerId);
        this.db.openHistory(e.printerId, state.jobName || job?.name || "unknown", job?.id ?? null, e.at);
        this.db.setFlag(`plate_clear:${e.printerId}`, false);
        break;
      }
      case "print_finished":
      case "print_failed": {
        const wasCancelled = this.cancelled.delete(e.printerId);
        const failure = e.type === "print_failed" ? summarizeFailure(state.printError, state.hms) : null;
        const outcome = e.type === "print_finished" ? "finished" : wasCancelled || failure?.cancelled ? "cancelled" : "failed";
        // Filament used: all of it for a finished print, the share reached for a failed/cancelled one.
        const used = settleUsage(this.db, e.printerId, outcome === "finished" ? 1 : state.progress / 100, { name: state.jobName, outcome });
        for (const l of used.low)
          this.raise(e.printerId, { key: `spool_low_${l.spoolId}`, severity: "warning", message: `spool #${l.spoolId} ${l.name} is down to ${l.remainingG} g` });
        const row = this.db.openHistoryRow(e.printerId);
        const job = this.db.activeJobFor(e.printerId);
        // Parts = objects on the plate (from the 3MF layout); 1 when the file did not say. Failed or cancelled prints give none.
        const parts = outcome === "finished" ? Math.max(1, job?.layout?.length ?? 1) : 0;
        const cost = computeCost(this.settings.cost, {
          durationSec: row ? (e.at - row.started_at) / 1000 : 0,
          entries: used.entries,
          priceOf: (id) => this.db.getSpool(id)?.pricePerKg ?? null,
        });
        this.db.closeHistory(e.printerId, outcome, e.at, state.layer || null, failure?.text ?? null, failure?.code ?? null, {
          grams: used.entries.length ? used.grams : null,
          energyKwh: cost.energyKwh,
          cost: cost.total,
          parts,
        });
        if (job) this.settleJob(job, outcome, failure);
        this.db.setFlag(`plate_clear:${e.printerId}`, false);
        if (e.type === "print_finished" && this.settings.autoEject) void this.autoEject(e.printerId, job?.layout ?? null);
        break;
      }
    }
    // Make status changes land on the timeline at the moment they happen, not up to 10 s later.
    if (e.type.startsWith("print_") || e.type === "connected" || e.type === "disconnected") this.sample(e.at);
  }

  /**
   * Close out the queue job of a print that just ended. A failed print is requeued for another
   * attempt only when attempts remain and the failure is not one that needs a human (or must not repeat).
   * The plate flag stays false, so the retry waits until the failed plate has been cleared.
   */
  private settleJob(job: Job, outcome: string, failure: FailureSummary | null): void {
    if (outcome === "finished") return this.db.finishJob(job.id, "done");
    if (outcome === "cancelled") return this.db.finishJob(job.id, "cancelled", failure?.text ?? null);
    const reason = failure?.text ?? "print failed";
    if (failure?.retry === "retry" && job.attempts + 1 < job.maxAttempts) {
      this.db.retryJob(job.id, reason);
      this.db.addEvent({
        printerId: job.assignedPrinter ?? "",
        type: "job_retry",
        at: Date.now(),
        data: { job: job.id, name: job.name, attempt: job.attempts + 1, of: job.maxAttempts, reason },
      });
      return;
    }
    const why = failure?.retry === "never" ? " (not retried: this error must not be repeated)" : failure?.retry === "human" ? " (not retried: needs attention first)" : "";
    this.db.finishJob(job.id, "failed", reason + why);
  }

  /** After a successful print: cool, sweep, verify; then dispatch the next job if the plate is verified empty. */
  private async autoEject(printerId: string, layout: PlateObject[] | null): Promise<void> {
    if (!this.ejector) return;
    try {
      const res = await this.ejector.run(this.fleet.get(printerId), this.settings.eject, { layout });
      if (!res.ok) {
        this.raise(printerId, { key: "eject_failed", severity: "warning", message: `auto-eject failed: ${res.error}` });
        return;
      }
      if (!res.plateCleared) {
        this.raise(printerId, { key: "plate_not_verified", severity: "warning", message: "plate swept but not verified empty; check it and call confirm_plate_cleared" });
        return;
      }
      if (this.settings.autoDispatch) for (const l of await this.scheduler.dispatch()) console.error("[queue]", l);
    } catch (e) {
      console.error(`[${printerId}] auto-eject error:`, (e as Error).message);
    }
  }

  private raise(printerId: string, alert: Alert): boolean {
    const k = `${printerId}:${alert.key}`;
    const now = Date.now();
    if (now - (this.lastAlert.get(k) ?? 0) < ALERT_COOLDOWN_MS) return false;
    this.lastAlert.set(k, now);
    const ev: PrinterEvent = { printerId, type: "alert", at: now, data: { ...alert } };
    this.db.addEvent(ev);
    return true;
  }

  private async autoPause(printerId: string, why: string): Promise<void> {
    if (!this.settings.autoPause) return;
    try {
      await this.fleet.get(printerId).pause();
      this.db.addEvent({ printerId, type: "auto_pause", at: Date.now(), data: { reason: why } });
    } catch (e) {
      console.error(`[${printerId}] auto-pause failed:`, (e as Error).message);
    }
  }

  // ---- snapshots ----------------------------------------------------------

  snapshotDir(printerId: string): string {
    return path.join(DATA_DIR, "snapshots", printerId);
  }

  saveSnapshot(printerId: string, jpeg: Buffer): string {
    const dir = this.snapshotDir(printerId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}.jpg`);
    fs.writeFileSync(file, jpeg);
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - SNAP_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  }

  /** Newest saved snapshot paths, oldest first. */
  recentSnapshots(printerId: string, n: number): string[] {
    try {
      const dir = this.snapshotDir(printerId);
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jpg"))
        .sort()
        .slice(-n)
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  // ---- watch loop ---------------------------------------------------------

  /** Current anomalies for one printer, without side effects on cooldowns. */
  detectorFor(printerId: string, model: string): AnomalyDetector {
    let d = this.detectors.get(printerId);
    if (!d) this.detectors.set(printerId, (d = new AnomalyDetector(model)));
    return d;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const p of this.fleet.list()) {
        const s = p.state;
        const printing = s.gcodeState === "RUNNING" || s.gcodeState === "PAUSE" || s.gcodeState === "PREPARE";

        if (!s.online && printing) {
          const since = this.offlineSince.get(p.id) ?? now;
          this.offlineSince.set(p.id, since);
          if (now - since > OFFLINE_GRACE_MS)
            this.raise(p.id, { key: "offline_during_print", severity: "warning", message: "printer offline while a print was active" });
        } else {
          this.offlineSince.delete(p.id);
        }
        if (s.gcodeState !== "RUNNING") continue;

        const alerts = this.detectorFor(p.id, p.config.model).check(s, now);
        for (const a of alerts) {
          if (this.raise(p.id, a) && a.severity === "critical") await this.autoPause(p.id, a.message);
        }

        try {
          const jpeg = await p.snapshot();
          this.saveSnapshot(p.id, jpeg);
          if (this.settings.visionSampling && this.vision) {
            const ctx = `${s.jobName || "print"}, layer ${s.layer}/${s.totalLayers}, ${s.progress}%`;
            const v = await this.vision(jpeg, ctx);
            if (v && v.status !== "ok") {
              const critical = v.status === "failure" && v.confidence >= 0.8;
              const alert: Alert = { key: "vision_" + v.status, severity: critical ? "critical" : "warning", message: v.reason };
              if (this.raise(p.id, alert) && critical) await this.autoPause(p.id, `vision: ${v.reason}`);
            }
          }
        } catch (e) {
          console.error(`[${p.id}] snapshot failed:`, (e as Error).message);
        }
      }
      if (this.settings.autoDispatch) {
        const lines = await this.scheduler.dispatch();
        for (const l of lines) if (l.includes("started")) console.error("[queue]", l);
      }
    } finally {
      this.busy = false;
    }
  }
}
