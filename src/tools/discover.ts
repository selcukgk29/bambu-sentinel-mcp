import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { discover } from "../discovery.js";
import { scanNetwork } from "../scan.js";
import { safe, text } from "./util.js";

export function registerDiscover(server: McpServer, c: Config): void {
  server.registerTool(
    "discover_printers",
    {
      description:
        "Find Bambu printers on the local network. First listens for their SSDP announcements (IP, serial, model); if that finds nothing, or when scan='always', it probes every address of the local subnet on the MQTT/TLS port (8883) and reads the printer's certificate. " +
        "The LAN access code is never broadcast: read it on the printer (Settings > Network) and pass it to add_printer. Only private ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x) are scanned.",
      inputSchema: {
        timeout_sec: z.number().min(1).max(30).default(6).describe("How long to listen for SSDP announcements"),
        scan: z.enum(["auto", "always", "never"]).default("auto").describe("auto: scan the subnet only when SSDP found nothing"),
        subnet: z.string().optional().describe("CIDR to scan instead of this machine's own subnets, e.g. 192.168.1.0/24 (max 1024 addresses)"),
      },
    },
    safe(async ({ timeout_sec, scan, subnet }) => {
      const known = new Set(c.fleet.list().map((p) => p.config.serial));
      const knownHosts = new Set(c.fleet.list().map((p) => p.config.host));
      const printers: Record<string, unknown>[] = [];
      const seen = new Set<string>();

      // With scan='always' SSDP gets a short window; the subnet scan is the main act.
      const ssdp = await discover({ timeoutMs: (scan === "always" ? Math.min(timeout_sec, 3) : timeout_sec) * 1000 });
      for (const d of ssdp) {
        seen.add(d.ip);
        printers.push({ ...d, source: "ssdp", already_added: known.has(d.serial) });
      }

      let scanned: { ranges: string[]; candidates: number } | undefined;
      if (scan === "always" || (scan === "auto" && printers.length === 0)) {
        const { ranges, hits } = await scanNetwork(subnet ? [subnet] : undefined);
        scanned = { ranges, candidates: hits.length };
        for (const h of hits) {
          if (seen.has(h.ip)) continue;
          printers.push({
            ip: h.ip,
            serial: h.serial,
            source: "subnet scan",
            looks_like_bambu: h.bambu,
            certificate: { common_name: h.commonName, issuer: h.issuer },
            already_added: (h.serial !== null && known.has(h.serial)) || knownHosts.has(h.ip),
          });
        }
      }

      const out: Record<string, unknown> = { printers };
      if (scanned) out.scanned = scanned;
      out.next = printers.length
        ? "add_printer with host=<ip>, serial=<serial> and the access code from the printer's screen. For scan results, model is not known: pass it yourself, and check 'looks_like_bambu' / the certificate before trusting an entry."
        : "nothing found. Check that this machine and the printer are on the same network (not a guest/VLAN), that the printer is on Wi-Fi with LAN mode, or pass subnet='192.168.x.0/24' explicitly; otherwise add the printer manually with its IP.";
      return text(out);
    }),
  );
}
