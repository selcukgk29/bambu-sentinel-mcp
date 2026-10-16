import * as path from "node:path";
import type { Db } from "./db.js";
import type { Fleet } from "./fleet.js";
import type { Printer } from "./printer/printer.js";
import { isFree } from "./printer/state.js";
import { needGrams, planUsage, rememberUsage } from "./inventory.js";
import type { FilamentRequirement, Job, Tray } from "./types.js";

export interface Match {
  amsMapping: number[];
  useAms: boolean;
}

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}
const colorDist = (a: string, b: string): number => {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
};

/** "PLA" matches "PLA", "PLA-CF", "PLA Basic"; case-insensitive. */
const typeMatches = (want: string, have: string): boolean => {
  const w = want.toUpperCase().trim();
  const h = have.toUpperCase().trim();
  return !!w && !!h && (h === w || h.startsWith(w + "-") || h.startsWith(w + " "));
};

/**
 * Map each required filament to a loaded tray. Returns null with a reason when impossible.
 * Colour is only enforced when the job specifies one (distance threshold 60 in RGB space).
 */
export function matchFilaments(
  required: FilamentRequirement[],
  trays: Tray[],
  colorTolerance = 60,
  /** Grams left in the spool loaded at each slot, where known. */
  remainingG?: Map<number, number>,
): { match: Match } | { reason: string } {
  if (required.length === 0) return { match: { amsMapping: [0], useAms: false } };
  const used = new Set<number>();
  const slots: number[] = [];
  for (const [i, req] of required.entries()) {
    const candidates = trays
      .filter((t) => !used.has(t.slot) && typeMatches(req.type, t.type) && t.remain !== 0)
      .map((t) => ({ t, d: req.color && t.color ? colorDist(req.color, t.color) : 0 }))
      .filter((c) => !req.color || !c.t.color || c.d <= colorTolerance)
      .sort((a, b) => a.d - b.d);
    const need = req.usedG ? needGrams(req.usedG) : 0;
    const enough = candidates.filter((c) => (remainingG?.get(c.t.slot) ?? Infinity) >= need);
    const best = enough[0];
    if (!best && candidates[0])
      return {
        reason: `${req.type} spool in slot ${candidates[0].t.slot} has ${Math.round(remainingG!.get(candidates[0].t.slot)!)} g left, the job needs about ${Math.ceil(need)} g`,
      };
    if (!best) return { reason: `no loaded ${req.type}${req.color ? " #" + req.color : ""} for filament slot ${i + 1}` };
    used.add(best.t.slot);
    slots.push(best.t.slot);
  }
  // ams_mapping[n] is the tray for the slicer's filament n+1; unused filaments are -1.
  const withIds = required.every((r) => r.id !== undefined);
  let mapping = slots;
  if (withIds) {
    mapping = Array(Math.max(...required.map((r) => r.id!))).fill(-1);
    for (const [i, req] of required.entries()) mapping[req.id! - 1] = slots[i]!;
  }
  const external = slots.every((s) => s === 254);
  return { match: { amsMapping: external ? [254] : mapping, useAms: !external } };
}

export interface Candidate {
  printer: Printer;
  match: Match;
}

export class Scheduler {
  /** Printers temporarily off-limits (e.g. plate sweep in progress). */
  private held = new Set<string>();
  hold = (id: string) => void this.held.add(id);
  release = (id: string) => void this.held.delete(id);
  isHeld = (id: string) => this.held.has(id);

  constructor(
    private fleet: Fleet,
    private db: Db,
    /** How long a printer gets to actually begin a print after the start command. */
    readonly startTimeoutMs = 45_000,
  ) {}

  plateCleared(printerId: string): boolean {
    return this.db.getFlag(`plate_clear:${printerId}`, true);
  }

  /** Can this printer run the job given only what is loaded (ignores whether it is busy)? */
  fits(job: Job, p: Printer): { ok: true; match: Match } | { ok: false; reason: string } {
    return this.fitsFilaments(job.filaments, p);
  }

  /** Grams left in the registered spool at each slot of this printer. */
  remainingFor(p: Printer): Map<number, number> {
    const m = new Map<number, number>();
    for (const s of this.db.spoolsFor(p.id)) if (s.slot !== null && s.remainingG !== null) m.set(s.slot, s.remainingG);
    return m;
  }

  fitsFilaments(filaments: FilamentRequirement[], p: Printer): { ok: true; match: Match } | { ok: false; reason: string } {
    const m = matchFilaments(filaments, p.state.trays, 60, this.remainingFor(p));
    return "reason" in m ? { ok: false, reason: m.reason } : { ok: true, match: m.match };
  }

  /** Free, online, plate-cleared printers that can run the job, with why-not for the rest. */
  evaluate(job: Job): { candidates: Candidate[]; rejected: { printerId: string; reason: string }[] } {
    const candidates: Candidate[] = [];
    const rejected: { printerId: string; reason: string }[] = [];
    for (const p of this.fleet.list()) {
      const s = p.state;
      const no = (reason: string) => rejected.push({ printerId: p.id, reason });
      if (job.printerId && job.printerId !== p.id) continue;
      if (this.held.has(p.id)) no("busy (plate sweep)");
      else if (!s.online) no("offline");
      else if (!isFree(s.gcodeState)) no(`busy (${s.gcodeState})`);
      else if (this.db.activeJobFor(p.id)) no("has an active queue job");
      else if (!this.plateCleared(p.id)) no("plate not confirmed clear (use confirm_plate_cleared)");
      else {
        const fit = this.fits(job, p);
        if (!fit.ok) no(fit.reason);
        else candidates.push({ printer: p, match: fit.match });
      }
    }
    return { candidates, rejected };
  }

  /**
   * Upload the file and start the job, confirming the printer really began. The job is claimed
   * first so a print_started event finds it; if the start fails it goes back to the queue with a
   * backoff (and is failed after 3 attempts), and the plate flag is restored.
   */
  async start(job: Job, cand: Candidate): Promise<void> {
    const id = cand.printer.id;
    const plateWas = this.plateCleared(id);
    this.db.markJobStarted(job.id, id);
    try {
      const remoteName = path.basename(job.filePath);
      await cand.printer.uploadFile(job.filePath, `/cache/${remoteName}`);
      await cand.printer.startAndConfirm(
        {
          file: remoteName,
          remoteDir: "/cache",
          plate: job.plate,
          useAms: cand.match.useAms,
          amsMapping: cand.match.amsMapping,
          ...(job.options as object),
        },
        this.startTimeoutMs,
      );
      this.db.setFlag(`plate_clear:${id}`, false);
      rememberUsage(this.db, id, planUsage(this.db, id, job.filaments, cand.match.amsMapping));
    } catch (e) {
      this.db.setFlag(`plate_clear:${id}`, plateWas);
      const verdict = this.db.failStart(job.id, (e as Error).message);
      throw new Error(`${(e as Error).message} (job ${verdict})`);
    }
  }

  /** Try to start the highest-priority runnable queued jobs. Returns one line per decision. */
  async dispatch(maxStarts = 1): Promise<string[]> {
    const log: string[] = [];
    const taken = new Set<string>();
    let started = 0;
    for (const job of this.db.listJobs(["queued"])) {
      if (started >= maxStarts) break;
      if (job.holdUntil && job.holdUntil > Date.now()) {
        log.push(`#${job.id} ${job.name}: held until ${new Date(job.holdUntil).toLocaleTimeString()} after a failed start (${job.lastError})`);
        continue;
      }
      const { candidates, rejected } = this.evaluate(job);
      const cand = candidates.find((c) => !taken.has(c.printer.id));
      if (!cand) {
        log.push(`#${job.id} ${job.name}: waiting (${rejected.map((r) => `${r.printerId}: ${r.reason}`).join("; ") || "no printer"})`);
        continue;
      }
      try {
        await this.start(job, cand);
        taken.add(cand.printer.id);
        started++;
        log.push(`#${job.id} ${job.name}: started on ${cand.printer.id}`);
      } catch (e) {
        log.push(`#${job.id} ${job.name}: failed to start on ${cand.printer.id}: ${(e as Error).message}`);
      }
    }
    if (log.length === 0) log.push("queue is empty");
    return log;
  }
}
