export interface ShiftDef {
  name: string;
  /** "HH:MM" local time. */
  start: string;
  /** "HH:MM" local time; "24:00" means midnight; an end at or before the start wraps past midnight. */
  end: string;
}

export const DEFAULT_SHIFTS: ShiftDef[] = [
  { name: "Vardiya 1", start: "08:00", end: "16:00" },
  { name: "Vardiya 2", start: "16:00", end: "24:00" },
  { name: "Vardiya 3", start: "00:00", end: "08:00" },
];

export interface ShiftWindow {
  name: string;
  from: number;
  to: number;
}

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`bad time "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Check a shift list; returns a message for the first problem, or null. */
export function validateShifts(shifts: ShiftDef[]): string | null {
  if (!Array.isArray(shifts) || shifts.length === 0) return "en az bir vardiya gerekli";
  for (const s of shifts) {
    if (!s || typeof s.name !== "string" || !s.name.trim()) return "vardiya adı boş olamaz";
    try {
      const a = minutes(s.start);
      const b = minutes(s.end);
      if (a < 0 || a >= 24 * 60 || b < 0 || b > 24 * 60) return `${s.name}: saat 00:00-24:00 arasında olmalı`;
    } catch {
      return `${s.name}: saat HH:MM biçiminde olmalı`;
    }
  }
  return null;
}

/** The shift windows that overlap [from, to], clipped to it, in time order. Uses local time. */
export function shiftWindows(shifts: ShiftDef[], from: number, to: number): ShiftWindow[] {
  const out: ShiftWindow[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1); // an overnight shift that started the day before
  for (let d = new Date(day); d.getTime() < to; d.setDate(d.getDate() + 1)) {
    for (const s of shifts) {
      const a = minutes(s.start);
      let b = minutes(s.end);
      if (b <= a) b += 24 * 60; // wraps past midnight
      const start = new Date(d);
      start.setHours(0, a, 0, 0);
      const end = new Date(d);
      end.setHours(0, b, 0, 0);
      const f = Math.max(start.getTime(), from);
      const t = Math.min(end.getTime(), to);
      if (t > f) out.push({ name: s.name, from: f, to: t });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}
