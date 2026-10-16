/**
 * Find Bambu printers on the LAN. They announce themselves over SSDP (UDP multicast 239.255.255.250,
 * port 1990; Bambu Studio also listens on 2021). The access code is never broadcast: it has to be
 * read from the printer's screen.
 */
import * as dgram from "node:dgram";

export interface Discovered {
  ip: string;
  serial: string;
  name: string;
  /** Marketing name when the model code is known, else the raw code. */
  model: string;
  modelCode: string;
  firmware: string;
  connectMode: string;
}

const MODELS: Record<string, string> = {
  N2S: "A1",
  N1: "A1 Mini",
  C12: "P1S",
  C11: "P1P",
  "BL-P001": "X1C",
  "BL-P002": "X1",
  C13: "X1E",
  O1D: "H2D",
};

const SSDP_ADDR = "239.255.255.250";
const SEARCH =
  `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:1990\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n`;

/** Parse one SSDP datagram; null when it is not a Bambu printer. */
export function parseSsdp(msg: string, fromIp: string): Discovered | null {
  const h: Record<string, string> = {};
  for (const line of msg.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const kind = `${h["nt"] ?? ""} ${h["st"] ?? ""}`.toLowerCase();
  if (!kind.includes("bambulab")) return null;
  const serial = h["usn"];
  if (!serial) return null;
  const code = h["devmodel.bambu.com"] ?? "";
  return {
    ip: h["location"] || fromIp,
    serial,
    name: h["devname.bambu.com"] ?? serial,
    model: MODELS[code] ?? (code || "unknown"),
    modelCode: code,
    firmware: h["devversion.bambu.com"] ?? "",
    connectMode: h["devconnect.bambu.com"] ?? "",
  };
}

export interface DiscoverOptions {
  timeoutMs?: number;
  ports?: number[];
  /** Join the SSDP multicast group and send a search (disable in tests). */
  multicast?: boolean;
  bindAddress?: string;
}

export function discover(opts: DiscoverOptions = {}): Promise<Discovered[]> {
  const { timeoutMs = 6000, ports = [1990, 2021], multicast = true, bindAddress } = opts;
  const found = new Map<string, Discovered>();
  const sockets: dgram.Socket[] = [];
  const errors: string[] = [];

  return new Promise((resolve) => {
    const finish = () => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()]);
    };

    let pending = ports.length;
    for (const port of ports) {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(sock);
      sock.on("message", (buf, rinfo) => {
        const d = parseSsdp(buf.toString("utf8"), rinfo.address);
        if (d) found.set(d.serial, d);
      });
      sock.on("error", (e) => {
        errors.push(`port ${port}: ${e.message}`);
        if (--pending === 0 && found.size === 0) finish();
      });
      sock.bind(port, bindAddress, () => {
        if (!multicast) return;
        try {
          sock.addMembership(SSDP_ADDR);
          if (port === 1990) sock.send(SEARCH, 1990, SSDP_ADDR, () => {});
        } catch (e) {
          errors.push(`multicast on ${port}: ${(e as Error).message}`);
        }
      });
    }
    setTimeout(finish, timeoutMs).unref();
  });
}
