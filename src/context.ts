import type { ConfigFile } from "./config.js";
import type { Db } from "./db.js";
import type { Ejector } from "./eject.js";
import type { Fleet } from "./fleet.js";
import type { Monitor } from "./monitor.js";
import type { Scheduler } from "./scheduler.js";

export interface Config {
  fleet: Fleet;
  db: Db;
  scheduler: Scheduler;
  monitor: Monitor;
  ejector: Ejector;
  file: ConfigFile;
  save: () => void;
}
