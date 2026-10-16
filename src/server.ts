import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./context.js";
import type { PlateVerdict } from "./eject.js";
import type { VisionVerdict } from "./monitor.js";
import { attachNotifier, NOTIFY_CAPABILITIES } from "./notify.js";
import { registerControl } from "./tools/control.js";
import { registerCost } from "./tools/cost.js";
import { registerDiscover } from "./tools/discover.js";
import { registerEject } from "./tools/eject.js";
import { registerHms } from "./tools/hms.js";
import { registerInventory } from "./tools/inventory.js";
import { registerJobs } from "./tools/jobs.js";
import { summary } from "./tools/util.js";
import { registerWatch } from "./tools/watch.js";
import { registerWorkshops } from "./tools/workshops.js";

const parseJson = (t: string): any => {
  const m = /\{[\s\S]*\}/.exec(t);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
};

/** Everything the MCP client sees: tools, resources, prompts, push notifications and the optional vision hooks. */
export function buildServer(ctx: Config): McpServer {
  const server = new McpServer(
    { name: "bambu-sentinel", version: "0.2.0" },
    {
      capabilities: NOTIFY_CAPABILITIES,
      instructions:
        "Controls Bambu Lab printers over LAN. Physical actions: always confirm the build plate is empty before starting, never bypass safety limits. For supervision use inspect_print and judge the camera frame; pause_print on a clear failure.",
    },
  );

  registerControl(server, ctx);
  registerJobs(server, ctx);
  registerWatch(server, ctx);
  registerEject(server, ctx);
  registerHms(server, ctx);
  registerDiscover(server, ctx);
  registerInventory(server, ctx);
  registerCost(server, ctx);
  registerWorkshops(server, ctx);
  attachNotifier(server, ctx.db);

  server.registerResource(
    "fleet",
    "bambu://fleet",
    { description: "Live status of all printers", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx.fleet.list().map((p) => summary(p, ctx)), null, 2) }],
    }),
  );

  server.registerPrompt(
    "supervise_print",
    {
      description: "Watch a running print and react to failures",
      argsSchema: { printer_id: z.string().optional(), every_minutes: z.string().optional() },
    },
    ({ printer_id, every_minutes }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Supervise the current print${printer_id ? ` on ${printer_id}` : ""}. Every ${every_minutes ?? "5"} minutes call inspect_print and judge the image against the earlier frame. If you see spaghetti, a detached part, a failed first layer or a clogged nozzle, call pause_print and tell me why. Also check get_events for HMS errors and alerts. Stop when the print finishes.`,
          },
        },
      ],
    }),
  );

  // Optional vision: borrow the client's model through MCP sampling.
  ctx.monitor.vision = async (jpeg, context): Promise<VisionVerdict | null> => {
    if (!server.server.getClientCapabilities()?.sampling) return null;
    const res = await server.server.createMessage({
      maxTokens: 200,
      systemPrompt:
        'You supervise a 3D print from a camera frame. Reply with JSON only: {"status":"ok|suspect|failure","confidence":0-1,"reason":"..."}. failure = spaghetti, part detached, nozzle blob, failed first layer.',
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `Print context: ${context}` },
          ],
        } as any,
      ],
    });
    const v = parseJson(res.content.type === "text" ? res.content.text : "");
    return v && ["ok", "suspect", "failure"].includes(v.status)
      ? { status: v.status, confidence: Number(v.confidence) || 0, reason: String(v.reason ?? "") }
      : null;
  };

  // Optional plate verification through the client's model (MCP sampling).
  ctx.ejector.plateCheck = async (jpeg, reference): Promise<PlateVerdict | null> => {
    if (!server.server.getClientCapabilities()?.sampling) return null;
    const content: any[] = [];
    if (reference)
      content.push({ type: "text", text: "Reference: the same plate known to be EMPTY." }, { type: "image", data: reference.toString("base64"), mimeType: "image/jpeg" });
    content.push({ type: "text", text: "Current frame after the sweep:" }, { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    const res = await server.server.createMessage({
      maxTokens: 200,
      systemPrompt:
        'You check a 3D printer build plate after parts were pushed off. Reply with JSON only: {"empty":true|false,"confidence":0-1,"reason":"..."}. empty=true only if NO part, fragment, brim or stringing remains. If unsure, empty=false.',
      messages: [{ role: "user", content } as any],
    });
    const v = parseJson(res.content.type === "text" ? res.content.text : "");
    return v && typeof v.empty === "boolean" ? { empty: v.empty, confidence: Number(v.confidence) || 0, reason: String(v.reason ?? "") } : null;
  };

  return server;
}
