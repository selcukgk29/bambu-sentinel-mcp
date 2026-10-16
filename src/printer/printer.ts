import { EventEmitter } from "node:events";
import * as mqtt from "mqtt";
import type { GcodeState, PrinterConfig, PrinterEvent, PrinterEventType, PrinterState } from "../types.js";
import { describeHms, hmsHex } from "../hms.js";
import { emptyState, isActive, normalize } from "./state.js";
import * as ftp from "./ftp.js";
import { grabSnapshot } from "./camera.js";

export interface StartPrintOptions {
  /** File name already present on the printer (under remoteDir). */
  file: string;
  remoteDir?: string;
  plate?: number;
  useAms?: boolean;
  amsMapping?: number[];
  bedLeveling?: boolean;
  flowCali?: boolean;
  vibrationCali?: boolean;
  timelapse?: boolean;
  bedType?: string;
}

/** What the printer said about a command. `acked:false` means it never answered (not necessarily a failure). */
export interface Ack {
  acked: boolean;
  result?: string;
  reason?: string;
}

export class Printer extends EventEmitter {
  /** How long to wait for a command acknowledgement. */
  ackTimeoutMs = 4000;
  private pending = new Map<string, { command: string; resolve: (a: Ack) => void }>();
  private client: mqtt.MqttClient | null = null;
  private raw: Record<string, any> = {};
  private seq = 1;
  private lastGcode: GcodeState | undefined;
  private knownHms = new Set<string>();
  private online = false;
  private pushTimer: NodeJS.Timeout | null = null;
  state: PrinterState = emptyState();
  lastSeenAt = 0;
  /** When the machine last changed between online/offline or between states. */
  stateSince = Date.now();

  constructor(readonly config: PrinterConfig) {
    super();
  }

  get id(): string {
    return this.config.id;
  }

  private emitEvent(type: PrinterEventType, data: Record<string, unknown> = {}): void {
    const ev: PrinterEvent = { printerId: this.id, type, at: Date.now(), data };
    this.emit("event", ev);
  }

  connect(): void {
    if (this.client) return;
    const c = this.config;
    this.client = mqtt.connect({
      host: c.host,
      port: c.ports?.mqtt ?? 8883,
      protocol: "mqtts",
      username: "bblp",
      password: c.accessCode,
      clientId: `sentinel_${c.id}_${Math.random().toString(16).slice(2, 8)}`,
      rejectUnauthorized: false,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
    });

    this.client.on("connect", () => {
      this.client!.subscribe(`device/${c.serial}/report`, (err) => {
        if (err) return console.error(`[${c.id}] subscribe failed:`, err.message);
        this.online = true;
        this.refreshState();
        this.pushAll();
        // A1/P1 only send deltas; ask for a full dump periodically to stay in sync.
        this.pushTimer ??= setInterval(() => this.pushAll(), 5 * 60_000);
        this.emitEvent("connected");
      });
    });
    this.client.on("message", (_t, payload) => this.onMessage(payload));
    this.client.on("close", () => {
      if (!this.online) return;
      this.online = false;
      this.failPending();
      this.refreshState();
      this.emitEvent("disconnected");
    });
    this.client.on("error", (e) => {
      const hint = /ECONNRESET|connack/i.test(e.message)
        ? " (only one LAN MQTT client allowed: close Bambu Studio/Orca/Home Assistant)"
        : "";
      console.error(`[${c.id}] MQTT error: ${e.message}${hint}`);
    });
  }

  disconnect(): void {
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.pushTimer = null;
    this.client?.end(true);
    this.client = null;
    this.online = false;
    this.failPending();
  }

  private failPending(): void {
    for (const p of this.pending.values()) p.resolve({ acked: false });
    this.pending.clear();
  }

  private refreshState(): void {
    const prev = this.state;
    this.state = normalize(this.raw, this.online);
    if (prev.online !== this.state.online || prev.gcodeState !== this.state.gcodeState) this.stateSince = Date.now();
  }

  private onMessage(payload: Buffer): void {
    let data: any;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }
    // Command acknowledgements carry the request's sequence_id, its command name and a `result`.
    for (const key of ["print", "system"] as const) {
      const o = data[key];
      if (!o || typeof o !== "object" || o.result === undefined || o.sequence_id === undefined) continue;
      const wait = this.pending.get(String(o.sequence_id));
      if (wait && wait.command === o.command) {
        this.pending.delete(String(o.sequence_id));
        wait.resolve({ acked: true, result: String(o.result), reason: o.reason ? String(o.reason) : undefined });
      }
      if (key === "print") return; // an ack is not a status report
    }
    const p = data.print;
    if (!p || typeof p !== "object") return;
    // `ams` and `lights_report` replace wholesale; everything else is a shallow merge.
    Object.assign(this.raw, p);
    this.lastSeenAt = Date.now();
    this.refreshState();
    this.detectEvents();
  }

  private detectEvents(): void {
    const s = this.state;
    const prev = this.lastGcode;
    const now = s.gcodeState;
    if (now === "UNKNOWN") return;
    this.lastGcode = now;

    if (prev !== undefined && prev !== now) {
      const wasActive = prev === "PREPARE" || prev === "RUNNING" || prev === "PAUSE";
      const base = { job: s.jobName, progress: s.progress, layer: s.layer };
      if ((now === "PREPARE" || now === "RUNNING") && !wasActive) this.emitEvent("print_started", base);
      else if (now === "PAUSE" && prev === "RUNNING") this.emitEvent("print_paused", base);
      else if (now === "RUNNING" && prev === "PAUSE") this.emitEvent("print_resumed", base);
      else if (now === "FINISH" && wasActive) this.emitEvent("print_finished", base);
      else if (now === "FAILED") this.emitEvent("print_failed", { ...base, printError: s.printError });
    }

    for (const h of s.hms) {
      const key = `${h.attr}:${h.code}`;
      if (!this.knownHms.has(key)) {
        this.knownHms.add(key);
        const info = describeHms(h.attr, h.code);
        this.emitEvent("hms_error", { attr: h.attr, code: h.code, hex: hmsHex(h.attr, h.code), text: info.text, severity: info.severity });
      }
    }
    // Forget cleared HMS entries so a repeat is reported again.
    const live = new Set(s.hms.map((h) => `${h.attr}:${h.code}`));
    for (const k of this.knownHms) if (!live.has(k)) this.knownHms.delete(k);
  }

  // ---- commands ----------------------------------------------------------

  private publish(body: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.online) return reject(new Error(`printer ${this.id} is offline`));
      this.client.publish(`device/${this.config.serial}/request`, JSON.stringify(body), { qos: 1 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /**
   * Send a command and wait for the printer's acknowledgement. Throws when the printer explicitly
   * rejects it; resolves `{acked:false}` when it simply does not answer within `ackTimeoutMs`.
   */
  private async cmd(type: "print" | "system", command: string, extra: Record<string, unknown> = {}): Promise<Ack> {
    const seq = String(this.seq++);
    let timer: NodeJS.Timeout | undefined;
    const answer = new Promise<Ack>((resolve) => {
      this.pending.set(seq, { command, resolve });
      timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve({ acked: false });
      }, this.ackTimeoutMs);
    });
    try {
      await this.publish({ [type]: { sequence_id: seq, command, ...extra } });
    } catch (e) {
      clearTimeout(timer);
      this.pending.delete(seq);
      throw e;
    }
    const ack = await answer;
    clearTimeout(timer);
    if (ack.acked && ack.result && !/^success$/i.test(ack.result))
      throw new Error(`printer rejected ${command}: ${ack.reason || ack.result}`);
    return ack;
  }

  pushAll = () => this.publish({ pushing: { sequence_id: String(this.seq++), command: "pushall" } }).catch(() => {});
  pause = () => this.cmd("print", "pause");
  resume = () => this.cmd("print", "resume");
  stop = () => this.cmd("print", "stop");
  setSpeed = (level: 1 | 2 | 3 | 4) => this.cmd("print", "print_speed", { param: String(level) });
  sendGcode = (gcode: string) => this.cmd("print", "gcode_line", { param: gcode.endsWith("\n") ? gcode : gcode + "\n" });
  setLight = (on: boolean) =>
    this.cmd("system", "ledctrl", {
      led_node: "chamber_light",
      led_mode: on ? "on" : "off",
      led_on_time: 500,
      led_off_time: 500,
      loop_times: 0,
      interval_time: 0,
    });

  startPrint(o: StartPrintOptions) {
    const dir = (o.remoteDir ?? "/cache").replace(/\/$/, "");
    const useAms = o.useAms ?? true;
    return this.cmd("print", "project_file", {
      param: `Metadata/plate_${o.plate ?? 1}.gcode`,
      url: `file:///sdcard${dir}/${o.file}`,
      file: o.file,
      subtask_name: o.file.replace(/\.3mf$/i, ""),
      project_id: "0",
      profile_id: "0",
      task_id: "0",
      subtask_id: "0",
      bed_type: o.bedType ?? "auto",
      bed_leveling: o.bedLeveling ?? true,
      flow_cali: o.flowCali ?? false,
      vibration_cali: o.vibrationCali ?? false,
      layer_inspect: false,
      timelapse: o.timelapse ?? false,
      use_ams: useAms,
      ams_mapping: o.amsMapping ?? [0],
    });
  }

  /** Poll the live state until `pred` holds or the timeout passes. */
  async waitFor(pred: (s: PrinterState) => boolean, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this.state)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return pred(this.state);
  }

  /**
   * Start a print and make sure it really started: the printer must not reject the command and its
   * state must become PREPARE/RUNNING within `timeoutMs`. Throws otherwise.
   */
  async startAndConfirm(o: StartPrintOptions, timeoutMs = 45_000): Promise<Ack> {
    const ack = await this.startPrint(o);
    const began = await this.waitFor((s) => isActive(s.gcodeState), timeoutMs);
    if (!began)
      throw new Error(
        `printer did not start the print within ${Math.round(timeoutMs / 1000)}s ` +
          `(${ack.acked ? "command acknowledged" : "no acknowledgement"}, state ${this.state.gcodeState})`,
      );
    return ack;
  }

  // ---- files & camera ----------------------------------------------------

  listFiles = (dir?: string) => ftp.listFiles(this.config.host, this.config.accessCode, dir, this.config.ports?.ftp);
  uploadFile = (local: string, remote?: string) =>
    ftp.uploadFile(this.config.host, this.config.accessCode, local, remote, this.config.ports?.ftp);
  deleteFile = (remote: string) => ftp.deleteFile(this.config.host, this.config.accessCode, remote, this.config.ports?.ftp);
  snapshot = () => grabSnapshot(this.config.host, this.config.accessCode, this.config.model, 10_000, this.config.ports?.camera);
}

export { hmsHex } from "../hms.js";
