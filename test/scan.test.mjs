import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as tls from "node:tls";
import { generate } from "selfsigned";

const { cidrHosts, localSubnets, isPrivate, scanHosts } = await import("../dist/scan.js");

test("cidrHosts: host addresses only, private ranges only, bounded size", () => {
  const h = cidrHosts("192.168.1.0/24");
  assert.equal(h.length, 254);
  assert.deepEqual([h[0], h.at(-1)], ["192.168.1.1", "192.168.1.254"]);
  assert.deepEqual(cidrHosts("192.168.1.77/30"), ["192.168.1.77", "192.168.1.78"]); // network .76 and broadcast .79 excluded
  assert.deepEqual(cidrHosts("10.0.0.9/32"), ["10.0.0.9"]);
  assert.deepEqual(cidrHosts("10.0.0.8/31"), ["10.0.0.8", "10.0.0.9"]);
  assert.equal(cidrHosts("172.20.0.0/22").length, 1022);
  assert.throws(() => cidrHosts("172.20.0.0/21"), /en fazla 1024/);
  assert.throws(() => cidrHosts("8.8.8.0/24"), /özel ağ/);
  assert.throws(() => cidrHosts("1.2.3.0/24"), /özel ağ/);
  assert.throws(() => cidrHosts("192.168.1.0"), /geçerli bir CIDR/);
  assert.throws(() => cidrHosts("192.168.300.0/24"), /geçerli bir CIDR/);
  assert.throws(() => cidrHosts("192.168.1.0/33"), /geçerli bir CIDR/);
});

test("isPrivate and localSubnets", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1"]) assert.equal(isPrivate(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "192.169.0.1", "11.0.0.1"]) assert.equal(isPrivate(ip), false, ip);

  const v4 = (address, cidr, internal = false) => ({ address, family: "IPv4", internal, cidr, netmask: "", mac: "", });
  const subs = localSubnets({
    Wifi: [v4("192.168.1.23", "192.168.1.23/24"), { address: "fe80::1", family: "IPv6", internal: false, cidr: "fe80::1/64" }],
    Lo: [v4("127.0.0.1", "127.0.0.1/8", true)],
    Vpn: [v4("8.8.4.4", "8.8.4.4/24")], // public: never scanned
    Big: [v4("10.1.2.3", "10.1.2.3/8")], // too big: narrowed to the /24 around us
    Small: [v4("172.20.5.9", "172.20.5.9/22")],
    Dup: [v4("192.168.1.50", "192.168.1.50/24")],
  });
  assert.deepEqual(subs.sort(), ["10.1.2.0/24", "172.20.4.0/22", "192.168.1.0/24"]);
});

let certs, servers = [];
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

before(async () => {
  const mk = async (attrs) => { const p = await generate(attrs); return { key: p.private, cert: p.cert }; };
  certs = {
    bambu: await mk([{ name: "commonName", value: "01P00A000000009" }, { name: "organizationName", value: "BBL Technology Co.,Ltd" }]),
    other: await mk([{ name: "commonName", value: "printer.example" }, { name: "organizationName", value: "Someone Else" }]),
  };
});
after(() => { for (const s of servers) s.close(); });

const tlsServer = async (c) => { const s = tls.createServer(c, (sock) => sock.on("error", () => {})); servers.push(s); return listen(s); };

test("scanHosts: recognises a Bambu-style certificate and reports other TLS services as candidates", async () => {
  const bambu = await tlsServer(certs.bambu);
  const [hit] = await scanHosts(["127.0.0.1"], { port: bambu });
  assert.deepEqual([hit.ip, hit.port, hit.serial, hit.commonName, hit.bambu], ["127.0.0.1", bambu, "01P00A000000009", "01P00A000000009", true]);
  assert.match(hit.issuer, /BBL/);

  const other = await tlsServer(certs.other);
  const [o] = await scanHosts(["127.0.0.1"], { port: other });
  assert.deepEqual([o.serial, o.commonName, o.bambu], [null, "printer.example", false]); // listed, but not claimed to be a printer
});

test("scanHosts: closed ports, plain TCP and silent hosts are skipped quickly", async () => {
  const plain = net.createServer((s) => { s.on("error", () => {}); s.write("hello\r\n"); }); // answers, but not with TLS
  servers.push(plain);
  const plainPort = await listen(plain);
  const silent = net.createServer((s) => s.on("error", () => {})); // accepts and says nothing: the handshake hangs
  servers.push(silent);
  const silentPort = await listen(silent);
  const closed = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

  const t0 = Date.now();
  for (const port of [plainPort, silentPort, closed]) assert.deepEqual(await scanHosts(["127.0.0.1"], { port, timeoutMs: 400 }), []);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test("scanHosts: many hosts at once, results sorted by address", async () => {
  const server = tls.createServer(certs.bambu, (sock) => sock.on("error", () => {}));
  servers.push(server);
  const bambu = await new Promise((r) => server.listen(0, "0.0.0.0", () => r(server.address().port))); // bound to every address: 127.0.0.x all reach it
  const hosts = ["127.0.0.3", "127.0.0.2", "127.0.0.1", "127.0.0.9"];
  const hits = await scanHosts(hosts, { port: bambu, concurrency: 2 });
  assert.deepEqual(hits.map((h) => h.ip), ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.9"]);
  assert.ok(hits.every((h) => h.bambu));
});
