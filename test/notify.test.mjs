import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const { Db } = await import("../dist/db.js");
const { attachNotifier, NOTIFY_CAPABILITIES, eventLevel, describeEvent, EVENTS_URI } = await import("../dist/notify.js");

const ev = (type, data = {}, printerId = "a1") => ({ printerId, type, at: Date.now(), data });

test("levels and wording", () => {
  assert.equal(eventLevel(ev("connected")), null);
  assert.equal(eventLevel(ev("print_finished")), "notice");
  assert.equal(eventLevel(ev("print_failed")), "error");
  assert.equal(eventLevel(ev("hms_error", { severity: "fatal" })), "error");
  assert.equal(eventLevel(ev("hms_error", { severity: "unknown" })), "warning");
  assert.equal(eventLevel(ev("alert", { severity: "critical" })), "critical");
  assert.equal(describeEvent(ev("print_failed", { job: "benchy", printError: 5 })), "[a1] print FAILED: benchy (error 5)");
  assert.match(describeEvent(ev("job_retry", { job: 3, name: "x", attempt: 1, of: 2, reason: "boom" })), /retrying \(attempt 2 of 2\): boom/);
});

test("subscribers are pushed events: log message for notable ones, resource updates for subscribed uris", async () => {
  const db = new Db(":memory:");
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: NOTIFY_CAPABILITIES });
  attachNotifier(server, db);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  const logs = [], updates = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void logs.push(n.params));
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
  await Promise.all([server.connect(st), client.connect(ct)]);

  await client.setLoggingLevel("notice");                      // client only wants notice and above
  await client.subscribeResource({ uri: EVENTS_URI });

  db.addEvent(ev("print_started", { job: "a" }));              // info: below the level -> no log
  db.addEvent(ev("print_failed", { job: "b", printError: 7 }));
  db.addEvent(ev("connected"));                                // never logged
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(logs.map((l) => [l.level, l.data]), [["error", "[a1] print FAILED: b (error 7)"]]);
  assert.equal(updates.length, 3);                             // every event refreshes the events resource
  assert.ok(updates.every((u) => u === EVENTS_URI));

  const res = await client.readResource({ uri: EVENTS_URI });
  const rows = JSON.parse(res.contents[0].text);
  assert.equal(rows[0].type, "connected");
  assert.match(rows[1].summary, /print FAILED/);

  await client.unsubscribeResource({ uri: EVENTS_URI });
  db.addEvent(ev("print_finished", { job: "b" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(updates.length, 3);                             // no more updates after unsubscribe
  assert.equal(logs.length, 2);                                // but the notice-level log still arrives
  await client.close();
  db.close();
});
