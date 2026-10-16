/**
 * A fake Bambu A1 on localhost: TLS MQTT broker, FTPS server and the port-6000 JPEG camera.
 * It speaks the same wire format the real printer uses (as far as we know it), so the real
 * client code can be exercised end to end without hardware. Dev-only: never imported by index.ts.
 */
import { Aedes } from "aedes";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { generate } from "selfsigned";
// @ts-ignore - ftp-srv ships loose typings
import FtpSrv from "ftp-srv";
import type { PrinterConfig } from "../types.js";
import { SCENES } from "./scenes.js";

export type Fault =
  | "heater_drift"
  | "overtemp"
  | "stall"
  | "hms"
  | "spaghetti"
  | "stuck_part"
  | "no_part"
  /** Never answer commands. */
  | "no_ack"
  /** Answer project_file with a failure. */
  | "reject_start"
  /** Acknowledge project_file but never begin printing. */
  | "no_start";

/** A finished part sitting on the plate (bed coordinates, mm). */
export interface SimPart {
  x: number;
  y: number;
  /** Extent in X and Y. */
  w: number;
  d: number;
  /** Height above the plate. */
  h: number;
}


export interface SimOptions {
  serial?: string;
  accessCode?: string;
  model?: string;
  /** Simulated time per real time. 60 = a 30 min print takes 30 s. */
  speed?: number;
  /** Real-time tick in ms. */
  tickMs?: number;
  printMinutes?: number;
  totalLayers?: number;
  ports?: { mqtt?: number; ftp?: number; camera?: number };
  trays?: { type: string; color: string; remain?: number }[];
}

/** Printer reports cancel as FAILED with this error code (assumption from field reports). */
export const CANCEL_ERROR = 0x0300400c;
const AMBIENT = 25;

/** A real (decodable) JPEG for the scene, with a COM marker after SOI carrying a text label tests can read back. */
function frame(label: string, scene: keyof typeof SCENES): Buffer {
  const jpeg = Buffer.from(SCENES[scene], "base64");
  const text = Buffer.from(label, "ascii");
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), text]);
  com.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)]);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

type Raw = Record<string, any>;

export class PrinterSimulator {
  readonly config: PrinterConfig;
  /** Files the printer sees on its "sdcard". */
  readonly root: string;
  /** Every project_file request received, for assertions. */
  readonly startRequests: Raw[] = [];
  /** Every gcode_line received. */
  readonly gcodeLog: string[] = [];
  readonly faults = new Set<Fault>();
  /** Toolhead position in bed coordinates. */
  pos = { x: 0, y: 0, z: 50 };
  /** The part left on the plate after a finished print; null when the plate is empty. */
  part: SimPart | null = null;
  /** Times the toolhead moved sideways through a part (would damage hardware). */
  crashes = 0;
  /** Parts pushed off the bed. */
  ejected = 0;

  private raw: Raw;
  private sent: Raw = {};
  private nozzleActual = AMBIENT;
  private bedActual = AMBIENT;
  private progress = 0;
  private seqCounter = 0;
  private timer: NodeJS.Timeout | null = null;
  private frameTimers = new Set<NodeJS.Timeout>();
  private servers: { close: (cb?: () => void) => unknown }[] = [];
  private lastTick = Date.now();
  private printMs: number;

  private constructor(
    private opts: Required<Pick<SimOptions, "serial" | "accessCode" | "model" | "speed" | "tickMs" | "printMinutes" | "totalLayers">>,
    private broker: Aedes,
    config: PrinterConfig,
    root: string,
    trays: NonNullable<SimOptions["trays"]>,
  ) {
    this.config = config;
    this.root = root;
    this.printMs = opts.printMinutes * 60_000;
    this.raw = {
      gcode_state: "IDLE",
      mc_percent: 0,
      mc_remaining_time: 0,
      layer_num: 0,
      total_layer_num: 0,
      subtask_name: "",
      gcode_file: "",
      nozzle_temper: AMBIENT,
      nozzle_target_temper: 0,
      bed_temper: AMBIENT,
      bed_target_temper: 0,
      spd_lvl: 2,
      cooling_fan_speed: "0",
      big_fan1_speed: "0",
      big_fan2_speed: "0",
      heatbreak_fan_speed: "0",
      wifi_signal: "-45dBm",
      print_error: 0,
      hms: [],
      lights_report: [{ node: "chamber_light", mode: "on" }],
      ams: {
        tray_now: "255",
        ams: [
          {
            id: "0",
            tray: trays.map((t, i) => ({
              id: String(i),
              tray_type: t.type,
              tray_color: t.color.toUpperCase().padEnd(8, "F").slice(0, 8),
              remain: t.remain ?? 100,
              tray_sub_brands: t.type,
            })),
          },
        ],
      },
    };
  }

  static async start(opts: SimOptions = {}): Promise<PrinterSimulator> {
    const o = {
      serial: opts.serial ?? "SIM00000001",
      accessCode: opts.accessCode ?? "12345678",
      model: opts.model ?? "A1",
      speed: opts.speed ?? 60,
      tickMs: opts.tickMs ?? 100,
      printMinutes: opts.printMinutes ?? 30,
      totalLayers: opts.totalLayers ?? 50,
    };
    const pems = await generate([{ name: "commonName", value: "127.0.0.1" }], { keySize: 2048 } as any);
    const tlsOpts = { key: pems.private, cert: pems.cert };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-sim-"));
    fs.mkdirSync(path.join(root, "cache"), { recursive: true });

    // ---- MQTT broker over TLS
    const broker = await Aedes.createBroker();
    broker.authenticate = (_c, user, pass, cb) => cb(null, user === "bblp" && pass?.toString() === o.accessCode);
    const mqttServer = tls.createServer(tlsOpts, (sock) => broker.handle(sock));
    await new Promise<void>((r) => mqttServer.listen(opts.ports?.mqtt ?? 0, "127.0.0.1", r));
    const mqttPort = (mqttServer.address() as net.AddressInfo).port;

    // ---- camera
    const camServer = tls.createServer(tlsOpts);
    await new Promise<void>((r) => camServer.listen(opts.ports?.camera ?? 0, "127.0.0.1", r));
    const camPort = (camServer.address() as net.AddressInfo).port;

    // ---- FTPS
    const ftpPort = opts.ports?.ftp ?? (await freePort());
    const pasvMin = await freePort();
    const FtpCtor: any = (FtpSrv as any).FtpSrv ?? (FtpSrv as any).default ?? FtpSrv;
    const ftp = new FtpCtor({
      url: `ftps://127.0.0.1:${ftpPort}`,
      tls: tlsOpts,
      pasv_url: "127.0.0.1",
      pasv_min: pasvMin,
      pasv_max: pasvMin + 50,
      anonymous: false,
      log: silent as any,
    });
    ftp.on("login", ({ username, password }: any, resolve: any, reject: any) =>
      username === "bblp" && password === o.accessCode ? resolve({ root }) : reject(new Error("bad credentials")),
    );
    await ftp.listen();

    const config: PrinterConfig = {
      id: "sim",
      name: "Simulated A1",
      host: "127.0.0.1",
      serial: o.serial,
      accessCode: o.accessCode,
      model: o.model,
      ports: { mqtt: mqttPort, ftp: ftpPort, camera: camPort },
    };
    const sim = new PrinterSimulator(
      o,
      broker,
      config,
      root,
      opts.trays ?? [
        { type: "PLA", color: "FFFFFF" },
        { type: "PLA", color: "FF0000" },
        { type: "PETG", color: "000000" },
      ],
    );
    sim.servers.push(mqttServer, camServer, { close: (cb) => void ftp.close().then(() => cb?.()) });
    camServer.on("secureConnection", (s) => sim.serveCamera(s));
    broker.on("publish", (packet) => {
      if (packet.topic === `device/${o.serial}/request`) {
        try {
          sim.onRequest(JSON.parse(packet.payload.toString()));
        } catch {
          /* ignore garbage */
        }
      }
    });
    sim.lastTick = Date.now();
    sim.timer = setInterval(() => sim.tick(), o.tickMs);
    sim.timer.unref();
    return sim;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.frameTimers) clearInterval(t);
    await new Promise<void>((r) => this.broker.close(() => r()));
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => void s.close(() => r()))));
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  // ---- inspection / fault injection -------------------------------------------------

  get gcodeState(): string {
    return this.raw.gcode_state;
  }
  get progressPct(): number {
    return this.progress;
  }

  /** Change the simulated-time multiplier on the fly (slow it down to make timing-sensitive checks robust). */
  setSpeed(v: number): void {
    this.opts.speed = v;
  }

  injectFault(f: Fault): void {
    this.faults.add(f);
    if (f === "hms") this.raw.hms = [{ attr: 0x07008000, code: 0x00020001 }];
  }
  clearFaults(): void {
    this.faults.clear();
    this.raw.hms = [];
  }
  /** The print fails now, the way a real error would: FAILED state plus an error code and/or HMS entries. */
  failNow(errorCode = 0x0500c010, hms: { attr: number; code: number }[] = []): void {
    this.raw.hms = hms;
    this.finish("FAILED", errorCode);
  }
  /** Put a 3MF-ish file into /cache as if uploaded from Studio. */
  dropFile(name: string, content: Buffer | string = "x"): void {
    fs.writeFileSync(path.join(this.root, "cache", name), content);
  }

  // ---- protocol ---------------------------------------------------------------------

  private publishReport(body: Raw, key: "print" | "system" = "print"): void {
    this.broker.publish(
      { cmd: "publish", qos: 0, dup: false, retain: false, topic: `device/${this.opts.serial}/report`, payload: Buffer.from(JSON.stringify({ [key]: body })) },
      () => {},
    );
  }

  private onRequest(msg: Raw): void {
    const p = msg.print;
    const s = msg.system;
    if (msg.pushing?.command === "pushall") {
      this.publishReport({ ...this.raw, command: "push_status", msg: 0, sequence_id: String(this.seqCounter++) });
      this.sent = structuredClone(this.raw);
      return;
    }
    const outcome = this.apply(p, s);
    const body = p ?? s;
    if (body && !this.faults.has("no_ack"))
      this.publishReport(
        { command: body.command, sequence_id: body.sequence_id, result: outcome.ok ? "success" : "fail", reason: outcome.reason ?? "" },
        p ? "print" : "system",
      );
  }

  /** Execute a print/system command and say whether the printer would accept it. */
  private apply(p: Raw | undefined, s: Raw | undefined): { ok: boolean; reason?: string } {
    if (s?.command === "ledctrl") {
      this.raw.lights_report = [{ node: s.led_node, mode: s.led_mode }];
      return { ok: true };
    }
    if (!p) return { ok: true };
    const st = this.raw.gcode_state;
    switch (p.command) {
      case "pause":
        if (st === "RUNNING") this.raw.gcode_state = "PAUSE";
        break;
      case "resume":
        if (st === "PAUSE") this.raw.gcode_state = "RUNNING";
        break;
      case "stop":
        if (st === "RUNNING" || st === "PAUSE" || st === "PREPARE") this.finish("FAILED", CANCEL_ERROR);
        break;
      case "print_speed":
        this.raw.spd_lvl = Number(p.param);
        break;
      case "gcode_line":
        for (const line of String(p.param).split("\n").filter(Boolean)) {
          this.gcodeLog.push(line);
          const v = Number(/S(\d+(?:\.\d+)?)/.exec(line)?.[1]);
          if (/^M104|^M109/.test(line)) this.raw.nozzle_target_temper = v;
          else if (/^M140|^M190/.test(line)) this.raw.bed_target_temper = v;
          else if (/^M106/.test(line)) this.raw.cooling_fan_speed = String(Math.round((v / 255) * 15));
          else if (/^M107/.test(line)) this.raw.cooling_fan_speed = "0";
          else if (/^G[01]\b/.test(line)) this.move(line);
        }
        break;
      case "project_file": {
        this.startRequests.push(p);
        const file = String(p.url).replace("file:///sdcard", "");
        const busy = st === "RUNNING" || st === "PAUSE" || st === "PREPARE";
        if (busy || this.faults.has("reject_start") || !fs.existsSync(path.join(this.root, file)))
          return { ok: false, reason: busy ? "busy" : this.faults.has("reject_start") ? "rejected by simulator" : "file not found" };
        if (this.faults.has("no_start")) break;
        this.progress = 0;
        Object.assign(this.raw, {
          gcode_state: "PREPARE",
          subtask_name: p.subtask_name,
          gcode_file: p.file ?? p.subtask_name,
          total_layer_num: this.opts.totalLayers,
          layer_num: 0,
          mc_percent: 0,
          mc_remaining_time: this.opts.printMinutes,
          print_error: 0,
          nozzle_target_temper: 220,
          bed_target_temper: 60,
          cooling_fan_speed: "0",
        });
        break;
      }
    }
    return { ok: true };
  }

  /** Absolute-mode G0/G1: update the toolhead and push or crash into the part. */
  private move(line: string): void {
    const ax = (k: string) => {
      const m = new RegExp(`${k}(-?\\d+(?:\\.\\d+)?)`, "i").exec(line);
      return m ? Number(m[1]) : undefined;
    };
    const from = { ...this.pos };
    const to = { x: ax("X") ?? from.x, y: ax("Y") ?? from.y, z: ax("Z") ?? from.z };
    this.pos = to;
    const part = this.part;
    if (!part || to.z > part.h) return;
    const bedMax = this.config.model.toUpperCase() === "A1 MINI" ? 180 : 256;
    const inX = (x: number) => Math.abs(x - part.x) <= part.w / 2;
    const inY = (y: number) => Math.abs(y - part.y) <= part.d / 2;
    const [y0, y1] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
    const overlapsY = y1 >= part.y - part.d / 2 && y0 <= part.y + part.d / 2;
    if (from.x !== to.x) {
      const [x0, x1] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
      if (x1 >= part.x - part.w / 2 && x0 <= part.x + part.w / 2 && inY(from.y)) this.crashes++;
      return;
    }
    if (from.y !== to.y && inX(to.x) && overlapsY && !this.faults.has("stuck_part")) {
      const dir = Math.sign(to.y - from.y);
      part.y = to.y + (dir * part.d) / 2; // pushed ahead of the nozzle
      if (part.y > bedMax || part.y < 0) { // centre of mass past the edge: it falls
        this.part = null;
        this.ejected++;
      }
    }
  }

  private finish(state: "FINISH" | "FAILED", error = 0): void {
    if (state === "FINISH" && !this.faults.has("no_part")) this.part = { x: 128, y: 128, w: 40, d: 40, h: 20 };
    Object.assign(this.raw, {
      gcode_state: state,
      print_error: error,
      nozzle_target_temper: 0,
      bed_target_temper: 0,
      cooling_fan_speed: "0",
      mc_remaining_time: 0,
    });
    if (state === "FINISH") Object.assign(this.raw, { mc_percent: 100, layer_num: this.opts.totalLayers });
  }

  private tick(): void {
    const now = Date.now();
    const dt = (now - this.lastTick) * this.opts.speed; // simulated ms
    this.lastTick = now;
    const r = this.raw;
    const sec = dt / 1000;
    const approach = (cur: number, target: number, rate: number) => {
      const goal = target > 0 ? target : AMBIENT;
      const step = rate * sec;
      return Math.abs(goal - cur) <= step ? goal : cur + Math.sign(goal - cur) * step;
    };
    this.nozzleActual = approach(this.nozzleActual, r.nozzle_target_temper, 6);
    this.bedActual = approach(this.bedActual, r.bed_target_temper, 1.2);

    const reached =
      Math.abs(this.nozzleActual - r.nozzle_target_temper) < 3 && Math.abs(this.bedActual - r.bed_target_temper) < 3;
    if (r.gcode_state === "PREPARE" && reached) {
      r.gcode_state = "RUNNING";
      r.cooling_fan_speed = "15";
    }
    if (r.gcode_state === "RUNNING" && !this.faults.has("stall")) {
      this.progress = Math.min(100, this.progress + (dt / this.printMs) * 100);
      r.mc_percent = Math.floor(this.progress);
      r.layer_num = Math.floor((this.progress / 100) * this.opts.totalLayers);
      r.mc_remaining_time = Math.ceil(((100 - this.progress) / 100) * this.opts.printMinutes);
      if (this.progress >= 100) this.finish("FINISH");
    }

    let nozzle = this.nozzleActual;
    if (r.gcode_state === "RUNNING" || r.gcode_state === "PAUSE") {
      if (this.faults.has("heater_drift")) nozzle = r.nozzle_target_temper - 40;
      if (this.faults.has("overtemp")) nozzle = r.nozzle_target_temper + 50;
    }
    r.nozzle_temper = Math.round(nozzle * 10) / 10;
    r.bed_temper = Math.round(this.bedActual * 10) / 10;

    // A1 only sends what changed.
    const delta: Raw = {};
    for (const k of Object.keys(r)) if (JSON.stringify(r[k]) !== JSON.stringify(this.sent[k])) delta[k] = r[k];
    if (Object.keys(delta).length) {
      this.publishReport({ ...delta, command: "push_status", sequence_id: String(this.seqCounter++) });
      this.sent = structuredClone(r);
    }
  }

  private serveCamera(sock: tls.TLSSocket): void {
    let authed = false;
    let buf = Buffer.alloc(0);
    sock.on("error", () => {});
    sock.on("data", (d) => {
      if (authed) return;
      buf = Buffer.concat([buf, d]);
      if (buf.length < 80) return;
      const user = buf.subarray(16, 48).toString("ascii").replace(/\0+$/, "");
      const pass = buf.subarray(48, 80).toString("ascii").replace(/\0+$/, "");
      if (user !== "bblp" || pass !== this.opts.accessCode) return void sock.destroy();
      authed = true;
      const send = () => {
        const label = this.faults.has("spaghetti") ? "scene=spaghetti" : `scene=ok plate=${this.part ? "part" : "empty"} layer=${this.raw.layer_num}`;
        const jpg = frame(label, this.faults.has("spaghetti") ? "spaghetti" : this.part ? "part" : "empty");
        const header = Buffer.alloc(16);
        header.writeUInt32LE(jpg.length, 0);
        if (!sock.destroyed) sock.write(Buffer.concat([header, jpg]));
      };
      send();
      const t = setInterval(send, 200);
      this.frameTimers.add(t);
      sock.on("close", () => {
        clearInterval(t);
        this.frameTimers.delete(t);
      });
    });
  }
}

const silent: any = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => silent,
};

/** Read the scene label back out of a simulator JPEG (for tests). */
export function frameLabel(jpeg: Buffer): string {
  const i = jpeg.indexOf(Buffer.from([0xff, 0xfe]));
  if (i < 0) return "";
  const len = jpeg.readUInt16BE(i + 2);
  return jpeg.subarray(i + 4, i + 2 + len).toString("ascii");
}
