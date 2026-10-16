import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { checkGcode, checkTemperature } from "../safety.js";
import { addDevice, removeDevice } from "../admin.js";
import { ackNote, fail, safe, summary, text } from "./util.js";

const pid = z.string().optional().describe("Printer id; may be omitted when only one printer is configured");

export function registerControl(server: McpServer, c: Config): void {
  server.registerTool(
    "fleet_overview",
    { description: "One-line status for every configured printer (state, progress, temps, plate-cleared flag)." },
    safe(async () => text(c.fleet.list().map((p) => summary(p, c)))),
  );

  server.registerTool(
    "printer_status",
    {
      description: "Full live state of one printer: temps, fans, layer, HMS errors, AMS trays.",
      inputSchema: { printer_id: pid },
    },
    safe(async ({ printer_id }) => text(c.fleet.get(printer_id).state)),
  );

  server.registerTool(
    "add_printer",
    {
      description:
        "Register a printer (LAN mode). Needs the printer IP, serial number and LAN access code (printer screen > Network). Saved to ~/.bambu-sentinel/config.json.",
      inputSchema: {
        id: z.string().regex(/^[a-z0-9_-]+$/i).describe("Short unique id, e.g. 'a1'"),
        host: z.string(),
        serial: z.string(),
        access_code: z.string(),
        model: z.string().default("A1").describe("A1, A1 Mini, P1S, P1P, X1C, H2D..."),
        name: z.string().optional(),
        workshop_id: z.string().optional().describe("Workshop to place it in (see workshop_list); default: the first workshop"),
      },
    },
    safe(async (a) => {
      const dev = addDevice(c, { id: a.id, name: a.name, workshop: a.workshop_id, host: a.host, serial: a.serial, accessCode: a.access_code, model: a.model });
      return text(`added ${dev.id} to workshop ${dev.workshop}; connecting (check fleet_overview in a few seconds)`);
    }),
  );

  server.registerTool(
    "remove_printer",
    {
      description: "Forget a printer (history is kept). Refused while it is printing unless force=true.",
      inputSchema: { printer_id: z.string(), force: z.boolean().default(false) },
    },
    safe(async ({ printer_id, force }) => {
      removeDevice(c, printer_id, force);
      return text(`removed ${printer_id}`);
    }),
  );

  server.registerTool(
    "pause_print",
    { description: "Pause the running print.", inputSchema: { printer_id: pid } },
    safe(async ({ printer_id }) => {
      const p = c.fleet.get(printer_id);
      return text(`pause ${ackNote(await p.pause())} (${p.id})`);
    }),
  );

  server.registerTool(
    "resume_print",
    { description: "Resume a paused print.", inputSchema: { printer_id: pid } },
    safe(async ({ printer_id }) => {
      const p = c.fleet.get(printer_id);
      return text(`resume ${ackNote(await p.resume())} (${p.id})`);
    }),
  );

  server.registerTool(
    "stop_print",
    {
      description: "Cancel the current print. Irreversible: the part is lost. Requires confirm=true.",
      inputSchema: { printer_id: pid, confirm: z.boolean().describe("Must be true") },
      annotations: { destructiveHint: true },
    },
    safe(async ({ printer_id, confirm }) => {
      if (!confirm) return fail("stop_print needs confirm=true");
      const p = c.fleet.get(printer_id);
      c.monitor.markCancelled(p.id);
      return text(`stop ${ackNote(await p.stop())} (${p.id})`);
    }),
  );

  server.registerTool(
    "set_speed",
    {
      description: "Print speed profile: 1 silent, 2 standard, 3 sport, 4 ludicrous.",
      inputSchema: { printer_id: pid, level: z.number().int().min(1).max(4) },
    },
    safe(async ({ printer_id, level }) => {
      return text(`speed level ${level}: ${ackNote(await c.fleet.get(printer_id).setSpeed(level as 1 | 2 | 3 | 4))}`);
    }),
  );

  server.registerTool(
    "set_light",
    { description: "Turn the work light on or off.", inputSchema: { printer_id: pid, on: z.boolean() } },
    safe(async ({ printer_id, on }) => {
      return text(`light ${on ? "on" : "off"}: ${ackNote(await c.fleet.get(printer_id).setLight(on))}`);
    }),
  );

  server.registerTool(
    "set_temperature",
    {
      description: "Set nozzle or bed target temperature (model limits enforced; 0 turns the heater off).",
      inputSchema: { printer_id: pid, target: z.enum(["nozzle", "bed"]), celsius: z.number() },
    },
    safe(async ({ printer_id, target, celsius }) => {
      const p = c.fleet.get(printer_id);
      const bad = checkTemperature(target, celsius, p.config.model);
      if (bad) return fail(bad);
      const ack = await p.sendGcode(`${target === "nozzle" ? "M104" : "M140"} S${Math.round(celsius)}`);
      return text(`${target} target ${Math.round(celsius)}°C: ${ackNote(ack)}`);
    }),
  );

  server.registerTool(
    "send_gcode",
    {
      description:
        "Send up to 20 lines of G-code. Only a safe allowlist is accepted (moves, homing, temps within model limits, fans, speed/flow). Not allowed during a print unless it is a temp/fan/speed command.",
      inputSchema: { printer_id: pid, gcode: z.string() },
    },
    safe(async ({ printer_id, gcode }) => {
      const p = c.fleet.get(printer_id);
      const chk = checkGcode(gcode, p.config.model);
      if (!chk.ok) return fail(`rejected: ${chk.reason}`);
      const printing = p.state.gcodeState === "RUNNING" || p.state.gcodeState === "PAUSE";
      const motion = chk.lines.some((l) => /^(G0|G1|G28|G92|M84|M17|M18)\b/i.test(l));
      if (printing && motion) return fail("motion G-code is blocked while a print is active");
      const ack = await p.sendGcode(chk.lines.join("\n"));
      return text(`${chk.lines.length} line(s): ${ackNote(ack)}`);
    }),
  );
}
