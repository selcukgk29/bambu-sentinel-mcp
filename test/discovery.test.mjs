import test from "node:test";
import assert from "node:assert/strict";
import * as dgram from "node:dgram";

const { parseSsdp, discover } = await import("../dist/discovery.js");

const NOTIFY = [
  "NOTIFY * HTTP/1.1",
  "HOST: 239.255.255.250:1990",
  "Server: UPnP/1.0",
  "Location: 192.168.1.50",
  "NT: urn:bambulab-com:device:3dprinter:1",
  "NTS: ssdp:alive",
  "USN: 0309EA000000001",
  "Cache-Control: max-age=1800",
  "DevModel.bambu.com: N2S",
  "DevName.bambu.com: Workshop A1",
  "DevSignal.bambu.com: -45",
  "DevConnect.bambu.com: lan",
  "DevBind.bambu.com: free",
  "DevVersion.bambu.com: 01.05.00.00",
  "",
  "",
].join("\r\n");

test("parse a printer announcement", () => {
  assert.deepEqual(parseSsdp(NOTIFY, "10.0.0.9"), {
    ip: "192.168.1.50", serial: "0309EA000000001", name: "Workshop A1", model: "A1", modelCode: "N2S", firmware: "01.05.00.00", connectMode: "lan",
  });
  // no Location header: fall back to the sender address; unknown model code is passed through
  const bare = NOTIFY.replace("Location: 192.168.1.50\r\n", "").replace("N2S", "ZZZ");
  assert.equal(parseSsdp(bare, "10.0.0.9").ip, "10.0.0.9");
  assert.equal(parseSsdp(bare, "10.0.0.9").model, "ZZZ");
});

test("ignore other devices and malformed packets", () => {
  assert.equal(parseSsdp("NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nUSN: uuid:x\r\n\r\n", "1.2.3.4"), null);
  assert.equal(parseSsdp("garbage", "1.2.3.4"), null);
  assert.equal(parseSsdp(NOTIFY.replace("USN: 0309EA000000001\r\n", ""), "1.2.3.4"), null);
});

test("discover collects announcements arriving on the listening port (deduplicated)", async () => {
  const port = await new Promise((r) => { const s = dgram.createSocket("udp4"); s.bind(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const search = discover({ ports: [port], multicast: false, bindAddress: "127.0.0.1", timeoutMs: 500 });
  await new Promise((r) => setTimeout(r, 100));
  const sender = dgram.createSocket("udp4");
  const other = NOTIFY.replace("0309EA000000001", "0309EA000000002").replace("Workshop A1", "Second");
  for (const msg of [NOTIFY, NOTIFY, other, "junk"]) await new Promise((r) => sender.send(msg, port, "127.0.0.1", r));
  sender.close();
  const found = await search;
  assert.deepEqual(found.map((d) => d.serial).sort(), ["0309EA000000001", "0309EA000000002"]);
});

test("discover returns an empty list when nothing answers", async () => {
  assert.deepEqual(await discover({ ports: [0], multicast: false, bindAddress: "127.0.0.1", timeoutMs: 200 }), []);
});
