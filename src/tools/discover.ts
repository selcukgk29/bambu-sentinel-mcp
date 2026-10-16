import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { discover } from "../discovery.js";
import { safe, text } from "./util.js";

export function registerDiscover(server: McpServer, c: Config): void {
  server.registerTool(
    "discover_printers",
    {
      description:
        "Look for Bambu printers on the local network (SSDP) and list their IP, serial number and model. The LAN access code is not broadcast: read it on the printer (Settings > Network) and pass it to add_printer. Printers must be on the same subnet, in LAN mode or connected to the network.",
      inputSchema: { timeout_sec: z.number().min(1).max(30).default(6) },
    },
    safe(async ({ timeout_sec }) => {
      const found = await discover({ timeoutMs: timeout_sec * 1000 });
      const known = new Set(c.fleet.list().map((p) => p.config.serial));
      return text(
        found.length
          ? {
              printers: found.map((d) => ({ ...d, already_added: known.has(d.serial) })),
              next: "add_printer with host=<ip>, serial=<serial>, model=<model> and the access code from the printer's screen",
            }
          : "no printers answered. Check that this machine and the printer share a subnet, that multicast is not blocked, and that no VPN is capturing traffic; or add the printer manually with its IP.",
      );
    }),
  );
}
