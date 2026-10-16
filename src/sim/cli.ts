#!/usr/bin/env node
/** Run a standalone fake A1: `npm run sim`. Type `fault <name>`, `clear`, or `quit` on stdin. */
import * as readline from "node:readline";
import { PrinterSimulator, type Fault } from "./simulator.js";

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const sim = await PrinterSimulator.start({
  speed: arg("speed", 60),
  printMinutes: arg("minutes", 30),
  ports: { mqtt: arg("mqtt", 18883), ftp: arg("ftp", 10990), camera: arg("camera", 16000) },
});
const c = sim.config;
console.log(`Simulated A1 running. Connect with add_printer:
  id=sim host=${c.host} serial=${c.serial} access_code=${c.accessCode} model=${c.model} ports=${JSON.stringify(c.ports)}
or env: BAMBU_HOST=127.0.0.1 BAMBU_SERIAL=${c.serial} BAMBU_ACCESS_CODE=${c.accessCode} BAMBU_MQTT_PORT=${c.ports!.mqtt} BAMBU_FTP_PORT=${c.ports!.ftp} BAMBU_CAMERA_PORT=${c.ports!.camera}
Commands: fault heater_drift|overtemp|stall|hms|spaghetti|stuck_part|no_part, clear, quit`);

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const [cmd, a] = line.trim().split(/\s+/);
  if (cmd === "fault" && a) sim.injectFault(a as Fault);
  else if (cmd === "clear") sim.clearFaults();
  else if (cmd === "quit") {
    await sim.stop();
    process.exit(0);
  }
});
