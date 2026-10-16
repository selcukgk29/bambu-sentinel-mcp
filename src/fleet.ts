import { EventEmitter } from "node:events";
import { Printer } from "./printer/printer.js";
import type { PrinterConfig, PrinterEvent } from "./types.js";

export class Fleet extends EventEmitter {
  private printers = new Map<string, Printer>();

  add(cfg: PrinterConfig): Printer {
    if (this.printers.has(cfg.id)) throw new Error(`printer id already exists: ${cfg.id}`);
    const p = new Printer(cfg);
    p.on("event", (e: PrinterEvent) => this.emit("event", e));
    this.printers.set(cfg.id, p);
    p.connect();
    return p;
  }

  remove(id: string): boolean {
    const p = this.printers.get(id);
    if (!p) return false;
    p.disconnect();
    p.removeAllListeners();
    return this.printers.delete(id);
  }

  list(): Printer[] {
    return [...this.printers.values()];
  }

  /** Resolve an optional id; with exactly one printer the id may be omitted. */
  get(id?: string): Printer {
    if (id) {
      const p = this.printers.get(id);
      if (!p) throw new Error(`unknown printer: ${id} (known: ${[...this.printers.keys()].join(", ") || "none"})`);
      return p;
    }
    if (this.printers.size === 1) return [...this.printers.values()][0]!;
    throw new Error(
      this.printers.size === 0
        ? "no printers configured; use add_printer"
        : `multiple printers configured; specify printer_id (${[...this.printers.keys()].join(", ")})`,
    );
  }

  shutdown(): void {
    for (const p of this.printers.values()) p.disconnect();
  }
}
