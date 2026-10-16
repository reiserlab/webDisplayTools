# ScanImage day (2026-10-16): a real 2P experiment through the ROS 2 graph

**Goal for today:** one simple, real experiment on the Bergamo rig — drive the G6 color LEDs at a few
intensities and record an ex vivo fly prep for SNR / SiPM characterization — with ScanImage driven
from the protocol through the same connector path that drives BIAS, and the run log + bag holding
the command/reply pairs so the TIFFs can be aligned to the trials. If the connector path slips, the
fallback (§6) still gets the data today.

Everything here builds on branch `claude/ros-studio-plan-b-c44942` (draft PR #254): the ROS 2 graph,
the Studio v0.95+ with `connector_command`, the Windows results from ww18 (2026-10-15).

## Where things are

| What | Where |
|---|---|
| ScanImage remote control (**si_zmp**): ZeroMQ REQ/REP on `tcp://127.0.0.1:5556` (`'*'` for other PCs), text commands `ping \| status \| focus \| grab \| loop \| abort \| get <prop> \| set <prop> <value>` | repo `reiserlab/scanimage-2026-bergamo`, `scanimage/SI2026.0.0_…/si_zmp/` (`HOW_TO_USE.txt`, `si_zmq_server.m`, `si_zmq_server2.m`, Python client `si_zmq_client.py` → `ScanImageClient(host, port)`) |
| Off-rig mocks for si_zmp (for the harness) | same repo, `tests/remote-control/mock_servers.py`, `tests/remote-control/offrig/` |
| LAB-305 head-to-head results (si_zmp vs the built-in JSON server; the JSON server must NOT be used on a rig) | same repo, `tests/remote-control/results/2026-10-15_LAB-305/report.html`; Linear LAB-305 (Done) |
| **Today's other rig block**: Hannah's Block Z (ZeroMQ frame stream, ~60 min, runs DARK) | same repo, `procedures/rig-session-2026-10-16.md` — coordinate: our prep needs the lasers ON |
| Rig-PC environment notes (git not on PATH, MATLAB R2025b vs R2026a, Python 3.14 terminal, F: for data) | same repo, `procedures/rig-session-2026-10-16.md` → "Environment notes" |
| 2P panel firmware (BETA line-sync: active-low EINT, 1 µs BCM base, free-running Triggered) + the two-minute functional check | `docs/development/2p-line-sync-rig-checklist.md` (§1 flash all 18 panels, §2 check) |
| What ScanImage must record for alignment (DO1 frame-transfer envelope, line clock loop-back, **AO condition marker** on an AI channel) and the controller settings before Run (panel display mode **2** Triggered, Digital IO 1 role framescan, refresh 300 Hz for GS16) | `protocols/g6_2x10_2p_duty_sweep.yaml` header; `docs/development/2p-scanimage-signal-logging.md` |
| Intensity = panel duty (25 / 64 / 128 / 191 / 255 ≈ 10–100 %); `duty: 0` means the pattern's own, OFF is `allOff`; end with `allOff`, not `stopDisplay` | same YAML header, notes 1–4 |
| Color patterns, one LED color at a time, top row, 25/50/100 % duty (made on ww18) | `protocols/g6_color_optomotor_smoke*.yaml` + its patterns on this branch; `scripts/make-2p-diagnostic-patterns.js` for full-field GS16 |
| The BIAS connector (the template for a ScanImage connector) | `ros2-poc/nodes/bias_node.py`, `bridge_node.py` (`CONNECTORS`, `on_connector_command`), `js/arena-runner-g6.js` (`connectorCommand`), `arena_studio.html` (`connectorPluginNames`), `js/plugin-registry.js` (`camera` plugin) |
| Arena → microscope signal into ZeroMQ (the event side si_zmp does not have yet) | Linear LAB-300 (Todo, Hannah) — out of scope today; alignment uses the AO marker |

## Decisions to make first (10 minutes with Michael)

1. **Which PC.** The Studio, the graph and the arena controller must sit on one PC; si_zmp can be
   local (`127.0.0.1:5556`) or remote (`'*'`). Default: the Bergamo PC `reiserlab-bergamo1`
   (ScanImage + si_zmp there; the 2P checklist already runs the Studio there). ww18 is the
   fallback if the Bergamo PC must stay untouched.
2. **Panels.** Are the 18 panels on the Bergamo arena on the BETA 2P firmware (checklist §1)? If
   not, flashing + §2 check is the first hardware step (~20 min).
3. **Stimulus set.** Which colors (which of the 4 banks), how many intensities (duty levels), how
   long per step, how many repeats; static full field or the top-row color patterns. Keep it to
   ≤ 15 conditions so one run fits in ~5 min.
4. **ScanImage side.** Where TIFFs go (`F:\ImagingData\…`), frames per grab, channels; whether
   `set hScan2D.logFileStem` per condition is wanted (one TIFF per condition — strongly preferred
   for alignment) or one long grab with the AO marker only.
5. **Time with Hannah.** Block Z runs dark; our runs need lasers on. Agree the order.

## Plan (in order; stop and report after each)

### 1. Bergamo PC setup (30 min, no hardware)
- Clone/fetch `reiserlab/webDisplayTools`, `git switch claude/ros-studio-plan-b-c44942`; `cd ros2-poc`;
  `pixi install --locked` (ww18: 25 s warm, minutes cold; 1.0 GB). Use the default env (String
  topics); the `typed` env is optional today.
- `pixi run test` (harness, 47/47 on ww18). Note the Windows gotchas already fixed there
  (`WINDOWS-TEST.md`, `windows-results-ww18-2026-10-15.md`).
- Confirm si_zmp answers: MATLAB `hZ = si_zmq_server(hSI);`, then from Python
  `ScanImageClient("127.0.0.1", 5556).ping()` → `pong`. Record the `status` reply shape.

### 2. ScanImage connector (2–3 h, mock first, then si_zmp)
- `ros2-poc/nodes/scanimage_node.py`, modeled on `bias_node.py`: one ZMQ REQ socket to si_zmp,
  topics `/scanimage/cmd`, `/scanimage/reply`, `/scanimage/status` (poll `status` at 1 Hz).
  Commands 1:1 with si_zmp: `ping, status, focus, grab, loop, abort, get(property),
  set(property, value)`, plus a composite `grabAndWait(frames?, timeout_s)` that issues `grab`
  and polls `status` until idle — the protocol needs "the grab is done" as a step boundary.
  Timeouts: a REQ with no reply within `timeout_s` is an UNKNOWN outcome (same LAB-303 rule as
  BIAS); ZMQ REQ/REP needs `RCVTIMEO` + socket reset on timeout or it wedges.
- `bridge_node.py`: `CONNECTORS["scanimage"] = "/scanimage/cmd"`; the relay is already generic.
- `js/plugin-registry.js`: a `scanimage` plugin (`matlab.class: "ScanImagePlugin"` as the key;
  MATLAB has no such class yet — say so in the registry comment) with those commands and params.
- `arena_studio.html` `connectorPluginNames`: ScanImagePlugin → `'scanimage'`.
- Harness: add the scanimage node + `mock_servers.py`'s si_zmp mock (copy the mock into
  `ros2-poc/tests/` with attribution) and a connector step in `studio_emulator.py`; keep 47/47.
- Bench the node against the real si_zmp from a terminal (`pixi run scanimage-cmd -- ping`, `…
  grabAndWait`) before any Studio run.

### 3. The protocol (30 min) — `protocols/g6_2p_color_led_sweep.yaml`
- Rig `./configs/rigs/cshl_g6_2x10.yaml` (the 2P rig config the duty sweep uses), plugins
  `scanimage` (+ nothing else; no fictrac on the 2P rig).
- `pre_blank`: `allOff`, `setAnalogOut` marker 0 V, `scanimage.set hScan2D.logFileStem "<run>_blank"`,
  `scanimage.grabAndWait`.
- Per condition (color × duty): `setAnalogOut` marker stepped (0.5 V per condition) →
  `scanimage.set logFileStem "<run>_c<k>_<color>_d<duty>"` → `scanimage.grab` → `wait 1` (grab
  start latency; measure it in step 2) → `trialParams` (static single-color full-field pattern,
  `duty: <level>`, mode 2, frame_rate 0) → `wait <step_dur>` → `allOff` → `scanimage.grabAndWait`
  (or `abort` if frames per grab > the step).
- `post_blank` as `pre_blank`. End with `allOff`.
- Patterns: static single-color full-field at GS16 from the color-panel tooling; if making them is
  slow, use the existing top-row color patterns from the ww18 smoke protocol.
- Controller settings before Run (Console, per the checklist): display mode 2 (Triggered), Digital
  IO 1 = framescan, refresh 300 Hz. Check whether the Studio on this branch asserts them from the
  protocol; if not, set them by hand and note it.

### 4. Dry run without the prep (20 min)
- Lasers off, detectors off: full protocol → bag + converted log → `runlog-check.py` OK; one TIFF
  per condition on F:, the AO marker steps visible in ScanImage's AI channel, command/reply pairs
  in the log with `t_ms`. This is the go/no-go for the real run.

### 5. The experiment (with Michael)
- Prep on, lasers on, SiPM channels recording. Run the protocol once per repeat. After each run:
  the converted log, the bag, the TIFF list and the AO marker trace. Alignment check: TIFF
  frame timestamps vs the log's `scanimage.grab` reply `t_ms` and the AO step edges.

### 6. Fallback (keeps today's data if §2 slips)
- A script on the rig PC, `tools/led_sweep_si.py`: `ScanImageClient` + a fixed condition table
  (color, duty, duration) that sets the file stem and grabs per condition, while the Studio runs
  the matching protocol via **Test experiment** (the 22 Sept route, `2p-line-sync-rig-checklist.md`
  §3) and the AO marker carries the alignment. Same TIFF-per-condition layout, so the analysis
  does not change later.

## Rules
- Nothing goes to Production or Next; all code on branch `claude/ros-studio-plan-b-c44942` (or a
  branch off it), commits name the step. Never change ScanImage's vendor files, `MicroscopeMDF.m`,
  `.cfg`/`.usr`, or the power plan (the scanimage repo's rules apply).
- Run dark until Michael says the prep is ready. Confirm before anything that starts FOCUS, GRAB or LOOP.
- Keep a results log from the first command (`ros2-poc/scanimage-day-2026-10-16.md`): one row per
  step, timings, every error verbatim.

## Paste into Claude Code on the rig PC

```
ScanImage day on the Bergamo rig (LAB-303 / LAB-300 context). Fetch reiserlab/webDisplayTools,
switch to claude/ros-studio-plan-b-c44942 and read ros2-poc/SCANIMAGE-DAY.md; it has the goal,
where everything is, the five decisions to settle with me first, and the plan in order. Also
read procedures/rig-session-2026-10-16.md in reiserlab/scanimage-2026-bergamo (Hannah's block
runs today on this rig; its environment notes apply). Work the plan in order, stop and report
after each numbered step, run dark until I say otherwise, and keep the results log the brief
asks for. Small fixes go on the branch; never touch Production, Next, or ScanImage's own files.
```
