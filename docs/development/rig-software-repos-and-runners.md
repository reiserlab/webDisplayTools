# Rig software beyond webDisplayTools: three repositories, two peer runners, the MATLAB runner

Decision record, 2026-10-26 (Michael Reiser; Codex cross-review of the draft 2026-10-25). Status:
**accepted**. Companion tickets: see "Linear" at the end. Scope: where rig software lives from here on,
which runner executes a protocol, and what the lab gives up by no longer running experiments from
MATLAB. It records decisions and their reasons; it moves no code.

## 1. Decisions

1. **Two peer runners for the same protocol v3 YAML.** Arena Studio (the web) stays the primary tool
   and the only UI. A **Python headless runner** is the alternative for command-line, unattended and
   sequencer-triggered runs. Neither runner is a client of the other; the web is not being moved onto
   Python.
2. **Three repositories with downward dependencies:**
   - `reiserlab/webDisplayTools`: the browser tools and their rig-side gateway (today's
     `ros2-poc/nodes/bridge_node.py`), the protocol v3 spec and its conformance fixtures, the arena
     rig's composition.
   - `reiserlab/LED-Display_pyDisplayTools` (revived): the Python arena library and the headless runner.
   - `reiserlab/rig-nodes` (new): shared ROS 2 infrastructure for every lab rig (interfaces, device
     nodes, recording and supervision primitives).
   `rig-nodes` imports nothing of ours; pyDisplayTools imports `rig-nodes`; webDisplayTools' Python
   side imports both. The browser talks to the gateway only through the WebSocket contract.
3. **The split is recorded now and executed after the 2026-10-20 release**, in this order: release
   (PR #262), cleanup session, extraction session (creates `rig-nodes`, moves the obvious set), runner
   planning session. Isabel's robot packages stay in her `meca_ws` and depend on `rig-nodes`.
4. **Protocol authority moves from MATLAB's `ProtocolParser.m` to the v3 spec plus language-neutral
   conformance fixtures** kept in webDisplayTools. MATLAB `version3` remains the reference for flow
   control only, until the fixtures cover it.
5. **The MATLAB YAML runner is G4.1-only and frozen.** `version3` is merged as its last feature release
   or archived (Frank's call on the `PanelsController` side).
6. **No Flutter. No Rust for the application.** Python first; a compiled node only on a measured budget
   miss, and then C++.
7. **Distribution is pixi end to end:** packages built by `pixi build` in CI, published to a channel,
   installed by `pixi install` like every RoboStack package today. No git submodules.

## 2. Context

Since 2026-10-16 the lab's bridge is a ROS 2 graph (LAB-303). The graph lives in `ros2-poc/` on PR
#254, release candidate 2026-10-20 (`origin/next` 8cd0148), with satellites: ScanImage frames (#261,
15db22c), SiPM (#266, 457b478, stacked on #261), the 10-column FicTrac record (#264, cbf604f, stacked on
#254), the Worker timer (#260, 0930df6), and the okey-cokey dashboard branch (c2f8f36, no PR). It has
run on Windows (ww18, the Bergamo PC) and the Mac with an unmodified Studio, an MCAP record of truth,
BIAS and ScanImage connectors and Foxglove dashboards.

Three facts prompted this record:

- **Most of `ros2-poc/` is not about the display.** Of its ~25 Python modules, the device adapters,
  recorder, MCAP tools and launcher serve any rig. The display-bound parts are the Studio gateway
  (`bridge_node.py`, which imports `fictrac-bridge/bridge.py` by path and owns the recording lifecycle
  in `RecordingLogWriter`), the transitional behavior_v2 export (`mcap_convert.py`, LAB-309), the arena
  visualization (`viz_node.py`, `foxglove_json.py`'s arena derivation, `stimulus_node.py`,
  `arena_display.py`) and the arena composition (`rig.py`, the workspace `pixi.toml`).
- **A second ROS 2 workspace is already planned elsewhere.** Isabel's robot station (LAB-245 `meca_*`
  packages, LAB-251 bag recording, LAB-250 event bridge, LAB-248 `bias_camera_node ×2`) would
  re-implement `bias_node`, `recorder.py` and the connector pattern unless the shared pieces have one
  home. FlyMAX (ROB-13, ROB-16, ROB-23) adds a tracking system and the same robot.
- **Experiments will be started by machines, not only by people.** The robot sequencer (LAB-258) waits
  for a deposit event and then runs the test; unattended web runs hit browser tab throttling (PR #260).
  Colleagues asked for a command-line runner soon.

The web runner's protocol logic is already separable: `js/arena-runner-g6.js` (2161 lines) has no DOM
dependency, `flattenStructure` and `translateCommand` produce a wire-neutral intermediate
representation (IR), only `arena-link.js` is Web Serial, and the golden wire vectors in
`tests/test-arena-wire-g6.js` descend from the firmware repository's `play_pattern.py`.

## 3. The three repositories

### 3.1 Responsibilities

| Repository | Responsibility | Depends on |
|---|---|---|
| **webDisplayTools** | The browser and its rig-side gateway. Arena Studio, designer, pattern tools, the JS runner, GitHub Pages and the release tiers. The protocol v3 spec and the conformance fixtures. The gateway (`bridge_node`: hello/hello_ack, config, log_control, connector_command), the behavior_v2 export while LAB-309 lives, the arena visualization nodes and Foxglove layouts, the arena rig profile and its deployable `pixi.toml`, the browser-contract conformance tools. | pyDisplayTools and rig-nodes packages, pinned |
| **LED-Display_pyDisplayTools** | The Python arena library and the headless runner. Existing G4 pattern and experiment-folder tools; new: v3 parser to IR, G6 wire encoder/decoder (port of `arena-wire-g6.js`, golden-tested), pyserial link, closed-loop mapping (the pure parts of `bridge.py`'s `Pipeline`, imported by the gateway instead of carried as a copy), pattern-file and panel-color helpers already written in Python, the `arena-run` CLI and the `run_protocol` ROS action. The library core (parser, IR, wire, serial, closed-loop evaluator) must import without ROS; the graph integration is an optional extra, so pattern tools and simple serial runs do not inherit the rig middleware stack. | rig-nodes packages, pinned (optional extra) |
| **rig-nodes** | Shared infrastructure for every lab rig. `rig_interfaces` (today `arena_interfaces`), device adapters and simulators, recording primitives, supervision primitives, Zenoh configuration, generic Foxglove layouts, benchmarks, and future shared processing nodes. | nothing of ours |

### 3.2 Rules

- **Dependencies point downward only.** Today three imports point the other way and each has a home:
  `bridge_node` → `bridge.py` (both stay in webDisplayTools until the pure functions move to
  pyDisplayTools), `mcap_convert` → `bridge.py` pure functions (same), `rig.py` → `fictrac_sim.py`
  (the simulator moves; the launcher depends on the package).
- **Each device node owns its command vocabulary.** `bias_node` defines what `connect`,
  `startRecording`, `getTimestamp` mean for BIAS; the JS plugin registry and MATLAB's `BiasPlugin.m`
  are clients of that vocabulary, not its source.
- **Application composition stays with the application.** Which nodes an arena rig runs, what happens
  when the gateway dies, the recording lifecycle: webDisplayTools. The robot station's equivalent:
  `meca_ws`. `rig-nodes` ships supervision primitives and a profile template, never a rig's policy.
- **A package moves to `rig-nodes` only when it carries no arena semantics and a second consumer
  confirms the abstraction.** The Python runner is the first second consumer; the robot station the
  next. Anything doubtful stays in webDisplayTools until a consumer asks for it.
- **The interfaces package is renamed `rig_interfaces` in the cleanup candidate.** Under `rmw_zenoh` a
  typed topic is keyed by type name and generated type hash, so the rename is a wire-contract change.
  The 2026-10-20 candidate ships the old name in its two **opt-in** environments (`typed`, source build;
  `typed-prebuilt`, win-64 package); the default environment every rig runs is String-only, and the bags
  recorded with typed topics so far are the PoC archives on Dropbox, read with the old name. Decision
  for Michael: accept that one released candidate carries `arena_interfaces` in opt-in environments
  (recommended: it does not delay the release), or re-cut the candidate with the rename.
- **Message contracts may carry arena semantics; code may not.** `rig_interfaces` holds every shared
  message type, `ArenaFrame` included: a message exists to be shared across processes and repositories.
  The "no arena semantics" rule in the next bullet is about executable code.

### 3.3 Inventory (pinned)

Every file under `ros2-poc/` on `origin/next` 8cd0148 and on the satellite heads, with its destination.
"stays" = webDisplayTools. Records of past sessions (run sheets, Windows results, the Plan B explainer)
stay as history.

| Destination | Files |
|---|---|
| **rig-nodes** | `interfaces/arena_interfaces/**` (→ `rig_interfaces`), `channel/README.md`, `config/zenoh-router.json5`, `config/zenoh-session.json5`, `nodes/_common.py`, `nodes/fictrac_udp_adapter.py`, `nodes/kinefly_udp_adapter.py`, `nodes/kinefly_sim.py`, `nodes/bias_node.py`, `nodes/bias_sim.py`, `nodes/bias_cmd.py`, `nodes/scanimage_node.py`, `nodes/scanimage_cmd.py`, `tests/si_json_mock.py`, `nodes/recorder.py`, `nodes/mcap_index.py`, `nodes/graph_dump.py`, `nodes/build_interfaces.py`, `sizing/compare.py`, `sizing/frames300.py`, `sizing/columns.py` (#264), the generic String→JSON-schema rewriter in `nodes/foxglove_json.py`, `shm_bench.py`, `shm_bench_qpc.py`, `mcap_bench.py`, `docs/shm-bench.md`, `docs/typed-distribution-decision.md`, `docs/typed-windows.md`; from #261/#266: `nodes/scanimage_frames_node.py`, `tests/test_scanimage_frames.py`, `tests/zmq_frames_mock.py`, `tools/zmq_latency_report.py`, `nodes/sipm_node.py`, `nodes/sipm_cmd.py`, `nodes/thorsipm.py`, `tests/test_sipm.py`; from okey-cokey: `nodes/bias_health.py`, `tools/ufmf.py` |
| **pyDisplayTools** | `tools/patfile.py` (pattern-file reader; the repo already has `pyPatternTools`), `nodes/arena_display.py` (Python port of `js/panel-color.js`, okey-cokey branch), the pure functions of `fictrac-bridge/bridge.py` (`Pipeline` mapping, `frame_schema_line`, `compact_arena_command`), `fictrac-bridge/fictrac_sim.py` moves to rig-nodes as a device simulator |
| **stays** (gateway, export, composition) | `nodes/bridge_node.py`, `nodes/mcap_convert.py`, `nodes/_rows.py` (behavior_v2 `kf` rows), `nodes/export_log.py`, `nodes/rig.py` (arena composition; its generic preflight/supervision helpers are extracted to rig-nodes first), `pixi.toml`, `pixi.lock`, `.gitignore`, `tests/studio_emulator.py`, `tests/check_runlog_readers.js`, the gateway half of `tests/test_ros2_poc.py` (node-level tests move with their nodes) |
| **stays** (arena visualization) | `nodes/viz_node.py`, `tests/test_viz_node.py`, the arena derivation in `nodes/foxglove_json.py`, `foxglove/arena-fictrac.json`, `foxglove/arena-bias.json`, `docs/foxglove-arena-layout.json`, `tools/tiff_run_to_mcap.py`; from okey-cokey: `nodes/stimulus_node.py`, `nodes/stimulus_core.py`, `nodes/dashboard_replay.py`, `tests/test_stimulus.py`, `tests/test_stimulus_live.py`, `foxglove/arena-okey-cokey.json`, `tests/fixtures/protocols-2026-10-14/*` |
| **stays** (rig-specific config and records) | `README.md`, `WINDOWS-TEST.md`, `SCANIMAGE-DAY.md`, `scanimage-day-2026-10-16.md`, `windows-results-ww18-2026-10-15.md`, `docs/plan-b-explainer*.html`, `docs/build-standalone-explainer.py`, `docs/img/*`; from okey-cokey: `config/bias/okey-cokey-bfs-u3-51s5m.json`, `tools/okey-cokey-start.ps1`, `tools/bias-ufmf.ps1`, the `okey-cokey-*.md` run sheets, `HANDOVER-okey-cokey-2026-10-21.md`, `docs/okey-cokey-foxglove-dashboard-plan.md` |

### 3.4 The robot station

`meca_driver`, `meca_description`, `meca_sequencer`, keypoints and routes stay in Isabel's repository;
`meca_interfaces` keeps the robot's actions and services. A message type moves to `rig_interfaces` only
when a second consumer appears. The ask for the robot station is **shared distribution (RoboStack Jazzy
via pixi), middleware (`rmw_zenoh`), one interfaces build and one deployment recipe**. It is not "drop
colcon": `ros2-poc/pixi.toml` already installs colcon and `build_interfaces.py` runs it inside the pixi
environment. LAB-245 currently describes a colcon workspace sourced from PowerShell; the two can be the
same environment.

### 3.5 Protocol authority

`docs/development/v3-spec.md` names MATLAB's `ProtocolParser.m` the ultimate authority, and the MATLAB
cross-check was never automated (`validate_web_protocol_roundtrip.m` covers v1 and v2). With a frozen
MATLAB runner and two live runners, the authority is **the v3 spec plus conformance fixtures**: parse →
flattened sequence → IR → wire bytes, host timing rules, run-log events, including interrupted runs and
failures between commands. The fixtures are exported from the JS runner's tests
(`tests/test-arena-runner-g6.js`, `tests/test-arena-wire-g6.js`, `tests/test-protocol-roundtrip-v3.js`)
and the Python runner downloads them pinned. A fixture is **inputs, timed external events, and expected
observable outputs** (acknowledgments, failures, cancellation, runtime updates), not a command list.
Coverage the export must include beyond the three runner/wire test files: seeded randomization (the
Studio shuffles with `Math.random()` today, so the PRNG, seed encoding, shuffle algorithm and the logged
realized order are new specification work for both runners), pattern resolution (SD inventory,
name-before-`pattern_ID` rule, missing-pattern behavior, frame-count lookup), frame coalescing and epoch
gating (`js/fictrac-bridge-client.js`), serial single-flight arbitration (`js/arena-link.js`), and runtime
variables (`js/runtime-controls.js`). Each exported behavior is reviewed as a specification decision,
not accepted because it is current output; the proceed-and-skip policy for unsupported commands is the
first such review (section 4). The fixture set is versioned and bundled for offline use. Every future
protocol feature lands with a fixture, then in both runners, or is declared runner-specific in the
compatibility table (`v3-spec.md`). Note the coordinated-change cycle this creates: the Python runner
downloads its semantic authority from webDisplayTools while webDisplayTools' gateway imports Python
packages; imports point one way, releases are still coordinated.

## 4. The Python headless runner

**Scope.** `arena-run protocol.yaml --rig rig.yaml` parses v3 (anchors, blocks, seeded randomize,
intertrial, `requires:` refusal), produces the IR, and drives a G6 controller over pyserial with a
golden-tested port of the wire module. FicTrac Mode 3 runs through the graph with the closed-loop
mapping from the shared library; plugins go through the same connector nodes the gateway uses; the
MCAP record goes through the graph's recorder. The run is also triggerable by a ROS action
`run_protocol` with a run id, duplicate-request and restart semantics, cancellation and a terminal
status on `/arena/run_status`. **Exit criterion:** the conformance fixtures pass under deterministic
replay (recorded FicTrac input, controlled acknowledgments, injected failures) with exact comparison of
wire bytes and run-log events against the web runner; bench runs then measure timing and hardware
behavior against explicit tolerances. A single live bench comparison is not sufficient, because live
FicTrac input and acknowledgment-dependent coalescing change the wire stream.

**Open design items for the runner planning session** (they decide the architecture, so they are
listed here rather than settled): where the action server, the run owner, the recording owner and the
closed-loop evaluator execute, how `arena-run` connects to or starts them, and whether headless
operation needs the gateway at all (today `rig.py` always starts the gateway and stops the graph when it
dies, and recording is an in-process writer owned by the gateway). Two evaluators must never publish
competing `/arena/frame` streams. The action contract needs a persistence boundary: when a run id is
durably accepted, how a repeated request retrieves the existing result, what happens after a crash
between acceptance and the first device command, whether an interrupted run resumes or needs a new id,
when ownership is released relative to device teardown and recording finalization, and an explicit
**outcome-unknown** state when a device acted but its acknowledgment was lost. The CLI defaults to
**strict acceptance** (refuse unknown commands, unresolved patterns and undeclared capabilities) rather
than the web runner's proceed-and-skip policy, which suits interactive use and not unattended runs. And
unattended execution needs a host-loss policy independent of trial timing: the host sends wire
duration 0, so a dead host leaves the display on until something sends STOP; a maximum-exposure
watchdog on the controller side or a controller-timed option (section 5, item 6) is that policy.

**Parity by construction.** Both runners execute the same IR against the same fixtures, so protocol
semantics have one authority instead of two state machines that drift. The cost the Codex review
named, a permanent behavioral-equivalence obligation (cancellation, fault outcomes, closed-loop epoch
gating, frame coalescing, LED teardown, single-flight serial because replies carry no request id,
runtime-variable resolution), is paid feature by feature through fixtures rather than by hoping.

**Both runners on one rig PC.** Ownership must govern **every mutation**, not run admission alone: a
browser that connects to the gateway sends `config` and, when enabled, `log_control` before any run,
and the gateway applies both globally (new time base, new log). So an idle browser can change
closed-loop parameters or recording boundaries under another executor's run. The rule: one owner per
rig; only the owner's configuration, connector commands, recording control and export are accepted;
other connections are read-only observers; a stale owner is fenced (its queued device operations and
recorder control are rejected after takeover). Serial-port exclusivity is not a portable substitute:
pySerial's POSIX `exclusive` flag defaults to off, so acquisition behavior is specified and
browser-versus-Python contention is tested on every supported platform. Prerequisite before both runners
share a rig; the same model two cameras need (section 7, item 3).

**Alternatives considered.** A headless Node run of the existing JS engine with a native serial adapter
would reuse the state machine with no parity obligation; colleagues prefer Python for the lab's skills
and the ROS integration. A fresh Python port without the shared IR would create two authorities.

## 5. The MATLAB runner: what is lost

Inventory: maDisplayTools `main` e3e36d0 (2026-10-12, protocol v2 only) and the unmerged
`origin/version3` ff008aa (2026-09-09: v3, flow control, DAQ plugins; 134 of 192 commits by Lisa
Ferguson, who has left).

**Already true today, so not a loss of this decision.** The MATLAB YAML runner drives only G4.1
(`ProtocolRunner.m` accepts `generation == 'G4.1'`, TCP 62222 through `PanelsController.m`); the web
drives only G6. The MATLAB YAML runner has no production users that could be found: the CSHL 2026 course
ran Arena Studio; the T4 electrophysiology and nested-RF rigs use G4_Display_Tools and
`G4_experiment_conductor` with TDMS logs; the freely-walking optomotor rig uses its own `Panel_com`
scripts; Shubham's G4.1 place-learning code is his own and is already ported to G6 YAML. Its logs
(`experiment.log`, `trial_order.mat`, `executed_trace.*`) have no downstream readers in any lab
repository. Those MATLAB ecosystems are untouched by this record.

**Capabilities only MATLAB has, ranked.**

| # | Capability | Where | Replacement |
|---|---|---|---|
| 1 | Flow control `trial_check` / `repeat_until`: `CriterionEvaluator.m` (294 lines), `runTrialCheck`, `runRepeatUntil`, the `executed_trace` record | version3 | LAB-218. `CriterionEvaluator` and `executed_trace` become reference fixtures before version3 rots; lands in both runners. |
| 2 | Any MATLAB code as a plugin: `ClassPlugin.m` (any class on the path via `feval`), `ScriptPlugin.m` (any `.m` via `run` / `evalin`) | main | Lost for MATLAB users. A Python-callable plugin in the Python runner is the analogue for Python users. |
| 3 | A serial device defined entirely in YAML: `SerialPlugin.m` (414 lines; format-string commands, `critical`, operator retry) | main | A generic `serial_node` in rig-nodes with the same `critical` / `on_loss` semantics (LAB-303). The browser's Web Serial holds exactly one port, the controller. |
| 4 | NI DAQ through the Data Acquisition Toolbox: `DAQThermometerPlugin.m` (707), `WingbeatMonitorPlugin.m` (597: analog-in wingbeat frequency, puffer digital-out, the flow-control metric) | version3 | An NI DAQ node (`nidaqmx-python`, LAB-303 slice 4, synchronization first); G6's own analog I/O for single channels. LAB-314, LAB-315. The wingbeat metric must exist before flow control can use it. |
| 5 | G4.1 execution, `setColorDepth` (grayscale 2/16), Mode 4 analog closed loop on G4.1 | main | Nobody needs the YAML runner on G4.1 today (LAB-155 is Low, "may not happen"). If ever: a `g4_host_node` grown from pyDisplayTools' 109-line TCP stub, as a rig-nodes device node. |
| 6 | Controller-timed trials: the duration is sent on the wire and the controller ends the display | both | True today: the web runner sends duration 0 and times the trial on the host, then sends STOP. An optional controller-timed mode in the web and Python runners is proposed as a ticket. |
| 7 | Operator retry prompt on hardware failure (`maxAttempts`) | main | The controller-fault post-mortem and `BRIDGE_LOST` replace it; a manual-retry option is a UI nicety, not a capability. |

**The real loss is institutional**: the reference implementation of the protocol language. It is
replaced by the spec plus fixtures (section 3.5). The runner is declared G4.1-only and frozen; `version3`
is merged as its last feature release if the lab wants flow control and the DAQ plugins preserved in a
runnable state, otherwise tagged and archived. Items 3 and 4 are ported as shared nodes, item 1 through
fixtures; item 2 is lost for MATLAB users and the record says so. MATLAB analysis code, the ROS Toolbox
and the G4 toolchains are out of scope.

## 6. Flutter and Rust

**Flutter: no.** Flutter compiles Dart to JavaScript or WebAssembly; serial access in a browser goes
through JavaScript-interop packages (`flserial`, `platform_serial`, `webserial`) with the same
Chromium-only, user-gesture limits the Studio has today, and Dart's `web` package excludes Web Serial
because it is not on the W3C standards track. Rewriting the Studio would buy no capability; desktop
builds would lose GitHub Pages' zero-install and need signing and installers; Dart has no ROS client.
If an installable-app feel is ever wanted, a PWA manifest is the cheap path, with the module-cache
gotcha handled.

**Rust: not for the application.** Rust is already in the stack indirectly (Zenoh and `rmw_zenoh`, the
MCAP libraries). `rclrs` 0.7 is the official ROS 2 Rust client (Jazzy, Windows), but its code generation
still requires a cloned `rosidl_rust`. The measured bottleneck is the Python subscriber for megabyte
frames: about 8 to 10 ms of CPU per 8 MB message on ww18, while the C++ rosbag2 recorder with shared
memory measured 0.12 ms median at 2 MB × 135 Hz and 0.18 to 0.19 ms at 8 MB. Those numbers justify a
compiled *recorder* path, which exists, not a language threshold by payload size. Rule: Python first; a
compiled node only on a measured budget miss for that node; C++ by default (ROS-native, the pixi
toolchain works, BIAS, ScanImage and FicTrac are C++). These are defaults, not exclusions. The arena
controller firmware is the real-time element; host code is orchestration.

## 7. Cross-repository checklist

These items are the body of the rig-nodes ticket and apply to pyDisplayTools as well.

1. **Versioned, conformance-tested contracts.** (a) Browser ⇄ gateway WebSocket: add an explicit
   `protocol` integer and advertised capabilities with a legacy fallback. Today `hello_ack.bridge` is a
   version string, `hello.v: 1` is unchecked, `supportsStartFrame()` is version-gated and only
   `supportsConnector()` is capability-gated. (b) Graph contract: topic names, QoS, the
   `{src, seq, rx_epoch_ms, rx_mono_ns, raw}` envelope, `/<src>/cmd` and `/<src>/reply`, the
   `/arena/frame` fields; owned by `rig_interfaces` plus a `CONTRACT.md` with semantic invariants and
   evolution rules (units, direction conventions, counter resets, clock domains), the role
   `telemetry-logging-reference.md` plays for arena rows today. (c) The `run_protocol` action contract.
2. **Required vs optional capabilities per protocol.** The v3 `requires:` gate exists and
   `WEB_RUNNER_CAPABILITIES` is empty. A missing required acquisition refuses the run before start; a
   mid-run loss follows `on_loss`. "Missing capability means a visible skip" is right for a dashboard and
   wrong for a required camera.
3. **Device-instance identity.** `bias_node` uses the absolute topics `/bias/cmd`, `/bias/reply`,
   `/bias/status`, `/bias/frames`; two instances without remapping send each command to both and mix
   replies. Namespaced topics per plugin instance, routing by plugin name, producer-restart identity,
   and a two-camera isolation test are prerequisites for LAB-248.
4. **Recording-ownership API.** Run boundaries, topic selection and failure policy move out of
   `RecordingLogWriter` into an owner the gateway, the CLI runner and a robot-only run can all drive.
   An MCAP open failure becomes a validity decision, not a fallback to the shadow log; write failures,
   disk exhaustion and close/finalization failures reach the active executor with a defined outcome,
   and terminal status stays available when the recording destination itself fails.
5. **Run-ownership rule** (section 4).
6. **Distribution.** `pixi build` produces the packages in CI; they are published to a channel (in the
   repository at a tag first, prefix.dev when the lab owns a channel); rigs install with
   `pixi install`. One tested package-set release per repository until independent cadence is
   demonstrated. Release gate: installed-package acceptance in a clean directory with the real JS
   client (today's harness runs source-tree files and a Python emulator). Retain an installable release
   bundle so a channel outage never blocks a rig rebuild. Keep a sibling-checkout developer path (pixi
   path dependencies) so a node fix never needs a release to test.
7. **Lock files and skew.** A supported-combination table (Studio × gateway × package sets) rather than
   "minimum tested version"; every package version written into `run_metadata`; the shared graph is
   single-host initially (`bridge_node` compares adapter and gateway monotonic clocks; Zenoh is
   loopback-only). Cross-host needs host identity and clock alignment first.
8. **Testing split.** Device-node conformance (simulator → node → topics → loss accounting) in
   rig-nodes; runner conformance (fixtures, interrupted runs, failures between commands) in
   pyDisplayTools; browser-contract conformance in webDisplayTools; one cross-repository smoke on a
   dependency bump. The root `pixi run test` does not run the ROS harness today.
9. **Release coordination.** Semantic-version tags → channel for the two Python repositories;
   webDisplayTools keeps Production and Next and names the gateway and package versions a Studio
   release was tested with.
10. **Linear.** Gateway and runner work stays in "Arena Software Control - towards Web-based V1.0"; a
    `rig-nodes` label marks tickets in the Robot arm, Bergamo III and FlyMAX projects; no new project.
11. **Documentation.** The orientation skill distinguishes *current location* from *accepted
    destination* and points here; `CLAUDE.md` gets one sentence; `telemetry-logging-reference.md`
    stays the arena format authority.
12. **Migration mechanics.** Package first inside webDisplayTools (`ros2-poc/` → `rig/`, package-set
    build), then move by directory with history. Deprecation shims are retired on evidence of deployed
    consumers, not after "one release", because rigs sit unchanged for months. Keep the behavior_v2
    *converter* for old data after the *producer* retires (LAB-309 wording).
13. **Maintainer cost, named.** Three repositories, two CI pipelines with three-platform builds, a
    channel, a compatibility table, and one maintainer today.

## 8. Known debts that hold regardless of layout

- Closed-loop math runs inside the gateway's `Pipeline`, and it is stateful: heading unwrapping,
  FicTrac restart detection, pending tares, epoch ids and bias clocks. Sharing only the final arithmetic
  would let two runners display different frames from identical input. What moves to pyDisplayTools is
  a reusable **stateful evaluator** with injected time and explicit outputs, covered by transition
  fixtures; Plan B's separate closed-loop node was never verified.
- Recording and FicTrac processing share one asynchronous consumer in the gateway and the recorder
  serializes writes under a lock; under a slow disk plus an imaging burst the design must choose between
  dropping data, delaying control and aborting, with measurable limits.
- The recording lifecycle lives in the gateway; an MCAP open failure falls back to the shadow log and
  the run proceeds (item 4 above).
- Fixed `/bias/*` topic names (item 3 above).
- No run-ownership rule between executors on one rig PC (section 4).
- Single-host clock assumption (item 7 above).
- `rig.py` is the only launcher; there is no `launch.py`. Replacing it is a separate behavioral change.

## 9. Sequencing

```
docs-only PR (this record) ──▶ gate 1: Michael runs `pixi run release` for #262 (candidate 2026-10-20)
  ──▶ CLEANUP session: rebase #261 / #264 / #266 / #260 onto released main → second candidate;
      okey-cokey and tiff2mcap branches → PRs or close; stale worktrees and branches removed;
      `ros2-poc/` → `rig/`; `arena_interfaces` → `rig_interfaces`; package-set build; hardware validation
  ──▶ gate 2: Frank's pilot sign-off (about 2026-10-30)
  ──▶ EXTRACTION session: create rig-nodes; move the obvious set (section 3.3) with history;
      package-set build and channel; webDisplayTools' `rig/` workspace pins it
  ──▶ RUNNER PLAN session (plan mode, own review; the second developer joins): revive pyDisplayTools,
      IR definition, fixture export, G6 wire port, `arena-run` CLI, action contract, recording API
```

Extraction directly after cleanup is preferred now that the Python runner is a committed second
consumer: the runner and its developer get a clean target, and the move is done once. The cost of
choosing boundaries with one live consumer is bounded by moving only the obvious set.

## 10. Decided, hypotheses, commitments

- **Decided:** the three repositories and their downward dependencies; two peer runners with the web
  primary; the Python runner on the shared IR in pyDisplayTools; release before runner work; cleanup →
  extraction → runner plan; no Flutter; Python first with C++ as the compiled default; no submodules;
  pixi-built package sets through a channel; `rig_interfaces` rename in the cleanup session; MATLAB
  YAML runner G4.1-only and frozen; protocol authority to spec plus fixtures.
- **Hypotheses awaiting evidence:** the exact rig-nodes package map beyond the obvious set (needs the
  runner and the robot station as consumers); robot-station toolchain compatibility (needs Isabel and a
  real install on the robot PC); whether `version3` merges or is archived (Frank).
- **Compatibility commitments:** deployed rig installations, published message identities, archived
  recordings (the behavior_v2 converter stays readable for old data).

## 11. Review record

A Codex cross-review (standard and adversarial passes, model `gpt-6-astra`, 2026-10-25) of the first
draft is on disk at `.codex-review/report-20261025-181500.md` (local, not committed). Its points that
changed this record: the first draft's single boundary rule contradicted its own inventory
(`viz_node`, `rig.py`, the recorder lifecycle and the runner all carried arena semantics), replaced by
the three responsibilities and the composition rule; `rig.py` is composition, not generic supervision;
`recorder.py` is a writer library and the lifecycle needs an owner; the interfaces rename is a
wire-contract change under Zenoh type hashing (hence the rename now, before release); pixi versus
colcon is a false choice; capability degradation must distinguish required from optional; two cameras
cross-talk on fixed topics; the performance numbers were being mixed; one tested package set beats
per-package versions at this size; the orientation skill must not present the destination as the
current map. The review's preference for a headless Node run of the JS engine over a Python port was
weighed and not taken (section 4). Sections 1 (peer-runner policy, pyDisplayTools as home), 5 (MATLAB)
and 9 (extraction before the runner) post-date the review.

**Second pass (2026-10-26, on this record, `.codex-review/codex-plan-review-20261026-124131-20256/`).**
Corrections taken: the interfaces rename contradicted the release order (now a stated choice for
Michael, section 3.2); start-only run ownership does not protect an active run (section 4, mutation
ownership); pySerial exclusivity is not portable; the conformance plan missed seeded randomization,
pattern resolution, coalescing, serial arbitration and runtime variables (section 3.5); one bench run
is not an equivalence test (deterministic replay first); `ArenaFrame` carries arena semantics, so the
rule distinguishes message contracts from code; `v3-spec.md` still told readers to defer upstream
(fixed); `Pipeline` is stateful; recording can fail after open; headless composition, restart
persistence, outcome-unknown, strict acceptance and host-loss policy were missing (section 4); the
Python core must not require ROS. **Not taken, recorded as dissent:** the adversarial pass would reopen
the two-peer-runner decision (headless Node run of the JS engine behind a Python CLI as the cheaper
path) and defer extraction until a real second consumer has exercised the shared lifecycle APIs. Michael
decided both with colleagues on 2026-10-26 (Python for the lab's skills and ROS integration;
extraction first so the runner and its developer start on a clean target). Mitigations adopted from the
dissent: the first headless implementation stays behind a stable CLI and action interface with an
explicitly limited protocol subset; portable protocols promise no arbitrary Python execution; the
extraction moves only the obvious set; and the runner planning session must resolve the open design
items in section 4 before code.

## 12. Open questions

- Frank: merge `version3` as the MATLAB runner's last feature release, or archive it? Pilot sign-off
  date.
- Isabel: is "shared distribution and middleware, keep colcon inside the pixi environment" workable for
  `meca_ws`? Which `meca_*` pieces are shared from day one (`meca_cameras` vs `bias_node`)?
- Who owns the channel on prefix.dev when it stops being in-repository at a tag?
- LAB-309 wording: retire the behavior_v2 producer by 2026-12-31, keep the converter for old data.

## Linear

Tickets created 2026-10-26 from this record (Reiser Lab, project "Arena Software Control - towards
Web-based V1.0"):

- **LAB-337** Python headless runner in LED-Display_pyDisplayTools (Todo, unassigned until the second
  developer is named).
- **LAB-338** rig-nodes: shared ROS 2 infrastructure repository, decision record + checklist (Backlog).
- **LAB-339** MATLAB YAML runner disposition (Backlog).
- **LAB-340** Run-ownership rule + recording-ownership API (Backlog).
- **LAB-341** Web runner: optional controller-timed trials (Backlog).

LAB-303 carries the architecture comment. Comments proposed for LAB-245 (Isabel, toolchain framing),
LAB-309 (producer vs converter), LAB-218, LAB-155 and LAB-314/315 are held as drafts.
