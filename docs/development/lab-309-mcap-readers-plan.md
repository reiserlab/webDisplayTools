# LAB-309 — readers on MCAP, retire the behavior_v2 JSONL as the default; reconciled with LAB-227 §5

**Status:** implementation plan, approved by Michael Reiser on 2026-11-03 (plan-mode session; this
document is the only deliverable of that session — no code changed, no Linear edits). Part B is the
design, Part B5 the PR order, Part C the verification, Part D the open questions Michael still decides
before candidate 2. Facts in Part A were read from `main` 62dbbe7 and reiserlab/rig-nodes v0.4.0.

## Context

MCAP is the record of a run (LAB-303). The `behavior_v2` `.jsonl.gz` is derived by
`rig/nodes/mcap_convert.py`, FicTrac-only, and is to be retired (LAB-309, Urgent). Today every reader
— the data-browser dashboard, Studio replay, `closed-loop-report.py`, `runlog-check.py`,
`bench-check.py`, `telemetry-report.py`, `wedge-scan.py`, and the `runlog-index` workflow — reads the
JSONL, and the Studio auto-commits it to the data repo. LAB-227 §5 wants run logs published from the rig
PC by the ROS graph into `reiserlab/arena-experiments`, with the bag location and an index in the repo.
This plan answers the five questions LAB-309 raises and orders the PRs.

**Direction from Michael (2026-11-03, plan review): two logging options, not one.** MCAP is the lab's
default record (a rig running `cd rig && pixi run rig`). The mature `behavior_v2` JSONL stays as the ONE
simpler option for the classic FicTrac setup (Studio + `pixi run bridge`, no ROS), committed by the Studio
as today. Every other level (`behavior_v1`, `full`) is retired. So LAB-309 "retires the JSONL" as the
default and as the ROS graph's output, not as a format: readers keep both forever, and the classic bridge
is trimmed, not removed. The LAB-309 ticket text needs this scope change (Part D, proposal only).

## Part A — Facts established (2026-11-03; main 62dbbe7, rig-nodes v0.4.0)

### A1 Tickets and prior decisions
- LAB-309 done-when: dashboard, Studio replay, `closed-loop-report.py`, `runlog-check.py` read the bag;
  course rigs run `rig/` instead of bridge 3.4; the converter's JSONL output is off by default.
- LAB-227 §5: bags in repo vs share; publisher on the rig PC with a rig-PC credential; Studio commits
  only protocols + patterns; shared `<rig-id>` layout + run-type routing; rig id + run type in MCAP
  metadata; legacy JSONL convert-or-archive; lift `data-repo-setup.md` + seed script from
  `feat/data-repo-registry`. §3 wants an explicit `run_type` (`experiment | rig-test`).
- Storage decisions on record conflict: 2026-10-17 "group share now, bucket later"; 2026-10-18 pm "git
  for everything, rotate"; `bridge_node.py:1103` help text says "archived on a share";
  `fictrac-columns-in-the-bag.md:8` says "pushed to the GitHub data repo". LAB-227 §5 reopens it.
- Phase 1 of LAB-227 passed on ww18 (2026-10-29): Studio + dashboard + replay work against the private
  repo with no code change; `arena-experiments` runs the `runlog-index` workflow (1 run indexed).

### A2 What a bag is (rig/ default env)
- One bag per logging activation: `<log-dir>/arena-log-YYYYMMDD-HHMMSS-mmm.bag/{<run>_0.mcap,
  metadata.yaml}` (`bridge_node.py:375`; default `--log-dir rig/runlogs`). The name carries no run_id and
  no rig id. Opens on `log_control enabled:true`, closes on `enabled:false` (the Studio does this in
  `onRunFinished`, `arena_studio.html:3915`), on `log_export`, or on shutdown.
- Writer: rosbag2 MCAP plugin, CDR. Profile `crashsafe` (no chunks, no compression) while open; at close
  `rig_nodes.mcap_index.reindex` rewrites in place: chunked, zstd 19, **chunk index only, no message
  index**, atomic `os.replace`. Torn bags are recovered.
- Topics are all `std_msgs/msg/String` JSON in the default env: `/arena/session` (open record `{seq, event,
  file, ms=t0, level, bag, connectors, node, typed, profile, packages}`), `/arena/browser` (`{seq, rx_ms,
  raw, line:true}` = every browser `{type:"log"}` line verbatim — `run_metadata`, `stream_schema`,
  `runner`, `trial_quality`, … — or `{type:"rows"}` controller rows), `/arena/frame` (per-frame record;
  typed `rig_interfaces/msg/ArenaFrame` only in the `typed` env), `/arena/event` (`bias_config`,
  `heading_tare`, `connector_status`, …), `/kinefly/raw`, `/bias|scanimage|sipm/{reply,status,cmd}`,
  `/rig/host`, `/bias/frames` (timestamps only). Camera pixels are never in the bag (uFMF/MJPEG files,
  ≈24 MB/s); ScanImage pixels stay in the TIFF. No MCAP Metadata/Attachment records of our own.
- `rig_id` and `run_id` exist only inside the `run_metadata` browser line, which the Studio sends only for
  experiment-intent (or soak) runs (`arena_studio.html:11073-11100`). The graph does not know its rig id
  (`rig.py` / `bridge_node.py` have no flag; QC maps hostname → rig in `rig/qc/profiles.toml`).
- Converter `mcap_convert.py`: pure Python (`mcap` + `rig_nodes.cdr`, XCDR1 primitives/strings/sequences),
  imports `fictrac-bridge/bridge.py`'s encoders, `--order seq` default, JSONL is its only output and always
  on; the node also always writes a shadow JSONL and serves converted JSONL on `log_export`. Byte-identity
  gate: `rig/tests/test_ros2_poc.py:586`.
- Sizes (`fictrac-columns-in-the-bag.md`): FicTrac-only bag = 2.41×/2.68× the `.jsonl.gz` (≈53–61
  B/frame) → ≈5–5.5 MB per 30 min at 50 Hz, ≈11 MB per hour, ≈105 MB per busy rig-day. Course repo today:
  304 run logs, 2.2 GB (mostly pre-v0.72 uncompressed `.jsonl`), largest 54 MB; a 10-min `.jsonl.gz` ≈ 1.6 MB
  (rig03-sr, 147 runs in 8 weeks ≈ 18 runs/week ≈ 70 MB/week of bags).

### A3 Readers today
- Browser: `js/runlog-format.js` (classic dual-export; `readRunlogText` inflates gzip by magic with
  `DecompressionStream`; `createNormalizer().normalize(rec)` expands only `"a"` rows) + byte-identical
  vendored copy `dashboard/data-browser/vendor/runlog-format.js` (identity test `tests/test-runlog-format.js`).
  `js/runlog-replay.js parseRunLog(text)` consumes `run_metadata`, session t0, frame rows, `fictrac_frame`,
  `heading_tare`, `bias_config`, runner events, `arena_command` (0x70); skips string-tagged rows.
  `js/studio-replay.js` fetches the whole file (raw URL signed-out, Contents API raw signed-in,
  `readRepoBytes :827`), lists runs from `runlogs/<dir>/index.json` (`loadRuns :1976`), gates paths with
  `RUNLOG_PATH_RE :51`, resolves the protocol by sha. Dashboard `app.js` reads `index.json`, a 64 KB Range
  prefix per file for metadata (`fetchPrefix`), whole files on demand; `analysis-core.js parseJsonl :723`
  keeps every object event + frames. Alt Studio keeps its own reference replay.
- Index: `scripts/build-runlog-index.py` (+ the data-repo workflow `scripts/data-repo-workflows/
  runlog-index.yml`: push on `runlogs/**`, dispatch) → `runlogs/<folder>/index.json` `{format_version:1,
  folder, runs:[{run_id, rig_id, protocol_filename, protocol_sha256, experimenter, genotype, sex,
  fly_number, age, notes, timestamp_start, tool_version, file, size, started_ms, stopped_ms, duration_s,
  complete}]}`. No outcome, no run_type, no bag pointer; names accepted: `.jsonl(.gz)` only.
- Python: no shared loader; each script opens its own file (`bench-check` by gzip magic, the others by `.gz`
  suffix). `rig/qc/qc.py:777-850` step 8 runs export → `runlog-check` → `closed-loop-report` → `bench-check`
  on the exported JSONL. Tests are synthetic-log based (no `.jsonl.gz` fixture at the root).
- Outcome vocabulary lives only in the browser's own run log (`js/run-log.js deriveOutcome`): COMPLETED,
  ABORTED_BY_USER, DISCONNECTED, CONTROLLER_FAULT, BRIDGE_LOST, ERRORED, UNKNOWN; nothing in the bridge
  log says it. Auto-commit (`maybeCommitRunLog`, `arena_studio.html:3954`) skips ABORTED_BY_USER /
  DISCONNECTED / BRIDGE_LOST; `commitRunLog :4024` needs `studio_gh_direct==='1'` + repo + token + bench id.
  The node's `hello_ack` carries `record:"mcap"`, `typed`, `packages` (`bridge_node.py:902`) but
  `FicTracBridgeClient._handleHelloAck` drops them (`js/fictrac-bridge-client.js:795-803`).

### A4 Library options checked
- `@mcap/core` 2.4.0 (ESM; deps `heap-js`, `@foxglove/crc`, `tslib`). `McapIndexedReader` needs a summary
  AND per-chunk message indexes → unusable on our chunk-only bags; `McapStreamReader` reads sequentially,
  expands chunks through `decompressHandlers`, needs no index → the one to use. `@mcap/support` 1.1.1 brings
  wasm zstd/lz4/bz2 + protobufjs (heavy; no `parseChannel`). `fzstd` 0.1.1 is a pure-JS zstd decoder with
  no dependencies. ROS 2 CDR decoding: `@foxglove/rosmsg` + `@foxglove/rosmsg2-serialization`, or a JS port
  of `rig_nodes.cdr` (≈100 lines, covers everything our `.msg` files use).
- Python: `mcap ≥1.2` on conda-forge (the `rig/` env has it; the root env does not); `rig_nodes.cdr` is the
  decoder. Vendoring precedent: `js/vendor/yaml/browser/` + LICENSE + import map +
  `tests/vendor-yaml.register.mjs`; CDN precedent for three/jszip/marked/Plotly.

## Part B — Answers to the five questions

### B0 The two logging options (the frame for everything below)
| | **MCAP (default)** | **JSONL `behavior_v2` (classic option)** |
|---|---|---|
| Rig side | `cd rig && pixi run rig` (ROS 2 graph, bag per run) | `pixi run bridge` at the root (classic bridge, one level only) |
| Who publishes | the rig-PC publisher (B3) | the Studio's existing auto-commit (`commitRunLog`) |
| Repo artifact | `runlogs/<rig-id>/<name>.mcap` + `.meta.json` | `runlogs/<rig-id>/<name>.jsonl.gz` (unchanged) |
| Index | `format: "mcap"` entry from the fragment | `format: "behavior_v2"` entry from the bookend scan (today's path) |
| Readers | native MCAP (B1) | unchanged |
| Retired | the shadow JSONL + converted `log_export` as defaults | `behavior_v1`, `full`, the Studio's Format selector |

The option is chosen by which bridge the rig runs, not by a Studio setting: `hello_ack` already tells the
Studio (`record:"mcap"` from the node; `levels` from the classic bridge). The Studio shows the record type
in the device line / run banner ("Record: MCAP → published by ww18" or "Record: JSONL behavior_v2 →
committed by Studio") instead of today's ⚙ Settings → Run logging → Format select, which goes away
(`studio_log_level` is read once for migration, then ignored; old files with other levels stay readable).
Everything the Studio adds to the log (`run_metadata`, the new `run_end`, `run_type`) is a browser line,
so both options carry it with one implementation.

### B1 Which readers read MCAP natively; what goes through a sidecar
- **Native MCAP in the browser: the dashboard and Studio replay** (LAB-309's first slice). A derived JSONL
  sidecar would just move the retired format one step downstream and keep two writers; the bag is small
  enough to fetch whole (as the `.jsonl.gz` is today). The reader is a thin container layer: parse MCAP
  (`McapStreamReader`), decompress zstd (`fzstd`), decode `std_msgs/String` (4-byte header + u32 + bytes) and
  typed `ArenaFrame` (JS port of `rig_nodes.cdr`), then emit **exactly the record stream the JSONL readers
  already consume** (`run_metadata` objects, `[ms,fc,idx,ft,x,y,hd]` rows, `cc/cf/cs` rows, events). The
  analysis code (`parseRunLog`, `parseJsonl`, `buildTimeline`) does not change; only the loader does.
- **One metadata sidecar, not a data sidecar:** the publisher commits a per-run `<name>.meta.json` beside
  the bag (= the index entry). It replaces the dashboard's 64 KB-prefix trick (a chunk-only bag has no
  cheap prefix) and lets the `runlog-index` workflow merge without reading bags in the Action.
- **Python scripts read MCAP through the converter's own record generator** (`mcap_convert.py` refactored
  into a library; the byte-identity harness keeps protecting it) behind one shared loader that accepts
  `.jsonl`, `.jsonl.gz`, `.mcap` and `.bag/`.
- **Alt Studio replay stays JSONL-only** (reference implementation; its retirement is a later PR).
- **JSONL stays a first-class input, not a legacy one:** every reader accepts `.jsonl(.gz)` and `.mcap`
  side by side (the classic option keeps producing JSONL), so "two-format" is the permanent state of the
  readers, and the loaders (`readRunlogText` / `RunlogMcap.readBag`, `scripts/runlog_io.py`) are the only
  place that knows the difference.
- **Dependency choice: vendor, never CDN.** `js/vendor/mcap/` = verbatim ESM dists of `@mcap/core` 2.4.0,
  `heap-js`, `@foxglove/crc`, `tslib`, `fzstd` 0.1.1 (+ LICENSEs), wired by import-map entries in
  `arena_studio.html` and `dashboard/data-browser/index.html`, and by extending the Node resolve hook
  (`tests/vendor-yaml.register.mjs` → a generic `tests/vendor.register.mjs`). Same pattern as `yaml`, no
  build tool. Fallback if the verbatim dists do not resolve (bare `tslib` imports etc.): a one-shot esbuild
  bundle (`esbuild` from conda-forge, script + lockfile committed under `scripts/vendor-mcap/`). CDN is
  rejected: the record's reader must be pinned, test-hermetic and immune to the catastrophic-import gotcha.
- **Load shape:** `js/runlog-mcap.js` is an ES module (it imports the vendored ESM) that also sets
  `window.RunlogMcap`; the classic replay code and the dashboard look it up **at use time** and show "MCAP
  reader not loaded" if absent, so a failed vendor import never takes down Connect/STOP (layer-1 rule).

### B2 Where bags live; what the index carries
- **Tier rule (recommendation):**
  1. The **run bag** (arena topics: `/arena/*`, `/kinefly/raw`, connector reply/status, `/rig/host`,
     `/bias/frames` timestamps) is published to GitHub as ONE flat file
     `runlogs/<rig-id>/<protocol>__<experimenter>__<stamp>__<run_id>.mcap` (+ `.meta.json`), the same name
     scheme as the JSONL. Browser readers can only fetch over HTTPS with the GitHub token today; the group
     share is SMB. ≈5 MB/30 min keeps a 9-hour FicTrac-only run under the 100 MB file cap. `metadata.yaml`
     is not published (Foxglove, the `mcap` CLI and our readers read the bare file; `ros2 bag reindex`
     regenerates it). The publisher refuses > 95 MB or split bags and leaves them on the share with an
     index entry pointing there.
  2. **Media** (uFMF/MJPEG movies, ScanImage TIFF, any future image topic) go to the **group share**
     under `arena-experiments/<rig-id>/<run_id>/` (path recorded in `media[]`; an HTTPS bucket later just
     changes the string to a URL).
  3. **Repo growth:** ≈70 MB/week per active rig (A2) → ≈3.5 GB/yr per rig, ≈10 GB/yr for ww18 + ww14 +
     rig03. GitHub's soft guidance is 5 GB. Recommendation: keep `arena-experiments/runlogs/` for 2026
     (ww18 already there), and give every index entry a `repo` field now so run logs can rotate into
     `reiserlab/arena-runlogs-<year>` when the repo passes ≈4 GB without touching readers. Michael decides
     (Q1). `--max-bag-mb` stays off.
- **Index `format_version: 2`** (`runlogs/<folder>/index.json`, backward compatible — v1 fields kept):
  `format` (`mcap | behavior_v2 | behavior_v1 | full | legacy`), `outcome` (the Studio vocabulary;
  `null` for legacy files, where `complete` stays), `run_type` (`experiment | rig-test`; `null` legacy),
  `rig_id`, `repo`, `file`, `size`, `sha256`, `duration_s`, `started_ms`/`stopped_ms`, `frames` (FicTrac
  rows), `trial_quality` (`{pass, fail, unknown}` counts), `firmware`, `protocol_sha256`, `media[]`
  (`{kind, path, bytes}`), `bag` (`{profile, typed, packages, recovered}`), `published_by`
  (`studio | rig-publisher/<version>`). Source: the `.meta.json` fragment for published bags, the
  existing bookend scan for legacy JSONL. For `outcome` the Studio adds ONE `{type:"log",
  event:"run_end", outcome, run_id, …}` line before `setLogging(false)` so the bag says how the run ended.

### B3 The publisher on the rig PC
- **Where:** webDisplayTools `rig/nodes/publish_run.py` (+ `pixi run publish`). It knows the Studio's
  `run_metadata`/`run_end` lines, so it belongs with the gateway, not in rig-nodes (repo-boundary rule).
- **Trigger + policy:** `RecordingLogWriter.close()` (after reindex) drops the bag into `pending/`; the
  publisher (thread in the bridge node, plus the standalone `pixi run publish` for retries) reads the bag
  (`mcap` + `rig_nodes.cdr`), requires a `run_metadata` line (none = Test run → never published, local
  retention only) and a `run_end` line, applies the Studio's publish rule (skip ABORTED_BY_USER /
  DISCONNECTED / BRIDGE_LOST), builds the name from `protocol_filename`/`experimenter`/`timestamp_start`/
  `run_id`, routes `runlogs/<rig-id>/` or `runlogs/<rig-id>/tests/` by `run_type`, writes `.meta.json`, and
  commits bag + fragment in ONE commit to the default branch. Idempotent (GET sha first; identical → skip),
  exponential-backoff retries for offline rigs, receipt file after success.
- **Transport:** the GitHub Contents API (PUT) with the Git Database path for > 30 MiB — the same
  two-path rule as `GH.commitFile`, so no git clone on the rig PC (rules out deploy keys).
- **Credential (recommendation):** a **fine-grained PAT dedicated to the rig PC** (`rig-<rig-id>-publisher`,
  owner `reiserlab`, repo `arena-experiments` only, Contents read/write, ≤ 1 year), stored in
  `rig/.secrets/github-token` (gitignored) or the `ARENA_PUBLISH_TOKEN` env — it satisfies "rig-PC
  credential, not the browser PAT" and the token runbook already exists. **Hardening step later:** a GitHub
  App installed on the data repo with the private key on the rig PC (hourly installation tokens, no seat,
  per-rig revocation). Michael confirms the org policy (Q2).
- **Rig id and run type in the bag:** `rig.py --rig-id` (default = hostname, matching LAB-227 "rig ids =
  PC hostnames" and `rig/qc/profiles.toml`) → bridge node → `/arena/session` open record + an MCAP
  `Metadata` record (`rig_id, hostname, node, packages`) written by reindex. `hello_ack` gains `publisher:
  {active, repo, rig_id, version}`; the Studio warns when `Studio.rigId` ≠ `publisher.rig_id`. `run_type`
  comes from a new Run-details control (`experiment | rig-test`, default experiment; LAB-227 §3) into
  `run_metadata`.
- **Switching off the Studio's JSONL commit per rig, without touching classic benches:** no toggle. The
  Studio keeps the `publisher` field from `hello_ack`; `maybeCommitRunLog` skips the JSONL commit when
  `publisher.active`, the run banner says "run log published by <rig-id> → <repo>", ⇪ Push log is disabled
  with that reason. A classic bridge sends no `publisher` → the Studio commits the JSONL exactly as today
  (this IS the classic option of B0). The node still closes the bag on `log_control enabled:false`
  (already the case); `log_export` becomes optional.
- **The classic bridge is trimmed, not retired:** `fictrac-bridge/bridge.py` → "bridge 4.0 (classic)":
  one level, `behavior_v2` (`LOG_LEVELS = ['behavior_v2']`; `--log-level`/`--to` lose `behavior_v1`/`full`;
  the `--convert` legacy→v2 path stays for old files), `hello_ack` advertises `levels: ["behavior_v2"]`
  and `record: "jsonl"`. The node keeps importing the same module (Hub, LogWriter, Pipeline, encoders), so
  the converter and the live writer still share one encoder.

### B4 Historical JSONL and the two-format period
- **Read-only legacy archive; no mass conversion.** A JSONL→MCAP conversion would manufacture a "record"
  with fewer columns and no provenance; readers must keep JSONL for the 2.2 GB corpus anyway; the converter
  stays for old bags (decision already recorded in `rig-software-repos-and-runners.md:346`).
- Post-course lab runs (rig03-sr, rig05-mr/rig5-mr, bench02-il, bench00 Oct 14) are copied into
  `arena-experiments/runlogs/<mapped rig id>/` under LAB-227 §2 with a PROVENANCE note; the course-week
  student runs stay in the course repo. Index v2 covers both formats; the dashboard and the replay list show
  a format badge; "legacy" entries never get `outcome`.
- Two formats are permanent (B0): a rig on the graph produces MCAP only (no shadow JSONL by default); a
  classic-bridge rig produces `behavior_v2` JSONL committed by the Studio. Nothing forces a classic bench
  onto the graph; a bench that wants camera/connector streams or the publisher moves to `rig/` when it is
  ready. `behavior_v1` and `full` are retired as producers; their old files stay readable.

### B5 Order of PRs (each a next-candidate PR, ≤ 4 per candidate; feature PRs never bump versions)
Candidate 1 — readers, no UI change, ships before any publisher exists:
- **R1 MCAP reader module.** `js/vendor/mcap/*` (+ LICENSEs, import maps, `tests/vendor.register.mjs`),
  `js/cdr-ros2.js` (dual-export port of `rig_nodes.cdr`), `js/runlog-mcap.js` (`readBag(bytes) →
  {records, t0, level, recovered}`; port of the `mcap_convert.py` dispatch, `--order seq` semantics,
  `a` lines emitted as the v1 object so `createNormalizer` is a no-op on them). Fixture: a small real bag
  from `rig/runlogs` (ww18 smoke or the harness simulator run) + its Python-converted JSONL under
  `tests/fixtures/mcap/`. Tests: `tests/test-runlog-mcap.js` (reader records, normalized, deep-equal the
  normalized JSONL records in order; typed-frame fixture from the `typed` env too), `tests/test-cdr-ros2.js`
  (vectors generated once by `rig_nodes.cdr`).
- **R2 Python shared loader.** `rig/nodes/mcap_convert.py` → library generator `iter_bag_records(bag,
  level, order)` (+ `convert_bag` = that + `dumps_jsonl`, byte-identity harness unchanged);
  `scripts/runlog_io.py iter_records(path)` for `.jsonl/.jsonl.gz/.mcap/.bag/`; convert the five scripts
  (`wedge-scan` takes protocol/run id from `run_metadata` when the name is a bag). Root `pixi.toml` adds
  `mcap`; the CDR decoder for the root env is a vendored copy `scripts/_cdr_ros2.py` with a version marker
  (rig harness checks it equals rig-nodes'), unless Michael prefers running the scripts from the `rig/` env
  (Q4). Tests: `tests/test-runlog-io.py` + each script's test gains an MCAP case on the R1 fixture.
- **D1 rig id in the graph.** `rig.py --rig-id` (default hostname) → `bridge_node` → `/arena/session` +
  MCAP Metadata; `hello_ack` `publisher` placeholder (`active:false`); `--shadow-jsonl` flag (default ON
  for now). Rig harness tests.
- **Docs PR (this plan)** — docs-only, merges directly.

Candidate 2 — the UI reads bags, the publisher exists:
- **R3 Studio replay + dashboard on MCAP.** `RUNLOG_PATH_RE` / `isRunlogName` / `RUNLOG_NAME_RE` accept
  `.mcap`; `readRepoBytes` → `RunlogMcap.readBag` when the bytes start with the MCAP magic; dashboard
  `ensureRun`/`loadFiles`/`loadUrl` the same, `browseGithub` takes mcap entries from `index.json` instead
  of a prefix read; format badge; `?replay=` works for `.mcap`; re-copy `dashboard/.../vendor/runlog-format.js`.
  Tests: `tests/test-studio-replay.js`, `dashboard/data-browser/tests/test-analysis.js` MCAP cases.
- **R4 Index v2 + run_end + run_type.** `build-runlog-index.py` merges `*.meta.json` fragments + legacy
  bookends (`format_version: 2`), workflow accepts `.mcap`; Studio `run_end` event; Run-details `run_type`
  control; client keeps `record`/`publisher` from `hello_ack`. Tests: `tests/test-build-runlog-index.py`,
  `tests/test-fictrac-bridge-client.js`, `tests/test-studio-shell.js` (tooltips/help text).
- **D2 Publisher.** `rig/nodes/publish_run.py`, pending queue, Contents API + Git-DB path, `.meta.json`,
  `pixi run publish`, `hello_ack publisher.active`; Studio skip-commit + banner + disabled Push button
  (same PR: node and Studio live in one repo). Tests: rig harness (publish against a local fake GitHub
  endpoint), `tests/test-studio-*.js` for the skip path.

Candidate 3 — two options only:
- **D3 QC on the bag + shadow off.** `rig/qc/qc.py` step 8 runs the scripts on the bag (R2); `--shadow-jsonl`
  default OFF (= "converter output off by default"); `log_export` keeps `--export converted` for manual use;
  docs: `telemetry-logging-reference.md §1.x`, `runlog-behavior-v2-plan.md` note, `rig/README.md`.
- **D4 Classic bridge 4.0 + Studio two-record UI.** `bridge.py` trimmed to `behavior_v2` (B3); the Studio
  replaces ⚙ Settings → Run logging → Format with the read-only record indicator (B0), drops
  `studio_log_level`, keeps the "no ack → behavior_v1" tolerance only for reading; `run_metadata.log_format`
  becomes `mcap | behavior_v2`. Tests: `tests/test-studio-shell.js` (help text/tooltips),
  `fictrac-bridge` Python tests, `tests/test-fictrac-bridge-client.js`. Course benches stay on the classic
  option (their Studio commits to the course repo continue); any bench may move to `rig/` later.
- Non-code, in order: org PAT/App decision → per-rig token → ww18 cutover (publisher on) → ww14 → rig03-sr
  (LAB-227 §2 copy first; graph or classic is Shubham's choice, either way the repo moves to
  `arena-experiments`); the course repo is frozen as the showcase only when the course benches leave it.
  Update the data-repo workflow copy in `arena-experiments` from R4.

Parallelism: R1 ∥ R2 ∥ D1; R3 and R4 depend on R1; D2 depends on D1 + R4; D3/D4 depend on R2 + D2.

LAB-309 scope change to propose (text, applied only on Michael's OK): "Done when: the dashboard, Studio
replay and the scripts read MCAP natively and keep reading `behavior_v2` JSONL; a rig on `rig/` publishes
MCAP from the rig PC and the Studio commits no JSONL for it; the converter's JSONL output is off by default;
the classic bridge offers `behavior_v2` only (`behavior_v1`/`full` retired). Course rigs may stay on the
classic bridge." Target stays ASAP for C1/C2.

## Part C — Verification
- Every PR: `pixi run test` (root) and `cd rig && pixi run test` where `rig/` changed; the vendored-copy
  identity tests; the byte-identity harness after R2.
- Oracle end to end (after R3/D2 on ww18): one recorded run → bag published → `index.json` entry →
  dashboard lists it with duration/outcome → Studio `?repo=&replay=` plays it → `closed-loop-report.py`
  and `runlog-check.py` on the published `.mcap` give the same numbers as on the exported JSONL.
- Browser smoke (`pixi run studio-smoke`) after R3 (layout/menus touched); the Studio still connects when
  `js/runlog-mcap.js` is made to fail (layer-1 guarantee).

## Part D — Open questions for Michael (decide before C2)
1. Storage: run bag in `arena-experiments/runlogs/<rig-id>/` + media on the share + rotation into
   `arena-runlogs-<year>` at ≈4 GB — agreed? Or run logs in their own repo from day one?
2. Credential: rig-PC fine-grained PAT now, GitHub App later — does the org allow fine-grained PATs
   without approval, and may a GitHub App be created in `reiserlab`?
3. Publish rule: same as the Studio today (skip ABORTED_BY_USER / DISCONNECTED / BRIDGE_LOST), or publish
   everything with `outcome` and let the index filter?
4. Python decoder in the root env: vendored `scripts/_cdr_ros2.py` copy, or run the scripts from `rig/`?
5. `run_type` UI: a Run-details selector, or derived from the existing Test/Experiment buttons plus a
   `rig-test` checkbox? Default for the legacy `genotype: none` runs during the LAB-227 §2 copy?
6. Media path convention on the group share (UNC root) and who archives movies there (manual for now?).
7. Rig id = hostname everywhere (rename `studio_bench_id` wording to "Rig id" in LAB-227 Phase 4)?
8. Timeline: LAB-309 is "ASAP"; three candidates ≈ 3 release weeks plus the ww18/ww14/rig03 cutovers —
   is 2026-12-31 still the date for C3 (classic bridge trimmed, Format selector gone)?
9. Alt Studio replay: leave JSONL-only until Alt retirement (recommended)?
10. Is the JSONL option tied to the classic bridge only (recommended: the rig's setup decides, the Studio
    just shows it), or should a rig on the graph also be able to ask for a JSONL export (would mean keeping
    `--shadow-jsonl` / `log_export converted` as a Studio-visible switch)?
11. Classic-bridge JSONL runs from `rig/`-less benches: still published by the Studio to the same
    `runlogs/<rig-id>/` folder as MCAP runs (recommended; the index carries `format`), or a separate folder?
