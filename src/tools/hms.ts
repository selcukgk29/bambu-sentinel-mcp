import * as fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { describeHms, describeKey, importDictionary } from "../hms.js";
import { fail, safe, text } from "./util.js";

export function registerHms(server: McpServer, c: Config): void {
  server.registerTool(
    "hms_active",
    {
      description: "Currently active HMS errors on a printer, decoded (text, severity, whether a reprint is advisable).",
      inputSchema: { printer_id: z.string().optional() },
    },
    safe(async ({ printer_id }) => {
      const s = c.fleet.get(printer_id).state;
      return text({ print_error: s.printError, hms: s.hms.map((h) => describeHms(h.attr, h.code)) });
    }),
  );

  server.registerTool(
    "hms_lookup",
    {
      description:
        "Decode an HMS code (0700_8000_0002_0001 or 16 hex digits) or a print_error (8 hex digits). The built-in table is tiny; load a full one with hms_import.",
      inputSchema: { code: z.string() },
    },
    safe(async ({ code }) => {
      const info = describeKey(code);
      return info ? text(info) : fail("expected 16 hex digits (HMS) or 8 hex digits (print_error)");
    }),
  );

  server.registerTool(
    "hms_import",
    {
      description:
        "Import an HMS dictionary from a JSON file: either {\"<code>\": {\"text\",\"severity\",\"retry\"}} or a Bambu Studio style hms json (data.device_hms.en[{ecode,intro}]). Saved to ~/.bambu-sentinel/hms.json. retry: retry | human | never controls automatic reprints.",
      inputSchema: { file_path: z.string() },
    },
    safe(async ({ file_path }) => {
      if (!fs.existsSync(file_path)) return fail(`no such file: ${file_path}`);
      const n = importDictionary(JSON.parse(fs.readFileSync(file_path, "utf8")));
      return text(`imported ${n} entries`);
    }),
  );
}
