import type { UsageEntry } from "./inventory.js";

export interface CostSettings {
  currency: string;
  /** Price of one kWh. */
  electricityPerKwh: number;
  /** Average power draw while printing, watts (an A1 averages roughly 90-120 W; measure with a smart plug for accuracy). */
  printingWatts: number;
  /** Printer purchase price / expected life in print hours, plus maintenance and consumables. */
  machineWearPerHour: number;
  /** Handling cost per print (plate clearing, labour). */
  perPrint: number;
  /** Filament price per kg by type (upper case); `default` is used for unlisted types. A spool's own price wins. */
  filamentPricePerKg: Record<string, number>;
}

export const DEFAULT_COST: CostSettings = {
  currency: "USD",
  electricityPerKwh: 0.15,
  printingWatts: 95,
  machineWearPerHour: 0.15,
  perPrint: 0,
  filamentPricePerKg: { PLA: 20, PETG: 22, ABS: 22, ASA: 25, TPU: 35, default: 25 },
};

/**
 * Settings with defaults filled in. The filament table is taken as a whole: a type removed from it falls
 * back to `default`, it does not come back from the built-in table. Only a missing table uses the built-in one.
 */
export function resolveCost(settings?: Partial<CostSettings>): CostSettings {
  const table = settings?.filamentPricePerKg ?? DEFAULT_COST.filamentPricePerKg;
  return { ...DEFAULT_COST, ...settings, filamentPricePerKg: { default: DEFAULT_COST.filamentPricePerKg.default!, ...table } };
}

export interface CostBreakdown {
  currency: string;
  grams: number;
  filament: number;
  electricity: number;
  wear: number;
  perPrint: number;
  total: number;
  energyKwh: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function priceFor(s: CostSettings, type: string): number {
  return s.filamentPricePerKg[type.toUpperCase()] ?? s.filamentPricePerKg.default ?? 0;
}

/**
 * Cost of one print (or of the part of it that ran). `priceOf` returns a registered spool's own
 * price per kg, which beats the per-type table.
 */
export function computeCost(
  settings: Partial<CostSettings> | undefined,
  input: { durationSec: number; entries: UsageEntry[]; priceOf?: (spoolId: number) => number | null },
): CostBreakdown {
  const s = resolveCost(settings);
  const hours = Math.max(0, input.durationSec) / 3600;
  let filament = 0;
  let grams = 0;
  for (const e of input.entries) {
    const own = e.spoolId != null ? input.priceOf?.(e.spoolId) ?? null : null;
    filament += (e.grams / 1000) * (own ?? priceFor(s, e.type));
    grams += e.grams;
  }
  const energyKwh = (hours * s.printingWatts) / 1000;
  const electricity = energyKwh * s.electricityPerKwh;
  const wear = hours * s.machineWearPerHour;
  return {
    currency: s.currency,
    grams: r2(grams),
    filament: r2(filament),
    electricity: r2(electricity),
    wear: r2(wear),
    perPrint: r2(s.perPrint),
    total: r2(filament + electricity + wear + s.perPrint),
    energyKwh: Math.round(energyKwh * 1000) / 1000,
  };
}

export interface HistoryCostRow {
  printer_id: string;
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
  grams: number | null;
  energy_kwh: number | null;
  cost: number | null;
  parts?: number | null;
}

export interface CostReport {
  currency: string;
  prints: number;
  finished: number;
  failed: number;
  cancelled: number;
  success_rate: number | null;
  /** Good parts produced (objects on finished plates). */
  parts: number;
  total_cost: number;
  /** Money spent on prints that did not finish. */
  wasted_cost: number;
  grams: number;
  energy_kwh: number;
  print_hours: number;
  avg_cost_per_finished: number | null;
  /** What a good print really costs once failures are spread over the successes. */
  avg_cost_per_good_print_incl_waste: number | null;
  /** Average cost of one good part (finished plates only; waste excluded). */
  avg_cost_per_part: number | null;
  /** Same, with the money lost on failed or cancelled prints spread over the good parts. */
  avg_cost_per_part_incl_waste: number | null;
  by_printer: Record<string, { prints: number; cost: number; wasted: number }>;
}

/** Aggregate closed history rows. Rows without a recorded cost count as zero. */
export function costReport(rows: HistoryCostRow[], currency: string): CostReport {
  const closed = rows.filter((r) => r.ended_at && r.outcome && r.outcome !== "unknown");
  const by: CostReport["by_printer"] = {};
  let total = 0;
  let wasted = 0;
  let grams = 0;
  let kwh = 0;
  let parts = 0;
  let ms = 0;
  const count = { finished: 0, failed: 0, cancelled: 0 };
  for (const r of closed) {
    const cost = r.cost ?? 0;
    total += cost;
    grams += r.grams ?? 0;
    kwh += r.energy_kwh ?? 0;
    parts += r.parts ?? 0;
    ms += (r.ended_at ?? r.started_at) - r.started_at;
    const key = r.outcome as keyof typeof count;
    if (key in count) count[key]++;
    const p = (by[r.printer_id] ??= { prints: 0, cost: 0, wasted: 0 });
    p.prints++;
    p.cost += cost;
    if (r.outcome !== "finished") {
      wasted += cost;
      p.wasted += cost;
    }
  }
  for (const p of Object.values(by)) {
    p.cost = r2(p.cost);
    p.wasted = r2(p.wasted);
  }
  const finished = count.finished;
  const judged = count.finished + count.failed; // a cancel is the operator's choice, not a failure
  return {
    currency,
    prints: closed.length,
    ...count,
    success_rate: judged ? Math.round((finished / judged) * 100) / 100 : null,
    parts,
    total_cost: r2(total),
    wasted_cost: r2(wasted),
    grams: r2(grams),
    energy_kwh: Math.round(kwh * 1000) / 1000,
    print_hours: Math.round((ms / 3_600_000) * 100) / 100,
    avg_cost_per_finished: finished ? r2((total - wasted) / finished) : null,
    avg_cost_per_good_print_incl_waste: finished ? r2(total / finished) : null,
    avg_cost_per_part: parts ? r2((total - wasted) / parts) : null,
    avg_cost_per_part_incl_waste: parts ? r2(total / parts) : null,
    by_printer: by,
  };
}
