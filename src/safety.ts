/** Hard limits and G-code screening. Everything that reaches the printer goes through here. */

export interface ModelLimits {
  nozzleMax: number;
  bedMax: number;
}

const LIMITS: Record<string, ModelLimits> = {
  A1: { nozzleMax: 300, bedMax: 100 },
  "A1 MINI": { nozzleMax: 300, bedMax: 80 },
  P1S: { nozzleMax: 300, bedMax: 100 },
  P1P: { nozzleMax: 300, bedMax: 100 },
};
const DEFAULT_LIMITS: ModelLimits = { nozzleMax: 280, bedMax: 90 };

/** Printable bed size in mm (X, Y). */
export function bedSize(model: string): { x: number; y: number } {
  return model.toUpperCase().trim() === "A1 MINI" ? { x: 180, y: 180 } : { x: 256, y: 256 };
}

export const limitsFor = (model: string): ModelLimits =>
  LIMITS[model.toUpperCase().trim()] ?? DEFAULT_LIMITS;

/** Commands that are safe to send. Anything else is rejected. */
const ALLOWED = new Set([
  "G0", "G1", "G4", "G28", "G90", "G91", "G92",
  "M82", "M83", "M84", "M104", "M106", "M107", "M109", "M140", "M190",
  "M220", "M221", "M300", "M400", "M17", "M18",
]);

export interface GcodeCheck {
  ok: boolean;
  reason?: string;
  lines: string[];
}

export function checkGcode(gcode: string, model: string): GcodeCheck {
  const limits = limitsFor(model);
  const lines = gcode
    .split(/\r?\n/)
    .map((l) => l.replace(/;.*$/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: "empty G-code", lines };
  if (lines.length > 20) return { ok: false, reason: "too many lines (max 20 per call)", lines };

  for (const line of lines) {
    const code = line.split(/\s+/)[0]!.toUpperCase();
    if (!ALLOWED.has(code)) return { ok: false, reason: `command not allowed: ${code}`, lines };
    const s = /\bS(-?\d+(?:\.\d+)?)/i.exec(line);
    const temp = s ? parseFloat(s[1]!) : undefined;
    if ((code === "M104" || code === "M109") && temp !== undefined && (temp < 0 || temp > limits.nozzleMax))
      return { ok: false, reason: `nozzle temp ${temp} outside 0-${limits.nozzleMax}`, lines };
    if ((code === "M140" || code === "M190") && temp !== undefined && (temp < 0 || temp > limits.bedMax))
      return { ok: false, reason: `bed temp ${temp} outside 0-${limits.bedMax}`, lines };
    if (code === "M106" || code === "M221" || code === "M220") {
      if (temp !== undefined && (temp < 0 || temp > (code === "M106" ? 255 : 300)))
        return { ok: false, reason: `${code} value ${temp} out of range`, lines };
    }
  }
  return { ok: true, lines };
}

export function checkTemperature(
  target: "nozzle" | "bed",
  value: number,
  model: string,
): string | null {
  const l = limitsFor(model);
  const max = target === "nozzle" ? l.nozzleMax : l.bedMax;
  if (!Number.isFinite(value) || value < 0 || value > max) return `${target} temp must be 0-${max}`;
  return null;
}
