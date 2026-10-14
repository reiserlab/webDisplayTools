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
