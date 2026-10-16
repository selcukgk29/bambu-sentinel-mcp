import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { computeCost, costReport, DEFAULT_COST } from "../cost.js";
import { planUsage, type UsageEntry } from "../inventory.js";
import { readJobInfo } from "../threemf.js";
import { fail, safe, text } from "./util.js";

export function registerCost(server: McpServer, c: Config): void {
  const costSettings = () => ({ ...DEFAULT_COST, ...c.file.settings.cost });
  const priceOf = (id: number) => c.db.getSpool(id)?.pricePerKg ?? null;

  server.registerTool(
    "estimate_cost",
    {
      description:
        "What will this sliced file cost to print? Filament (spool price when a spool is loaded in the matching slot, else the per-type price), electricity from the print time and the configured power draw, machine wear, and the expected cost per GOOD part given the historical failure rate.",
      inputSchema: {
        file_path: z.string(),
        plate: z.number().int().min(1).default(1),
        printer_id: z.string().optional().describe("Use this printer's loaded spools for pricing"),
        quantity: z.number().int().min(1).default(1),
      },
    },
    safe(async ({ file_path, plate, printer_id, quantity }) => {
      const info = readJobInfo(file_path, plate);
      if (info.estimateSec == null && !info.filaments.some((f) => f.usedG))
        return fail("this file has no slicer print-time/weight data (needs a sliced .3mf)");
      const settings = costSettings();

      // Price against a real printer's spools when we can map filaments to slots.
      let entries: UsageEntry[] = info.filaments.filter((f) => f.usedG).map((f) => ({ type: f.type, grams: f.usedG!, spoolId: null }));
      const printer = printer_id ? c.fleet.get(printer_id) : c.fleet.list().length === 1 ? c.fleet.list()[0]! : null;
      if (printer) {
        const fit = c.scheduler.fitsFilaments(info.filaments, printer);
        if (fit.ok) entries = planUsage(c.db, printer.id, info.filaments, fit.match.amsMapping);
      }
      const one = computeCost(settings, { durationSec: info.estimateSec ?? 0, entries, priceOf });

      const rows = c.db.historyBetween(0);
      const judged = rows.filter((r) => r.outcome === "finished" || r.outcome === "failed");
      const rate = judged.length >= 5 ? judged.filter((r) => r.outcome === "finished").length / judged.length : null;
      // One plate usually holds several parts. Equal split is exact for identical parts; the per-object split by footprint is an approximation.
      const parts = info.objects.length;
      const n = Math.max(1, parts);
      const area = (b: [number, number, number, number]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      const totalArea = info.objects.reduce((a, o) => a + area(o.bbox), 0);
      return text({
        currency: one.currency,
        per_print: one,
        parts_on_plate: parts || "unknown (the file lists no objects); counted as 1",
        cost_per_part: Math.round((one.total / n) * 100) / 100,
        ...(parts > 1 && totalArea > 0
          ? {
              cost_per_part_by_footprint: info.objects.map((o) => ({
                part: o.name,
                share: Math.round((area(o.bbox) / totalArea) * 1000) / 1000,
                cost: Math.round(one.total * (area(o.bbox) / totalArea) * 100) / 100,
              })),
              note: "cost_per_part splits the plate equally; cost_per_part_by_footprint weights by each part's footprint (approximate: it ignores height)",
            }
          : {}),
        quantity,
        total_for_quantity: Math.round(one.total * quantity * 100) / 100,
        print_minutes: info.estimateSec == null ? null : Math.round(info.estimateSec / 60),
        success_rate: rate === null ? "not enough history (needs 5+ finished/failed prints)" : Math.round(rate * 100) / 100,
        expected_cost_per_good_part: rate ? Math.round((one.total / rate / n) * 100) / 100 : null, // per good part, failures spread over the parts
        priced_with: entries.map((e) => (e.spoolId != null && priceOf(e.spoolId) != null ? `spool #${e.spoolId}` : `${e.type} table price`)),
      });
    }),
  );

  server.registerTool(
    "cost_report",
    {
      description:
        "Spending over a period from the print history: total cost, money wasted on failed/cancelled prints, grams, energy, average cost per finished print (with and without waste), per printer.",
      inputSchema: { since_days: z.number().min(0.01).max(3650).default(30), printer_id: z.string().optional() },
    },
    safe(async ({ since_days, printer_id }) => {
      const rows = c.db.historyBetween(Date.now() - since_days * 86_400_000, printer_id);
      return text({ period_days: since_days, ...costReport(rows, costSettings().currency) });
    }),
  );

  server.registerTool(
    "configure_cost",
    {
      description:
        "Set the cost model. Electricity price, printer power draw, machine wear per print hour (price / life hours + upkeep), per-print handling cost, and filament prices per kg by type. Costs are computed when a print ends, with the values in force then.",
      inputSchema: {
        currency: z.string().min(1).max(8).optional(),
        electricity_per_kwh: z.number().min(0).optional(),
        printing_watts: z.number().min(1).max(3000).optional(),
        machine_wear_per_hour: z.number().min(0).optional(),
        per_print: z.number().min(0).optional(),
        filament_price_per_kg: z.record(z.string(), z.number().min(0)).optional().describe('e.g. {"PLA": 18, "PETG": 21, "default": 25}'),
      },
    },
    safe(async (a) => {
      const s = (c.file.settings.cost = costSettings());
      if (a.currency !== undefined) s.currency = a.currency;
      if (a.electricity_per_kwh !== undefined) s.electricityPerKwh = a.electricity_per_kwh;
      if (a.printing_watts !== undefined) s.printingWatts = a.printing_watts;
      if (a.machine_wear_per_hour !== undefined) s.machineWearPerHour = a.machine_wear_per_hour;
      if (a.per_print !== undefined) s.perPrint = a.per_print;
      if (a.filament_price_per_kg)
        for (const [k, v] of Object.entries(a.filament_price_per_kg)) s.filamentPricePerKg[k.toUpperCase() === "DEFAULT" ? "default" : k.toUpperCase()] = v;
      c.save();
      return text(s);
    }),
  );
}
