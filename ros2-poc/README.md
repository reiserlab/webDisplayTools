# ROS 2 bridge proof of concept (LAB-303)

A bounded spike, not a product: can the web runner's bridge be a ROS 2 node graph while the
**unmodified Arena Studio** keeps connecting to `ws://localhost:8765`, the **run log stays the
same file every reader already accepts**, and the devices (FicTrac, Kinefly, BIAS) sit behind
small adapters with **no custom message types**? Decision context: Linear LAB-303 (2026-10-14
comment holds the acceptance criteria), `docs/development/bridge-connectors-exec-summary.md`.

This directory is its own pixi workspace. The root `pixi.toml` and `fictrac-bridge/` are
untouched, so bridge 3.4 (`pixi run bridge` at the repo root) stays installed side by side.

```
 fictrac_sim.py / FicTrac ──UDP :60000──▶ fictrac_udp_adapter ──/fictrac/raw──▶┐
 Kinefly (KF/1)           ──UDP :60001──▶ kinefly_udp_adapter ──/kinefly/raw──▶│  bridge_node ──ws://localhost:8765──▶ Arena Studio (unmodified)
 BIAS (HTTP :5010)        ◀──────────────  bias_node  ◀──/bias/cmd  /bias/reply,status──▶│     │ ──/arena/frame──▶ any ROS node
                                                                                    └─────┴──▶ runlogs/arena-log-*.jsonl (behavior_v2, as today)
 all topics std_msgs/String carrying JSON · middleware rmw_zenoh_cpp · one Zenoh router per host, loopback only
```

## Setup and run

```bash
cd ros2-poc
pixi install              # RoboStack Jazzy ros-base + rmw_zenoh + demo nodes + websockets/pyzmq (≈1.3 GB)
pixi run rig              # router + FicTrac adapter + bridge node        → Studio connects to ws://localhost:8765
pixi run rig -- --kinefly --bias           # + Kinefly KF/1 adapter + BIAS node
pixi run rig -- --sim --bias --bias-sim    # demo with no hardware: FicTrac sim + a fake BIAS program
pixi run test             # the acceptance run (≈ 60 s, no hardware, see below)
```

Pieces, individually (each is also a `pixi run` task; `--help` on every script):

| task | what |
|---|---|
| `router` | `ros2 run rmw_zenoh_cpp rmw_zenohd` with `config/zenoh-router.json5` (listens on `tcp/127.0.0.1:7447`) |
| `talker` / `listener` | the stock `demo_nodes_py` pair — the first thing to run on a new machine |
| `fictrac-adapter` | UDP :60000 → `/fictrac/raw`; FicTrac's own `sock_port` stays what it is today |
| `kinefly-adapter` | UDP :60001 → `/kinefly/raw`; accepts only `protocol: "Kinefly", version: 1` datagrams |
| `bias-node` / `bias-cmd` | BIAS HTTP command port ⇄ `/bias/cmd`, `/bias/reply`, `/bias/status`; `bias-cmd` sends one plugin command |
| `bridge-node` | bridge.py's `Hub` + `LogWriter` + `Pipeline` + `make_dispatcher` on ROS input; `/arena/frame` mirror |
| `sim` | the root `fictrac-bridge/fictrac_sim.py`, unmodified (`-- --model fly --kp 2` for a fixating fly) |
| `kinefly-sim` / `bias-sim` | synthetic KF/1 producer; a fake BIAS program (HTTP, state machine, writes the video file) |
| `studio-emulator` | the Studio runner's exact bridge conversation, for machines without a browser |

Environment set by the workspace (`[activation.env]`): `RMW_IMPLEMENTATION=rmw_zenoh_cpp`,
`ZENOH_ROUTER_CHECK_ATTEMPTS=0` (nodes wait for the router), `ZENOH_ROUTER_CONFIG_URI` /
`ZENOH_SESSION_CONFIG_URI` → the two files under `config/` (stock rmw_zenoh configs with the
endpoint changed from `tcp/[::]:7447` / `tcp/localhost:7447` to `tcp/127.0.0.1:7447`: the
stock router fails on a host without IPv6, and a rig's graph should not be reachable from the
lab network anyway). The two config paths use `$PIXI_PROJECT_ROOT`; `rig.py` sets them
explicitly for its children, so `pixi run rig` does not depend on the shell expanding it
(Windows: to verify; the individual `router` / `*-adapter` tasks do).

## What was built in the first day

**Hour one (middleware bring-up).** `pixi install` resolved and installed for linux-64,
osx-arm64 and win-64 from `conda-forge` + `robostack-jazzy` with no manual step (Python 3.12,
`ros-jazzy-ros-base` 0.11, `ros-jazzy-rmw-zenoh-cpp` 0.2.9). Router up; talker/listener 7 of 7
messages under `rmw_zenoh_cpp`; the FicTrac adapter republished the simulator at 50.0 Hz
(`ros2 topic hz`) as one `std_msgs/String` JSON envelope per record:
`{"src":"fictrac","seq":…,"rx_epoch_ms":…,"rx_mono_ns":…,"raw":"<the FicTrac line>"}`.

**The bridge node** (`nodes/bridge_node.py`) imports `fictrac-bridge/bridge.py` by path and
reuses its four load-bearing parts unmodified. Only the input changed (a subscription instead
of a UDP socket), so the run log is the behavior_v2 file bridge 3.4 writes. Additions, all
visible in the log: `connector_status` lines (frames per source, adapter→bridge latency
p50/p99), `source_lost` / `source_resumed` when a logged source goes silent (`--source-timeout`,
default 2 s), `["kf", ms, seq, src_t_s, left, right, head, abdomen]` rows from Kinefly, and
`{"type":"connector","src":"bias",…}` events for every BIAS reply and status poll. The
`fictrac_port` config key is acknowledged with a warning instead of re-binding (the adapter
owns the socket).

**Kinefly** (`nodes/kinefly_udp_adapter.py`): KF/1 as specified in
`mbreiser/Kinefly-MacOS/docs/udp-protocol.md` — protocol discrimination before any decoding,
non-KF/1 datagrams counted and dropped, the record republished verbatim. Logging only; the
L−R → yaw integrator is slice 2 work and is deliberately not here.

**BIAS** (`nodes/bias_node.py`): the protocol's `camera` plugin commands (`connect`,
`startRecording`, `stopRecording`, `startPreview`, `stopCapture`, `getTimestamp`, `disconnect`)
mapped to BIAS's HTTP command sequences; a timeout is an **unknown** outcome (`outcome:
"unknown"`, then a `get-status` reconcile); `startRecording` reports the video file as an
`artifact`. Since the Studio does not send plugin commands to the bridge yet, commands come from
`pixi run bias-cmd` (or any node publishing `/bias/cmd`).

## Acceptance run (`pixi run test`, `tests/test_ros2_poc.py`)

Brings up the whole graph in-process, drives it with `fictrac_sim.py --model fly --kp 2` on
the WebSocket (FicTrac untouched) and `tests/studio_emulator.py` (3 constant-bias epochs of
6 s, the exact message sequence of `js/fictrac-bridge-client.js` + `js/arena-runner-g6.js`,
one `arena_command` echo per applied frame honouring the epoch gate), **SIGKILLs the FicTrac
adapter 2 s into epoch 2 and restarts it 3 s later**, and sends BIAS commands mid-run.
Result on 2026-10-14 (Linux container, loopback): **29 / 29**.

| LAB-303 criterion | evidence |
|---|---|
| pixi install, no manual steps; one `pixi run rig` | lock file for osx-arm64 / win-64 / linux-64; `rig.py` supervises router + nodes |
| no custom message types | `std_msgs/String` only (checked by grepping `nodes/`) |
| FicTrac via the sim through a UDP→ROS adapter, FicTrac untouched | `fictrac_sim.py` unmodified; 912 rows logged, every frame |
| Kinefly fork via a KF/1 adapter | 2153 `["kf",…]` rows with left/right angles; garbage datagram rejected |
| BIAS via the Mac port | here `bias_sim.py`: 25 connector events, video artifact path logged and file present; the real port = same HTTP interface, **to confirm on the Mac** |
| unmodified Studio passes the closed-loop report | emulator 12/12 protocol assertions; report: 3 epochs from `fictracApply`, rejection **+1.01 / +0.32 (interrupted) / +0.99**, idx mismatch 0.00 % |
| … and the runlog format tests | `js/runlog-format` normalizer + `js/runlog-replay` parser accept all 3865 lines; `bridge.py --convert` v2→v1→v2 byte-identical |
| the closed-loop node stamps its own sample time | `Pipeline.handle_line`'s `now_ms()` (reused); adapter→bridge latency p50 1.7 ms, p99 3.8 ms logged |
| bridge 3.4 stays installed side by side | root `bridge.py --version` still `fictrac-bridge 3.4 …` |
| a device node killed mid-run leaves the log intact | `source_lost` (silence 1835 ms) + `source_resumed` logged; file closes normally; every reader parses it |

One subtlety the harness documents: the report's epoch opens at the `fictracApply` event's
millisecond, and a FicTrac row computed under the previous mapping can carry that same
millisecond (it is even written before the config line). The report then reconstructs that
one row with the new epoch's bias and tare. The bar is therefore "≤ 1 boundary row", which is
what bridge 3.4 produces as well; the mapping itself is exact.

## Further automated checks (2026-10-14, same container)

| check | result |
|---|---|
| **Soak**: `pixi run rig -- --sim --kinefly --bias --bias-sim` with the emulator looping 2 × 20 s epochs per run + one BIAS command per run, 60 min | 78 / 78 runs passed, 78 / 78 BIAS replies ok, no launcher errors; latency flat (p50 1.6–1.8 ms, p99 3.2–4.6 ms). **Watch item:** RSS creeps — bridge node 67.4 → 71.8 MB (+58 kB/run), adapters +30–36 kB/run, BIAS node +28 kB/run, router +12 kB/run. Harmless for a rig session, but a slope, not noise; a multi-hour soak should precede calling it benign |
| **Zero loss under load**: sim at 200 Hz × 4000 frames + Kinefly at 500 Hz × 10 000 | 4000 / 4000 FicTrac rows (frame counters 1..4000, no gap); every KF/1 frame sent while the log was open logged, no sequence gap; p99 3.3 ms (FicTrac) / 4.7 ms (Kinefly) |
| **Router killed and restarted mid-run** (6 s outage) | no data gap at all (rmw_zenoh peers keep their direct links; the router is discovery), emulator run completed, log intact |
| **Student mistakes**: a second `pixi run rig`; `pixi run rig` while bridge 3.4 holds ws :8765 / udp :60000 | `rig.py` pre-flights its ports and names the culprit in one line instead of a Rust panic or a Python traceback |
| **Code review** of the diff (nine findings) | fixed: BIAS worker exception guard + status-poll coalescing, watchdog scoped per log file (`RosLogWriter` hooks instead of re-parsing messages), router death stops the rig, kill timing in the harness anchored on the log, config paths set explicitly by `rig.py`, shared `_common.py` |

## Mac results (2026-10-14, MacBook Pro osx-arm64, macOS 27.0.1, Chrome 155)

The items the container could not cover, run on the lab Mac with the 2×10 bench arena
(controller fw `c15d840a 2x10 2026-09-29`), the real BIAS Mac port and the real Kinefly fork.

| step | result |
|---|---|
| `pixi install` | **25 s** wall for a fresh download (the package cache had none of these packages), 1.0 GB env, no manual step; `ros-jazzy-rmw-zenoh-cpp` 0.2.10 from the lock |
| `pixi run talker` / `listener` under `rmw_zenoh_cpp` | router listening 2.9 s after start; every message heard ≈ 1.5 ms after it was published. The only noise is the stock demo nodes' `rcl_shutdown already called` traceback on Ctrl-C (an upstream `demo_nodes_py` quirk, not the middleware) |
| `pixi run test -- --keep` | **29 / 29** in 27 s; adapter→bridge latency p50 0.89 ms / p99 1.43 ms (1.7 / 3.8 in the container) |
| **Unmodified Arena Studio** (the GitHub Pages copy, v0.94) → `pixi run rig -- --sim --sim-args "--model fly --kp 2 --seed 1"`, G6 controller over Web Serial | Connected to the bridge node first try; **no Chrome local-network-access prompt** appeared for `reiserlab.github.io` → `ws://localhost:8765`. Two Mode-3 constant-bias runs (`cl_bias_none` / `cl_bias_constant` +90°/s / `cl_bias_constant_rev` −90°/s, 20 s each) **auto-committed through the normal path** to `reiserlab/cshl-2026-course` `runlogs/bench00/` (`…T21-02-13__lhc9k8i6.jsonl.gz`, `…T21-09-58__lrbhnsf5.jsonl.gz`); each gunzips byte-identical to the bridge node's own file. `scripts/closed-loop-report.py`: 3 epochs from `fictracApply`, idx mismatch **0.00 %** in all six epochs; rejection +0.39 / −0.46 and +0.48 / −0.50 (the card's only rotating pattern is a 20-frame grating, so the model fly's "feature" wraps every 36°; the mapping check is the point here). `scripts/runlog-check.py`: **OK** on both files — `run_metadata.firmware` and SD identity present, trial verdicts 3 pass / 0 fail, `cc_0x70_ok` 3000, `fictrac_per_cmd` 1.0 (the container's logs lacked these only because the emulator has no controller) |
| Real BIAS Mac port (`bias/build/test_gui.app`, C922 webcam as cam 0, HTTP :5010) via `pixi run bias-node` + `bias-cmd` | `connect` / `startRecording` / `getTimestamp` / `stopRecording` all `ok`, during the second Studio run as well (60 status + 3 reply connector events in that committed log). Reply shape identical to `bias_sim.py` (`[{"command","message","success","value"}]`); `get-status` value keys identical except the sim's extra `videoFile`. `start-capture` 180–280 ms, every other command ≈ 1 ms; server listens dual-stack (`*:5010`), 127.0.0.1 works. Two real-port facts the sim does not have: (1) a **relative `filename` resolves against BIAS's own cwd** (`/` when launched with `open`); `start-capture` then returns success while nothing captures (`capturing:false`, frame count stays 0, the preview never goes live) — `bias_node.py` now warns on a relative filename; (2) `get-video-file` answers `<stem>.jpg`, but the Mac port writes `<stem>_cam_0_date_…_v001/movie.mjpg` + `index.txt` and a `stamp_log_cam0.txt` beside it, so the logged `artifact.path` is the stem the operator asked for, not the file on disk |
| Real Kinefly fork (`mbreiser/Kinefly-MacOS`, OpenCV 4.13, headless, synthetic 160 fps sample) `--udp 127.0.0.1:60001` → `pixi run kinefly-adapter` | 160 / 160, then 9600 / 9600 datagrams sent with `send_errors 0`; adapter **0 rejected**; **9487 `["kf",…]` rows** with left / right / head / abdomen angles in the committed run log (the remainder fell outside the log window); adapter→bridge p50 0.73 / p99 1.29 ms at 160 Hz |

**BIAS from the protocol (Studio v0.95, branch `claude/bias-connector-command`, 2026-10-14 evening).**
The web runner now drives a protocol's `camera` plugin (BiasPlugin) through the bridge
(`connector_command` → `/bias/cmd`, `/bias/reply` → `connector_reply`; `hello_ack` advertises
`connectors: ["bias"]`, so bridge 3.4 yields a visible skip instead). End to end on this bench,
Studio served from localhost, real BIAS app, `fictrac_sim --model fly`: a 6-step protocol
(`cam_start`: connect → startRecording → getTimestamp · two 15 s Mode-3 trials · `cam_sync`:
getTimestamp · `cam_stop`: getTimestamp → stopRecording) completed with **0 errors, 0 skips**;
all six command/reply pairs are in the run log (`via: "ws"`), the recording
(`poc_studio_run_cam_0_…_v001/movie.mjpg`, 764 frames ≈ 24 fps × 32 s) exists, closed-loop
report idx mismatch 0.00 %, `runlog-check` OK. **Sync:** the bridge-clock interval between the
two later getTimestamps matched BIAS's own timestamps to −62 ms (one to two frames at 24 fps);
the first getTimestamp, sent 1 ms after `start-capture` returned, read 0.0 because BIAS's clock
starts at its first frame, ≈ 300 ms later — take the alignment stamp ≥ 0.5 s after
startRecording, or anchor on the first frame. The harness (`pixi run test`) exercises the same
path through the emulator: 32 / 32.

One detour worth knowing: the stock `fictrac_bias_test.yaml` names `frame2_h_ccw_200f` at `pattern_ID 4`; this card's slot 4 is a 1-frame color test pattern, the runner read `frames: 1` from the card (correctly) and the display sat on frame 0. The protocol was re-pointed at the card's 20-frame grating — a card-content mismatch the Studio already warns about, not a bridge issue.

**Still not verified:** Windows execution (`win-64` only resolves and locks; the rig-PC session is
scripted step by step in `WINDOWS-TEST.md`), and the macOS router with the stock IPv6 config (the
loopback config was used throughout).

## Observations for the decision

* Install friction was low: a ~1.3 GB environment, one lock file, no system packages. The
  only environment-specific knobs were the two Zenoh endpoint lines.
* The graph adds ~1.7 ms (p50) between the UDP receive and the bridge on loopback; the
  WebSocket side is unchanged.
* `rmw_zenoh` needs the router process running; without it nodes retry forever
  (`ZENOH_ROUTER_CHECK_ATTEMPTS=0`). `rig.py` starts it first and waits for the port.
* Everything a student would debug is `ros2 topic echo /fictrac/raw`, `/kinefly/raw`,
  `/bias/status`, `/arena/frame` — plain JSON strings.
* Not exercised: rosbag recording, rosbridge, Frank's FicTrac ROS 2 node pair. The log stayed
  the bridge's NDJSON on purpose (the readers are the expensive part to replace).

## Plan B spike (2026-10-14 evening, LAB-303) — Frank's graph with MCAP as the record of truth

Built on the graph above so the architecture decision can be made on measured data. Hard cutover
and MATLAB-on-the-graph are out of scope; bridge 3.4 stays installed side by side. The browser
protocol is unchanged, so the Studio on this branch (v0.95, with the BIAS connector path) works
without further changes; **"ROS Studio" = that Studio served from the `/ros/` Pages path** (below).

```
 FicTrac / fictrac_sim ──UDP :60000──▶ fictrac_udp_adapter ──/fictrac/frame (FicTracFrame)──▶┐
 Kinefly (KF/1)        ──UDP :60001──▶ kinefly_udp_adapter ──/kinefly/raw──────────────────▶│ bridge_node ──ws :8765──▶ Studio
 BIAS (HTTP :5010)     ◀── bias_node ◀─/bias/cmd   /bias/reply,status──────────────────────▶│   │ /arena/frame (ArenaFrame), /arena/browser, /arena/event, /arena/session
                                                                                            └───┴──▶ runlogs/<run>.bag/  (MCAP, rosbag2_py)  ──mcap_convert.py──▶ <run>.jsonl (behavior_v2 | v1 | full)
```

### What was built

| item | where | what |
|---|---|---|
| MCAP record | `nodes/recorder.py`, `bridge_node.py` | one bag per run (opened with the run's log, closed at `log_control off` / `log_export` / shutdown) holding every device topic as received (raw CDR bytes), `/arena/frame` (the closed-loop evaluation with the node's **own sample time** `t_ms`/`ms` as fields, and as MCAP `publish_time`), `/arena/browser` (**every** browser message, verbatim, with the receive stamp), `/arena/event` (bias_config, heading_tare, connector_status, source_lost/resumed, warn), `/arena/session`. Bridge-side records carry the writer's emission sequence number `seq`. Two writer profiles: `crashsafe` (no chunking, no cache; the default) and rosbag2's `default`. |
| converter | `nodes/mcap_convert.py` (`pixi run convert`) | bag → NDJSON, pure Python (`mcap` + a 60-line CDR decoder driven by the schema text rosbag2 embeds): no ROS process needed, reads a torn bag with `--recover`. Reuses bridge.py's own pure encoders (`compact_arena_command`, schema line). Levels are a converter option (`--level behavior_v2|behavior_v1|full`); the run's acked level is the default. `--order seq` reproduces the live writer's order; `--order time` is what a separate closed-loop process would have to do. ONE ms base per run (the pipeline's t0 is set from the log's open stamp — bridge 3.4 takes two samples there, comparison.md appendix 4). `log_export` returns the converted log; the live NDJSON stays as a shadow file during the spike and `converted == live` is checked and printed at every export. |
| typed messages | `interfaces/arena_interfaces/` (`FicTracFrame`, `ArenaFrame`, `ConnectorReply`) | built **by `pixi install`** (pixi-build preview + the RoboStack `pixi-build-ros` backend; the workspace depends on the package by path). `pixi run build-interfaces` is the colcon alternative. `ArenaFrame` and `FicTracFrame` are in use; `ConnectorReply` is defined and built but the BIAS reply stays JSON-in-String (its shape is BIAS's, not ours — typing it would make the derived connector event a rebuild instead of a copy). |
| FicTrac as a typed topic | `fictrac_udp_adapter.py --typed`, `bridge_node.py --typed` | the adapter publishes `/fictrac/frame` (parsed columns + FT tag + receive stamps + the verbatim line) beside `/fictrac/raw`; the bridge subscribes to the typed topic when the package imports (`auto`). The mapping math still parses the verbatim line, so it stays byte-for-byte bridge 3.4's. |
| harness | `tests/test_ros2_poc.py` | the 32 PoC checks now judged against the **converted** log, plus bag presence per topic, fidelity vs the shadow, levels, ordering, typed schemas, and a crash phase (bridge node SIGKILLed mid-run, both profiles): **46 / 46 in 46 s** on the Mac. |
| Pages path | `scripts/tiers/stamp.py --ros REF`, `deploy-pages.yml` input `ros`, `pixi run ros-preview`, `js/build-channel.js` channel `ros` | a third, optional path `/ros/` beside Production and Next: this branch's tree, stamped `channel: "ros"`, magenta badge/banner "ROS STUDIO", tier-suffixed window names, `run_metadata.channel = "ros"`. Off by default; a problem there never blocks the other tiers; the production tree check skips it. Production and Next are untouched (tiers test 109 / 109). **Enabling it on the live site needs this tooling commit on `main`** (the deploy workflow runs from `main`): a tooling-only PR, then `gh workflow run deploy-pages.yml -f ros=<spike sha>`. Until then: `pixi run ros-preview` + `python -m http.server -d _site`. |

### Measured on the Mac (MacBook Pro osx-arm64, macOS 27.0.1, pixi 0.69)

| measurement | result |
|---|---|
| `pixi install` with `ros-jazzy-rosbag2-py` + `ros-jazzy-rosbag2-storage-mcap` + `mcap` + the ament/rosidl toolchain (`cmake`, `ninja`, `cxx-compiler`, `colcon`) | 10 s wall with a warm package cache (the sibling PoC env had most packages); env **1.0 GB → 1.7 GB**; lock +1442 lines |
| typed messages, route 1: **pixi-build-ros** (scratch workspace, first attempt) | **37 s** wall for `pixi install` incl. an 18 s build of the package (`arena_interfaces-0.1.0-h60d57d3_0.conda`, 1.1 MiB, 149 files incl. Rust bindings); imported and serialized on the first try. One deprecation warning (`[package.build] channels` → `backend.channels`, fixed). |
| typed messages, route 1 integrated in `ros2-poc/pixi.toml` | `pixi install` **25 s** (17 s build); lock +3305 lines (a `conda_source` record per platform). Windows: the build needs MSVC 2022 on the PC (pixi cannot install it) — untested. |
| typed messages, route 2: **colcon** in the env (`pixi run build-interfaces -- --clean`) | build 23 s (first) / 12 s (second clean build), all 8 typesupport libraries. **First attempt failed at import**: `UnsupportedTypeSupport: Could not import 'rosidl_typesupport_c' for package 'arena_interfaces'` — RoboStack's toolchain sets the extension's install rpath to the env's `lib` only, and macOS SIP strips `DYLD_LIBRARY_PATH` on the way through pixi's shell. Fixed with `-DCMAKE_INSTALL_RPATH=<install>/lib;<env>/lib`: imports and serializes. |
| bag open (per run start, blocks the asyncio loop) | **158 ms** with rosbag2's defaults (100 MiB message cache) vs **8 ms** crashsafe; records arriving meanwhile are buffered, so nothing is lost either way |
| recording overhead on the closed loop (adapter → bridge, `connector_status`) | FicTrac p50 0.87 / p99 1.65 ms, Kinefly p50 0.82 / p99 1.51 ms — the same as the PoC without recording (0.89 / 1.43) |
| recorder receive time vs the closed-loop node's own sample time (`/arena/frame` `log_time − publish_time`) | p50 0.53 ms, p99 1.07 ms, max 1.2 ms (the sample time is a whole ms). The record carries both, so `idx` reconstruction uses the node's clock, never the recorder's. |
| conversion | 962 lines in 50 ms (smoke run); 3949 lines (harness run, 197 kB NDJSON) from a 4.1 MB bag of 4889 records. The bag is ~20× the NDJSON: it holds the raw inputs (every FicTrac line twice — typed fields + verbatim — every Kinefly envelope) and the outputs, uncompressed (zstd is a profile knob; compression and crash-safety pull in opposite directions). |
| **fidelity, sequenced lines** (frames, browser lines, bridge events, session/schema): converted vs the live writer | **byte-identical and in the same order** in every run (smoke, harness, both levels); `bag → behavior_v1` equals `bridge.py --convert` of the live v2 byte for byte; `full` carries the 25 FicTrac columns for every frame |
| fidelity, DERIVED lines (2204 Kinefly rows + 31 BIAS reply/status events): content | identical apart from `ms`; `\|Δms\|` **p50 0 / p99 1 / max 2 ms** (recorder receive vs the live writer's processing time) |
| fidelity, derived lines: placement | 113 of 2235 (5 %) land after a different neighbouring line than in the live file (within the same 1–2 ms). The file as a whole is therefore **not** byte-identical when Kinefly/BIAS are present; it is when they are absent. |
| `--order time` vs `--order seq` | same multiset of lines; **17 of 3949** positions differ (12 of 962 in the smoke run), all same-millisecond ties (`log_control` vs the first frame, runner `fictracApply` vs `bias_config`, `config` vs `heading_tare`); `closed-loop-report.py` output identical for both orders |
| **crash: bridge node SIGKILLed 2.5 s into a closed-loop epoch, `crashsafe` profile** | NDJSON (line-buffered): 624 lines / 160 frames, no torn line. Bag: `metadata.yaml` never written (as predicted), `--recover` + convert: 621 lines / **159 frames** — one frame (≈ 14 ms) and the two session lines lost; every reader parses the result. |
| crash, rosbag2 `default` profile | NDJSON: 625 lines / 159 frames. Bag: **nothing recoverable** — a short run sits in one unflushed 768 KiB chunk (plus the message cache) until close; `ros2 bag info` of a completed default-profile run shows exactly one chunk. Offline truncation of a completed default bag confirms it: nothing until 99 %, then everything. |
| what the readers needed | nothing: the converted log passes `js/runlog-format` + `js/runlog-replay` (JS), `closed-loop-report.py`, `bridge.py --convert` round trip, and (bench run below) `runlog-check.py` |

### What broke, in order

1. `rosbag2_py`'s four-argument `write()` is `(topic, data, recv_timestamp, send_timestamp)` — the opposite of what the docstring order suggests; the first bags had the node's sample time in `log_time`. Found by reading a bag back.
2. The MCAP storage plugin's YAML rejects `compression: ""`; it wants `"None"`. The first crashsafe bag failed to open and the exception propagated into the WebSocket handler. Now a recorder failure is a warning line and the run keeps its shadow file.
3. Records arriving during the 158 ms bag open were dropped (8 frames at 50 Hz): the recorder now buffers while opening.
4. The `mcap` Python reader's `iter_messages()` defaults to log-time order, which reads the whole file before yielding — a torn file yielded nothing. File order (`log_time_order=False`) in both modes.
5. The colcon-built extension's rpath (above).

### Plain comparison with the live-NDJSON PoC (same graph, 2026-10-14 afternoon)

| | live NDJSON PoC | Plan B spike (MCAP record of truth) |
|---|---|---|
| install size (osx-arm64 env) | 1.0 GB | 1.7 GB (+ rosbag2, MCAP plugin, C/C++ toolchain, colcon); bridge 3.4's root env is 0.28 GB |
| install time (warm cache) | 25 s | 25 s incl. building the interfaces package; the build needs a compiler on every installing machine (MSVC on Windows: untested) |
| processes per rig | router + FicTrac adapter + bridge node (+ Kinefly adapter, + BIAS node) = 3–5 | the same; the recorder runs inside the bridge node |
| latency (adapter → bridge, p50 / p99) | 0.89 / 1.43 ms | 0.87 / 1.65 ms |
| record of truth | the live `.jsonl`, written in processing order | the bag; the `.jsonl` is derived at export (50 ms per 1000 lines) or offline |
| crash loss (SIGKILL mid-run) | at most the line in progress | crashsafe profile: ≈ 1 frame + the session close, and `--recover` is required (no `metadata.yaml`); rosbag2 defaults: the whole short run |
| reader changes needed | none | none — sequenced lines byte-identical; Kinefly/BIAS lines ±2 ms and ~5 % placed one neighbour apart |
| log levels | writer option, acked | converter option; `log_control_ack` still acks the level (recorded with the run, the converter's default) |
| typed messages | none (String JSON) | FicTracFrame + ArenaFrame in the loop and the bag; ConnectorReply defined only |
| ordering across processes | not a question (one process) | solved here by the bridge-side `seq`; a separate closed-loop process would fall back to `--order time` (17 same-ms swaps per 4000 lines, readers unaffected) |

### Still not verified

Windows (now also: whether `pixi install` builds the interfaces package there — `WINDOWS-TEST.md` has the steps); the closed-loop math in a **separate** process (it stays in the bridge node here, so the `seq` ordering is available; the `--order time` numbers are the proxy); rosbag2's own reader on a torn bag (the spike's converter uses the `mcap` library instead); a multi-hour recording for bag growth; `ros2 bag play` of a recorded run against the Studio.
