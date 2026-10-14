# Bridge connectors: executive summary for review

**For:** Frank (original bridge author) · **From:** Michael (with Claude) · **Date:** 2026-10-14 · **Status:** for review; nothing is implemented. Your OK gates the first slice.

> **Status 2026-10-14 (evening):** reviewed by Frank and Isabel the same day. Frank counter-proposed a
> ROS 2 graph (his `bridge-connectors-exec-summary-ros.md` and `comparison.md`); the decision is now a
> bounded ROS 2 proof of concept before either plan's slice 0. This file is kept as the record of the
> connector proposal as reviewed. Current state and criteria: Linear LAB-303. Controller-hardware vs
> plugin rule and the `devices:` layer: `rig-model-plugins-vs-devices.md`.

## Why

The web runner needs three more external programs soon: the BIAS camera (HTTP), Kinefly
(tethered-flight tracker, UDP/ZeroMQ), and ScanImage (ZeroMQ), with a standalone NI DAQ
penciled in. A rig may run two or three at once. The constraint on any design is the
bridge's main strength: every run produces one unified log with one clock base, and that
has to survive intact.

## What stays

- One bridge process per rig PC, one WebSocket, `pixi run bridge`, `pixi run sim`.
- One unified run log, same three line shapes readers dispatch on today: JSON objects are
  events (`session`, `runner`, `run_metadata`, `log`, …); arrays whose first element is a
  number are FicTrac frames `[ms,fc,idx,ft,x,y,hd]`; arrays whose first element is a 1–4
  character string are tagged streams (`["a",…]` echoes, `cc/cf/cs` telemetry). The
  untagged shape stays FicTrac-only because readers identify it by shape; a second untagged
  stream would be indistinguishable. `log_control` ack and `log_export` are unchanged.
- The FicTrac path: `Pipeline` (heading tare, coupling, bias waveform) and `InputManager`
  move into `connectors/fictrac.py` unchanged. The browser keeps the closed-loop apply
  loop (`_drain` → SET_FRAME_POSITION, `applied`, 3-of-10 fault latch) because only it
  holds the serial port.

## What changes

- **Connectors.** One adapter per program behind a serializable contract
  (`start/stop/configure/command/status/cleanup`, emits frames, tagged rows, events).
  In-process by default; the same contract can run a connector as a worker process or
  on another machine ("satellite") later without touching the browser, the log, or YAML.
  Imports are lazy, so a FicTrac-only rig needs no `pyzmq`/`aiohttp`.
- **Wire protocol.** `hello_ack` advertises `connectors` (types, instances, caps) and the
  current `owner`. New types: `connector_config/_ack`, `connector_command` →
  `connector_reply {ok|error|unknown}`, `connector_status`, `event`, `artifact`
  (actual output file identity), `claim_owner`. `frame` gains `src`; `config` becomes an
  alias of `connector_config{instance:'fictrac'}`.
- **Hub.** The single coalescing `_latest` slot stays for `frame`; everything else goes
  through a bounded per-client ordered queue (replies are never dropped; the client is
  disconnected instead). Commands are dispatched to supervised per-instance tasks, never
  awaited inside `_recv_loop`, so a slow camera call cannot stall echoes or telemetry.
- **Logging.** Every connector writes tagged rows with `rx` first (`["kf",…]`, `["si",…]`,
  `["cam",…]`, `["dq",…]`); tags are registered in the connector's stream schema and the
  bridge's one tag table. Status, replies, `artifact` and `clock_sync` are JSON objects
  like today's `runner` lines. Readers already pass unknown tags through, so no reader
  changes are needed to accept a new stream. Tagging FicTrac too (`["ft",…]`) would break
  every behavior_v2 reader, so it is left for a future log level.
- **Clocks.** `LogWriter` owns `t0` (removes the `reset_base`/`start_new_log` skew).
  Every stream declares its `rx` clock domain in `stream_schema` (`cc/cf/cs` are epoch
  ms today; new connector rows are session ms). `clock_sync{rx, src_t, mono, rtt}` at
  connect, run start, and every 60 s. Where a device has an input line, the rig YAML
  names the DIO carrying the controller framescan pulse into it.
- **Safety.** Connector commands and `claim_owner` accepted only from an allowlisted WS
  `Origin`. A small state file (`run_id`, log path, `t0`) lets a restarted bridge
  re-export the last file.
- **Rename.** `fictrac-bridge/` → `arena-bridge/` (`core.py`, `connectors/`), with an
  import-compatible shim at the old path for one release. `BRIDGE_VERSION` 4.0.

## YAML and the MATLAB side

Protocol `plugins:` and `type: plugin` commands are unchanged. Plugins are instances
(`camera`, `camera2`); connectors are types (`bias`), so two cameras work. Additive keys
under `config:`: `critical` (same place and meaning as `BiasPlugin.m`: default true,
unreachable at run start refuses the run, a failed or timed-out command mid-run follows
`on_loss`, default `abort`), `timeout_s`, `on_loss: abort|continue` (`pause` reserved
for self-healing). A timeout is an *unknown* outcome; the connector reconciles
(`get-status`) before any retry. Where web and MATLAB differ we document it in a
compatibility table in `v3-spec.md` rather than engineer around it.

## Slices and gates

| Slice | Content | Gate |
|---|---|---|
| 0a | extract + rename, no wire or scheduling change | recorded FicTrac input + injected clocks → byte-identical log vs 3.4 |
| 0b | hub queue, non-blocking dispatch, `t0`, clock domains, owner, Origin, state file | same replay + slow-client/flood/blocking-adapter harness + bench closed loop on the ball rig within timing tolerances |
| 1 | BIAS camera connector + `bias_sim.py` + Studio Bridge panel, preflight, lifecycle table, `CONNECTOR_FAULT` outcome | real BIAS on a G6 rig: video file in an `artifact` line, command/reply pairs, refusal when BIAS is down, abort with cleanup when killed mid-run, FicTrac unchanged |
| 2 | Kinefly (L−R → yaw → integrator → index is new code) | closed loop from wingbeat difference on a G6 rig |
| 3 | ScanImage ZeroMQ subscribe + log + scope markers | after establishing the ZMQ facts; satellite only if the 2P topology needs it |

Deferred on purpose: the satellite peer protocol; self-healing `pause`
(reconnect-and-continue) as a LAB-212 follow-on.

## Alternatives considered (added 2026-10-14 after Frank's review)

Frank's objection: don't hand-roll a communication protocol and runtime; migrate to
ROS 2. The diagnosis is right: the connector contract specifies command/reply, status,
discovery, an owner claim, and clock sync, all of which middleware provides. The
prescription has two costs the proposal must weigh honestly.

| Option | What it gives | What it costs | Our read |
|---|---|---|---|
| **ROS 2** (Frank) | typed messages, introspection, rosbag2 + Foxglove, Frank's existing FicTrac ROS 2 port (camera and tracking as separate nodes) | heavy install per rig (RoboStack via pixi exists for Windows/macOS but the Windows binaries are not relocatable); a node graph to operate on every rig instead of one process; the browser still needs rosbridge over a localhost WebSocket; rosbag replaces the unified log, so dashboard, scope, replay and wedge-scan readers are rewritten; ScanImage, BIAS and the Kinefly fork have no nodes | the per-program work does not go away; the bridge does not go away; the log pipeline does. Open question for Frank: fresh-machine setup time and student debuggability of the FicTrac node pair |
| **Our connector contract** (LAB-303 as written) | fastest to BIAS; FicTrac path and log untouched | we own a small protocol and its clock-sync scheme | fine as the fallback |
| **Zenoh** as the connector wire | pub/sub + query (request/reply) + liveliness (presence) + discovery + storage + a browser client via the remote-API WebSocket plugin; also a ROS 2 middleware (`rmw_zenoh`, binaries for Humble/Jazzy/Kilted), so Zenoh-native connectors can share a wire with ROS nodes later, Frank's FicTrac node included | young (1.0 late 2024, now 1.6; plugin must match router version exactly; thin browser-client activity); no cross-machine clock correction; no ZeroMQ ingestion | the strongest middle option: removes the hand-rolled parts without closing the ROS door |
| **Transport-generic connectors** (`zmq-json`, `lsl`) | programs that already publish ZeroMQ or LSL (Kinefly, ScanImage, Bonsai) need no code in our repo; LSL brings NTP-style clock offset and drift correction used across neuroscience labs | ingestion only; commands (BIAS HTTP) still need a connector | adopt regardless of the wire decision |
| MQTT / plain ZeroMQ / LCM | lightweight, mature | no request/reply (MQTT), no presence or browser (ZMQ), no browser (LCM) | not chosen |

Decision procedure: keep the gateway as the single logger and the FicTrac path untouched;
run two one-day spikes on the Windows rig PC before committing the connector wire.
(1) Zenoh: router, Python publisher, queryable, liveliness token, remote-API WebSocket
reached from the Studio. (2) ROS 2: RoboStack via pixi, rosbridge, Frank's FicTrac node, a
bag recording. Yardstick for both: install friction, unattended stability, and whether a
course student could debug it. If Zenoh passes, it becomes the connector wire with LSL's
clock model and ZMQ ingestion; if both fail the student test, the contract above stands.

## Three questions for you

1. Is there anything in the FicTrac path you consider load-bearing that the Hub split or
   the `t0` ownership change could disturb?
2. In-process vs worker-process hosting for BIAS: do you see a reason to start with a
   worker?
3. Does the replay gate (recorded input + injected clocks → byte-identical log) match how
   you validated 3.x, or did you rely on something else we should keep?

Full critique (standard + adversarial Codex review and reconciliation):
`.codex-review/report-20261013-151005.md` in Michael's checkout. Linear: LAB-303
(this architecture), LAB-304 (the Chrome 147/156 local-network-access prompt that now
affects every Studio → bridge connection, independent of this work).
