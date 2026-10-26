# ScanImage day (2026-10-16): a real 2P experiment through the ROS 2 graph

**Goal for today:** one simple, real experiment on the Bergamo rig — the G6 four-color arena shows
one-color top-row gratings at six panel duty levels while ScanImage grabs an ex vivo fly prep for
SNR / SiPM characterization (lasers ON, data run) — with ScanImage driven from the protocol through
the same connector path that drives BIAS, and the run log + bag holding the command/reply pairs so
the TIFFs can be aligned to the trials. If the connector path slips, the fallback (§6) still gets
the data today.

Everything here is on branch `claude/ros-studio-plan-b-c44942` (draft PR #254): the ROS 2 graph,
Studio v0.96 with the `scanimage` plugin, the Windows results from ww18 (2026-10-15). **The
off-rig half is built and tested** (Mac, 2026-10-16 morning, commits 93fc80d…); the rig session
runs §1–§5. **Decided with Michael 2026-10-16:** ROS 2 graph adopted (LAB-303), MCAP primary,
**ScanImage's built-in JSON server, not si_zmp** (LAB-305: event-driven, no frame-timing
disturbance; si_zmp's polling timer disturbed frames), one grab per color, no analog marker today
(alignment = Digital IO 1 frame-transfer pulse into ScanImage), GS16 patterns (no refresh-rate
confound vs the 22 Sept runs), unidirectional scan, both channels, server local to the Bergamo PC.

## The two-hour version (2026-10-16: 2 h of rig time in total — run THIS, not the long plan)

Block Z is **not today** (Hannah's ZeroMQ frame-stream test, 60 min dark, conflicts with our
acquisitions; it runs whenever the rig is next free). Steps below are the long plan's §1–§5 with
the optional parts removed and the install overlapped with the hardware setup.

| When | Who | What | Pass |
|---|---|---|---|
| 0:00 | Claude on the PC | `git switch` + `pixi install --locked` in `rig` (cold install can take minutes: start it FIRST). Skip `pixi run test` unless the install finished early | env installs |
| 0:00 | Michael | Arena on the microscope; Studio from the checkout (`python .claude/nocache-server.py 8092`), Connect | Inventory: 20 present |
| 0:10 | Michael | Controller ▾: mode 2, Digital IO 1 = framescan, refresh reads 300. Upload `protocols/g6_2p_color_led_sweep_patterns/` (4 files), note the slots | slots noted; IDs in the YAML fixed if not 5–8 |
| 0:15 | Michael | MATLAB (R2025b, ScanImage idle): `hJ = most.network.json.Server(5555);` logging on, `logFilePath` on F:, unidirectional, channels 1+2 | — |
| 0:20 | Claude | `pixi run rig -- --scanimage` then `pixi run scanimage-cmd -- ping` and `-- status --json` | ping ok, status shows logging on + F: path |
| 0:25 | both, dark | New-arena trigger check: FOCUS → Test full-field ≤ 128 lights every panel; stop FOCUS → all dark; DO1 pulses + line clock on ScanImage's inputs | all three seen |
| 0:35 | Claude, dark | One grab through the connector: `set framesPerSlice 60`, `setFileStem connector_check`, `grab`, `waitIdle` | one TIFF on F:, counter +1, idle again |
| 0:40 | both, dark | Dry run of the whole protocol from the Studio (≈ 2.5 min + overhead) | 4 TIFF series, DO1 in each, bag closed at run end, log converts with 4 grab replies |
| 0:55 | Michael | Prep in, lasers on, SiPMs recording | — |
| 1:05 → 1:50 | both | The experiment: the protocol once per repeat (≈ 3 min each incl. the operator check between runs); 3 to 5 repeats | per run: TIFFs, bag, converted log |
| 1:50 | both | `clear hJ`, arena `allOff`, copy TIFFs + logs; results log filled in | — |

If the connector ping (0:20) or the single grab (0:35) fails and is not fixed in ten minutes:
switch to §6 (fallback script) at once and keep the schedule.

## Where things are

| What | Where |
|---|---|
| **ScanImage remote control = the built-in JSON server** (`most.network.json.Server`): TCP 5555, `<Q` byte count + JSON each way, `get`/`set`/`eval`; started in MATLAB with `hJ = most.network.json.Server(5555);`. Stock install has bugs B1–B4 (patches reverted after LAB-305); the connector is written to stay clear of them: one localhost client, scalar properties only (allowlists), two fixed evals (`hSI.startGrab()`, `hSI.abort()`), complete messages in one write | repo `reiserlab/scanimage-2026-bergamo`: `tests/remote-control/si_remote.py` (JsonClient), `tests/remote-control/mock_servers.py`, `patches/scanimage-2026.0.0/README.md` (B1–B4); LAB-305 results (Done); LAB-306 status block (2026-10-16) |
| **The ScanImage connector** (built today): node, CLI, mock | `rig/nodes/scanimage_node.py` (topics `/scanimage/cmd|reply|status`), `nodes/scanimage_cmd.py`, `tests/si_json_mock.py`; `bridge_node.py` `CONNECTOR_TOPICS` (hello_ack advertises `bias` + `scanimage`); `rig.py --scanimage` / `--si-mock`; `mcap_convert.py` derives the connector events; harness `pixi run test` **52/52** (Mac) incl. grab/waitIdle/abort and the UNKNOWN path |
| **Studio v0.96** plugin `scanimage` (class `ScanImagePlugin`): `setFileStem`, `set` (allowlist), `grab`, `waitIdle`, `abort`; `connectorPluginNames` maps it to the `scanimage` connector; the run file + MCAP bag now **close at run end** (`log_control off` after the commit step) | `js/plugin-registry.js`, `arena_studio.html`, release notes v0.96 |
| **The protocol**: `g6_2p_color_led_sweep` — pre_blank (sets framesPerSlice 640) → per color: setFileStem `<color>_sweep` → grab → 1 s → six conditions (duty 7/15/31/63/127/255, 3 s each, 20 fps) → allOff → waitIdle → post_blank. ≈ 2.5 min. Everything tunable in `variables:` | `protocols/g6_2p_color_led_sweep.yaml` (+ `protocols/index.json`); header = controller settings, ScanImage setup, new-arena check |
| **Patterns (GS16)**: the four one-color top-row gratings re-encoded as Gray_16 (lit = 15), names `G6_2x10_toprow_grat20_<color>_gs16`, **to be uploaded onto the card** (Console → Patterns → Add ▾ → folder); expected slots 5–8 after the GS2 set in 1–4 — verify in the SD listing (the Studio resolves by NAME; IDs are the fallback) | `protocols/g6_2p_color_led_sweep_patterns/` (`node scripts/make-color-optomotor-patterns.js --gs16`) |
| **Fallback driver** (no ROS, stdlib Python): same condition table and TIFF layout | `tools/led_sweep_si.py` (`--dry-run`, `--ping`) |
| **Panel firmware facts (side session 2026-10-16, note `panel-firmware-lineage-2026-10-16.md`)**: all 20 panels carry the 2P timing (falling-edge free-running Triggered, 1 µs base in Triggered, EINT pull-down); bottom row v1.3.1 (`0xB8796BAF`), top row bank-window diag builds (`0x362644DD` / `0x1A74DD1D` / `0x9E03D589`); **20 panels, not 18**; clean bank-window builds hung at boot before → run Inventory after every power cycle; never mode 3 (Gated) on the Bergamo; the 5 A supply resets on all-on at duty 255 → test displays ≤ 128; Triggered gives ⅓ of mode-1 light and the top row's bank windows cut ~5× more | `docs/development/2p-line-sync-rig-checklist.md` (§1 flash is NOT needed today; §2 check applies), `2p-scanimage-signal-logging.md` |
| Hannah's Block Z (ZeroMQ frame stream, ~60 min, runs DARK, changes channelSave/framesPerSlice/acqsPerLoop/logging and restores them; no acquisitions from another block while its subscriber runs) | `reiserlab/scanimage-2026-bergamo` `procedures/rig-session-2026-10-16.md` + `-zmq-frames.md`. **Not today** (2 h of rig time); it runs whenever the rig is next free. Ports would not collide (Z: ZMQ PUB 65179; ours: JSON 5555) |
| Rig-PC environment notes (git not on PATH → GitHub Desktop's git; MATLAB `matlab` is R2026a, ScanImage needs **R2025b**; Python from the operator's terminal; F: for data; `logFilePath` was empty) | same repo, `procedures/rig-session-2026-10-16.md` → "Environment notes" |

## Settled decisions (2026-10-16, Michael)

1. **PC:** the Bergamo PC `reiserlab-bergamo1` runs everything: ScanImage + JSON server, the ROS graph,
   the Studio (served from this checkout), the arena controller. Client on `127.0.0.1` (sidesteps B1
   and the server's all-interfaces bind).
2. **Panels:** no flashing today. Verify with Inventory (20 present) and the §3 behavior check.
3. **Stimulus:** 4 colors × 6 duties (7/15/31/63/127/255) × 3 s at 20 fps on the GS16 gratings,
   one grab per color (startGrab costs 1.2–2.4 s, so per-condition grabs would waste more than they
   image). Repeats = run the protocol again (new TIFF counters).
4. **ScanImage:** unidirectional, both channels, logging on, TIFFs under `F:\ImagingData\2026-10-16\…`,
   framesPerSlice set by the protocol (640 ≈ 22 s at 29 Hz). Lasers on.
5. **Alignment:** Digital IO 1 (BNC J3) frame-transfer pulse + the line clock loop-back recorded by
   ScanImage (aux triggers → TIFF header, or spare AI channels). No AO marker today.

## Plan (in order; stop and report after each)

### 1. Bergamo PC setup (30 min, no hardware)

```
# a terminal the operator owns (git via GitHub Desktop if `git` is not on PATH)
git clone https://github.com/reiserlab/webDisplayTools.git   # or fetch an existing clone
cd webDisplayTools && git switch claude/ros-studio-plan-b-c44942 && git pull
cd rig && pixi install --locked          # default env (String topics); 25 s warm, minutes cold, ~1.5 GB
pixi run test                                 # harness: expect 52 / 52 (≈ 60 s; ports 7447/8765/60000 must be free)
```
Then ScanImage (R2025b MATLAB), idle:
```matlab
hJ = most.network.json.Server(5555);          % the JSON server; keep this handle; clear hJ to stop it
hSI.hChannels.loggingEnable = true; hSI.hScan2D.logFilePath = 'F:\ImagingData\2026-10-16\led_sweep';
```
And the connector against the real server:
```
pixi run router                               # terminal A (or skip: `pixi run rig` starts it)
pixi run scanimage-node                       # terminal B: 127.0.0.1:5555, status 1 Hz
pixi run scanimage-cmd -- ping                # terminal C → "ping → ok (… ms) value={'acqState': 'idle'}"
pixi run scanimage-cmd -- status --json       # acqState, lastFrameNumber, logFileCounter, stem, path, loggingEnable
```
**Pass:** ping ok with a few-ms RTT; status shows logging on and the F: path. Record the RTT.

### 2. Connector bench against the real ScanImage, dark (15 min)

```
pixi run scanimage-cmd -- set --property hStackManager.framesPerSlice --value 60
pixi run scanimage-cmd -- setFileStem --stem connector_check
pixi run scanimage-cmd -- grab                # ≈ 1–3 s; reply carries artifact {stem, counter, path}
pixi run scanimage-cmd -- waitIdle --timeout-s 20
pixi run scanimage-cmd -- grab && pixi run scanimage-cmd -- abort
```
**Pass:** one TIFF `connector_check_00001.tif` on F:, logFileCounter incremented, acqState back to
idle, Hannah's `hMon` shows no lostFrames, MATLAB never froze. **Record:** grab start RTT (the
synchronous startGrab), TIFF frame count.

### 3. The arena on the microscope (new arena: 20 min)

Studio from this checkout (not Pages): `python .claude/nocache-server.py 8092` at the repo root →
`http://localhost:8092/arena_studio.html?advanced=1` (soft password per the branch notes). Connect.
1. **Console → Panel firmware → Inventory:** 20 present; 1–10 `fw_match 0xB8796BAF`; 11–20
   `fw_differs` with `0x362644DD` / `0x1A74DD1D` / `0x9E03D589`. Repeat after any power cycle.
2. **Controller ▾:** panel display mode **2** (Triggered). **Digital IO 1 = out_debug_framescan.**
   Digital IO 2 stays `in_trigger` (line clock → EINT). **Refresh rate reads 300 Hz** (GS16 default).
3. **Trigger + edges (the new-arena check):** ScanImage FOCUS (dark) so the line clock runs →
   Console → Test → full-field at level **≤ 128**: every panel lit at ~⅓ of mode-1 brightness.
   Stop FOCUS → every panel dark. On the scope / ScanImage AI: DO1 shows one pulse per controller
   refresh tick (~0.7 ms wide), the line clock is on its loop-back channel. `stopDisplay` does not
   blank; `allOff` does.
4. **Patterns:** Console → Patterns → Add ▾ → `protocols/g6_2p_color_led_sweep_patterns/` (4 GS16
   files). SD listing shows `…_gs16` names; note their slots. If they are not 5–8, fix the four IDs
   in the protocol's `variables:` (the Studio resolves by name; the IDs are the fallback).
5. **Graph up:** `pixi run rig -- --scanimage` (router + fictrac adapter + scanimage node + bridge
   node). Studio Console → FicTrac/bridge: Connect → hello_ack lists connectors `bias, scanimage`.

### 4. Dry run without the prep, dark (20 min) — the go/no-go

Lasers off. Studio → Open `protocols/g6_2p_color_led_sweep.yaml` → Run (experiment). **Pass:**
- 24 stimulus conditions + 2 blanks run; four TIFF series `violet_sweep_…`, `blue_sweep_…`,
  `green_sweep_…`, `yellow_sweep_…` on F:, each ≈ 640 frames;
- DO1 pulses visible in each TIFF's aux record / AI channel; six brightness steps visible on the
  arena by eye (the duty steps);
- the run ends, the bridge's run file AND the bag close (`[record] closed …bag` in the rig terminal);
  `pixi run convert -- <bag>` (or the Studio export) gives a `.jsonl` with 4 `grab` replies carrying
  `artifact.stem` + `counter`, 4 `waitIdle` ok, `setFileStem` ×4, `set` ×1; `runlog-check` OK.
- `hMon`: no lostFrames attributable to the connector (compare with Block Z's idle baseline).

### 5. The experiment (with Michael)

Prep in, lasers on, SiPM channels recording. Run the protocol once per repeat. After each run:
the converted log, the bag, the TIFF list, the DO1 trace. **Alignment check:** TIFF frame times vs
the `grab` reply `t_ms` and the first DO1 pulse of each color block; duty steps vs the trialParams
`["a",…]` echoes in the log.

### 6. Fallback (keeps today's data if the connector path slips)

`python tools/led_sweep_si.py --dry-run` → `--ping` → `python tools/led_sweep_si.py` on the rig
PC (stdlib Python, talks to the JSON server directly). It sets the stem and starts the grab per
color and cues the operator; the Studio runs the matching color block by hand (**Test experiment**
or Run on a copy of the protocol with the `scanimage` commands removed). Same one-TIFF-per-color
layout and DO1 alignment, so the analysis does not change.

## What still needs the rig (cannot be tested off-rig)

- The JSON server's real reply shape for `set` (`actual`) and `eval` on ScanImage 2026.0.0 — the
  mock follows Hannah's mock; a difference shows up in step 1/2 as an `error` reply, and the
  node's `steps` list says which request.
- startGrab latency on the Bergamo PC (1.2–2.4 s in LAB-305) → whether `grab_settle: 1` is enough
  (the grab reply already waits for `acqState == grab`, so the settle covers scanner start only).
- The arena's trigger path on the microscope (step 3.3), the DO1 record in ScanImage, the SD slots
  after the upload, and the bank-window boot behavior after power cycles.
- Windows specifics of the node: the TCP client is stdlib; `raise_timer_resolution()` applies as
  for the other nodes. `pixi run test` is the check (52/52 expected; ww18 was 47/47 before today).

## Rules
- Nothing goes to Production or Next; all code on branch `claude/ros-studio-plan-b-c44942`, commits
  name the step. Never change ScanImage's vendor files, `MicroscopeMDF.m`, `.cfg`/`.usr`, or the
  power plan (the scanimage repo's rules apply). Clear the JSON server (`clear hJ`) at the end.
- Dark until Michael says the prep is ready (steps 1–4). Confirm before anything that starts FOCUS,
  GRAB or LOOP while someone is at the microscope.
- Keep a results log from the first command (`rig/scanimage-day-2026-10-16.md`): one row per
  step, timings, every error verbatim. Add our block to the scanimage repo's session index
  (`procedures/rig-session-2026-10-16.md`, block letter S, this file as the plan) — that repo
  commits straight to `main`.

## Paste into Claude Code on the rig PC

```
ScanImage day on the Bergamo rig (LAB-303 / LAB-306). Fetch reiserlab/webDisplayTools, switch to
claude/ros-studio-plan-b-c44942 (git pull) and read rig/SCANIMAGE-DAY.md end to end: the
off-rig half is built and tested; today is steps 1–5 in order, dark through step 4, lasers on
only when Michael says so. Also read procedures/rig-session-2026-10-16.md in
reiserlab/scanimage-2026-bergamo (Hannah's Block Z runs today on this rig, dark, before us; its
environment notes apply). Stop and report after each numbered step, keep the results log the
brief asks for, and use the fallback (§6) rather than debugging on site if the connector path
fails. Small fixes go on the branch; never touch Production, Next, or ScanImage's own files.
```
