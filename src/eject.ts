import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR, type EjectProfile } from "./config.js";
import type { Db } from "./db.js";
import type { Printer } from "./printer/printer.js";
import { isFree } from "./printer/state.js";
import { bedSize, checkGcode } from "./safety.js";
import type { Scheduler } from "./scheduler.js";
import type { PlateObject } from "./types.js";

export interface EjectOptions {
  /** Tallest part on the plate; travel height is kept 10 mm above it. */
  partHeightMm?: number;
  /** Explicit X passes for this run (e.g. where the parts are). */
  xPositions?: number[];
  /** Where the parts sit (from the 3MF). Used when profile.useLayout is on and no explicit X list is set. */
  layout?: PlateObject[] | null;
  /** Run the full path 25 mm higher so nothing is touched. */
  rehearsal?: boolean;
  coolDown?: boolean;
}

export interface SweepPlan {
  passes: string[][];
  park: string[];
  xPositions: number[];
  zTravel: number;
  zPush: number;
  estimateS: number;
}

export interface PlateVerdict {
  empty: boolean;
  confidence: number;
  reason: string;
}
/** Judge whether the plate is empty from a frame (and optionally a known-empty reference). */
export type PlateCheckFn = (jpeg: Buffer, reference: Buffer | null) => Promise<PlateVerdict | null>;

export interface EjectResult {
  ok: boolean;
  steps: string[];
  error?: string;
  snapshot?: Buffer;
  verdict?: PlateVerdict | null;
  /** True only when the plate was verified empty and the scheduler flag was set. */
  plateCleared: boolean;
}

const f = (n: number) => String(Math.round(n * 100) / 100);

/** X positions that cover every [minX, maxX] range with passes at most `step` apart, ends included. */
export function coverRanges(ranges: [number, number][], step: number, margin: number, bedX: number): number[] {
  const padded = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, b) - margin), Math.min(bedX, Math.max(a, b) + margin)] as [number, number])
    .sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const r of padded) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + step) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const xs: number[] = [];
  for (const [a, b] of merged) {
    const n = Math.max(1, Math.ceil((b - a) / step));
    const gap = n === 1 && b - a === 0 ? 0 : (b - a) / n;
    for (let i = 0; i <= n; i++) xs.push(Math.round((a + gap * i) * 10) / 10);
  }
  return [...new Set(xs)];
}

/** Build and validate the sweep G-code. Pure: no printer access. */
export function planSweep(profile: EjectProfile, model: string, o: EjectOptions = {}): SweepPlan {
  const bed = bedSize(model);
  if (profile.zPush < 1) throw new Error("zPush must be at least 1 mm");
  const zPush = profile.zPush + (o.rehearsal ? 25 : 0);
  const zTravel = Math.max(profile.zTravelMin, (o.partHeightMm ?? 0) + 10, zPush + 10);
  if (zTravel > 240) throw new Error(`travel height ${zTravel} mm exceeds the Z range; check part_height_mm`);

  let xs = o.xPositions ?? profile.xPositions;
  if (!xs?.length && profile.useLayout && o.layout?.length) {
    xs = coverRanges(
      o.layout.map((b) => [b.bbox[0], b.bbox[2]] as [number, number]),
      Math.max(1, profile.sweeperWidth * 0.9),
      profile.layoutMarginMm,
      bed.x,
    );
  }
  if (!xs?.length) {
    const step = Math.max(1, profile.sweeperWidth * 0.9);
    xs = [];
    for (let x = profile.xMin; x <= profile.xMax + 0.001; x += step) xs.push(Math.round(x * 10) / 10);
  }
  if (xs.length > 40) throw new Error(`${xs.length} passes is too many; widen sweeperWidth or narrow xMin/xMax`);
  for (const x of xs) if (x < 0 || x > bed.x) throw new Error(`X ${x} outside 0-${bed.x}`);
  for (const y of [profile.yStart, profile.yEnd]) if (y < 0 || y > bed.y) throw new Error(`Y ${y} outside 0-${bed.y}`);
  if (profile.yStart === profile.yEnd) throw new Error("yStart and yEnd must differ");

  const passes = xs.map((x) => [
    "G90",
    `G1 Z${f(zTravel)} F600`,
    `G1 X${f(x)} Y${f(profile.yStart)} F6000`,
    `G1 Z${f(zPush)} F600`,
    `G1 Y${f(profile.yEnd)} F${Math.round(profile.feed)}`,
    `G1 Z${f(zTravel)} F600`,
    "M400",
  ]);
  const park = ["G90", `G1 Y${f(profile.yStart)} F6000`, "M400"];

  for (const lines of [...passes, park]) {
    const chk = checkGcode(lines.join("\n"), model);
    if (!chk.ok) throw new Error(`generated G-code rejected by safety: ${chk.reason}`);
  }
  const pushS = (Math.abs(profile.yEnd - profile.yStart) / profile.feed) * 60;
  const zS = ((zTravel - zPush) * 2 * 60) / 600;
  const travelS = ((bed.x + bed.y) * 60) / 6000;
  return { passes, park, xPositions: xs, zTravel, zPush, estimateS: Math.ceil((pushS + zS + travelS + 2) * xs.length + 5) };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Ejector {
  /** Set by the host; null when the MCP client cannot do vision for us. */
  plateCheck: PlateCheckFn | null = null;

  constructor(
    private scheduler: Scheduler,
    private db: Db,
    private sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  referencePath(printerId: string): string {
    return path.join(DATA_DIR, "reference", `${printerId}.jpg`);
  }
  saveReference(printerId: string, jpeg: Buffer): string {
    const p = this.referencePath(printerId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, jpeg);
    return p;
  }
  loadReference(printerId: string): Buffer | null {
    try {
      return fs.readFileSync(this.referencePath(printerId));
    } catch {
      return null;
    }
  }

  async run(p: Printer, profile: EjectProfile, o: EjectOptions = {}): Promise<EjectResult> {
    const steps: string[] = [];
    const fail = (error: string): EjectResult => ({ ok: false, steps, error, plateCleared: false });
    const s = () => p.state;

    if (!s().online) return fail("printer offline");
    if (!isFree(s().gcodeState)) return fail(`printer is ${s().gcodeState}; sweep only runs when idle or finished`);
    if (this.scheduler.isHeld(p.id)) return fail("a sweep is already running");
    let plan: SweepPlan;
    try {
      plan = planSweep(profile, p.config.model, o);
    } catch (e) {
      return fail((e as Error).message);
    }

    this.scheduler.hold(p.id);
    try {
      // -- cool down
      const warm = () => s().bed.temp > profile.bedMaxC || s().nozzle.temp > profile.nozzleMaxC;
      if (warm()) {
        if (o.coolDown === false)
          return fail(`too hot (bed ${s().bed.temp}°C > ${profile.bedMaxC}, nozzle ${s().nozzle.temp}°C > ${profile.nozzleMaxC})`);
        steps.push("cooling");
        await p.sendGcode("M140 S0\nM104 S0\nM106 S255");
        const t0 = Date.now();
        while (warm()) {
          if (Date.now() - t0 > profile.cooldownTimeoutS * 1000) return fail("cooldown timed out");
          await this.sleep(5000);
        }
        await p.sendGcode("M107");
        steps.push(`cooled to bed ${s().bed.temp}°C, nozzle ${s().nozzle.temp}°C`);
      }

      // -- sweep
      const passMs = Math.ceil(plan.estimateS / plan.passes.length) * 1000;
      for (const [i, lines] of plan.passes.entries()) {
        if (!isFree(s().gcodeState) || !s().online)
          return fail(`aborted before pass ${i + 1}: printer is ${s().online ? s().gcodeState : "offline"}`);
        await p.sendGcode(lines.join("\n"));
        await this.sleep(passMs);
        steps.push(`pass ${i + 1}/${plan.passes.length} at X=${plan.xPositions[i]}`);
      }
      await p.sendGcode(plan.park.join("\n"));
      await this.sleep(3000);
      steps.push(o.rehearsal ? "rehearsal done (nothing touched)" : "sweep done");

      // -- verify
      const snapshot = await p.snapshot().catch(() => undefined);
      let verdict: PlateVerdict | null | undefined;
      let plateCleared = false;
      if (snapshot && !o.rehearsal && this.plateCheck) {
        verdict = await this.plateCheck(snapshot, this.loadReference(p.id)).catch(() => null);
        if (verdict?.empty && verdict.confidence >= 0.9) {
          this.db.setFlag(`plate_clear:${p.id}`, true);
          plateCleared = true;
          steps.push(`verified empty (${verdict.confidence})`);
        } else {
          steps.push(`NOT verified: ${verdict ? `${verdict.reason} (${verdict.confidence})` : "no automatic check available"}`);
        }
      }
      this.db.addEvent({
        printerId: p.id,
        type: "eject",
        at: Date.now(),
        data: { rehearsal: !!o.rehearsal, passes: plan.passes.length, plateCleared, verdict: verdict ?? null },
      });
      return { ok: true, steps, snapshot, verdict, plateCleared };
    } catch (e) {
      return fail((e as Error).message);
    } finally {
      this.scheduler.release(p.id);
    }
  }
}
