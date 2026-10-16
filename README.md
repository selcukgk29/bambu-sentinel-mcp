# bambu-sentinel-mcp

MCP server for Bambu Lab printers (built for an A1, designed for fleets): live control, job queue with
filament-aware scheduling, print monitoring and AI supervision. LAN mode only (MQTT 8883, FTPS 990, camera 6000).

## Setup
1. Printer: enable LAN Only / Developer mode; note IP, serial, access code. Close Bambu Studio/Orca/Home Assistant (one MQTT client at a time).
2. `npm install && npm run build`
3. Add to your MCP client:
```json
{ "mcpServers": { "bambu": {
  "command": "node", "args": ["<path>/sentinel/dist/index.js"],
  "env": { "BAMBU_HOST": "192.168.x.x", "BAMBU_SERIAL": "...", "BAMBU_ACCESS_CODE": "...", "BAMBU_MODEL": "A1" } } } }
```
Or skip the env and call `add_printer` (saved to `~/.bambu-sentinel/config.json`; data dir override: `BAMBU_SENTINEL_HOME`).

## What it does
- **Control**: pause/resume/stop, speed, light, temps, G-code through an allowlist with per-model limits (`src/safety.ts`).
- **Queue**: `queue_add` reads required filaments from the 3MF; the scheduler picks a free printer whose AMS has matching type/colour,
  maps slots automatically, and never starts on a printer until `confirm_plate_cleared` (A1 has no ejector).
- **Monitoring**: event log (start/finish/fail/pause/HMS), SQLite history, background telemetry checks
  (heater drift after reaching target, overtemp, progress stall, offline mid-print).
- **AI supervision**: `inspect_print` returns the live frame + an earlier frame + telemetry for the model to judge
  (`supervise_print` prompt loops it). `configure_watch vision_sampling=true` makes the server ask the client's model about every
  periodic snapshot via MCP sampling; `auto_pause=true` pauses on critical findings.

## Reliability
- Every command waits for the printer's acknowledgement (`acked:false` when it stays silent; an explicit rejection throws).
- A print start is only believed once the printer reaches PREPARE/RUNNING; otherwise the job goes back to the queue with a
  5 min backoff, the plate flag is restored, and after 3 failed starts it is marked failed.
- Failed prints record the printer error and HMS text. A job is reprinted automatically (default 2 attempts, `queue_add max_attempts`)
  unless the error is marked `human`/`never`; the retry still waits for `confirm_plate_cleared`. Cancels are never retried.
- HMS decoding: the built-in table is tiny on purpose. Load a full one with `hms_import` (plain map or a Bambu Studio style hms json).

## Planning, inventory, cost
- `queue_eta`: which printer and when for every queued job, from the 3MF time estimate (else history, else 60 min).
- `spool_add / spool_assign / spool_update / check_filament`: grams per spool, "does it fit" checks before dispatch, usage subtracted
  when a print ends (failed prints by the share printed), low-spool alerts under 50 g.
- `estimate_cost / cost_report / configure_cost`: filament (spool price, else per-type price), electricity (watts x time x tariff),
  machine wear per hour, optional handling cost. Reports show waste on failed prints and cost per good print including failures.
  Per part: `estimate_cost` reads how many objects the plate holds (3MF) and returns `cost_per_part` (equal split) and, for several
  objects, `cost_per_part_by_footprint` (approximate); `cost_report` gives `avg_cost_per_part` (waste excluded) and
  `avg_cost_per_part_incl_waste`; `get_history` shows parts and `cost_per_part` for every cycle.
  Defaults are placeholders (USD, 0.15/kWh, 95 W, 0.15/h wear): set your own with `configure_cost`. Cost is fixed when a print ends.

## Notifications and discovery
- The server pushes MCP log messages (print finished/failed, HMS, alerts, auto-pause, retries) and `resources/updated` for
  `bambu://events` / `bambu://fleet` subscribers. Whether you see them depends on the client.
- `discover_printers` finds printers via SSDP (UDP 1990/2021); the LAN access code still has to be read from the printer.

## Plate ejection (`eject_plate`)
Sweeps finished parts off with the toolhead: bed slides in Y while the toolhead sits low. Flow: wait for bed/nozzle to cool,
sweep X passes (`yStart -> yEnd`), camera check, and only a verified-empty plate sets the scheduler's `plate_cleared` flag.
- First use: `save_empty_plate_reference`, `configure_eject` (calibrate Y range and sweeper width), `eject_plate dry_run`, then
  `rehearsal` (path 25 mm above the plate), then `confirm=true`.
- `configure_watch auto_eject=true auto_dispatch=true` chains print -> sweep -> verify -> next queued job. Failed/cancelled
  prints are never swept automatically.
- A bare nozzle is narrow, so the default needs ~11 passes; a clip-on scraper (raise `sweeperWidth`) needs far fewer and is safer for the nozzle.
- Avoid `G28` here: homing Z with a part on the plate can mis-reference.
- `use_layout` sweeps only the X strips where the 3MF says parts sit (`Metadata/plate_N.json`). Assumes plate coordinates equal bed coordinates: check with a rehearsal before trusting it.

## Simulator
`npm run sim` starts a fake A1 (MQTT/FTPS/camera on localhost, prints the connection details). Faults: `heater_drift`, `overtemp`,
`stall`, `hms`, `spaghetti`, `stuck_part`, `no_part`. `npm test` runs the unit tests and the end-to-end tests against it.

## Not verified on real hardware yet
Written from protocol knowledge, unit-tested (`npm test`) but not run against a printer. First things to check on the A1:
camera frame grab, `project_file` start (`file:///sdcard/cache/...`), external-spool mapping (254), HMS events.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). You may use, copy and modify this software for noncommercial purposes (personal use, hobby,
research, education, nonprofits). Commercial use, including selling it or offering it as part of a paid product or service, is not
permitted without a separate agreement with the author. This is a source-available license, not an OSI "open source" one.
