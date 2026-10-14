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
lab network anyway).

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

## Not verified here (needs the Mac / a rig)

* A real browser: Web Serial and the Studio UI were replaced by the emulator. Run the Studio
  against `pixi run rig -- --sim` on the Mac and commit a run log through the normal path.
* The real BIAS Mac port: command names and the JSON-array reply shape follow BIAS's
  documented external interface; the `value` payloads are logged verbatim and untested.
* The real Kinefly fork sending `--udp 127.0.0.1:60001` (only `kinefly_sim.py`, which follows
  `kinefly/core/udp.py` byte for byte, was used).
* Windows (`win-64` resolves and locks; nothing was executed there) and the macOS router with
  IPv6 present (the loopback config sidesteps it).
* `scripts/runlog-check.py` fails on these logs for want of `run_metadata.firmware`,
  `stream_schema` and `trial_quality`, which only a Studio run with a controller produces.

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
