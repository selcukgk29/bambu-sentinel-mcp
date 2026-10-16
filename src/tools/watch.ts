import * as fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { fail, safe, text } from "./util.js";

const pid = z.string().optional().describe("Printer id; may be omitted when only one printer is configured");

const image = (buf: Buffer) => ({ type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" });

const INSPECT_GUIDE = `Judge the print from the image(s). Look for: spaghetti / detached filament strands, part knocked off the plate, first layer not sticking (curling, missing lines), nozzle clogged with blobs, layer shifts, warped corners lifting, stringing mess. Reply with a verdict (ok / suspect / failure), confidence 0-1 and the visible evidence. If it is a clear failure and the user asked for supervision, call pause_print.`;

export function registerWatch(server: McpServer, c: Config): void {
  server.registerTool(
    "get_snapshot",
    { description: "Capture a live camera frame from the printer.", inputSchema: { printer_id: pid } },
    safe(async ({ printer_id }) => {
      const p = c.fleet.get(printer_id);
      const jpeg = await p.snapshot();
      c.monitor.saveSnapshot(p.id, jpeg);
      return { content: [image(jpeg)] };
    }),
  );

  server.registerTool(
    "inspect_print",
    {
      description:
        "Supervision check: live camera frame (plus an older frame for comparison when available), key telemetry, telemetry anomalies and recent events, with guidance for judging whether the print is failing.",
      inputSchema: { printer_id: pid },
    },
    safe(async ({ printer_id }) => {
      const p = c.fleet.get(printer_id);
      const s = p.state;
      const older = c.monitor.recentSnapshots(p.id, 6)[0];
      const jpeg = await p.snapshot();
      c.monitor.saveSnapshot(p.id, jpeg);
      // Fresh detector so the report does not depend on the watch loop's cooldowns.
      const anomalies = new (await import("../anomaly.js")).AnomalyDetector(p.config.model).check(s, Date.now());
      const events = c.db.recentEvents({ printerId: p.id, since: Date.now() - 30 * 60_000, limit: 10 });
      const report = {
        printer: p.id,
        state: s.gcodeState,
        job: s.jobName,
        progress: `${s.progress}% layer ${s.layer}/${s.totalLayers}, ${s.remainingMin} min left`,
        nozzle: `${s.nozzle.temp}/${s.nozzle.target}`,
        bed: `${s.bed.temp}/${s.bed.target}`,
        fans: s.fans,
        hms: s.hms,
        anomalies,
        recent_events: events,
        note: "Anomalies here are single-sample; drift/stall detection runs continuously in the background and appears in get_events.",
      };
      const content: any[] = [{ type: "text", text: JSON.stringify(report, null, 2) }, image(jpeg)];
      if (older) {
        content.push({ type: "text", text: "Earlier frame for comparison:" }, image(fs.readFileSync(older)));
      }
      content.push({ type: "text", text: INSPECT_GUIDE });
      return { content };
    }),
  );

  server.registerTool(
    "get_events",
    {
      description: "Recent printer events: print started/finished/failed, pauses, HMS errors, anomaly alerts, auto-pauses.",
      inputSchema: {
        printer_id: z.string().optional(),
        since_minutes: z.number().default(120),
        types: z.array(z.string()).optional(),
        limit: z.number().int().default(50),
      },
    },
    safe(async (a) =>
      text(
        c.db
          .recentEvents({ printerId: a.printer_id, since: Date.now() - a.since_minutes * 60_000, types: a.types, limit: a.limit })
          .map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
      ),
    ),
  );

  server.registerTool(
    "get_history",
    { description: "Print history with outcomes and a success summary.", inputSchema: { printer_id: z.string().optional(), limit: z.number().int().default(20) } },
    safe(async ({ printer_id, limit }) => {
      const rows = c.db.history({ printerId: printer_id, limit });
      const done = rows.filter((r) => r.outcome);
      const ok = done.filter((r) => r.outcome === "finished").length;
      return text({
        summary: { total: done.length, finished: ok, success_rate: done.length ? +(ok / done.length).toFixed(2) : null },
        prints: rows.map((r) => ({
          printer: r.printer_id,
          name: r.name,
          started: new Date(r.started_at).toISOString(),
          minutes: r.ended_at ? Math.round((r.ended_at - r.started_at) / 60_000) : null,
          outcome: r.outcome ?? "in progress",
          grams: r.grams,
          parts: r.parts,
          cost: r.cost,
          cost_per_part: r.parts && r.cost != null ? Math.round((r.cost / r.parts) * 100) / 100 : null,
          energy_kwh: r.energy_kwh,
          reason: r.reason,
          error_code: r.error_code,
          job_id: r.job_id,
        })),
      });
    }),
  );

  server.registerTool(
    "configure_watch",
    {
      description:
        "Configure background supervision. auto_pause: pause on critical anomalies (overtemp, confident vision failure). vision_sampling: ask the client's model to judge each periodic snapshot (needs a client that supports MCP sampling). auto_dispatch: start queued jobs automatically on free, plate-cleared printers.",
      inputSchema: {
        auto_pause: z.boolean().optional(),
        vision_sampling: z.boolean().optional(),
        watch_interval_sec: z.number().int().min(15).max(600).optional(),
        auto_dispatch: z.boolean().optional(),
        auto_eject: z.boolean().optional().describe("Sweep the plate after every successful print (see eject_plate)"),
      },
    },
    safe(async (a) => {
      const s = c.file.settings;
      if (a.auto_pause !== undefined) s.autoPause = a.auto_pause;
      if (a.vision_sampling !== undefined) {
        if (a.vision_sampling && !c.monitor.vision) return fail("this client does not support MCP sampling; use inspect_print manually");
        s.visionSampling = a.vision_sampling;
      }
      if (a.auto_dispatch !== undefined) s.autoDispatch = a.auto_dispatch;
      if (a.auto_eject !== undefined) s.autoEject = a.auto_eject;
      if (a.watch_interval_sec !== undefined) {
        s.watchIntervalSec = a.watch_interval_sec;
        c.monitor.restart();
      }
      c.save();
      return text(s);
    }),
  );
}
