import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { planSweep } from "../eject.js";
import { fail, safe, text } from "./util.js";

const pid = z.string().optional().describe("Printer id; may be omitted when only one printer is configured");
const image = (buf: Buffer) => ({ type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" });

export function registerEject(server: McpServer, c: Config): void {
  server.registerTool(
    "eject_plate",
    {
      description:
        "Sweep finished parts off the plate with the toolhead (bed slides in Y while the toolhead sits low), then check the plate with the camera. " +
        "Safe workflow: dry_run=true to inspect the G-code, rehearsal=true to run the path 25 mm higher with nothing touched, then confirm=true for the real sweep. " +
        "Waits for the bed to cool first. Only runs when the printer is idle/finished, and aborts if a print starts. " +
        "If the plate is not verified empty automatically, look at the returned image and call confirm_plate_cleared yourself.",
      inputSchema: {
        printer_id: pid,
        confirm: z.boolean().default(false).describe("Required for the real sweep (not for dry_run / rehearsal)"),
        dry_run: z.boolean().default(false).describe("Only return the plan"),
        rehearsal: z.boolean().default(false).describe("Run the path 25 mm above the plate"),
        part_height_mm: z.number().min(0).max(200).optional().describe("Tallest part; travel height stays 10 mm above it"),
        x_positions: z.array(z.number()).optional().describe("Only sweep these X positions"),
        use_layout: z.boolean().optional().describe("Sweep only the strips where the parts were printed (from the 3MF); defaults to the profile setting"),
        job_id: z.number().int().optional().describe("Queue job whose layout to use; default: the last job printed on this printer"),
        cool_down: z.boolean().default(true),
      },
      annotations: { destructiveHint: true },
    },
    safe(async (a) => {
      const p = c.fleet.get(a.printer_id);
      const profile = { ...c.file.settings.eject, ...(a.use_layout !== undefined ? { useLayout: a.use_layout } : {}) };
      let layout = null;
      if (profile.useLayout && !a.x_positions) {
        const jobId = a.job_id ?? c.db.history({ printerId: p.id, limit: 1 })[0]?.job_id ?? null;
        layout = jobId ? c.db.getJob(jobId)?.layout ?? null : null;
        if (!layout?.length) return fail("no plate layout known for that job (queue the 3MF with queue_add, or pass x_positions / use_layout=false)");
      }
      const opts = { partHeightMm: a.part_height_mm, xPositions: a.x_positions, rehearsal: a.rehearsal, coolDown: a.cool_down, layout };
      if (a.dry_run) {
        const plan = planSweep(profile, p.config.model, opts);
        return text({
          passes: plan.passes.length,
          x_positions: plan.xPositions,
          z_push: plan.zPush,
          z_travel: plan.zTravel,
          estimate_seconds: plan.estimateS,
          first_pass: plan.passes[0],
          profile,
        });
      }
      if (!a.rehearsal && !a.confirm) return fail("eject_plate needs confirm=true (or use dry_run / rehearsal first)");
      const res = await c.ejector.run(p, profile, opts);
      const summary = { ok: res.ok, error: res.error, steps: res.steps, plate_cleared: res.plateCleared, verdict: res.verdict ?? null };
      const content: any[] = [{ type: "text", text: JSON.stringify(summary, null, 2) }];
      if (res.snapshot) {
        const ref = c.ejector.loadReference(p.id);
        if (ref) content.push({ type: "text", text: "Known-empty reference:" }, image(ref));
        content.push({ type: "text", text: "Plate after sweep:" }, image(res.snapshot));
        if (!res.plateCleared && res.ok && !a.rehearsal)
          content.push({ type: "text", text: "Not auto-verified. If the plate is empty (no parts, fragments or strings) call confirm_plate_cleared; otherwise do not." });
      }
      return res.ok ? { content } : { isError: true as const, content };
    }),
  );

  server.registerTool(
    "save_empty_plate_reference",
    {
      description: "Store the current camera frame as the known-empty plate. Make sure the plate is really empty first; used to verify sweeps.",
      inputSchema: { printer_id: pid, plate_is_empty: z.boolean().describe("Must be true") },
    },
    safe(async ({ printer_id, plate_is_empty }) => {
      if (!plate_is_empty) return fail("plate_is_empty must be true");
      const p = c.fleet.get(printer_id);
      const file = c.ejector.saveReference(p.id, await p.snapshot());
      return text(`saved ${file}`);
    }),
  );

  server.registerTool(
    "configure_eject",
    {
      description:
        "Tune the sweep profile (bed coordinates, mm). Calibrate yStart/yEnd so parts clear the bed edge into your bin, and sweeperWidth to what actually touches the part (bare nozzle is narrow: many passes). Always rehearse after changing.",
      inputSchema: {
        bed_max_c: z.number().min(15).max(80).optional(),
        nozzle_max_c: z.number().min(15).max(120).optional(),
        z_push: z.number().min(1).max(30).optional(),
        z_travel_min: z.number().min(10).max(200).optional(),
        y_start: z.number().optional(),
        y_end: z.number().optional(),
        x_min: z.number().optional(),
        x_max: z.number().optional(),
        sweeper_width: z.number().min(1).max(100).optional(),
        x_positions: z.array(z.number()).optional().describe("Explicit passes; empty array returns to the generated range"),
        feed_mm_min: z.number().min(300).max(6000).optional(),
        use_layout: z.boolean().optional().describe("Default for sweeping only where parts were printed"),
        layout_margin_mm: z.number().min(0).max(50).optional(),
      },
    },
    safe(async (a) => {
      const prof = { ...c.file.settings.eject }; // edit a copy: nothing is kept unless it validates
      const set = <K extends keyof typeof prof>(k: K, v: (typeof prof)[K] | undefined) => {
        if (v !== undefined) prof[k] = v;
      };
      set("bedMaxC", a.bed_max_c);
      set("nozzleMaxC", a.nozzle_max_c);
      set("zPush", a.z_push);
      set("zTravelMin", a.z_travel_min);
      set("yStart", a.y_start);
      set("yEnd", a.y_end);
      set("xMin", a.x_min);
      set("xMax", a.x_max);
      set("sweeperWidth", a.sweeper_width);
      set("feed", a.feed_mm_min);
      set("useLayout", a.use_layout);
      set("layoutMarginMm", a.layout_margin_mm);
      if (a.x_positions) prof.xPositions = a.x_positions.length ? a.x_positions : undefined;
      for (const p of c.fleet.list()) planSweep(prof, p.config.model); // validate against every printer's bed
      c.file.settings.eject = prof;
      c.save();
      return text(prof);
    }),
  );
}
