import type { Config } from "../context.js";
import type { Printer } from "../printer/printer.js";

export const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

/** Wording for a command result, so callers can tell "done" from "sent but unanswered". */
export const ackNote = (a: { acked: boolean }): string => (a.acked ? "acknowledged by printer" : "sent, but the printer did not acknowledge");

export const fail = (msg: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: msg }],
});

/** Wrap a handler so thrown errors become tool errors instead of protocol errors. */
export function safe<A>(fn: (args: A) => Promise<any>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

export function summary(p: Printer, cfg: Config) {
  const s = p.state;
  return {
    id: p.id,
    name: p.config.name,
    model: p.config.model,
    online: s.online,
    state: s.gcodeState,
    job: s.jobName || null,
    progress: s.progress,
    layer: s.totalLayers ? `${s.layer}/${s.totalLayers}` : null,
    remaining_min: s.remainingMin,
    nozzle: `${s.nozzle.temp.toFixed(0)}/${s.nozzle.target}`,
    bed: `${s.bed.temp.toFixed(0)}/${s.bed.target}`,
    plate_cleared: cfg.scheduler.plateCleared(p.id),
    hms: s.hms.length,
  };
}
