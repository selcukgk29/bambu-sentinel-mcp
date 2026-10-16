import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { needGrams } from "../inventory.js";
import { readJobInfo } from "../threemf.js";
import { fail, safe, text } from "./util.js";

const slotDoc = "AMS slot 0-3 (unit 1), 4-7 (unit 2)... or 254 for the external spool";

export function registerInventory(server: McpServer, c: Config): void {
  server.registerTool(
    "spool_add",
    {
      description:
        "Register a filament spool with its weight so the scheduler can check a job fits and subtract usage after each print. Optionally load it into a printer slot right away.",
      inputSchema: {
        type: z.string().describe("PLA, PETG, ABS, TPU..."),
        name: z.string().optional().describe("Label, e.g. 'Bambu PLA red'"),
        color: z.string().optional().describe("RRGGBB"),
        brand: z.string().optional(),
        weight_g: z.number().positive().describe("Filament weight when full (e.g. 1000)"),
        remaining_g: z.number().min(0).optional().describe("Defaults to weight_g"),
        price_per_kg: z.number().min(0).optional().describe("Used for cost calculation"),
        printer_id: z.string().optional(),
        slot: z.number().int().optional().describe(slotDoc),
      },
    },
    safe(async (a) => {
      if ((a.printer_id === undefined) !== (a.slot === undefined)) return fail("give both printer_id and slot, or neither");
      if (a.printer_id) c.fleet.get(a.printer_id);
      const spool = c.db.addSpool({
        name: a.name ?? `${a.brand ? a.brand + " " : ""}${a.type}${a.color ? " #" + a.color : ""}`,
        type: a.type,
        color: a.color?.replace("#", "").toUpperCase() ?? null,
        brand: a.brand ?? null,
        initialG: a.weight_g,
        remainingG: a.remaining_g ?? a.weight_g,
        pricePerKg: a.price_per_kg ?? null,
      });
      if (a.printer_id) c.db.assignSpool(spool.id, a.printer_id, a.slot!);
      return text(c.db.getSpool(spool.id));
    }),
  );

  server.registerTool(
    "spool_list",
    {
      description: "List spools with remaining grams and where each is loaded; flags the ones that are low.",
      inputSchema: { include_archived: z.boolean().default(false) },
    },
    safe(async ({ include_archived }) =>
      text(
        c.db.listSpools(include_archived).map((s) => ({
          ...s,
          loaded_in: s.printerId ? `${s.printerId} slot ${s.slot}` : null,
          low: s.remainingG != null && s.remainingG < 100,
        })),
      ),
    ),
  );

  server.registerTool(
    "spool_update",
    {
      description: "Correct a spool (e.g. after weighing it), change its price, or archive it when empty.",
      inputSchema: {
        spool_id: z.number().int(),
        remaining_g: z.number().min(0).optional(),
        price_per_kg: z.number().min(0).optional(),
        name: z.string().optional(),
        archived: z.boolean().optional(),
      },
    },
    safe(async ({ spool_id, ...patch }) => {
      if (!c.db.getSpool(spool_id)) return fail(`no spool ${spool_id}`);
      c.db.updateSpool(spool_id, patch);
      return text(c.db.getSpool(spool_id));
    }),
  );

  server.registerTool(
    "spool_assign",
    {
      description: "Say which spool is loaded in which printer slot (or unload it with clear=true). Do this whenever you change spools.",
      inputSchema: {
        spool_id: z.number().int(),
        printer_id: z.string().optional(),
        slot: z.number().int().optional().describe(slotDoc),
        clear: z.boolean().default(false),
      },
    },
    safe(async ({ spool_id, printer_id, slot, clear }) => {
      if (!c.db.getSpool(spool_id)) return fail(`no spool ${spool_id}`);
      if (clear) c.db.assignSpool(spool_id, null, null);
      else {
        if (!printer_id || slot === undefined) return fail("printer_id and slot are required unless clear=true");
        c.fleet.get(printer_id);
        c.db.assignSpool(spool_id, printer_id, slot);
      }
      return text(c.db.getSpool(spool_id));
    }),
  );

  server.registerTool(
    "check_filament",
    {
      description:
        "Before queueing: will this sliced file fit on each printer? Checks that matching filament is loaded AND that the spools in those slots hold enough grams.",
      inputSchema: { file_path: z.string(), plate: z.number().int().min(1).default(1) },
    },
    safe(async ({ file_path, plate }) => {
      const info = readJobInfo(file_path, plate);
      const need = info.filaments.map((f) => ({ type: f.type, color: f.color, needs_g: f.usedG ? Math.ceil(needGrams(f.usedG)) : null }));
      const printers = c.fleet.list().map((p) => {
        const fit = c.scheduler.fitsFilaments(info.filaments, p);
        return { printer: p.id, fits: fit.ok, ...(fit.ok ? { ams_mapping: fit.match.amsMapping } : { why: fit.reason }) };
      });
      return text({ needs: need, printers });
    }),
  );
}
