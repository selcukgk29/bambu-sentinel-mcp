import * as fs from "node:fs";
import { unzipSync } from "fflate";
import type { FilamentRequirement, PlateObject } from "./types.js";

export interface PlateInfo {
  index: number;
  predictionSec: number | null;
  weightG: number | null;
  filaments: (Omit<FilamentRequirement, "usedG"> & { usedG: number | null })[];
  /** Object footprints on the plate (mm), when the file carries Metadata/plate_N.json. */
  objects: PlateObject[];
}

export interface ThreeMfInfo {
  plates: PlateInfo[];
  hasGcode: boolean;
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const metaVal = (xml: string, key: string): string | undefined =>
  new RegExp(`<metadata[^>]*\\bkey="${key}"[^>]*\\bvalue="([^"]*)"`).exec(xml)?.[1];

function parseObjects(raw: Uint8Array | undefined): PlateObject[] {
  if (!raw) return [];
  try {
    const json = JSON.parse(new TextDecoder().decode(raw));
    return (json.bbox_objects ?? [])
      .filter((o: any) => Array.isArray(o?.bbox) && o.bbox.length >= 4 && o.bbox.slice(0, 4).every(Number.isFinite))
      .map((o: any) => ({ name: String(o.name ?? ""), bbox: o.bbox.slice(0, 4) as PlateObject["bbox"] }));
  } catch {
    return [];
  }
}

/** Parse sliced-plate metadata out of a Bambu/Orca 3MF (slice_info.config and plate_N.json). */
export function readThreeMf(file: string): ThreeMfInfo {
  const zip = unzipSync(fs.readFileSync(file), {
    filter: (f) =>
      f.name === "Metadata/slice_info.config" || /^Metadata\/plate_\d+\.(gcode|json)$/.test(f.name),
  });
  const gcode = Object.keys(zip).some((n) => n.endsWith(".gcode"));
  const raw = zip["Metadata/slice_info.config"];
  const plates: PlateInfo[] = [];
  if (raw) {
    const xml = new TextDecoder().decode(raw);
    for (const m of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
      const body = m[1]!;
      const index = parseInt(metaVal(body, "index") ?? "1", 10);
      const filaments = [...body.matchAll(/<filament\b[^>]*\/?>/g)].map((f) => ({
        id: attr(f[0], "id") ? parseInt(attr(f[0], "id")!, 10) : undefined,
        type: attr(f[0], "type") ?? "",
        color: (attr(f[0], "color") ?? "").replace("#", "").slice(0, 6).toUpperCase() || undefined,
        usedG: attr(f[0], "used_g") ? parseFloat(attr(f[0], "used_g")!) : null,
      }));
      plates.push({
        index,
        predictionSec: metaVal(body, "prediction") ? parseInt(metaVal(body, "prediction")!, 10) : null,
        weightG: metaVal(body, "weight") ? parseFloat(metaVal(body, "weight")!) : null,
        filaments,
        objects: parseObjects(zip[`Metadata/plate_${index}.json`]),
      });
    }
  }
  return { plates, hasGcode: gcode };
}

export interface JobInfo {
  filaments: FilamentRequirement[];
  estimateSec: number | null;
  weightG: number | null;
  objects: PlateObject[];
}

/** What a queued job needs, read from its 3MF (empty for plain .gcode). */
export function readJobInfo(file: string, plate: number): JobInfo {
  const empty: JobInfo = { filaments: [], estimateSec: null, weightG: null, objects: [] };
  if (!/\.3mf$/i.test(file)) return empty;
  const info = readThreeMf(file);
  const p = info.plates.find((x) => x.index === plate) ?? info.plates[0];
  if (!p) return empty;
  return {
    filaments: p.filaments.map((f) => ({
      ...(f.id !== undefined ? { id: f.id } : {}),
      type: f.type,
      ...(f.color ? { color: f.color } : {}),
      ...(f.usedG !== null ? { usedG: f.usedG } : {}),
    })),
    estimateSec: p.predictionSec,
    weightG: p.weightG,
    objects: p.objects,
  };
}
