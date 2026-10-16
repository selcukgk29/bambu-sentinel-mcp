import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { DATA_DIR, ensureDataDir } from "./config.js";
import type { FilamentRequirement, Job, JobStatus, PlateObject, PrinterEvent } from "./types.js";

export interface HistoryRow {
  id: number;
  printer_id: string;
  job_id: number | null;
  name: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  layers: number | null;
  reason: string | null;
  error_code: string | null;
  grams: number | null;
  energy_kwh: number | null;
  cost: number | null;
  /** Good parts this cycle produced (objects on the plate for a finished print, 0 otherwise). */
  parts: number | null;
}

export interface Sample {
  at: number;
  status: string;
  nozzle: number;
  nozzleTarget: number;
  bed: number;
  bedTarget: number;
  progress: number;
  speed: number;
  fan: number;
}

export interface StatusSegment {
  from: number;
  to: number;
  status: string;
  reason: string | null;
}

export interface ConsumptionRow {
  id: number;
  at: number;
  printerId: string;
  printName: string | null;
  outcome: string | null;
  type: string;
  color: string | null;
  grams: number;
  spoolId: number | null;
}

export interface Spool {
  id: number;
  name: string;
  type: string;
  color: string | null;
  brand: string | null;
  initialG: number | null;
  remainingG: number | null;
  pricePerKg: number | null;
  printerId: string | null;
  slot: number | null;
  archived: boolean;
}

export class Db {
  private db: DatabaseSync;

  constructor(file = path.join(DATA_DIR, "sentinel.db")) {
    if (file !== ":memory:") ensureDataDir();
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        plate INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'queued',
        printer_id TEXT,
        assigned_printer TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        filaments TEXT NOT NULL DEFAULT '[]',
        options TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        notes TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id TEXT NOT NULL,
        job_id INTEGER,
        name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        layers INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (
        printer_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        status TEXT NOT NULL,
        nozzle REAL, nozzle_target REAL, bed REAL, bed_target REAL,
        progress REAL, speed INTEGER, fan INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_samples ON samples(printer_id, at);
      CREATE TABLE IF NOT EXISTS status_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_status ON status_log(printer_id, at);
      CREATE TABLE IF NOT EXISTS consumption (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        printer_id TEXT NOT NULL,
        print_name TEXT,
        outcome TEXT,
        type TEXT NOT NULL,
        color TEXT,
        grams REAL NOT NULL,
        spool_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_consumption ON consumption(at);
      CREATE TABLE IF NOT EXISTS spools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color TEXT,
        brand TEXT,
        initial_g REAL,
        remaining_g REAL,
        price_per_kg REAL,
        printer_id TEXT,
        slot INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    this.migrate("jobs", "last_error", "TEXT");
    this.migrate("jobs", "hold_until", "INTEGER");
    this.migrate("jobs", "start_failures", "INTEGER NOT NULL DEFAULT 0");
    this.migrate("jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.migrate("jobs", "max_attempts", "INTEGER NOT NULL DEFAULT 2");
    this.migrate("jobs", "estimate_sec", "REAL");
    this.migrate("jobs", "layout", "TEXT");
    this.migrate("history", "reason", "TEXT");
    this.migrate("history", "error_code", "TEXT");
    this.migrate("history", "grams", "REAL");
    this.migrate("history", "energy_kwh", "REAL");
    this.migrate("history", "cost", "REAL");
    this.migrate("history", "parts", "INTEGER");
  }

  /** Add a column to an existing table when an older database file lacks it. */
  private migrate(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ---- telemetry --------------------------------------------------------
  /** Record a status change; returns false when the status is the same as the last one. */
  logStatus(printerId: string, at: number, status: string, reason: string | null): boolean {
    // Compare with the record just before `at` in time (not the newest one), so history can be backfilled.
    const last = this.db.prepare("SELECT status, reason FROM status_log WHERE printer_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1").get(printerId, at) as
      | { status: string; reason: string | null }
      | undefined;
    if (last && last.status === status && (last.reason ?? null) === reason) return false;
    this.db.prepare("INSERT INTO status_log(printer_id,at,status,reason) VALUES(?,?,?,?)").run(printerId, at, status, reason);
    return true;
  }

  /** The machine's status as a series of segments over [from, to]; time after `now` and before the first record is left empty. */
  statusSegments(printerId: string, from: number, to: number, now = Date.now()): StatusSegment[] {
    const before = this.db.prepare("SELECT at, status, reason FROM status_log WHERE printer_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1").get(printerId, from) as any;
    const inside = this.db.prepare("SELECT at, status, reason FROM status_log WHERE printer_id = ? AND at >= ? AND at <= ? ORDER BY at, id").all(printerId, from, to) as any[];
    const rows = before ? [{ ...before, at: from }, ...inside] : inside;
    const end = Math.min(to, now);
    const out: StatusSegment[] = [];
    for (const [i, r] of rows.entries()) {
      const next = rows[i + 1]?.at ?? end;
      const a = Math.max(r.at, from);
      const b = Math.min(next, end);
      if (b <= a) continue;
      const prev = out.at(-1);
      if (prev && prev.status === r.status && prev.reason === (r.reason ?? null) && prev.to === a) prev.to = b; // merge neighbours that are the same
      else out.push({ from: a, to: b, status: r.status, reason: r.reason ?? null });
    }
    return out;
  }

  addSample(printerId: string, s: Sample): void {
    this.db
      .prepare("INSERT INTO samples(printer_id,at,status,nozzle,nozzle_target,bed,bed_target,progress,speed,fan) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(printerId, s.at, s.status, s.nozzle, s.nozzleTarget, s.bed, s.bedTarget, s.progress, s.speed, s.fan);
  }

  /** Samples in [from, to], averaged down to at most `maxPoints` points. */
  samplesBetween(printerId: string, from: number, to: number, maxPoints = 240): Sample[] {
    const rows = this.db.prepare("SELECT * FROM samples WHERE printer_id = ? AND at >= ? AND at <= ? ORDER BY at").all(printerId, from, to) as any[];
    const toSample = (r: any): Sample => ({ at: r.at, status: r.status, nozzle: r.nozzle, nozzleTarget: r.nozzle_target, bed: r.bed, bedTarget: r.bed_target, progress: r.progress, speed: r.speed, fan: r.fan });
    if (rows.length <= maxPoints) return rows.map(toSample);
    const size = Math.ceil(rows.length / maxPoints);
    const out: Sample[] = [];
    for (let i = 0; i < rows.length; i += size) {
      const g = rows.slice(i, i + size);
      const avg = (k: string) => Math.round((g.reduce((s, r) => s + (r[k] ?? 0), 0) / g.length) * 10) / 10;
      out.push({ at: g[Math.floor(g.length / 2)].at, status: g[g.length - 1].status, nozzle: avg("nozzle"), nozzleTarget: avg("nozzle_target"), bed: avg("bed"), bedTarget: avg("bed_target"), progress: avg("progress"), speed: avg("speed"), fan: avg("fan") });
    }
    return out;
  }

  /** Drop old telemetry: samples after 14 days, status changes after 90 (keeping each machine's latest). */
  prune(now: number): void {
    this.db.prepare("DELETE FROM samples WHERE at < ?").run(now - 14 * 86_400_000);
    this.db
      .prepare("DELETE FROM status_log WHERE at < ? AND id NOT IN (SELECT MAX(id) FROM status_log GROUP BY printer_id)")
      .run(now - 90 * 86_400_000);
  }

  /** Work cycles that overlap [from, to], including one still running. */
  historyOverlap(printerId: string, from: number, to: number): HistoryRow[] {
    return this.db
      .prepare("SELECT * FROM history WHERE printer_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at")
      .all(printerId, to, from) as unknown as HistoryRow[];
  }

  // ---- spools ---------------------------------------------------------
  private toSpool(r: any): Spool {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      color: r.color ?? null,
      brand: r.brand ?? null,
      initialG: r.initial_g ?? null,
      remainingG: r.remaining_g ?? null,
      pricePerKg: r.price_per_kg ?? null,
      printerId: r.printer_id ?? null,
      slot: r.slot ?? null,
      archived: !!r.archived,
    };
  }
  addSpool(s: { name: string; type: string; color?: string | null; brand?: string | null; initialG?: number | null; remainingG?: number | null; pricePerKg?: number | null }): Spool {
    const r = this.db
      .prepare("INSERT INTO spools(name,type,color,brand,initial_g,remaining_g,price_per_kg,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(s.name, s.type, s.color ?? null, s.brand ?? null, s.initialG ?? null, s.remainingG ?? null, s.pricePerKg ?? null, Date.now());
    return this.getSpool(Number(r.lastInsertRowid))!;
  }
  getSpool(id: number): Spool | null {
    const r = this.db.prepare("SELECT * FROM spools WHERE id = ?").get(id);
    return r ? this.toSpool(r) : null;
  }
  listSpools(includeArchived = false): Spool[] {
    const rows = this.db.prepare(`SELECT * FROM spools ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY id`).all();
    return rows.map((r) => this.toSpool(r));
  }
  /** Material taken from stock by a print (whether or not a registered spool was loaded). */
  logConsumption(c: { at: number; printerId: string; printName?: string | null; outcome?: string | null; type: string; color?: string | null; grams: number; spoolId?: number | null }): void {
    this.db
      .prepare("INSERT INTO consumption(at,printer_id,print_name,outcome,type,color,grams,spool_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(c.at, c.printerId, c.printName ?? null, c.outcome ?? null, c.type, c.color ?? null, c.grams, c.spoolId ?? null);
  }
  consumptionSince(sinceMs: number, limit = 1000): ConsumptionRow[] {
    return (this.db.prepare("SELECT * FROM consumption WHERE at >= ? ORDER BY at DESC LIMIT ?").all(sinceMs, limit) as any[]).map((r) => ({
      id: r.id,
      at: r.at,
      printerId: r.printer_id,
      printName: r.print_name ?? null,
      outcome: r.outcome ?? null,
      type: r.type,
      color: r.color ?? null,
      grams: r.grams,
      spoolId: r.spool_id ?? null,
    }));
  }

  updateSpool(id: number, p: { remaining_g?: number; price_per_kg?: number; name?: string; archived?: boolean; type?: string; color?: string | null; initial_g?: number; brand?: string | null }): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (p.type !== undefined) (sets.push("type = ?"), args.push(p.type));
    if (p.color !== undefined) (sets.push("color = ?"), args.push(p.color));
    if (p.brand !== undefined) (sets.push("brand = ?"), args.push(p.brand));
    if (p.initial_g !== undefined) (sets.push("initial_g = ?"), args.push(p.initial_g));
    if (p.remaining_g !== undefined) (sets.push("remaining_g = ?"), args.push(p.remaining_g));
    if (p.price_per_kg !== undefined) (sets.push("price_per_kg = ?"), args.push(p.price_per_kg));
    if (p.name !== undefined) (sets.push("name = ?"), args.push(p.name));
    if (p.archived !== undefined) {
      sets.push("archived = ?");
      args.push(p.archived ? 1 : 0);
      if (p.archived) sets.push("printer_id = NULL", "slot = NULL");
    }
    if (sets.length) this.db.prepare(`UPDATE spools SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }
  /** Load a spool into a slot (replacing whatever was there) or unload it with nulls. */
  assignSpool(id: number, printerId: string | null, slot: number | null): void {
    if (printerId !== null && slot !== null)
      this.db.prepare("UPDATE spools SET printer_id = NULL, slot = NULL WHERE printer_id = ? AND slot = ?").run(printerId, slot);
    this.db.prepare("UPDATE spools SET printer_id = ?, slot = ? WHERE id = ?").run(printerId, slot, id);
  }
  spoolAt(printerId: string, slot: number): Spool | null {
    const r = this.db.prepare("SELECT * FROM spools WHERE printer_id = ? AND slot = ? AND archived = 0").get(printerId, slot);
    return r ? this.toSpool(r) : null;
  }
  spoolsFor(printerId: string): Spool[] {
    return this.db.prepare("SELECT * FROM spools WHERE printer_id = ? AND archived = 0").all(printerId).map((r) => this.toSpool(r));
  }
  /** Subtract grams (never below zero). Returns the new remaining weight, or null when the weight is unknown. */
  deductSpool(id: number, grams: number): number | null {
    this.db.prepare("UPDATE spools SET remaining_g = MAX(0, remaining_g - ?) WHERE id = ? AND remaining_g IS NOT NULL").run(grams, id);
    return this.getSpool(id)?.remainingG ?? null;
  }

  // ---- kv -------------------------------------------------------------
  getKv(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  delKv(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
  getFlag(key: string, fallback = false): boolean {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? r.value === "1" : fallback;
  }
  setFlag(key: string, v: boolean): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, v ? "1" : "0");
  }

  // ---- events ---------------------------------------------------------
  private listeners: ((e: PrinterEvent) => void)[] = [];
  /** Called for every event as it is recorded (used to push notifications). */
  onEvent(fn: (e: PrinterEvent) => void): void {
    this.listeners.push(fn);
  }
  addEvent(e: PrinterEvent): void {
    this.db.prepare("INSERT INTO events(printer_id,type,at,data) VALUES(?,?,?,?)").run(e.printerId, e.type, e.at, JSON.stringify(e.data));
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("event listener failed:", (err as Error).message);
      }
    }
  }
  recentEvents(opts: { printerId?: string; since?: number; types?: string[]; limit?: number }): PrinterEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.printerId) (where.push("printer_id = ?"), args.push(opts.printerId));
    if (opts.since) (where.push("at >= ?"), args.push(opts.since));
    if (opts.types?.length) (where.push(`type IN (${opts.types.map(() => "?").join(",")})`), args.push(...opts.types));
    const sql = `SELECT printer_id,type,at,data FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, opts.limit ?? 50) as any[];
    return rows.map((r) => ({ printerId: r.printer_id, type: r.type, at: r.at, data: JSON.parse(r.data) }));
  }

  /** Events for one machine inside a time window, oldest first. */
  eventsBetween(printerId: string, from: number, to: number): PrinterEvent[] {
    const rows = this.db
      .prepare("SELECT printer_id,type,at,data FROM events WHERE printer_id = ? AND at >= ? AND at <= ? ORDER BY at, id")
      .all(printerId, from, to) as any[];
    return rows.map((r) => ({ printerId: r.printer_id, type: r.type, at: r.at, data: JSON.parse(r.data) }));
  }

  // ---- history --------------------------------------------------------
  historyRow(id: number): HistoryRow | null {
    return (this.db.prepare("SELECT * FROM history WHERE id = ?").get(id) as unknown as HistoryRow) ?? null;
  }
  openHistory(printerId: string, name: string, jobId: number | null, at: number): void {
    this.closeHistory(printerId, "unknown", at, null); // close any dangling row
    this.db.prepare("INSERT INTO history(printer_id,job_id,name,started_at) VALUES(?,?,?,?)").run(printerId, jobId, name, at);
  }
  closeHistory(
    printerId: string,
    outcome: string,
    at: number,
    layers: number | null,
    reason: string | null = null,
    errorCode: string | null = null,
    extra: { grams?: number | null; energyKwh?: number | null; cost?: number | null; parts?: number | null } = {},
  ): void {
    this.db
      .prepare("UPDATE history SET ended_at=?, outcome=?, layers=?, reason=?, error_code=?, grams=?, energy_kwh=?, cost=?, parts=? WHERE printer_id=? AND ended_at IS NULL")
      .run(at, outcome, layers, reason, errorCode, extra.grams ?? null, extra.energyKwh ?? null, extra.cost ?? null, extra.parts ?? null, printerId);
  }
  /** The print currently open for this printer, if any. */
  openHistoryRow(printerId: string): HistoryRow | null {
    return (this.db.prepare("SELECT * FROM history WHERE printer_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(printerId) as unknown as HistoryRow) ?? null;
  }
  /** Mean wall-clock minutes-to-seconds of finished prints with this name, or null when never printed. */
  avgDurationSec(name: string): number | null {
    const r = this.db
      .prepare("SELECT AVG(ended_at - started_at) AS ms FROM history WHERE name = ? AND outcome = 'finished' AND ended_at IS NOT NULL")
      .get(name) as { ms: number | null } | undefined;
    return r?.ms ? Math.round(r.ms / 1000) : null;
  }
  /** Closed prints that ended at or after `sinceMs`. */
  historyBetween(sinceMs: number, printerId?: string): HistoryRow[] {
    const sql = `SELECT * FROM history WHERE ended_at IS NOT NULL AND ended_at >= ? ${printerId ? "AND printer_id = ?" : ""} ORDER BY started_at`;
    return this.db.prepare(sql).all(...(printerId ? [sinceMs, printerId] : [sinceMs])) as unknown as HistoryRow[];
  }
  history(opts: { printerId?: string; limit?: number }): HistoryRow[] {
    const sql = `SELECT * FROM history ${opts.printerId ? "WHERE printer_id = ?" : ""} ORDER BY started_at DESC LIMIT ?`;
    const args = opts.printerId ? [opts.printerId, opts.limit ?? 20] : [opts.limit ?? 20];
    return this.db.prepare(sql).all(...args) as unknown as HistoryRow[];
  }

  // ---- jobs -----------------------------------------------------------
  private toJob(r: any): Job {
    return {
      id: r.id,
      name: r.name,
      filePath: r.file_path,
      plate: r.plate,
      status: r.status,
      printerId: r.printer_id,
      assignedPrinter: r.assigned_printer,
      priority: r.priority,
      filaments: JSON.parse(r.filaments) as FilamentRequirement[],
      options: JSON.parse(r.options),
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      notes: r.notes,
      lastError: r.last_error ?? null,
      holdUntil: r.hold_until ?? null,
      startFailures: r.start_failures ?? 0,
      attempts: r.attempts ?? 0,
      maxAttempts: r.max_attempts ?? 2,
      estimateSec: r.estimate_sec ?? null,
      layout: r.layout ? (JSON.parse(r.layout) as PlateObject[]) : null,
    };
  }
  addJob(j: {
    name: string;
    filePath: string;
    plate?: number;
    printerId?: string | null;
    priority?: number;
    filaments?: FilamentRequirement[];
    options?: Record<string, unknown>;
    notes?: string;
    maxAttempts?: number;
    estimateSec?: number | null;
    layout?: PlateObject[] | null;
  }): Job {
    const r = this.db
      .prepare(
        "INSERT INTO jobs(name,file_path,plate,printer_id,priority,filaments,options,created_at,notes,max_attempts,estimate_sec,layout) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(j.name, j.filePath, j.plate ?? 1, j.printerId ?? null, j.priority ?? 0, JSON.stringify(j.filaments ?? []), JSON.stringify(j.options ?? {}), Date.now(), j.notes ?? "", j.maxAttempts ?? 2, j.estimateSec ?? null, j.layout?.length ? JSON.stringify(j.layout) : null);
    return this.getJob(Number(r.lastInsertRowid))!;
  }
  getJob(id: number): Job | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return r ? this.toJob(r) : null;
  }
  listJobs(statuses?: JobStatus[], limit = 50): Job[] {
    const where = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`)
      .all(...(statuses ?? []), limit);
    return rows.map((r) => this.toJob(r));
  }
  activeJobFor(printerId: string): Job | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE assigned_printer = ? AND status = 'printing' ORDER BY started_at DESC LIMIT 1").get(printerId);
    return r ? this.toJob(r) : null;
  }
  markJobStarted(id: number, printerId: string): void {
    this.db.prepare("UPDATE jobs SET status='printing', assigned_printer=?, started_at=? WHERE id=?").run(printerId, Date.now(), id);
  }
  finishJob(id: number, status: "done" | "failed" | "cancelled", error: string | null = null): void {
    this.db.prepare("UPDATE jobs SET status=?, finished_at=?, last_error=COALESCE(?, last_error) WHERE id=?").run(status, Date.now(), error, id);
  }
  /** A print of this job started and failed; put it back in the queue for another attempt. */
  retryJob(id: number, reason: string): void {
    this.db
      .prepare("UPDATE jobs SET status='queued', assigned_printer=NULL, started_at=NULL, hold_until=NULL, attempts=attempts+1, last_error=? WHERE id=?")
      .run(reason, id);
  }
  /**
   * A start attempt did not work (printer rejected it, or never began). Requeue with a backoff;
   * after 3 failed starts the job is marked failed so it cannot loop forever.
   */
  failStart(id: number, error: string, holdMs = 5 * 60_000): "requeued" | "failed" {
    const n = (this.getJob(id)?.startFailures ?? 0) + 1;
    if (n >= 3) {
      this.db
        .prepare("UPDATE jobs SET status='failed', finished_at=?, last_error=?, start_failures=?, assigned_printer=NULL WHERE id=?")
        .run(Date.now(), error, n, id);
      return "failed";
    }
    this.db
      .prepare("UPDATE jobs SET status='queued', assigned_printer=NULL, started_at=NULL, last_error=?, start_failures=?, hold_until=? WHERE id=?")
      .run(error, n, Date.now() + holdMs, id);
    return "requeued";
  }
  clearHold(id: number): void {
    this.db.prepare("UPDATE jobs SET hold_until=NULL WHERE id=?").run(id);
  }
  requeueJob(id: number): void {
    this.db.prepare("UPDATE jobs SET status='queued', assigned_printer=NULL, started_at=NULL WHERE id=?").run(id);
  }
  setPriority(id: number, priority: number): void {
    this.db.prepare("UPDATE jobs SET priority=? WHERE id=?").run(priority, id);
  }

  close(): void {
    this.db.close();
  }
}
