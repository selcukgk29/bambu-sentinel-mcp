import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../context.js";
import { isFree } from "../printer/state.js";
import { matchFilaments } from "../scheduler.js";
import { planUsage, rememberUsage } from "../inventory.js";
import { buildPlan } from "../plan.js";
import { readJobInfo, readThreeMf } from "../threemf.js";
import type { FilamentRequirement } from "../types.js";
import { ackNote, fail, safe, text } from "./util.js";

const pid = z.string().optional().describe("Printer id; may be omitted when only one printer is configured");
const filaments = z
  .array(z.object({ type: z.string(), color: z.string().optional().describe("RRGGBB") }))
  .optional()
  .describe("Required filaments per slot; read from the 3MF when omitted");

const requirementsFrom = (file: string, plate: number): FilamentRequirement[] => readJobInfo(file, plate).filaments;

const when = (t: number | null): string | null => (t == null ? null : new Date(t).toLocaleString());

export function registerJobs(server: McpServer, c: Config): void {
  server.registerTool(
    "inspect_3mf",
    {
      description: "Read a sliced .3mf: plates, estimated print time, filament weight and required filament types/colours.",
      inputSchema: { path: z.string() },
    },
    safe(async ({ path: p }) => text(readThreeMf(p))),
  );

  server.registerTool(
    "list_printer_files",
    { description: "List files on the printer's storage over FTPS.", inputSchema: { printer_id: pid, dir: z.string().default("/") } },
    safe(async ({ printer_id, dir }) => text(await c.fleet.get(printer_id).listFiles(dir))),
  );

  server.registerTool(
    "upload_file",
    {
      description: "Upload a local file to the printer (default /cache/<name>).",
      inputSchema: { printer_id: pid, local_path: z.string(), remote_path: z.string().optional() },
    },
    safe(async ({ printer_id, local_path, remote_path }) => {
      if (!fs.existsSync(local_path)) return fail(`no such file: ${local_path}`);
      return text({ uploaded: await c.fleet.get(printer_id).uploadFile(local_path, remote_path) });
    }),
  );

  server.registerTool(
    "delete_printer_file",
    {
      description: "Delete a file from the printer storage. Requires confirm=true.",
      inputSchema: { printer_id: pid, remote_path: z.string(), confirm: z.boolean() },
      annotations: { destructiveHint: true },
    },
    safe(async ({ printer_id, remote_path, confirm }) => {
      if (!confirm) return fail("delete_printer_file needs confirm=true");
      await c.fleet.get(printer_id).deleteFile(remote_path);
      return text(`deleted ${remote_path}`);
    }),
  );

  server.registerTool(
    "start_print",
    {
      description:
        "Upload a local .3mf/.gcode.3mf and start it now. Filament slots are matched automatically against the loaded AMS trays. You must confirm the build plate is empty (plate_cleared=true).",
      inputSchema: {
        printer_id: pid,
        local_path: z.string(),
        plate: z.number().int().min(1).default(1),
        plate_cleared: z.boolean().describe("Must be true: you checked the plate is empty"),
        filaments,
        ams_mapping: z.array(z.number().int()).optional().describe("Override automatic AMS slot mapping"),
        timelapse: z.boolean().default(false),
        bed_leveling: z.boolean().default(true),
        flow_cali: z.boolean().default(false),
      },
    },
    safe(async (a) => {
      if (!a.plate_cleared) return fail("start_print needs plate_cleared=true");
      const p = c.fleet.get(a.printer_id);
      if (!p.state.online) return fail(`${p.id} is offline`);
      if (!isFree(p.state.gcodeState)) return fail(`${p.id} is busy (${p.state.gcodeState})`);
      if (!fs.existsSync(a.local_path)) return fail(`no such file: ${a.local_path}`);

      let mapping = a.ams_mapping;
      let useAms = (mapping?.length ?? 0) > 0 && mapping!.some((s) => s !== 254);
      const req = a.filaments ?? requirementsFrom(a.local_path, a.plate);
      if (!mapping) {
        const m = matchFilaments(req, p.state.trays, 60, c.scheduler.remainingFor(p));
        if ("reason" in m) return fail(`filament mismatch: ${m.reason}. Loaded: ${JSON.stringify(p.state.trays.map((t) => `${t.slot}:${t.type}#${t.color}`))}`);
        mapping = m.match.amsMapping;
        useAms = m.match.useAms;
      }
      const remote = path.basename(a.local_path);
      await p.uploadFile(a.local_path, `/cache/${remote}`);
      const ack = await p.startAndConfirm(
        {
          file: remote,
          remoteDir: "/cache",
          plate: a.plate,
          useAms,
          amsMapping: mapping,
          timelapse: a.timelapse,
          bedLeveling: a.bed_leveling,
          flowCali: a.flow_cali,
        },
        c.scheduler.startTimeoutMs,
      );
      c.db.setFlag(`plate_clear:${p.id}`, false);
      rememberUsage(c.db, p.id, planUsage(c.db, p.id, req, mapping));
      return text({ started: remote, printer: p.id, state: p.state.gcodeState, ams_mapping: mapping, use_ams: useAms, command: ackNote(ack) });
    }),
  );

  // ---- queue -----------------------------------------------------------------

  server.registerTool(
    "queue_add",
    {
      description:
        "Add a sliced file to the print queue. The scheduler later picks a free printer that has the right filament loaded. Higher priority runs first.",
      inputSchema: {
        file_path: z.string(),
        name: z.string().optional(),
        plate: z.number().int().min(1).default(1),
        printer_id: z.string().optional().describe("Pin to one printer"),
        priority: z.number().int().default(0),
        filaments,
        notes: z.string().optional(),
        max_attempts: z.number().int().min(1).max(5).optional().describe("Print attempts before giving up (default from settings, 2)"),
      },
    },
    safe(async (a) => {
      if (!fs.existsSync(a.file_path)) return fail(`no such file: ${a.file_path}`);
      if (a.printer_id) c.fleet.get(a.printer_id);
      const info = readJobInfo(a.file_path, a.plate);
      const job = c.db.addJob({
        name: a.name ?? path.basename(a.file_path),
        filePath: a.file_path,
        plate: a.plate,
        printerId: a.printer_id ?? null,
        priority: a.priority,
        filaments: a.filaments ?? info.filaments,
        estimateSec: info.estimateSec,
        layout: info.objects,
        notes: a.notes ?? "",
        maxAttempts: a.max_attempts ?? c.file.settings.defaultMaxAttempts,
      });
      return text(job);
    }),
  );

  server.registerTool(
    "queue_list",
    {
      description: "List queue jobs (default: queued and printing).",
      inputSchema: { status: z.array(z.enum(["queued", "printing", "done", "failed", "cancelled"])).optional(), limit: z.number().int().default(50) },
    },
    safe(async ({ status, limit }) => text(c.db.listJobs(status ?? ["queued", "printing"], limit))),
  );

  server.registerTool(
    "queue_eta",
    {
      description:
        "Forecast the queue: which printer each queued job would go to, when it starts and ends, and when everything is done. Uses the slicer's time estimate (3MF), else past runs of the same name, else 60 min. Running prints count with their remaining time.",
      inputSchema: {
        job_id: z.number().int().optional().describe("Only this job (the rest still shapes the plan)"),
        changeover_minutes: z.number().min(0).max(120).optional().describe("Time between jobs for sweeping/clearing; defaults to the sweep estimate when auto_eject is on, else 0"),
      },
    },
    safe(async ({ job_id, changeover_minutes }) => {
      const changeoverSec = (changeover_minutes ?? (c.file.settings.autoEject ? 5 : 0)) * 60;
      const rows = buildPlan(c.fleet, c.db, c.scheduler, { changeoverSec });
      const shown = job_id ? rows.filter((r) => r.jobId === job_id) : rows;
      if (job_id && !shown.length) return fail(`job ${job_id} is not queued`);
      const ends = rows.map((r) => r.endAt).filter((t): t is number => t != null);
      return text({
        all_done_at: when(ends.length ? Math.max(...ends) : null),
        jobs: shown.map((r) => ({
          job: `#${r.jobId} ${r.name}`,
          printer: r.printerId,
          starts: when(r.startAt),
          ends: when(r.endAt),
          minutes: r.durationSec == null ? null : Math.round(r.durationSec / 60),
          estimate_from: r.durationSource,
          note: r.note,
        })),
      });
    }),
  );

  server.registerTool(
    "queue_cancel",
    { description: "Remove a queued job. For a job already printing use stop_print.", inputSchema: { job_id: z.number().int() } },
    safe(async ({ job_id }) => {
      const j = c.db.getJob(job_id);
      if (!j) return fail(`no job ${job_id}`);
      if (j.status !== "queued") return fail(`job is ${j.status}; only queued jobs can be cancelled here`);
      c.db.finishJob(job_id, "cancelled");
      return text(`cancelled #${job_id}`);
    }),
  );

  server.registerTool(
    "queue_set_priority",
    { description: "Change a queued job's priority.", inputSchema: { job_id: z.number().int(), priority: z.number().int() } },
    safe(async ({ job_id, priority }) => {
      if (!c.db.getJob(job_id)) return fail(`no job ${job_id}`);
      c.db.setPriority(job_id, priority);
      return text(`#${job_id} priority ${priority}`);
    }),
  );

  server.registerTool(
    "queue_dispatch",
    {
      description:
        "Start queued jobs on free printers (plate must be confirmed clear). dry_run=true only reports which printer would take each job and why others are rejected.",
      inputSchema: { dry_run: z.boolean().default(true), max_starts: z.number().int().min(1).max(10).default(1) },
    },
    safe(async ({ dry_run, max_starts }) => {
      if (!dry_run) return text(await c.scheduler.dispatch(max_starts));
      return text(
        c.db.listJobs(["queued"]).map((j) => {
          const e = c.scheduler.evaluate(j);
          return {
            job: `#${j.id} ${j.name}`,
            would_run_on: e.candidates.map((x) => ({ printer: x.printer.id, ams_mapping: x.match.amsMapping })),
            rejected: e.rejected,
          };
        }),
      );
    }),
  );

  server.registerTool(
    "confirm_plate_cleared",
    {
      description:
        "Tell the scheduler the build plate has been emptied after the last print. Without this the printer is never given a new queued job. If auto_dispatch is on, the queue is dispatched immediately.",
      inputSchema: { printer_id: pid },
    },
    safe(async ({ printer_id }) => {
      const p = c.fleet.get(printer_id);
      c.db.setFlag(`plate_clear:${p.id}`, true);
      const dispatched = c.file.settings.autoDispatch ? await c.scheduler.dispatch() : undefined;
      return text({ printer: p.id, plate_cleared: true, dispatched });
    }),
  );
}
