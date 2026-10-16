import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "./db.js";
import type { PrinterEvent } from "./types.js";

export const EVENTS_URI = "bambu://events";
export const FLEET_URI = "bambu://fleet";

/** Capabilities the server must declare at construction for notifications to work. */
export const NOTIFY_CAPABILITIES = { logging: {}, resources: { subscribe: true } };

type Level = "debug" | "info" | "notice" | "warning" | "error" | "critical";

/** How loudly an event should be pushed to the client; null = not worth a message. */
export function eventLevel(e: PrinterEvent): Level | null {
  switch (e.type) {
    case "connected":
      return null;
    case "print_started":
    case "print_paused":
    case "print_resumed":
    case "eject":
      return "info";
    case "print_finished":
      return "notice";
    case "print_failed":
    case "auto_pause":
      return "error";
    case "hms_error":
      return e.data.severity === "fatal" || e.data.severity === "error" ? "error" : "warning";
    case "alert":
      return e.data.severity === "critical" ? "critical" : "warning";
    case "disconnected":
    case "job_retry":
    case "vision":
      return "warning";
    default:
      return "info";
  }
}

/** One readable line for a push notification. */
export function describeEvent(e: PrinterEvent): string {
  const d = e.data as Record<string, any>;
  const who = `[${e.printerId}]`;
  switch (e.type) {
    case "print_started":
      return `${who} print started: ${d.job ?? ""}`.trim();
    case "print_finished":
      return `${who} print finished: ${d.job ?? ""}`.trim();
    case "print_failed":
      return `${who} print FAILED: ${d.job ?? ""}${d.printError ? ` (error ${d.printError})` : ""}`.trim();
    case "print_paused":
      return `${who} print paused at ${d.progress ?? "?"}%`;
    case "print_resumed":
      return `${who} print resumed`;
    case "hms_error":
      return `${who} HMS ${d.hex}: ${d.text ?? "unknown"}`;
    case "alert":
      return `${who} ${String(d.severity).toUpperCase()}: ${d.message}`;
    case "auto_pause":
      return `${who} paused automatically: ${d.reason}`;
    case "job_retry":
      return `${who} job #${d.job} ${d.name ?? ""} failed, retrying (attempt ${d.attempt + 1} of ${d.of}): ${d.reason}`;
    case "eject":
      return `${who} plate sweep ${d.rehearsal ? "rehearsal " : ""}done${d.plateCleared ? ", plate verified empty" : d.rehearsal ? "" : ", plate NOT verified"}`;
    case "disconnected":
      return `${who} printer went offline`;
    default:
      return `${who} ${e.type}`;
  }
}

/**
 * Push events to the client: a `notifications/message` log line for notable ones, and
 * `notifications/resources/updated` for subscribers of bambu://events and bambu://fleet.
 * The server must have been built with NOTIFY_CAPABILITIES.
 */
export function attachNotifier(server: McpServer, db: Db): void {
  const subs = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subs.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subs.delete(req.params.uri);
    return {};
  });

  server.registerResource(
    "events",
    EVENTS_URI,
    { description: "The 50 most recent printer events (subscribe to be notified of new ones)", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            db.recentEvents({ limit: 50 }).map((e) => ({ ...e, at: new Date(e.at).toISOString(), summary: describeEvent(e) })),
            null,
            2,
          ),
        },
      ],
    }),
  );

  const quiet = () => {};
  db.onEvent((e) => {
    if (!server.isConnected()) return;
    const level = eventLevel(e);
    if (level) void server.server.sendLoggingMessage({ level, logger: "bambu-sentinel", data: describeEvent(e) }).catch(quiet);
    if (subs.has(EVENTS_URI)) void server.server.sendResourceUpdated({ uri: EVENTS_URI }).catch(quiet);
    if (subs.has(FLEET_URI) && e.type !== "alert" && e.type !== "hms_error")
      void server.server.sendResourceUpdated({ uri: FLEET_URI }).catch(quiet);
  });
}
