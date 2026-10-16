import type { Db } from "./db.js";
import type { FilamentRequirement } from "./types.js";

/** One filament a print is expected to use. */
export interface UsageEntry {
  type: string;
  color?: string;
  grams: number;
  /** The spool loaded in that slot at start time, when one was registered. */
  spoolId: number | null;
}

/** Margin kept when checking whether a spool can finish a job: purge/waste plus rounding. */
export const needGrams = (usedG: number): number => usedG * 1.05 + 2;

/** Which spool feeds each filament of a job, given the slot mapping the print starts with. */
export function planUsage(db: Db, printerId: string, filaments: FilamentRequirement[], mapping: number[]): UsageEntry[] {
  const withIds = filaments.every((f) => f.id !== undefined);
  const out: UsageEntry[] = [];
  for (const [i, f] of filaments.entries()) {
    if (!f.usedG) continue;
    const slot = withIds ? mapping[f.id! - 1] : mapping[i];
    if (slot === undefined || slot < 0) continue;
    out.push({ type: f.type, ...(f.color ? { color: f.color } : {}), grams: f.usedG, spoolId: db.spoolAt(printerId, slot)?.id ?? null });
  }
  return out;
}

/** Remember what the print now running will consume; settled when it ends. */
export function rememberUsage(db: Db, printerId: string, entries: UsageEntry[]): void {
  db.setKv(`usage:${printerId}`, JSON.stringify(entries));
}

export interface Settled {
  entries: UsageEntry[];
  grams: number;
  /** Spools that dropped below the low-stock threshold because of this print. */
  low: { spoolId: number; name: string; remainingG: number }[];
}

export const LOW_SPOOL_G = 50;

/**
 * The print ended: subtract what it used from the spools. `fraction` is 1 for a finished print
 * and the progress reached for a failed or cancelled one (an approximation).
 */
export function settleUsage(db: Db, printerId: string, fraction: number, context: { name?: string | null; outcome?: string | null } = {}): Settled {
  const raw = db.getKv(`usage:${printerId}`);
  db.delKv(`usage:${printerId}`);
  if (!raw) return { entries: [], grams: 0, low: [] };
  const f = Math.max(0, Math.min(1, fraction));
  const entries = (JSON.parse(raw) as UsageEntry[]).map((e) => ({ ...e, grams: Math.round(e.grams * f * 100) / 100 }));
  const low: Settled["low"] = [];
  const at = Date.now();
  for (const e of entries) {
    if (e.grams > 0)
      db.logConsumption({ at, printerId, printName: context.name ?? null, outcome: context.outcome ?? null, type: e.type, color: e.color ?? null, grams: e.grams, spoolId: e.spoolId });
    if (e.spoolId == null) continue;
    const remaining = db.deductSpool(e.spoolId, e.grams);
    const spool = db.getSpool(e.spoolId);
    if (remaining != null && remaining < LOW_SPOOL_G && spool) low.push({ spoolId: spool.id, name: spool.name, remainingG: Math.round(remaining) });
  }
  return { entries, grams: Math.round(entries.reduce((s, e) => s + e.grams, 0) * 100) / 100, low };
}
