import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWorkshop, deleteWorkshop, updateDevice, updateWorkshop, workshopOf } from "../admin.js";
import type { Config } from "../context.js";
import { safe, text } from "./util.js";

export function registerWorkshops(server: McpServer, c: Config): void {
  server.registerTool(
    "workshop_list",
    { description: "List workshops (groups of machines) and which machines are in each." },
    safe(async () => {
      const ws = c.file.workshops ?? [];
      return text(
        ws.map((w) => ({ ...w, machines: c.fleet.list().filter((p) => workshopOf(c, p.config) === w.id).map((p) => p.id) })),
      );
    }),
  );

  server.registerTool(
    "workshop_create",
    { description: "Create a workshop to group machines.", inputSchema: { name: z.string(), description: z.string().optional() } },
    safe(async (a) => text(createWorkshop(c, a))),
  );

  server.registerTool(
    "workshop_update",
    {
      description: "Rename a workshop or change its description.",
      inputSchema: { workshop_id: z.string(), name: z.string().optional(), description: z.string().optional() },
    },
    safe(async ({ workshop_id, ...patch }) => text(updateWorkshop(c, workshop_id, patch))),
  );

  server.registerTool(
    "workshop_delete",
    {
      description: "Delete a workshop. Its machines move to the first remaining workshop. The last workshop cannot be deleted.",
      inputSchema: { workshop_id: z.string() },
      annotations: { destructiveHint: true },
    },
    safe(async ({ workshop_id }) => text(deleteWorkshop(c, workshop_id))),
  );

  server.registerTool(
    "machine_assign_workshop",
    { description: "Move a machine to another workshop.", inputSchema: { printer_id: z.string(), workshop_id: z.string() } },
    safe(async ({ printer_id, workshop_id }) => text(updateDevice(c, printer_id, { workshop: workshop_id }))),
  );
}
