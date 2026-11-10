# Arena Studio remote-control mode (LAB-357)

In remote-control mode the Studio page is a **display**. An external program (Python, or MATLAB
through the Python client) starts the runs through the rig gateway. **The Studio still executes
the steps**: a remote run is `Studio.loadProtocol` + `Studio.runOnce`, the path the QC harness
drives (`rig/qc/qc.py`). Step execution, timing and the serial path do not change. First use: flow
control between protocols (run one, read its bag, choose the next).

> **2026-11-09 — amends `rig-software-repos-and-runners.md` §1**, "Neither runner is a client of
> the other": a Python client may now *start* Studio runs. It drives the Studio; it does not
> execute steps, and the Python headless runner stays a separate peer.

```
controller (a ROS node) ──/arena/run_request──▶ gateway (rig/nodes/bridge_node.py) ──WebSocket──▶ Studio page (executor)
        ▲───────────────/arena/run_status──────────┴◀───────────────run_status───────────────────────┘
                                                   └─▶ the run's MCAP bag (request + every status)
```

The controller side is on the **ROS 2 graph** (the robot station's sequencer is a ROS node and
starts an arena run natively). The same request also works on the gateway's WebSocket, for
environments without ROS. The Studio hop is always the WebSocket (`ws://localhost:8765`).

Code: `js/studio-remote-control.js` (validation, state machine, status messages; Node-tested),
the "(2d) REMOTE CONTROL" glue in `arena_studio.html`, `js/fictrac-bridge-client.js`
(`remoteAttach`, `sendRunStatus`, `supportsRemote`), `rig/nodes/remote_relay.py` (the gateway's
bookkeeping), `rig/nodes/studio_remote.py` (the client). Bridge 3.4 (`fictrac-bridge/bridge.py`)
does not relay; the Studio refuses to enter remote mode against it.

## Messages

| direction | message |
|---|---|
| gateway → any WebSocket client | `hello_ack` gains `"remote": true` |
| Studio → gateway (WebSocket) | `{"type":"remote_attach","on":true\|false}` → `{"type":"remote_attach_ack","ok","on","error"?}` |
| controller → gateway | `{"id","action":"run","name":"file.yaml","protocol":"<YAML text>","intent":"experiment"\|"test","metadata":{…},"client"?}` |
| controller → gateway | `{"id","action":"stop","run":"<run id>"?}` and `{"id","action":"status"}` |
| Studio → gateway → controller | `{"type":"run_status","id","state","detail"?,"step"?:{"i","n","condition"},"summary"?}` |
| gateway → asker | `{"type":"remote_status","id","executor":bool,"active":{…}\|null,"last":{…}\|null}` (answer to `status`) |

Controller transport, the same JSON object on either:

- **ROS 2 (default):** publish the request on `/arena/run_request` (std_msgs/String, reliable,
  keep-last). Every answer comes on `/arena/run_status` (std_msgs/String): the Studio's statuses,
  the gateway's own (`rejected`, "Studio disconnected", the 60 s no-answer failure, the stop's
  `accepted`) and `remote_status`. Match on `id`. Subscribe before publishing, and publish only
  after the gateway's subscription has matched (`get_subscription_count() > 0`): a message
  published during discovery is lost.
- **WebSocket:** send it with `"type":"run_request"`; the answers come on that socket (and on
  `/arena/run_status` too).

- `id` is chosen by the client and must be unique. `client` is optional free text that names the
  asker (kept in the gateway's bookkeeping and the bag). `intent` defaults to `"test"`
  (`runOnce(false)`); `"experiment"` is a recorded run (`runOnce(true)`).
- **An experiment obeys the Run button's rule.** A run with `intent: "experiment"` is judged by
  the page's own "Run experiment" predicate (`Studio.runExperimentGate`, the function the button
  uses), after the request's `metadata` is in the panel and its protocol is loaded: the arena
  connected, a saved protocol (no unsaved edits, not an `untitled…` name), Experimenter and Fly
  genotype filled in, the bridge connected, every referenced pattern on the SD card (and no
  duplicate names), and the controller preflight (panel mode, refresh, panel firmware; a strict
  rig's defaults). A missing Experimenter or Genotype is `rejected` with both named
  ("… missing metadata: experimenter, genotype"); any other failure is `rejected` with "the Run
  experiment rule refused: <the page's reason>". `intent: "test"` is not restricted.
- `metadata` keys: `experimenter`, `genotype`, `age`, `sex`, `fly_number`, `notes`. They are set in
  the Run details panel (the fields the run log reads). A key left out keeps the panel's value; a
  value that is not in a controlled list is kept and marked "(not in list)".
- `step.i` is 1-based. `running` is sent once when the sequence starts and once per step change,
  never per frame.
- The gateway adds `t_ms` to every status. A terminal status also gets `bag` (the run's bag
  directory on the gateway PC) and `bag_files` when the run recorded one.
- Every inbound WebSocket message is published on `/arena/browser` as before. Every `run_status`
  is published on `/arena/run_status` and recorded in the run's bag; the bag also holds the
  request with its YAML text (`/arena/run_request` for a ROS request, `/arena/browser` for a
  WebSocket one), and any stop or status request made during the run. None of these become lines
  of the derived `behavior_v2` run log.
- The JSON-over-String topics follow the rest of this graph (no custom message types). A typed
  ROS action (goal = the request, feedback = `running`, result = the terminal status) can replace
  them later without changing the Studio side.

## States

`accepted` → `running` → one terminal state. A run that cannot start ends `rejected`.

| terminal state | meaning |
|---|---|
| `done` | the protocol completed: no fault, no bridge loss, not aborted (`detail` counts step errors, if any) |
| `aborted` | stopped on request: "stopped by the operator at the Studio" or "stopped by the remote controller" |
| `failed` | controller fault, bridge lost, "Studio disconnected", the run threw, or an abort nobody requested |
| `rejected` | it did not start: no Studio in remote-control mode, busy, controller not connected, the YAML did not load, the controller preflight or a `requires:` gate refused (`detail` carries the reason shown on the page) |

**Order rule.** The terminal status reaches the controller only after the run's bag is closed and
re-indexed, so the file can be opened at once. The Studio closes the log (`log_control` off)
before it sends the terminal status; one socket's messages are handled in order, and the gateway
closes the bag synchronously. As a safety net the gateway closes a log that is still open when a
terminal status arrives (`"bag_closed_by":"gateway"`), also when the Studio's socket dropped.

## Ownership

- One executor: the first Studio that attaches. A second attach is refused while that socket is
  open. The slot is free when the socket closes or sends `on:false`.
- Whoever sent `run` owns the run. **All ROS publishers are one owner** ("ros": a topic has no
  sender identity), so any ROS node may stop a run that was started over ROS. A WebSocket run is
  owned by its socket. A run started over one transport cannot be stopped over the other.
- Any `run` while a run is active is `rejected` ("busy: run <id> is active"), whatever its
  origin. `status` is answered for anyone and names the active run's `origin` and `client`.
- Executor socket closes during a run → the owner gets `failed`, "Studio disconnected" (the page
  also stops the run when it loses the bridge). A WebSocket owner's socket closes → the run
  continues; only STOP at the Studio ends it early. `status` then reports the result under `last`.

## The page in remote-control mode

- Enter: Run view → **Remote control**, or `?remote=1` (the page waits for the one Connect click
  and the bridge, then enters; the parameter stays in the URL while the mode is on).
  Preconditions: controller connected, bridge connected with `remote: true`, no run active, no
  soak, no replay, no unsaved edits. The page shows the exact reason when it cannot enter.
- A full-width banner states the mode and one state line (waiting / running step i of n / last
  result). Everything below it is `inert`: the visualization keeps updating, no control accepts
  clicks, and no key reaches the page's shortcuts.
- **STOP rule.** The banner's red STOP is the only action during a run. It opens an in-page
  dialog ("Are you sure you want to stop? We're in remote control mode." — Stop the run / Keep
  running), never `window.confirm`, which would block the event loop of a host-timed run.
  Confirming takes the page's ordinary STOP path (`doStop`).
- **Exit remote control** is enabled only when no run is active.
- Soak and remote control exclude each other.

## Python client

```python
from studio_remote import StudioRemote          # rig/nodes/studio_remote.py
studio = StudioRemote()                          # transport="ros" (default); "ws" = the WebSocket
meta = {"experimenter": "reiserm", "genotype": "CS", "fly_number": 3}
r = studio.run("stage1.yaml", intent="experiment", metadata=meta)
if r["state"] == "done":
    next_yaml = choose(r["bag"])                 # the bag is closed
    studio.run(next_yaml, name="stage2.yaml", intent="experiment", metadata=meta)
```

`StudioRemote(transport="ros" | "ws", url="ws://localhost:8765")`. The ROS transport makes its
own node in a private rclpy context, subscribes, waits for the gateway to match, then publishes;
with no gateway it raises `StudioRemoteError` ("no gateway on the ROS graph") after
`connect_timeout_s`. `rclpy` is imported only for `"ros"`, so `"ws"` needs just `websockets`.
It uses only API present in both ROS 2 Jazzy and Lyrical.

`run(protocol_path_or_text, name=None, intent="test", metadata=None, timeout_s=None, on_status=None)`
blocks until the terminal status and returns it as a dict. `timeout_s` stops the run when it
expires (`"timed_out": true`). `stop()` and `status()` return the gateway's answers. Ctrl-C
during `run()` stops the run.

Command line (`cd rig`): `pixi run remote -- run protocol.yaml [--experiment --experimenter … --genotype …] [--json]`,
`pixi run remote -- stop`, `pixi run remote -- status`; add `--ws [URL]` for the WebSocket.
Exit code 0 only for `done`.

From another ROS node, with plain `rclpy` (no client library):

```python
req = {"id": uuid.uuid4().hex, "action": "run", "name": "stage1.yaml", "protocol": yaml_text,
       "intent": "test", "metadata": {"genotype": "CS"}, "client": "sequencer"}
node.create_subscription(String, "/arena/run_status", on_status, 10)     # subscribe first
pub = node.create_publisher(String, "/arena/run_request", 10)
while pub.get_subscription_count() == 0:                                  # wait for the gateway
    rclpy.spin_once(node, timeout_sec=0.1)
pub.publish(String(data=json.dumps(req)))
# on_status(msg): s = json.loads(msg.data); act on s["id"] == req["id"];
# s["state"] in ("done", "aborted", "failed", "rejected") ends the run, and s["bag"] is closed
```

MATLAB (not yet tried from MATLAB): `r = py.studio_remote.StudioRemote().run("stage1.yaml");`
with `rig/nodes` on the Python path, or a `system()` call to the command line with `--json`.

## Tests

`pixi run test` (root): `tests/test-studio-remote-control.js`, the remote section of
`tests/test-fictrac-bridge-client.js`, `tests/test-studio-url-state.js`.
`cd rig && pixi run test-remote`: a fake Studio, controllers on both transports and the real
client against a real bridge node (also `pixi run -e lyrical test-remote`).

Bench check on a rig PC (needs the controller): `cd rig && pixi run rig`; open the Studio with
`?remote=1`, click Connect; confirm the banner and that the page ignores clicks and keys; run
`pixi run remote -- run ../protocols/g6_2x10_smoke.yaml`; press STOP → "Keep running", then STOP →
"Stop the run" (the command prints `aborted`); run again to the end (`done`, and the printed `bag`
opens); `pixi run remote -- status`; Exit remote control.
