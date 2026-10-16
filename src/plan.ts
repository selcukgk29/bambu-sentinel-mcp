import type { Db } from "./db.js";
import type { Fleet } from "./fleet.js";
import { isActive } from "./printer/state.js";
import type { Scheduler } from "./scheduler.js";

export interface PlanRow {
  jobId: number;
  name: string;
  /** null when no printer can run it as things are loaded now. */
  printerId: string | null;
  startAt: number | null;
  endAt: number | null;
  durationSec: number | null;
  durationSource: "3mf" | "history" | "default";
  note?: string;
}

const DEFAULT_DURATION_SEC = 3600;

/**
 * Forecast where and when each queued job would run. Greedy in queue order: a job goes to the
 * eligible printer that frees up first. Filament eligibility uses what is loaded right now.
 * `changeoverSec` is added after each job (plate sweep / clearing time).
 */
export function buildPlan(
  fleet: Fleet,
  db: Db,
  scheduler: Scheduler,
  opts: { now?: number; changeoverSec?: number } = {},
): PlanRow[] {
  const now = opts.now ?? Date.now();
  const changeover = (opts.changeoverSec ?? 0) * 1000;

  const freeAt = new Map<string, number>();
  for (const p of fleet.list()) {
    const s = p.state;
    if (!s.online) continue;
    if (isActive(s.gcodeState)) freeAt.set(p.id, now + Math.max(0, s.remainingMin) * 60_000 + changeover);
    else if (db.activeJobFor(p.id)) freeAt.set(p.id, now + 60_000);
    else freeAt.set(p.id, now);
  }

  const rows: PlanRow[] = [];
  for (const job of db.listJobs(["queued"], 500)) {
    let durationSec = job.estimateSec;
    let source: PlanRow["durationSource"] = "3mf";
    if (durationSec == null) {
      durationSec = db.avgDurationSec(job.name);
      source = "history";
    }
    if (durationSec == null) {
      durationSec = DEFAULT_DURATION_SEC;
      source = "default";
    }

    let best: { id: string; start: number } | null = null;
    let why = "";
    for (const p of fleet.list()) {
      if (!freeAt.has(p.id)) continue;
      if (job.printerId && job.printerId !== p.id) continue;
      const fit = scheduler.fits(job, p);
      if (!fit.ok) {
        why ||= fit.reason;
        continue;
      }
      const start = Math.max(freeAt.get(p.id)!, job.holdUntil ?? 0, now);
      if (!best || start < best.start) best = { id: p.id, start };
    }
    if (!best) {
      rows.push({ jobId: job.id, name: job.name, printerId: null, startAt: null, endAt: null, durationSec, durationSource: source, note: why || "no online printer is available for this job" });
      continue;
    }
    const end = best.start + durationSec * 1000;
    freeAt.set(best.id, end + changeover);
    const notes: string[] = [];
    if (job.holdUntil && job.holdUntil > now) notes.push("held after a failed start");
    if (best.start <= now && !scheduler.plateCleared(best.id)) notes.push("needs confirm_plate_cleared first");
    rows.push({
      jobId: job.id,
      name: job.name,
      printerId: best.id,
      startAt: best.start,
      endAt: end,
      durationSec,
      durationSource: source,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    });
  }
  return rows;
}
