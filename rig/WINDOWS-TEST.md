# ROS 2 Plan B spike: Windows rig test (LAB-303)

The one item still open after the Mac runs is **Windows**, where most rig PCs live. This is a
step-by-step for one session on a rig PC with a G6 controller, BIAS (the Windows `bias_gui.exe`
with a FLIR camera) and, if present, FicTrac. It tests what the Mac proved on 2026-10-14
(`README.md` → "Plan B spike" and "Mac bench end-to-end"): **the Studio on this branch drives
the camera and the closed loop through the ROS 2 graph, every run is recorded as an MCAP bag,
and the run log every reader accepts is derived from the bag.** Budget: about 90 minutes.
**A failure with its verbatim error text is as valuable as a pass**: copy the text before
trying anything to fix it.

Nothing here touches bridge 3.4 or Production. `rig/` is its own pixi workspace.

## Kickoff prompt for the Windows session (paste into Claude Code on the rig PC)

There is no remote path into the rig PCs from the Mac, so the Windows session is started on the PC
itself: open Claude Code in a checkout of `reiserlab/webDisplayTools` and paste this as the first
message. Everything it needs is in this file.

```
Windows rig test of the LAB-303 ROS 2 Plan B spike (draft PR #254, branch
claude/ros-studio-plan-b-c44942). Fetch and switch to that branch, then follow
rig/WINDOWS-TEST.md step by step, in order, and keep a results log as you go
(rig/windows-results-<hostname>-<date>.md: one row per step, pass/fail, timings,
sizes, and every error verbatim). Rules: stop bridge 3.4 first; capture an error's full
text before trying to fix it; small fixes may be committed to the branch with a message
that names the step; never touch Production or Next; ask me (Michael) before anything that
needs a click on hardware, the serial-port picker, or the BIAS GUI. Steps 1–3 need no
hardware and can run unattended; tell me when you reach step 4 (BIAS) and step 5 (the
Studio + controller run). At the end, commit the results file, push, and add a short
"Windows results" row to the test-plan table in the PR #254 description.
```

**Bare machine (no git / pixi / build tools yet, e.g. reiserlab-ww18):** paste this one instead;
it bootstraps first. The Claude Code CLI on Windows needs Git for Windows installed beforehand (it
runs through its bash); the desktop app does not.

```
You are on a Windows rig PC (reiserlab-ww18). Set it up for the LAB-303 ROS 2 Plan B Windows
test, then run the test. Keep a results log from the first command: one row per step with
pass/fail, timings, sizes and every error verbatim.
1. Tooling check: git --version; pixi --version (need 0.69+); Chrome; whether Visual Studio
   2022 Build Tools with the Desktop C++ workload is installed (vswhere or Settings → Apps).
   Install what is missing: Git.Git via winget; pixi via
   `irm -useb https://pixi.sh/install.ps1 | iex` (open a new shell afterwards);
   `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive
   --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` for the typed-message
   build. Ask me before any admin/UAC step and before any download over 1 GB; record how
   long each install took.
2. Clone reiserlab/webDisplayTools under Documents\GitHub (gh auth login, or HTTPS), then
   `git switch claude/ros-studio-plan-b-c44942`.
3. Follow rig/WINDOWS-TEST.md in order. Steps 1–3 need no hardware and can run
   unattended; stop and ask me to be at the keyboard before step 4 (BIAS) and step 5 (Studio +
   controller over Web Serial). Stop bridge 3.4 first if it is running.
4. Results: rig/windows-results-ww18-<date>.md committed to the branch and pushed; add a
   "Windows results" row to the test-plan table in PR #254's description. Small fixes may go on
   the branch (message names the step); never touch Production or Next.
```

**Custom BIAS build on the PC** (ww18 runs one tweaked for fast cameras): the node needs only
BIAS's external-control HTTP interface (connect, disconnect, set-video-file, enable/disable-logging,
start/stop-capture, get-status, get-time-stamp, get-video-file), which lives in the GUI core, so it
should work unchanged. Before step 4, probe it and record the answers: is the server enabled, on
which port (5010 = camera 0; 5020, 5030 for more cameras), what shape `?get-status` returns, and
what `?get-video-file` reports after `set-video-file` (ufmf / avi / something else). Those four
answers decide whether `bias_node.py` needs any change at all.

Prerequisites on the PC (check before pasting): `git`, `pixi` 0.69+, Chrome, the BIAS
Windows build with its FLIR camera, the G6 controller on USB, optionally FicTrac; and know whether
Visual Studio 2022 Build Tools (Desktop C++) is installed — step 1b measures the typed-message
build with and without it.

**Windows notes from the first run (ww18, 2026-10-15 — `windows-results-ww18-2026-10-15.md`):**

- **Short build path for the typed build**: under `C:\Users\<name>\Documents\GitHub\…` it hits Windows'
  260-character path limit (`C1083`). Either clone to under ~45 characters before `\rig`, or, from any
  checkout, run `pixi config set --local detached-environments C:\px` in `rig` once (≤ 12 characters;
  it moves envs and build dirs there). See `docs/typed-windows.md` §3.
- **MSVC**: VS Build Tools **2026** alone is not found by conda-forge's VS 2022 activation; add the component
  group "MSVC v143 - VS 2022 C++ x64/x86 build tools (v14.44)"
  (`Microsoft.VisualStudio.ComponentGroup.VC.Tools.143.x86.x64`, UAC, < 5 min). The packaging failure that
  followed (`paths in archives must not have '..'`, a pixi-build-ros bug) is worked around in the package
  since 538cc85: 1b / 7 install on ww18 (35 s, harness 48 / 48).
- **Check the controller's SD card first**: an empty SD listing / "pattern missing" can mean no card is mounted
  at all (ww18's old card). The site library's 2×10 set (`patterns/g6_2x10/patterns/`) plus
  `protocols/bias_camera_closed_loop_poc_ww18*.yaml` (slot 2 `grating_sq`) work on any 2×10 card loaded that way.
- **FicTrac** (pixi-built): start it with `build\Release\fictrac.bat <config>` from the config folder —
  `fictrac.exe` alone exits silently with `0xC0000135` (DLL not found).
- **BIAS Atlas10 build** (atlas-bench): HTTP server on by default at 5010; uFMF by default, so `.avi` names
  become `.ufmf`; `connect` ≈ 2.2 s and `stop-capture` up to several seconds on short recordings (the node's
  15 s slow timeout covers both); uFMF ≈ 24 MB/s at 8 MP × 135 fps.
- **Studio**: open protocols with Protocol ▾ → **Open from Library…** (this server's registry, no sign-in);
  if a `?p=` link does not load, refresh the tab.

## 0. Before starting

- Repo: `reiserlab/webDisplayTools`, branch `claude/ros-studio-plan-b-c44942` (draft PR
  [#254](https://github.com/reiserlab/webDisplayTools/pull/254)):
  `git fetch && git switch claude/ros-studio-plan-b-c44942`.
- Stop bridge 3.4 if it is running (the terminal with `pixi run bridge`): the graph binds the same
  ports. FicTrac itself may keep running; it only *sends* to UDP 60000.
- `pixi --version` (0.69 or newer: the `typed` environment uses pixi's preview build feature).
  PowerShell, not Git Bash, for the `Measure-Command` timing.
- Chrome version (Settings → About). Note it.
- Ports free: `netstat -ano | findstr ":7447 :8765 :8092 :60000 :60001 :5010"` prints nothing except
  BIAS on 5010 (once it is running).
- Is **Visual Studio 2022 Build Tools (Desktop C++)** installed on this PC? Note yes/no; step 1b
  measures what it costs when it is not.

## 1. Install (timed) — two environments

**1a. The default environment** (String topics; this must always work):

```powershell
cd rig
Measure-Command { pixi install --locked | Out-Default }
```

Record the wall time, the environment size (`(Get-ChildItem .pixi\envs\default -Recurse | Measure-Object Length -Sum).Sum / 1GB`)
and whether anything had to be done by hand. Then the Windows-only check: does pixi expand
`$PIXI_PROJECT_ROOT` in `[activation.env]`?

```powershell
pixi run python -c "import os; print(os.environ['ZENOH_ROUTER_CONFIG_URI'])"
```

Expected: a real path ending in `rig\config\zenoh-router.json5`. If it prints the literal
`$PIXI_PROJECT_ROOT/...`, the individual `router` / `*-adapter` tasks will use the stock IPv6
config (or fail); `pixi run rig` is unaffected because `rig.py` sets both paths itself.
**Write down which of the two you saw.**

**1b. The `typed` environment** (since 2026-10-26: downloads `rig_interfaces` from the rig-nodes
channel — no MSVC, no build; the source build is the rig-nodes workspace itself, or `pixi install -e dev` here):

```powershell
Measure-Command { pixi install --locked -e typed | Out-Default }
pixi run -e typed check-typed
```

Record: wall time; success or the **first error verbatim** (the expected failure without Build
Tools is a compiler-not-found message from the backend); with Build Tools present, whether
`--check` prints `"importable": true, "serializes": true`. **Spend at most 20 minutes here**, then
continue with the default environment regardless. Everything below says `pixi run …`; if 1b
succeeded, run the same commands once more at the end as `pixi run -e typed …` (step 7).

## 2. Middleware (three terminals)

```powershell
pixi run router       # terminal 1: expect "Zenoh can be reached at: tcp/127.0.0.1:7447"
pixi run listener     # terminal 2
pixi run talker       # terminal 3
```

Pass: every `Publishing: "Hello World: N"` has a matching `I heard` within a few ms. Ctrl-C all
three (an `rcl_shutdown already called` traceback is the stock demo nodes, not a failure). Note
whether the router keeps running after Ctrl-C (`tasklist | findstr rmw_zenohd`).

## 3. Acceptance harness (no hardware)

```powershell
pixi run test -- --keep
```

Expected: `46 / 46 checks passed` in about a minute and a line `artifacts kept in …`. Keep that
directory (`summary.md`, `crash-results.json`, the converted export, `runlogs\*.bag`, `proc-logs\`).
Windows-specific things it exercises for the first time: child processes in their own group,
`CTRL_BREAK_EVENT` as the stop signal, `TerminateProcess` for the mid-run kills (the FicTrac adapter
AND, in the crash phase, the bridge node itself), file reads while another process writes, console
encoding (`PYTHONUTF8=1`), and rosbag2's MCAP plugin writing under a Windows path. Record the
`[test] crash (...)` lines (frames kept by the NDJSON vs recovered from the bag, both profiles) and
the `info  typed topics:` line (`False` in the default env is expected). If it fails, send
`summary.md` plus the whole `proc-logs\` folder.

## 4. BIAS on Windows, through the node

BIAS must have its external-control HTTP server on (camera window → server menu → `Port (5010)…`,
enable). Check from PowerShell:

```powershell
curl.exe "http://127.0.0.1:5010/?get-status"
```

Expected: `[ { "command" : "get-status", "success" : true, "value" : { "capturing" : …, "connected" : …, "frameCount" : …, "framesPerSec" : …, "logging" : …, "timeStamp" : … } } ]`
(the Mac port's shape; note any extra or missing key). Decide the **video directory** now, an
absolute path the rig uses for videos, e.g. `C:\Users\<rig>\Videos\rig`; create it. Then,
with a router running (`pixi run router`), in two terminals:

```powershell
pixi run bias-node -- --host 127.0.0.1 --port 5010 --video-dir C:\Users\<rig>\Videos\rig
pixi run bias-cmd -- connect --json
pixi run bias-cmd -- startRecording --filename poc.avi --json      # relative → resolved against --video-dir
curl.exe "http://127.0.0.1:5010/?get-status"                       # capturing true, frameCount rising
pixi run bias-cmd -- getTimestamp --json
pixi run bias-cmd -- stopRecording --json
dir C:\Users\<rig>\Videos\rig
```

Record every reply (`--json` prints it), the `value` of `get-video-file` versus the file(s)
actually written (the Mac port wrote `<stem>_cam_0_date_…_v001\movie.mjpg` + `stamp_log_cam0.txt`;
the Windows BIAS with Spinnaker may write the `.avi` it was asked for), `start-capture` round-trip
ms, and whether the camera preview went live. Stop the node and the router.

**Unknown-outcome path** (the LAB-303 semantics): start a recording, then close BIAS while the node
polls. Expect `/bias/status` lines with `reachable:false`, and a `bias-cmd -- getTimestamp` to come
back `outcome: "unknown"` or `error` (exit code 3 or 1), never a hang. Restart BIAS: status must
flip back to `reachable:true` without restarting the node.

## 5. The rig: Studio + BIAS + closed loop, recorded as a bag — THE test

Terminal A — the graph (model fly unless the rig has FicTrac, see below), BIAS node included:

```powershell
pixi run rig -- --sim --sim-args "--proto udp --model fly --kp 2 --seed 1 --rate 50" --bias --bias-args "--video-dir C:\Users\<rig>\Videos\rig"
```

Expected: `[rig] up: router, fictrac, bias, bridge, sim — Studio → ws://localhost:8765`, and in the
bridge lines `record=mcap/crashsafe` and `typed=False` (default env) or `typed=True`.

Terminal B — this branch's Studio, served from the checkout (there is no Pages copy of this branch
yet; `/ros/` needs the tooling on `main` first):

```powershell
cd ..                                   # repo root
python .claude\nocache-server.py 8092
```

Chrome: `http://localhost:8092/arena_studio.html?p=bias_camera_closed_loop_poc&rig=<rig key>&mode=run`
with the rig key from `configs\rigs\index.json` that matches this arena (`cshl_g6_2x10_ball` for a
2×10 ball rig). Then:

1. Run view → **Bridge: Connect**. Expect `connected · rx N` and the scope scrolling. Note whether
   Chrome shows a local-network-access prompt (none on the Mac, Chrome 155; both ends are localhost).
2. **Connect** (top bar) → pick the controller in the serial-port picker.
3. **Check the pattern first:** Console → SD listing must show the protocol's pattern *by name* with
   more than one frame. The protocol names `G6_2x10_grat_rot_20px_50pct_4c-B-Y` at `pattern_ID 1`;
   if this card differs, edit the name / `pattern_ID` in Edit view to a rotating pattern that is on
   the card (any frame count > 1; the report checks the mapping, not the pattern).
4. Fill experimenter and genotype (required; the site lists work offline), **Run experiment**. The
   protocol is 6 steps / ~35 s: camera `connect → startRecording → getTimestamp`, 15 s Mode-3 closed
   loop, `getTimestamp`, 15 s closed loop with a +90 °/s bias, `getTimestamp → stopRecording`,
   shutdown. Watch the step strip: every camera step must complete, none skipped. Note the BIAS
   preview and whether the display turns with the model fly.
5. **Collect the run.** If the Studio has the course token on this origin it auto-commits (the
   bridge log then shows `[convert] … identical to the live file: …` and `[log] export →`). If not
   (normal for a fresh localhost origin), export it yourself — the same message the Studio sends:

```powershell
pixi run export                          # → rig\runlogs\exports\arena-log-….jsonl (converted from the bag)
```

   Terminal A shows `[record] closed … records`, `[convert] … → N lines in M ms; identical to the
   live file: True|False`, and the bag directory `runlogs\arena-log-….bag\` now has `metadata.yaml`.

6. **Judge it** (stdlib scripts; the workspace Python is fine):

```powershell
pixi run python ..\scripts\closed-loop-report.py runlogs\exports\<file>.jsonl
pixi run python ..\scripts\runlog-check.py runlogs\exports\<file>.jsonl
pixi run convert -- runlogs\<run>.bag --level behavior_v2 --out v2.jsonl      # level switch from the same bag
pixi run convert -- runlogs\<run>.bag --order time --out time.jsonl
pixi run ros2 bag info runlogs\<run>.bag
fc.exe /b runlogs\exports\<file>.jsonl runlogs\<run>.jsonl                      # vs the live shadow file
```

Pass: two epochs from `fictracApply`, idx mismatch ≤ 0.2 % (one boundary row) in each;
`runlog-check` prints `OK` with the firmware line and `cc_0x70_ok` ≈ 1500; six `connector` replies
with `"outcome":"ok"` and `"via":"ws"` and the `startRecording` one carrying `artifact.path`; the
video exists in the video directory; `ros2 bag info` lists `/arena/frame`, `/fictrac/raw` (or
`/fictrac/frame` in the typed env), `/arena/browser`, `/bias/cmd`, `/bias/reply`, `/bias/status`.
On the Mac the exported file matched the shadow file on every line except the BIAS status/reply
lines, which differ by ≤ 1 ms in their `ms` — `fc` will report those; anything else differing is a
finding. Record the bag size vs the `.jsonl` size and the `[convert]` time.

7. **Crash on the real rig** (optional, 3 minutes): start a second run; ~10 s into the first closed
   loop, kill the bridge node from another terminal (`taskkill /F /PID <bridge pid>` — `rig.py`
   prints `[rig] bridge exited` and stops the rig). Then:

```powershell
pixi run convert -- runlogs\<run>.bag --recover --out recovered.jsonl
```

   Record the recovered line and frame counts against the shadow `.jsonl` (the Mac lost one frame
   with the `crashsafe` profile), and whether the Studio reported the lost bridge cleanly.

If the rig has **real FicTrac**: repeat step 5 once without `--sim` with FicTrac running and a ball
(FicTrac sending to `127.0.0.1:60000` as for bridge 3.4). The adapter log shows its line rate; the
closed-loop report then has no `rejection` to check — the idx mismatch is the test.

## 5b. Look at the graph while the rig is up (2 minutes)

```powershell
pixi run graph -- --text          # nodes, topics, publishers/subscribers, rates
pixi run graph -- --out graph.md  # the Mermaid diagram (paste into the report)
```

Optional, if time: `pixi install -e viz` (Qt + foxglove_bridge, ~0.3 GB more) then
`pixi run -e viz rqt-graph` for the live graph window; restart the rig with `--foxglove` added
(Terminal A: `pixi run rig -- --sim --bias --foxglove`) and connect Foxglove to `ws://localhost:8766`
for the live plots (without the viz environment the rig prints one note and runs without it); and open the run's
`runlogs\<run>.bag\<run>_0.mcap` in Foxglove on any machine (free account sign-in; Layout → Import →
`docs\foxglove-arena-layout.json`) to plot `/arena/frame`.

## 5c. The color optomotor protocol (the experiment-shaped test, ~18 minutes)

Start with the 2-minute **smoke variant** `?p=g6_color_optomotor_smoke` (10 s per pattern, duty 100 %
only, same camera bracket) — it passed on the Mac bench on 2026-10-14 — then the full protocol.

`protocols/g6_color_optomotor_test.yaml` is the G6 version of the lab's Protocol 11/13: open-loop
rotating gratings, clockwise then counterclockwise, 20 s trials, a camera timestamp at every trial
start and one video for the run — with ONE LED color at a time on the TOP panel row (four-color G6
panels; patterns in `protocols\g6_color_optomotor_test_patterns\`, one per color bank) and the
brightness swept with the per-trial `duty` override (25 / 50 / 100 %). 3 duties × 4 colors × 2
directions × 2 repetitions = 48 trials × 20 s + 3 s dark ITIs ≈ 18 min; set `repetitions: 1` on the
three blocks for ≈ 9 min.

1. **Patterns onto the card:** Console → Patterns → Add ▾ → the folder above (four files, 21 kB each).
   The SD listing must then show the four `G6_2x10_toprow_grat20_*` names with 20 frames. Note the
   slot numbers; the YAML's `pattern_ID` 1–4 is only the fallback when the listing is unavailable.
2. **Direction check (once):** Console → Test one trial of `green_cw_d100`. Decide whether the
   grating turns clockwise seen from above; if not, swap the `fps_cw` / `fps_ccw` values in
   `variables:` (Edit view) — record which.
3. **BIAS:** external-control server on; logging format set to **ufmf** in BIAS's own settings
   (the protocol asks for `color_optomotor.ufmf`; BIAS writes the configured format whatever the
   extension); the bias node started with `--video-dir <absolute path>` as in step 5.
4. **Run** from the Run view with the graph up (step 5, terminal A). Watch the first block: every
   trial should start with a `getTimestamp` reply (BIAS clock advancing ~23 s per trial), the top
   row only lit, one color per trial, the bottom row dark; the ITIs dark.
5. **Collect** with `pixi run export`, then `runlog-check.py` (48 trials, `cc_0x70_ok` 0 — these
   are mode-2 trials, no host frames) and look at the bag in Foxglove: `/bias/reply` should hold
   50 `getTimestamp` replies plus connect/start/stopRecording; `/arena/browser` carries the 48
   `trialParams` with their `duty` bytes. Record the video's frame count vs 48 × 20 s × fps.

Known gaps to record: whether the panels honor `duty` per trial visibly (25 % vs 100 % brightness
step), whether ufmf frame timestamps line up with the `getTimestamp` replies, and the direction
result from step 2.

## 6. Student mistakes (2 minutes)

- A second `pixi run rig` while the first runs → one clear `[rig] cannot start, ports already bound`
  line (no traceback).
- `pixi run rig` while bridge 3.4 holds :8765 → the same line naming bridge 3.4.
- Stop the rig with Ctrl-C in terminal A: every child exits, and the LAST run's bag gets its
  `metadata.yaml` (the bridge closes the bag on shutdown). Record if any process lingers
  (`tasklist | findstr /i "rmw_zenohd python"`).

## 7. If the `typed` environment installed (step 1b)

Repeat step 3 and step 5 with `-e typed` (`pixi run -e typed test -- --keep`, `pixi run -e typed rig …`).
Expected differences: `typed=True` in the bridge banner, `/fictrac/frame` + `/arena/frame` as
`rig_interfaces/msg/…` in `ros2 bag info`, the harness line `info  typed topics: True`.

## 7b. Typed messages on a PC WITHOUT Visual Studio (~10 minutes)

> 2026-10-26: `typed-prebuilt` IS `typed` now (the channel package from reiserlab/rig-nodes); read `typed` for every `typed-prebuilt` below, `pixi run -e typed check-typed` for the `--check` line. Kept as the ww18 record.

The no-compiler route (`docs/typed-windows.md` §5): the `typed-prebuilt` environment downloads an
`rig_interfaces` built once on ww18 (`channel/`, read from raw.githubusercontent.com) instead of
building it. Run it on a PC with **no** Visual Studio / Build Tools; that is the point. Any checkout
path works (nothing is compiled). PowerShell, in `rig`:

```powershell
git fetch; git switch claude/ros-studio-plan-b-c44942; git pull
Measure-Command { pixi install --locked -e typed-prebuilt | Out-Default }
pixi run -e typed-prebuilt python nodes\build_interfaces.py --check
pixi run -e typed-prebuilt test
```

Expected: install ~5 s on ww18 with a warm package cache (a fresh PC first downloads the ROS
packages, as in step 1a), no
`failed to build` and no compiler message. In a fresh checkout pixi also starts the ROS build backend
once (a ~15 MB download from prefix.dev) to read the `typed` environment's package metadata
from the lock. That is not a build; nothing compiles. `--check` prints `"importable": true` and
`"serializes": true`; the harness passes every check (49 / 49 on ww18, 2026-10-16) with `info  typed topics: True`.
If step 5's hardware is attached, `pixi run -e typed-prebuilt rig …` runs the rig with typed topics.
Record: the PC's Windows version, "no Visual Studio" confirmed (`winget list Microsoft.VisualStudio`
prints nothing), the install time, and the first error verbatim if anything fails.

## 8. Optional: shared-memory and MCAP benchmarks (no hardware, ~7 minutes)

Never during an experiment (it loads the CPU). Commands, what to check and the ww18 reference
numbers: `docs/shm-bench.md`.

## What to send back

The timings and sizes from step 1, the `$PIXI_PROJECT_ROOT` answer, the harness artifact folder,
the exported `.jsonl` + the bag directory + the shadow `.jsonl` of the Studio run, the video file
name(s), the Chrome version and prompt note, and every verbatim error.
