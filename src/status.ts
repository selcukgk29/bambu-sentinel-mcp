import { summarizeFailure } from "./hms.js";
import type { Printer } from "./printer/printer.js";

/**
 * Where a machine stands in its work cycle:
 * start = producing, pause = held mid-print, stop = idle and ready,
 * reset = needs an operator before it can run again (error, or plate not yet cleared), offline = unreachable.
 */
export type StatusCode = "start" | "pause" | "stop" | "reset" | "offline";
export type StatusReason = "plate" | "error" | "hms" | null;

export function machineStatus(p: Printer, plateCleared: boolean): { code: StatusCode; reason: StatusReason } {
  const st = p.state;
  if (!st.online) return { code: "offline", reason: null };
  if (st.gcodeState === "RUNNING" || st.gcodeState === "PREPARE" || st.gcodeState === "SLICING") return { code: "start", reason: null };
  if (st.gcodeState === "PAUSE") return { code: "pause", reason: null };
  const failure = summarizeFailure(st.printError, st.hms);
  const cancelled = st.printError !== 0 && failure.cancelled && st.hms.length === 0;
  if (!cancelled && st.hms.length) return { code: "reset", reason: "hms" };
  if (!cancelled && (st.gcodeState === "FAILED" || st.printError !== 0)) return { code: "reset", reason: "error" };
  if (!plateCleared) return { code: "reset", reason: "plate" };
  return { code: "stop", reason: null };
}
