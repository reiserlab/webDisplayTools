# What else moves to rig-nodes (or pyDisplayTools): review after the extraction, 2026-10-27

**Status:** proposal, moves nothing. Written the day after the extraction session (LAB-338) created
[reiserlab/rig-nodes](https://github.com/reiserlab/rig-nodes) (package set 0.2.1) and opened
[#274](https://github.com/reiserlab/webDisplayTools/pull/274), which removes the moved files from
`rig/` and installs the package set. Question answered here: beyond what #274 moved, what in
webDisplayTools (code, tests, configs, docs, CI, scripts) belongs in rig-nodes, or in
LED-Display_pyDisplayTools where the record says so?

**Sources compared:** [`rig-software-repos-and-runners.md`](rig-software-repos-and-runners.md) (§3.2 rules,
§3.3 inventory, §7 checklist), #274's body and diff, `rig/` on `main` versus on
`origin/feat/rig-nodes-extraction`, rig-nodes' `README.md`, `CONTRACT.md` and `src/` layout (sibling
checkout at tag v0.2.1 plus its branches `feat/bias-health` = rig-nodes PR 1 and `docs/setup-note` =
`SETUP.md`, the machine setup note Michael assigned to rig-nodes on 2026-10-27), and the open
satellites [#261](https://github.com/reiserlab/webDisplayTools/pull/261) (ScanImage frames),
[#266](https://github.com/reiserlab/webDisplayTools/pull/266) (SiPM),
[#269](https://github.com/reiserlab/webDisplayTools/pull/269) (okey-cokey),
[#273](https://github.com/reiserlab/webDisplayTools/pull/273) (tiff2mcap `--runlog`).

**Summary.** The extraction took the obvious set and left little *code* to move. Every remaining code
move is one the record already names, and each is blocked on an open PR (#261, #266, #269) or on
pyDisplayTools becoming an installable package (`patfile.py`, `arena_display.py`, the pure half of
`bridge.py`). What #274 did not cover, and what this review adds, is (a) the satellites cannot rebase
onto #274 mechanically, because their nodes import `_common` from the deleted `rig/nodes/` and must be
rewritten as `rig_nodes` modules behind a rig-nodes release; (b) the record contradicts itself on the
behavior_v2 codec (§3.1 keeps the export here, §3.3 sends its functions to pyDisplayTools); (c) the
setup material is split three ways and rig-nodes' `SETUP.md` points at a webDisplayTools `rig/SETUP.md`
that does not exist; (d) a handful of recording and device decisions live only in `rig/README.md`'s
build record and `CONTRACT.md` lacks two links; (e) no CI runs the cross-repository smoke (§7.8).

## 1. Item table

Rules (record §3.2): **R1** dependencies point downward only · **R2** each device node owns its command
vocabulary · **R3** application composition stays with the application · **R4** a package moves to
rig-nodes only with no arena semantics in its code *and* a second consumer; anything doubtful stays ·
**R5** message contracts may carry arena semantics, code may not · **H** dated records and run sheets stay
as history (§3.3 note) · **S** machine setup and onboarding belong in rig-nodes (Michael, 2026-10-27).
Effort: S = under an hour, M = a session, L = more than one.

### 1a. `rig/` after #274: code

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| Studio gateway | `rig/nodes/bridge_node.py` | stays | R1, R3 | — | — | — |
| behavior_v2 converter | `rig/nodes/mcap_convert.py` | stays (export while LAB-309 lives) | R3 | — | — | — |
| Row encoders | `rig/nodes/_rows.py` | stays; the FicTrac grammar is already re-exported from `rig_nodes.fictrac`. `fictrac_extras` (FicTrac cols 5, 6–8, 22, 23 → `ArenaFrame` fields) is contract material and is already CONTRACT §5 | R5 | — | — | — |
| Arena composition | `rig/nodes/rig.py` | stays; already composes with `rig_nodes.supervise` and `rig_nodes.zenoh` | R3 | — | — | — |
| Foxglove republisher | `rig/nodes/viz_node.py` | stays (record). Doubtful: its BIAS, Kinefly and `/diagnostics` halves carry no arena semantics and could become a generic device-status republisher in rig-nodes | R4 doubtful stays | none yet (a camera status board for the robot station would be the ask) | — | M |
| Arena Foxglove enrich | `rig/nodes/foxglove_json.py` | stays; the generic rewriter already moved, this is its `enrich` hook | R4 | — | — | — |
| Export tool | `rig/nodes/export_log.py` | stays (speaks the browser WebSocket contract) | R3 | — | — | — |
| G6 `.pat` reader | `rig/tools/patfile.py` | **pyDisplayTools** (record): the G6 counterpart of its `pyPatternTools/ReadPattern.py` (G4) | R1 | Python runner; `stimulus_core.py` (#269), `tiff_run_to_mcap.py` (#273) keep importing it, from the package | pyDisplayTools has no release channel or G6 module yet; waits for the runner plan session | S code, M plumbing |
| 2P TIFF → MCAP | `rig/tools/tiff_run_to_mcap.py` (+ #273 `check_tiff2mcap.py`, `test_tiff2mcap_runlog.py`) | stays (record); re-imports `patfile` from pyDisplayTools after that move | R3 | — | #273 | S |
| Acceptance harness | `rig/tests/test_ros2_poc.py` | stays: browser-contract conformance = the cross-repository smoke (§7.8). Audit once for checks that need no gateway; the adapter SIGKILL/restart and BIAS-command checks run through the gateway here, so they stay | §7.8 | — | — | S |
| Studio emulator, JS reader check, viz test | `rig/tests/studio_emulator.py`, `rig/tests/check_runlog_readers.js`, `rig/tests/test_viz_node.py` | stay | §7.8 | — | — | — |
| Arena workspace | `rig/pixi.toml`, `rig/pixi.lock`, `rig/.gitignore` | stay (the deployable arena profile) | R3 | — | — | — |
| Consumer manifest template | derived from `rig/pixi.toml` | **rig-nodes** (a copy, e.g. `examples/consumer-pixi.toml`): the record says rig-nodes ships "a profile template", and `SETUP.md` tells a new rig to copy the arena manifest's shape | §3.2 "profile template" | robot station (`meca_ws`), the Python runner | none | S |

### 1b. `rig/` after #274: docs, configs, records (including #269's additions)

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| Build record | `rig/README.md` | stays (banner added by #274) | H | — | — | — |
| Windows test plan | `rig/WINDOWS-TEST.md` | stays. Its §1 (install), §2 (middleware) and §7b (typed messages without Visual Studio) now duplicate rig-nodes `SETUP.md`: replace with pointers in a docs pass, not a move | S (dedupe) | — | rig-nodes `docs/setup-note` merged first | S |
| ScanImage day plan | `rig/SCANIMAGE-DAY.md` | stays | H | — | — | — |
| Dated results | `rig/scanimage-day-2026-10-16.md`, `rig/windows-results-ww18-2026-10-15.md` | stay; `SETUP.md` links to them as records | H | — | — | — |
| Plan B explainer | `rig/docs/plan-b-explainer*.html`, `rig/docs/build-standalone-explainer.py`, `rig/docs/img/*` | stay | H | — | — | — |
| Arena layouts | `rig/docs/foxglove-arena-layout.json`, `rig/foxglove/arena-fictrac.json`, `rig/foxglove/arena-bias.json` | stay (record). rig-nodes `foxglove/README.md` says "none yet"; `arena-bias.json`'s BIAS panels are the seed of a generic camera status board when a second BIAS rig asks | R4 doubtful stays | none yet | — | S |
| BIAS camera config (#269) | `rig/config/bias/okey-cokey-bfs-u3-51s5m.json` | stays (rig configuration) | R3 | — | #269 | — |
| okey-cokey PC setup notes (#269) | `rig/okey-cokey-pc-setup.md`, `rig/okey-cokey-pc-ww14-setup-2026-10-22.md` | **split**: machine setup and BIAS-on-Windows quirks → rig-nodes `SETUP.md` (its ww14 section exists); the arena half (Studio page server on :8092, protocol, controller COM port) → a new webDisplayTools `rig/SETUP.md` (see §4) | S | every rig PC | #269; rig-nodes `docs/setup-note` | S |
| okey-cokey run sheets and plan (#269) | `rig/okey-cokey-pc-2026-10-21.md`, `rig/okey-cokey-pc-results-2026-10-21.md`, `rig/HANDOVER-okey-cokey-2026-10-21.md`, `rig/docs/okey-cokey-foxglove-dashboard-plan.md` | stay | H | — | #269 | — |
| BIAS uFMF switch (#269) | `rig/tools/bias-ufmf.ps1` | stays now (record). Doubtful: what it encodes (BIAS v0.73.1 rejects `load-configuration` before a first capture; capture 2 s, stop, then load with `logging.format/directory` overridden) is BIAS knowledge that R2 assigns to `bias_node`, as a `configure`-style command; the script would shrink to composition | R2 vs R3 | any BIAS rig that records uFMF (robot station cameras?) | #269; decision (§3 Q2) | S |
| Rig launcher (#269) | `rig/tools/okey-cokey-start.ps1` | stays | R3 | — | #269 | — |
| uFMF reader (#269) | `rig/tools/ufmf.py` | **rig-nodes** (record): BIAS's file format, numpy only, no arena semantics | R4 | `dashboard_replay.py` today; any BIAS rig's analysis | #269; `rig_nodes` has no numpy run-dependency today (§3 Q3) | S |
| Arena frame renderer (#269) | `rig/nodes/arena_display.py` | **pyDisplayTools** (record): Python port of `js/panel-color.js` | R1 | `stimulus_node.py`, `dashboard_replay.py` (stay); the Python runner | pyDisplayTools channel; runner plan session | S |
| BIAS health (#269) | `rig/nodes/bias_health.py` | **rig-nodes**, in flight: rig-nodes PR 1 (`feat/bias-health`, adds a `derive` hook to `foxglove_json.convert`). #269's `dashboard_replay.py` already imports `rig_nodes.bias_health` (≥ 0.2.2) | R4 | okey-cokey dashboard; any BIAS rig | rig-nodes 0.2.2 release → `rig/pixi.toml` re-pin → #269 merge | S |
| Stimulus dashboard (#269) | `rig/nodes/stimulus_node.py`, `stimulus_core.py`, `dashboard_replay.py`, `rig/tests/test_stimulus*.py`, `rig/foxglove/arena-okey-cokey.json`, `rig/tests/fixtures/*` | stay (record) | R3 | — | #269 | — |

### 1c. Device nodes still inside open PRs

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| ScanImage ZMQ frames node (#261) | `rig/nodes/scanimage_frames_node.py`, `rig/tests/zmq_frames_mock.py`, `rig/tests/test_scanimage_frames.py`, `rig/tools/zmq_latency_report.py` | **rig-nodes** (record): a device stream adapter plus its mock and latency report; zero arena semantics | R2, R4 | Bergamo 2P rig; the mock's frame format is shared with `reiserlab/scanimage-2026-bergamo` | #261 imports `from _common import …`, which #274 deletes: the node becomes `rig_nodes.scanimage_frames_node` (+ `rig_nodes.sims.zmq_frames_mock`), `pyzmq` becomes a `rig_nodes` run-dependency, and a rig-nodes release precedes the webDisplayTools half (gateway, `rig.py`, `pixi.toml` edits stay). LAB-311 lab day gate | M |
| SiPM node (#266, draft) | `rig/nodes/sipm_node.py`, `sipm_cmd.py`, `thorsipm.py`, `rig/tests/test_sipm.py` | **rig-nodes** (record) | R2, R4 | Bergamo 2P rig only today; "device node" is the category the record assigns, not a second-consumer test | same `_common` rewrite; `thorsipm.py` is a Windows-only ctypes driver for an unreleased Thorlabs DLL, never run on hardware (LAB-319, Block S). Its `/sipm/*` entries in `mcap_convert.CONNECTOR_TOPIC_SRC` and `bridge_node` stay | M |
| New vocabularies | `/sipm/cmd\|reply\|status` (`status`, `get`, `info`), `/scanimage/frame_meta`, `/scanimage/frame_stats`, `/scanimage/preview/*` | **rig-nodes `CONTRACT.md`** §2 and §4, in the same PR as each node (CONTRACT rule 8) | R2 | — | with the two moves above | S |

### 1d. `fictrac-bridge/` (bridge 3.4, the legacy path)

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| Closed-loop math | `bridge.py`: `frame_index_from_heading`, `wrap180`, `bias_angle_deg`, `behavior_v1_row`, `BIAS_TYPES`, `FT_TS_NS_PER_MS`, the state of `Pipeline` that maps heading → index | **pyDisplayTools** (record §3.1: "closed-loop mapping … imported by the gateway instead of carried as a copy") | R1 (the gateway → `bridge.py` path import is webDisplayTools-internal today, so no cycle either way) | the Python runner first; then the gateway | pyDisplayTools channel; `tests/test-plugin-registry.js` pins `BIAS_TYPES` equal in three places, a fourth joins. Runner plan session | M |
| behavior_v2 codec | `bridge.py`: `frame_schema_line`, `compact_arena_command`, `expand_arena_command`, `convert_v1_to_v2`, `convert_v2_to_v1`, `detect_format`, `canonical_json`, `RunlogFormatError` | **recommend stays** (into `rig/nodes/runlog_codec.py` beside `_rows.py` when bridge 3.4 retires). Record §3.3 lists two of these for pyDisplayTools, §3.1 keeps "the behavior_v2 export while LAB-309 lives" here; the format retires 2026-12-31, so it should not become a pyDisplayTools API | R3 | the converter, `scripts/runlog-v2-corpus.py` | decision (§3 Q1) | S |
| Transport and server | `bridge.py`: `Hub`, `LogWriter`, `InputManager`, `make_dispatcher`, `read_udp`, `read_tcp`, `run`, `main` | stays; the gateway reuses them by path. Nothing is rig-generic (the WebSocket is the browser contract). When bridge 3.4 retires, fold into `bridge_node.py` and delete `fictrac-bridge/` | R3 | — | course rigs moving to `pixi run rig` (LAB-309 horizon) | M (retirement) |
| Bridge README | `fictrac-bridge/README.md` | stays (already updated by #274 for the simulator) | H | — | — | — |
| Bridge tests | `tests/test-bridge-behavior.py` (bias + mapping), `tests/test-bridge-clock.py`, `tests/test-closed-loop-report.py` (mirrors `bias_angle_deg`), `scripts/runlog-v2-corpus.py` | follow their subjects: the bias and mapping tests go with the math; the clock, codec and corpus tests stay | R1 | — | as above | S |
| Bridge CI | `.github/workflows/validate-fictrac-bridge.yml` | stays while `bridge.py` exists; delete with the retirement | — | — | — | S |

### 1e. `scripts/`

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| Closed-loop report | `scripts/closed-loop-report.py` | stays (doubtful): arena run-log analysis (bias, coupling, index consistency); it re-implements `bias_angle_deg` so it imports nothing. Natural future home is a pyDisplayTools analysis module beside the evaluator, so the two stop mirroring each other and the runner's deterministic-replay check (record §11) can use it | R4 doubtful stays | the Python runner's conformance tests | pyDisplayTools; runner plan | M |
| Controller telemetry and run-log checks | `scripts/telemetry-report.py`, `scripts/wedge-scan.py`, `scripts/runlog-check.py`, `scripts/bench-check.py` | stay: G6 controller telemetry rows (`cc`/`cf`/`cs`), firmware opcodes, SD stalls, Studio run-log completeness. Arena semantics throughout; they read the derived JSONL, not bags (the only bag readers are the converter and the moved `rig_nodes.mcap_index`/`cdr`/`foxglove_json`) | R4 | — | — | — |
| Data-repo index | `scripts/build-runlog-index.py`, `scripts/data-repo-workflows/runlog-index.yml` | stay (course data repository tooling) | — | — | — | — |
| Soak watcher | `scripts/soak-wedge-watch.sh` | stays, or delete (hard-codes one Mac's path) | — | — | — | S |

### 1f. `docs/development/`

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| FicTrac columns audit | `fictrac-columns-in-the-bag.md` | stays (arena-authored decision). CONTRACT §5 is its normative result but does not link to it: add the link in rig-nodes | R5 | readers of `ArenaFrame.msg` | — | S |
| Talk outline | `ros2-mcap-foxglove-talk-outline.md` | stays (a dated talk draft; the measured Zenoh and MCAP numbers are already rig-nodes `docs/shm-bench.md`) | H | — | — | — |
| Run-log format authority | `telemetry-logging-reference.md` | stays (record §7.11); two stale `ros2-poc/` lines → docs pass | — | — | — | S |
| Model-fly bench | `model-fly-bench.md` | stays; names `fictrac_sim.py` and `pixi run sim`, now `rig-fictrac-sim` behind the root task → docs pass | — | — | — | S |
| Arena protocol, controller, firmware, run-log docs | `bridge-connectors-exec-summary.md`, `rig-model-plugins-vs-devices.md`, `clock-sync-analysis-2026-09-18.md`, `2p-line-sync-rig-checklist.md`, `2p-scanimage-signal-logging.md`, `lab-test-day-windows-2026-09-14.md`, `closed-loop-*.md`, `runlog-*.md`, `run-log-encoding-options.md`, `mode3-*.md` | stay. Checked: none describes graph behavior beyond what `CONTRACT.md` now holds | R4 | — | — | — |
| The record | `rig-software-repos-and-runners.md` | stays; §3.3 needs a one-line amendment if Q1 or Q2 below is decided against its current text | — | — | — | S |

### 1g. CI

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| Interfaces build | `.github/workflows/rig-interfaces.yml` | removed by #274 (rig-nodes `package-set.yml` builds, indexes and install-tests the set on three platforms) | — | — | — | done |
| Cross-repository smoke | none: no workflow runs `rig/tests/test_ros2_poc.py`; `ci.yml` runs `pixi run test` (root), which the record says does not include the ROS harness | **new here**, not a move: `rig-smoke.yml` on ubuntu-24.04 (`cd rig && pixi install --locked && pixi run test`), on changes under `rig/` and on a rig-nodes re-pin. rig-nodes' `accept` job proves the installed packages; this one proves the gateway against them | §7.8 | — | decision (§3 Q5): a RoboStack install per run | M |

### 1h. Decisions recorded only in webDisplayTools that describe rig-nodes behavior

| Item | Current path | Destination | Rule | Consumer | Blocker / PR | Effort |
|---|---|---|---|---|---|---|
| Recording lessons and measurements | `rig/README.md` "Plan B spike → What broke" items 1 (rosbag2 `write()` argument order), 2 (MCAP plugin wants `compression: "None"`), 3 (buffer while the bag opens), 4 (`mcap` reader must read file order for a torn bag), 6 and 8 (importable ≠ usable typed package; one build per process); "Measured on the Mac" (bag open 158 ms default vs 8 ms crashsafe; crash loss ≈ 1 frame vs the run) | **rig-nodes `docs/recording-decisions.md`** (a copy; the record stays here as history). The code in `rig_nodes.recorder`, `mcap_index`, `_common.probe_interfaces` carries the fixes with comments, but the evidence and the why live only in this build record | §7.1(b), §7.4 | the robot station's recorder use; the recording-ownership owner (LAB-340) | — | S |
| BIAS bench quirks | `rig/README.md`, "Mac results" (`getTimestamp` sent 1 ms after `start-capture` reads 0.0); relative filename → dark capture (already a warning in `bias_node`) | the `getTimestamp` note → `rig_nodes.bias_node` docstring or CONTRACT §4 | R2 | any BIAS executor | — | S |
| Already covered | adapter envelope, Kinefly KF/1 discrimination, Windows precise clocks, loopback Zenoh, instance namespacing (LAB-340), ScanImage bug B2 | nothing to move: CONTRACT §1–§6, `scanimage_node` allowlists, rig-nodes `README.md` | — | — | — | — |

## 2. Move batches, in order

**Batch 0: docs only, no PR dependency (can go now).** rig-nodes: CONTRACT §5 link to
`fictrac-columns-in-the-bag.md`; `docs/recording-decisions.md`; the `getTimestamp` note; the consumer
manifest template. webDisplayTools: the docs pass (stale `ros2-poc/` paths in
`telemetry-logging-reference.md`, `model-fly-bench.md`'s simulator path, `WINDOWS-TEST.md` §1/§2/§7b
→ pointers to `SETUP.md`) and the arena-side `rig/SETUP.md` (§4). Order: merge rig-nodes
`docs/setup-note` first, so the install recipe has one home before anything points at it.

**Batch 1: after #274 merges, one rig-nodes release (0.2.2).** `bias_health` (rig-nodes PR 1) plus
`ufmf.py` (needs the numpy decision, Q3). Then `rig/pixi.toml` re-pins 0.2.2 and #269 merges with its
"stays" set; its PC setup notes split per §1b.

**Batch 2: one rig-nodes release per satellite, each after its hardware gate.** #261 (LAB-311 lab
day): `scanimage_frames_node` + mock + test + latency report into `rig_nodes` (pyzmq run-dependency),
CONTRACT §2/§4 additions, then the webDisplayTools half rebased onto #274. #266 (Block S on the
Bergamo PC): `sipm_node`/`sipm_cmd`/`thorsipm` + test, CONTRACT additions, then its converter and
gateway edits. Whether these ship as 0.2.3/0.2.4 or one 0.3.0 is Q4.

**Batch 3: the runner plan session (pyDisplayTools).** `patfile.py` + `arena_display.py` as the G6
module; the closed-loop math and `BIAS_TYPES` as the evaluator; optionally `closed-loop-report.py` as
the analysis module. webDisplayTools' gateway, converter, `stimulus_core.py` and `tiff_run_to_mcap.py`
then import the package; `test-bridge-behavior.py`'s bias and mapping suites follow. Precondition:
pyDisplayTools gets a release path (it has `pyproject.toml` + `pixi.lock`, no channel or tag yet).

**Batch 4: bridge 3.4 retirement (LAB-309 horizon, 2026-12-31).** `Hub`/`LogWriter`/dispatcher fold into
`bridge_node.py`; the behavior_v2 codec becomes `rig/nodes/runlog_codec.py` (if Q1 = stays); delete
`fictrac-bridge/`, `validate-fictrac-bridge.yml`, the root `bridge` task; course rigs on `pixi run rig`.

**Never (decided stays):** gateway, converter, composition, arena visualization and layouts, harness
and emulator, run sheets and results, telemetry and run-log scripts, every arena protocol/firmware doc.

## 3. Open questions for Michael

1. **behavior_v2 codec:** record §3.3 sends `frame_schema_line` and `compact_arena_command` to
   pyDisplayTools; §3.1 keeps the export here. Recommendation: stays (the format retires); amend §3.3.
2. **`bias-ufmf.ps1`:** keep the workaround as a rig script (record), or make it a `bias_node`
   command so a second BIAS rig does not rediscover the "capture first, then load configuration" rule?
3. **numpy in `rig_nodes`:** `ufmf.py` needs it and the package has no run-dependencies beyond ROS
   today. Accept numpy for the whole package, or keep readers like uFMF in a separate optional package?
4. **Release cadence for the satellites:** one 0.3.0 carrying ScanImage frames + SiPM + bias_health +
   uFMF, or a patch release per node as each hardware gate passes? (The record prefers one tested set
   per repository until independent cadence is demonstrated.)
5. **Cross-repository smoke in CI:** a RoboStack install per run (1–2 GB) to run the harness on
   `rig/` changes and re-pins, or keep it a manual step named in the release notes?
6. **`rig/SETUP.md` (arena half):** write it now from `WINDOWS-TEST.md` §0–§2, the okey-cokey setup
   notes and `SCANIMAGE-DAY.md` §1, or wait until rig-nodes' `SETUP.md` has landed?
7. **Generic device-status board:** leave `viz_node`'s BIAS/Kinefly halves and `arena-bias.json` until
   the robot station asks (recommended), or extract now while the author remembers?

## 4. Found on the way (not moves)

- rig-nodes `SETUP.md` (branch `docs/setup-note`) says "application-specific setup … lives with the
  application: webDisplayTools `rig/SETUP.md`". That file does not exist; the arena-side material is
  spread over `WINDOWS-TEST.md` §0–§2, `SCANIMAGE-DAY.md` §1 and #269's `okey-cokey-pc-setup.md`.
- #261 and #266 were rebased over the `ros2-poc/` → `rig/` rename but not over #274: both still import
  `_common` from `rig/nodes/`. Their next rebase is a rewrite into `rig_nodes`, not a path fix.
- #269 already depends on `rig_nodes.bias_health` (≥ 0.2.2), which exists only on rig-nodes PR 1.
- `scripts/soak-wedge-watch.sh` hard-codes `/Users/reiserm/…`.
- Stale `ros2-poc/` mentions on `main`: `telemetry-logging-reference.md` (two lines), the talk
  outline (a Dropbox data path, leave), the v0.98 release-notes headline.

LAB-338, LAB-303.
