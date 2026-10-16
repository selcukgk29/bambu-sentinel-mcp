/**
 * Workshop and device management, shared by the MCP tools and the web API so both enforce the same
 * rules. Access codes go in but never come out.
 */
import type { Config } from "./context.js";
import { resolveCost, type CostSettings } from "./cost.js";
import type { Spool } from "./db.js";
import { isActive } from "./printer/state.js";
import type { PrinterConfig } from "./types.js";

export class AdminError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface Workshop {
  id: string;
  name: string;
  description?: string;
}

export interface DeviceInput {
  id?: string;
  name?: string;
  workshop?: string;
  host: string;
  serial: string;
  accessCode: string;
  model?: string;
}

/** A device as shown to clients: everything but the access code. */
export interface PublicDevice {
  id: string;
  name: string;
  workshop: string;
  host: string;
  serial: string;
  model: string;
}

export const DEFAULT_WORKSHOP: Workshop = { id: "main", name: "Ana Atölye" };

/** Lower-case ASCII slug; Turkish letters are folded (ş→s, ı→i, ...). */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "x"
  );
}

const uniqueId = (base: string, taken: Set<string>): string => {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
  return id;
};

const workshopsOf = (ctx: Config): Workshop[] => (ctx.file.workshops ??= [{ ...DEFAULT_WORKSHOP }]);

export const defaultWorkshopId = (ctx: Config): string => workshopsOf(ctx)[0]?.id ?? DEFAULT_WORKSHOP.id;

/** The workshop a device belongs to; unknown or missing ids fall back to the first workshop. */
export function workshopOf(ctx: Config, cfg: PrinterConfig): string {
  const list = workshopsOf(ctx);
  return list.some((w) => w.id === cfg.workshop) ? cfg.workshop! : defaultWorkshopId(ctx);
}

export const publicDevice = (ctx: Config, c: PrinterConfig): PublicDevice => ({
  id: c.id,
  name: c.name,
  workshop: workshopOf(ctx, c),
  host: c.host,
  serial: c.serial,
  model: c.model,
});

// ---- workshops ---------------------------------------------------------------------

const cleanName = (v: unknown, what: string, max = 60): string => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) throw new AdminError(`${what} boş olamaz`);
  if (s.length > max) throw new AdminError(`${what} en fazla ${max} karakter olabilir`);
  return s;
};

export function createWorkshop(ctx: Config, input: { name: string; description?: string }): Workshop {
  const name = cleanName(input.name, "Atölye adı");
  const list = workshopsOf(ctx);
  if (list.some((w) => w.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))) throw new AdminError("Bu adda bir atölye zaten var", 409);
  const w: Workshop = { id: uniqueId(slug(name), new Set(list.map((x) => x.id))), name };
  if (input.description?.trim()) w.description = cleanName(input.description, "Açıklama", 200);
  list.push(w);
  ctx.save();
  return w;
}

export function updateWorkshop(ctx: Config, id: string, patch: { name?: string; description?: string }): Workshop {
  const w = workshopsOf(ctx).find((x) => x.id === id);
  if (!w) throw new AdminError("Atölye bulunamadı", 404);
  if (patch.name !== undefined) {
    const name = cleanName(patch.name, "Atölye adı");
    if (workshopsOf(ctx).some((x) => x.id !== id && x.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))) throw new AdminError("Bu adda bir atölye zaten var", 409);
    w.name = name;
  }
  if (patch.description !== undefined) {
    if (patch.description.trim()) w.description = cleanName(patch.description, "Açıklama", 200);
    else delete w.description;
  }
  ctx.save();
  return w;
}

/** Remove a workshop; its devices move to the first remaining one. The last workshop cannot be deleted. */
export function deleteWorkshop(ctx: Config, id: string): { moved: number; movedTo: string } {
  const list = workshopsOf(ctx);
  if (!list.some((w) => w.id === id)) throw new AdminError("Atölye bulunamadı", 404);
  if (list.length === 1) throw new AdminError("Son atölye silinemez", 409);
  ctx.file.workshops = list.filter((w) => w.id !== id);
  const target = ctx.file.workshops[0]!.id;
  let moved = 0;
  // Every known config: the saved list plus live printers that may not be in it (e.g. defined by environment variables).
  for (const p of new Set([...ctx.file.printers, ...ctx.fleet.list().map((x) => x.config)])) {
    if (p.workshop === id) {
      p.workshop = target;
      moved++;
    }
  }
  ctx.save();
  return { moved, movedTo: target };
}

// ---- devices -----------------------------------------------------------------------

const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/i;
const SERIAL_RE = /^[A-Za-z0-9]{6,32}$/;
const CODE_RE = /^[\x21-\x7e]{1,32}$/;

function validate(input: Partial<DeviceInput>, requireAll: boolean): void {
  const need = (k: keyof DeviceInput) => requireAll && (input[k] === undefined || input[k] === "");
  if (need("host") || (input.host !== undefined && !HOST_RE.test(input.host))) throw new AdminError("Geçerli bir IP adresi ya da ana makine adı girin");
  if (input.host && /^\d+(\.\d+){3}$/.test(input.host) && input.host.split(".").some((n) => Number(n) > 255)) throw new AdminError("Geçersiz IP adresi");
  if (need("serial") || (input.serial !== undefined && !SERIAL_RE.test(input.serial))) throw new AdminError("Seri numarası 6-32 harf/rakam olmalı");
  if (need("accessCode") || (input.accessCode !== undefined && !CODE_RE.test(input.accessCode))) throw new AdminError("Erişim kodu boşluksuz, 1-32 karakter olmalı");
  if (input.model !== undefined && !/^[\w .-]{1,16}$/.test(input.model)) throw new AdminError("Model adı geçersiz");
}

const findConfig = (ctx: Config, id: string): PrinterConfig | undefined =>
  ctx.file.printers.find((p) => p.id === id) ?? ctx.fleet.list().find((p) => p.id === id)?.config;

export function addDevice(ctx: Config, input: DeviceInput): PublicDevice {
  validate(input, true);
  const name = input.name?.trim() ? cleanName(input.name, "Cihaz adı") : "";
  const taken = new Set([...ctx.file.printers.map((p) => p.id), ...ctx.fleet.list().map((p) => p.id)]);
  let id = input.id?.trim();
  if (id) {
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) throw new AdminError("Kimlik yalnızca harf, rakam, - ve _ içerebilir");
    if (taken.has(id)) throw new AdminError("Bu kimlik zaten kullanılıyor", 409);
  } else {
    id = uniqueId(slug(name || input.model || "cihaz"), taken);
  }
  const serials = new Set([...ctx.file.printers.map((p) => p.serial), ...ctx.fleet.list().map((p) => p.config.serial)]);
  if (serials.has(input.serial)) throw new AdminError("Bu seri numarası zaten ekli", 409);
  const workshops = workshopsOf(ctx);
  if (input.workshop && !workshops.some((w) => w.id === input.workshop)) throw new AdminError("Atölye bulunamadı", 404);

  const cfg: PrinterConfig = {
    id,
    name: name || id,
    host: input.host,
    serial: input.serial,
    accessCode: input.accessCode,
    model: input.model?.trim() || "A1",
    workshop: input.workshop ?? defaultWorkshopId(ctx),
  };
  ctx.fleet.add(cfg);
  ctx.file.printers.push(cfg);
  ctx.save();
  return publicDevice(ctx, cfg);
}

/** Change a device. Connection details (host, serial, access code, model) reconnect it; name/workshop do not. */
export function updateDevice(ctx: Config, id: string, patch: Partial<Omit<DeviceInput, "id">>): PublicDevice {
  const cfg = findConfig(ctx, id);
  if (!cfg) throw new AdminError("Cihaz bulunamadı", 404);
  validate(patch, false);
  if (patch.workshop !== undefined && !workshopsOf(ctx).some((w) => w.id === patch.workshop)) throw new AdminError("Atölye bulunamadı", 404);
  if (patch.serial && patch.serial !== cfg.serial && ctx.fleet.list().some((p) => p.id !== id && p.config.serial === patch.serial)) throw new AdminError("Bu seri numarası zaten ekli", 409);
  const name = patch.name !== undefined ? cleanName(patch.name, "Cihaz adı") : undefined;

  const wasActive = isActive(ctx.fleet.get(id).state.gcodeState);
  const conn = (["host", "serial", "accessCode", "model"] as const).filter((k) => patch[k] !== undefined && patch[k] !== "" && patch[k] !== cfg[k]);
  if (conn.length && wasActive) throw new AdminError("Makine şu an basıyor; bağlantı bilgileri baskı bitince değiştirilebilir", 409);

  if (name !== undefined) cfg.name = name;
  if (patch.workshop !== undefined) cfg.workshop = patch.workshop;
  if (conn.length) {
    ctx.fleet.remove(id);
    for (const k of conn) cfg[k] = (patch[k] as string).trim();
    ctx.fleet.add(cfg);
  }
  ctx.save();
  return publicDevice(ctx, cfg);
}

/** Stop managing a device. History stays in the database. Refuses while it is printing unless forced. */
export function removeDevice(ctx: Config, id: string, force = false): void {
  const cfg = findConfig(ctx, id);
  if (!cfg) throw new AdminError("Cihaz bulunamadı", 404);
  if (!force && isActive(ctx.fleet.get(id).state.gcodeState)) throw new AdminError("Makine şu an basıyor; önce baskıyı bitirin ya da zorla silin", 409);
  ctx.fleet.remove(id);
  ctx.file.printers = ctx.file.printers.filter((p) => p.id !== id);
  ctx.save();
}

// ---- raw material (spools) ----------------------------------------------------------------

export interface SpoolInput {
  type: string;
  name?: string;
  color?: string;
  brand?: string;
  weightG: number;
  remainingG?: number;
  pricePerKg?: number;
  printerId?: string;
  slot?: number;
}

const num = (v: unknown, what: string, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new AdminError(`${what} ${min} ile ${max} arasında bir sayı olmalı`);
  return n;
};
const matType = (v: unknown): string => {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9 +-]{0,15}$/.test(t)) throw new AdminError("Malzeme türü 1-16 karakter olmalı (örn. PLA, PETG)");
  return t;
};
const colorOf = (v: unknown): string | null => {
  const c = typeof v === "string" ? v.trim().replace(/^#/, "").toUpperCase() : "";
  if (!c) return null;
  if (!/^[0-9A-F]{6}$/.test(c)) throw new AdminError("Renk 6 haneli HEX olmalı (örn. FF0000)");
  return c;
};

function checkSlot(ctx: Config, printerId: string, slot: number): void {
  if (!ctx.fleet.list().some((p) => p.id === printerId)) throw new AdminError("Makine bulunamadı", 404);
  if (!Number.isInteger(slot) || !((slot >= 0 && slot <= 15) || slot === 254)) throw new AdminError("Slot 0-15 ya da 254 (harici makara) olmalı");
}

export function addSpool(ctx: Config, input: SpoolInput): Spool {
  const type = matType(input.type);
  const weight = num(input.weightG, "Ağırlık (g)", 1, 20000);
  const remaining = input.remainingG === undefined || (input.remainingG as unknown) === "" ? weight : num(input.remainingG, "Kalan (g)", 0, 20000);
  const price = input.pricePerKg === undefined || (input.pricePerKg as unknown) === "" ? null : num(input.pricePerKg, "Fiyat (kg başına)", 0, 100000);
  const color = colorOf(input.color);
  const brand = input.brand?.trim() ? cleanName(input.brand, "Marka", 40) : null;
  const name = input.name?.trim() ? cleanName(input.name, "Ad", 60) : `${brand ? brand + " " : ""}${type}${color ? " #" + color : ""}`;
  const hasLoc = input.printerId !== undefined && input.printerId !== "";
  if (hasLoc) checkSlot(ctx, input.printerId!, Number(input.slot));
  const spool = ctx.db.addSpool({ name, type, color, brand, initialG: weight, remainingG: remaining, pricePerKg: price });
  if (hasLoc) ctx.db.assignSpool(spool.id, input.printerId!, Number(input.slot));
  return ctx.db.getSpool(spool.id)!;
}

export function updateSpool(
  ctx: Config,
  id: number,
  patch: { name?: string; type?: string; color?: string; brand?: string; weightG?: number; remainingG?: number; pricePerKg?: number | null; archived?: boolean },
): Spool {
  if (!ctx.db.getSpool(id)) throw new AdminError("Makara bulunamadı", 404);
  const p: Parameters<Config["db"]["updateSpool"]>[1] = {};
  if (patch.name !== undefined) p.name = cleanName(patch.name, "Ad", 60);
  if (patch.type !== undefined) p.type = matType(patch.type);
  if (patch.color !== undefined) p.color = colorOf(patch.color);
  if (patch.brand !== undefined) p.brand = patch.brand.trim() ? cleanName(patch.brand, "Marka", 40) : null;
  if (patch.weightG !== undefined) p.initial_g = num(patch.weightG, "Ağırlık (g)", 1, 20000);
  if (patch.remainingG !== undefined) p.remaining_g = num(patch.remainingG, "Kalan (g)", 0, 20000);
  if (patch.pricePerKg !== undefined && patch.pricePerKg !== null) p.price_per_kg = num(patch.pricePerKg, "Fiyat (kg başına)", 0, 100000);
  if (patch.archived !== undefined) p.archived = !!patch.archived;
  ctx.db.updateSpool(id, p);
  return ctx.db.getSpool(id)!;
}

/** Load a spool into a printer slot (replacing what was there) or unload it (printerId null). */
export function assignSpool(ctx: Config, id: number, printerId: string | null, slot: number | null): Spool {
  if (!ctx.db.getSpool(id)) throw new AdminError("Makara bulunamadı", 404);
  if (printerId === null || slot === null) ctx.db.assignSpool(id, null, null);
  else {
    checkSlot(ctx, printerId, slot);
    ctx.db.assignSpool(id, printerId, slot);
  }
  return ctx.db.getSpool(id)!;
}

// ---- cost settings -------------------------------------------------------------------------

export function setCostSettings(ctx: Config, patch: Partial<CostSettings>): CostSettings {
  const cur: CostSettings = resolveCost(ctx.file.settings.cost);
  const next: CostSettings = { ...cur, filamentPricePerKg: { ...cur.filamentPricePerKg } };
  if (patch.currency !== undefined) {
    const c = String(patch.currency).trim();
    if (!c || c.length > 8) throw new AdminError("Para birimi 1-8 karakter olmalı");
    next.currency = c;
  }
  if (patch.electricityPerKwh !== undefined) next.electricityPerKwh = num(patch.electricityPerKwh, "Elektrik fiyatı (kWh)", 0, 1000);
  if (patch.printingWatts !== undefined) next.printingWatts = num(patch.printingWatts, "Yazıcı gücü (W)", 1, 3000);
  if (patch.machineWearPerHour !== undefined) next.machineWearPerHour = num(patch.machineWearPerHour, "Makine aşınması (saat başı)", 0, 100000);
  if (patch.perPrint !== undefined) next.perPrint = num(patch.perPrint, "Baskı başı gider", 0, 100000);
  if (patch.filamentPricePerKg !== undefined) {
    const entries = Object.entries(patch.filamentPricePerKg);
    if (entries.length > 30) throw new AdminError("En fazla 30 malzeme türü tanımlanabilir");
    const prices: Record<string, number> = {};
    for (const [k, v] of entries) {
      const lower = k.trim().toLocaleLowerCase("tr");
      const key = ["default", "diğer", "diger", "varsayılan"].includes(lower) ? "default" : matType(k);
      prices[key] = num(v, `${key} fiyatı`, 0, 100000);
    }
    if (prices.default === undefined) prices.default = cur.filamentPricePerKg.default ?? 25;
    next.filamentPricePerKg = prices; // the table is replaced as a whole: removed rows disappear
  }
  ctx.file.settings.cost = next;
  ctx.save();
  return next;
}
