/**
 * Human-readable meaning of Bambu HMS codes and print_error codes.
 *
 * The built-in table is deliberately tiny and best-effort: only entries we are reasonably sure of.
 * Everything else is "unknown" until you import a full dictionary (`hms_import`, e.g. the HMS json
 * shipped with Bambu Studio) or add entries to ~/.bambu-sentinel/hms.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "./config.js";

export type Severity = "info" | "warning" | "error" | "fatal" | "unknown";
/** retry: safe to reprint automatically; human: needs someone to fix something first; never: do not reprint. */
export type RetryPolicy = "retry" | "human" | "never";

export interface HmsEntry {
  text: string;
  severity?: Severity;
  retry?: RetryPolicy;
  /** The user (or printer UI) cancelled the print; not a failure. */
  cancelled?: boolean;
}

export interface HmsInfo {
  code: string;
  text: string;
  severity: Severity;
  retry: RetryPolicy;
  cancelled: boolean;
  source: "builtin" | "user" | "unknown";
}

/** AAAA_BBBB_CCCC_DDDD, the way Bambu's wiki lists HMS codes. */
export function hmsHex(attr: number, code: number): string {
  const h = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const a = h(attr);
  const c = h(code);
  return `${a.slice(0, 4)}_${a.slice(4)}_${c.slice(0, 4)}_${c.slice(4)}`;
}

/** Accept "0700_8000_0002_0001", "0700800000020001" (16 hex) or "0300400C" (8 hex, print_error). */
export function normalizeKey(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length === 16) return `${hex.slice(0, 4)}_${hex.slice(4, 8)}_${hex.slice(8, 12)}_${hex.slice(12)}`;
  if (hex.length === 8) return hex;
  return null;
}

const BUILTIN: Record<string, HmsEntry> = {
  "0300400C": { text: "The print was cancelled", severity: "info", retry: "never", cancelled: true },
  "0300_0100_0001_0001": { text: "Heatbed temperature is abnormal (heater or sensor fault)", severity: "fatal", retry: "never" },
  "0300_0100_0002_0001": { text: "Heatbed temperature is abnormal (heater or sensor fault)", severity: "fatal", retry: "never" },
  "0300_0200_0001_0001": { text: "Nozzle temperature is abnormal (heater or sensor fault)", severity: "fatal", retry: "never" },
  "0300_0200_0002_0001": { text: "Nozzle temperature is abnormal (heater or sensor fault)", severity: "fatal", retry: "never" },
};

const user = new Map<string, HmsEntry>();

function dictFile(): string {
  return path.join(DATA_DIR, "hms.json");
}

export function loadUserDictionary(file = dictFile()): number {
  try {
    user.clear();
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, HmsEntry>;
    for (const [k, v] of Object.entries(data)) {
      const key = normalizeKey(k);
      if (key && v?.text) user.set(key, v);
    }
  } catch {
    /* no user dictionary yet */
  }
  return user.size;
}

function build(key: string, e: HmsEntry, source: HmsInfo["source"]): HmsInfo {
  return {
    code: key,
    text: e.text,
    severity: e.severity ?? "warning",
    retry: e.retry ?? "human",
    cancelled: !!e.cancelled,
    source,
  };
}

function lookup(key: string): HmsInfo {
  const u = user.get(key);
  if (u) return build(key, u, "user");
  const b = BUILTIN[key];
  if (b) return build(key, b, "builtin");
  return { code: key, text: `unknown code ${key}`, severity: "unknown", retry: "retry", cancelled: false, source: "unknown" };
}

export const describeHms = (attr: number, code: number): HmsInfo => lookup(hmsHex(attr, code));

export function describePrintError(code: number): HmsInfo {
  return lookup((code >>> 0).toString(16).toUpperCase().padStart(8, "0"));
}

export function describeKey(raw: string): HmsInfo | null {
  const key = normalizeKey(raw);
  return key ? lookup(key) : null;
}

/**
 * Merge a dictionary into the user table and persist it. Accepts a plain map
 * `{ "<code>": {text, severity?, retry?} }` or a Bambu-style document
 * `{ data: { device_hms: { en: [{ecode, intro}] }, device_error: { en: [...] } } }`.
 * Bambu-style entries get severity "warning" / retry "human" (their files do not say).
 */
export function importDictionary(data: any, file = dictFile()): number {
  let added = 0;
  const put = (rawKey: string, e: HmsEntry) => {
    const key = normalizeKey(rawKey);
    if (!key || !e.text) return;
    user.set(key, e);
    added++;
  };

  const lists: any[] = [
    data?.data?.device_hms?.en,
    data?.data?.device_error?.en,
    data?.device_hms?.en,
    data?.device_error?.en,
  ].filter(Array.isArray);
  for (const list of lists) for (const it of list) if (it?.ecode && it?.intro) put(String(it.ecode), { text: String(it.intro) });

  if (!lists.length && data && typeof data === "object")
    for (const [k, v] of Object.entries<any>(data)) if (v && typeof v === "object" && typeof v.text === "string") put(k, v);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(user), null, 1));
  return added;
}

export interface FailureSummary {
  text: string;
  code: string | null;
  retry: RetryPolicy;
  cancelled: boolean;
}

/** Combine print_error and active HMS entries into one verdict, taking the strictest retry policy. */
export function summarizeFailure(printError: number, hms: { attr: number; code: number }[]): FailureSummary {
  const infos: HmsInfo[] = [];
  if (printError) infos.push(describePrintError(printError));
  for (const h of hms) infos.push(describeHms(h.attr, h.code));
  if (infos.length === 0) return { text: "print failed (printer reported no error code)", code: null, retry: "retry", cancelled: false };
  const rank: Record<RetryPolicy, number> = { retry: 0, human: 1, never: 2 };
  const retry = infos.reduce<RetryPolicy>((w, i) => (rank[i.retry] > rank[w] ? i.retry : w), "retry");
  return {
    text: infos.map((i) => `${i.text} [${i.code}]`).join("; "),
    code: infos[0]!.code,
    retry,
    cancelled: infos.some((i) => i.cancelled),
  };
}
