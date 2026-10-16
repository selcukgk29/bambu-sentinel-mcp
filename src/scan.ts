/**
 * Find Bambu printers without SSDP: try the MQTT-over-TLS port (8883) on every address of the local
 * subnet and look at the TLS certificate. As far as we know a Bambu printer's MQTT certificate is issued
 * by a "BBL" CA and carries the printer's serial number as its common name; that is what `bambu` means
 * below. Nothing here is verified against real hardware, so an unrecognised certificate is reported as
 * a candidate (`bambu: false`) instead of being dropped.
 *
 * Only private address ranges are scanned (RFC 1918 and link-local), never the internet.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as tls from "node:tls";

export interface ScanHit {
  ip: string;
  port: number;
  /** Serial number from the certificate's common name, when it looks like one. */
  serial: string | null;
  /** Certificate subject common name and issuer, for the user to judge unknown devices. */
  commonName: string;
  issuer: string;
  /** The certificate looks like a Bambu printer's. */
  bambu: boolean;
}

const MAX_HOSTS = 1024;
const SERIAL = /^[0-9A-Z]{10,20}$/;

const toInt = (ip: string): number => ip.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
const toIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** RFC 1918 and link-local: ranges it is safe to probe. */
export function isPrivate(ip: string): boolean {
  const n = toInt(ip);
  const inRange = (base: string, bits: number) => (n >>> (32 - bits)) === (toInt(base) >>> (32 - bits));
  return inRange("10.0.0.0", 8) || inRange("172.16.0.0", 12) || inRange("192.168.0.0", 16) || inRange("169.254.0.0", 16);
}

/** Host addresses of a CIDR block (network and broadcast excluded). Rejects public ranges and anything over 1024 hosts. */
export function cidrHosts(cidr: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) throw new Error(`"${cidr}" geçerli bir CIDR değil (örn. 192.168.1.0/24)`);
  const bits = Number(m[5]);
  const base = m.slice(1, 5).join(".");
  if (!isPrivate(base)) throw new Error(`${cidr}: yalnızca özel ağ aralıkları taranır (192.168.x.x, 10.x.x.x, 172.16-31.x.x)`);
  const size = 2 ** (32 - bits);
  if (size - 2 > MAX_HOSTS) throw new Error(`${cidr}: en fazla ${MAX_HOSTS} adres taranabilir (/22 ya da daha küçük)`);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const network = (toInt(base) & mask) >>> 0;
  if (size <= 2) return size === 2 ? [toIp(network), toIp(network + 1)] : [toIp(network)]; // /31 and /32 have no broadcast
  return Array.from({ length: size - 2 }, (_, i) => toIp(network + 1 + i));
}

/** The subnets this machine is on (IPv4, non-loopback). A subnet larger than /22 is narrowed to the /24 around our address. */
export function localSubnets(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces))
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || !isPrivate(i.address)) continue;
      const bits = i.cidr ? Number(i.cidr.split("/")[1]) : 24;
      const useBits = bits >= 22 ? bits : 24;
      const mask = (~0 << (32 - useBits)) >>> 0;
      out.add(`${toIp((toInt(i.address) & mask) >>> 0)}/${useBits}`);
    }
  return [...out];
}

/** Open a TLS connection and read the peer certificate; null when the port is closed or does not speak TLS. */
function probe(ip: string, port: number, timeoutMs: number): Promise<ScanHit | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: ScanHit | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const socket = tls.connect({ host: ip, port, rejectUnauthorized: false, timeout: timeoutMs });
    const timer = setTimeout(() => finish(null), timeoutMs + 300);
    socket.on("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const cn = String(cert?.subject?.CN ?? "");
      const issuer = [cert?.issuer?.O, cert?.issuer?.CN].filter(Boolean).join(" / ");
      const serial = SERIAL.test(cn) ? cn : null;
      const bbl = /BBL|bambu/i.test(`${issuer} ${cert?.subject?.O ?? ""}`);
      finish({ ip, port, serial, commonName: cn, issuer, bambu: bbl });
    });
    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
  });
}

export interface ScanOptions {
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
}

/** Probe the given addresses; returns every one that answers with a TLS certificate on `port`. */
export async function scanHosts(hosts: string[], opts: ScanOptions = {}): Promise<ScanHit[]> {
  const { port = 8883, timeoutMs = 700, concurrency = 96 } = opts;
  const hits: ScanHit[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const ip = hosts[next++]!;
      const hit = await probe(ip, port, timeoutMs);
      if (hit) hits.push(hit);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return hits.sort((a, b) => toInt(a.ip) - toInt(b.ip));
}

/** Scan the given CIDR blocks, or every local subnet when none are given. */
export async function scanNetwork(cidrs?: string[], opts: ScanOptions = {}): Promise<{ ranges: string[]; hits: ScanHit[] }> {
  const ranges = cidrs?.length ? cidrs : localSubnets();
  const hosts = [...new Set(ranges.flatMap(cidrHosts))];
  return { ranges, hits: await scanHosts(hosts, opts) };
}
