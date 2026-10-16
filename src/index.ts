#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, saveConfig } from "./config.js";
import type { Config } from "./context.js";
import { Db } from "./db.js";
import { Ejector } from "./eject.js";
import { Fleet } from "./fleet.js";
import { loadUserDictionary } from "./hms.js";
import { Monitor } from "./monitor.js";
import { Scheduler } from "./scheduler.js";
import { buildServer } from "./server.js";

const file = loadConfig();
const db = new Db();
const fleet = new Fleet();
const scheduler = new Scheduler(fleet, db);
const monitor = new Monitor(fleet, db, scheduler, file.settings);
const ejector = new Ejector(scheduler, db);
monitor.ejector = ejector;
const ctx: Config = { fleet, db, scheduler, monitor, ejector, file, save: () => saveConfig(file) };

loadUserDictionary();
const server = buildServer(ctx);

for (const p of file.printers) fleet.add(p);
monitor.start();

const shutdown = () => {
  monitor.stop();
  fleet.shutdown();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error(`bambu-sentinel ready: ${file.printers.length} printer(s)`);
