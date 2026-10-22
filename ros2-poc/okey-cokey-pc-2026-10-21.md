# Okey-cokey rig PC — BIAS + G6 color optomotor test, 2026-10-21

The run sheet for today's test on the new lab PC in the okey-cokey room (freely walking flies, overhead
BIAS camera, G6 2×10 four-color arena, **no FicTrac**). It is `WINDOWS-TEST.md` cut down to what this
rig needs, with the ww18 findings of 2026-10-15 (`windows-results-ww18-2026-10-15.md`) applied up front.
Record results in a sibling `okey-cokey-pc-results-2026-10-21.md` in the same shape as the ww18 file.

Branch: `claude/okey-cokey-dashboard` = the 2026-10-20 release candidate (Studio v0.97, ROS 2 graph,
BIAS connector) + the CW/CCW-pair protocols Grace asked for (`claude/okey-cokey-pairs`) + the camera +
G6 Foxglove dashboard (`docs/okey-cokey-foxglove-dashboard-plan.md`). Neither is on a Pages tier, so
serve the checkout locally (step 4).

## 0. Setup (bare PC → ready)

Do [`okey-cokey-pc-setup.md`](okey-cokey-pc-setup.md) first: PC access, git / pixi / Chrome /
Foxglove, BIAS + camera SDK, the controller, the clone at `C:\w` on `claude/okey-cokey-dashboard`,
the three `pixi install`s, both dashboard tests and a no-flies smoke of the whole stack. The steps
below assume it is done.

- [ ] IR backlight on by hand (Arduino). The web runner does not drive the backlight yet.

## 1. BIAS itself (10 min)

- [ ] **Which BIAS build?** FLIR/Spinnaker build or the atlas-bench Atlas10 fork (ww18 ran the fork).
      Note the exe path and camera model.
- [ ] External-control server on, port **5010** for camera 0:
      `curl.exe "http://127.0.0.1:5010/?get-status"` returns `"success" : true`. Note any extra keys.
- [ ] Logging format = **ufmf** in BIAS's own settings (BIAS writes its configured format whatever
      extension it is sent; ww18 B1). BIAS v0.73.1 (Spinnaker) resets to jpg on **every** restart (ww14),
      so after each BIAS start run
      `powershell -ExecutionPolicy Bypass -File tools\bias-ufmf.ps1 -VideoDir <video dir>`.
      It must print `BIAS logging: ufmf -> …` (details: setup checklist C.3).
- [ ] Choose and create the **video directory**, e.g. `D:\rec\okey-cokey`. Use plain file names with
      no dots or spaces (BIAS cuts the name at the first dot; ww18 B1).
- [ ] Camera preview live, frame rate as expected (note `framesPerSec`).
- [ ] Never run `bias_sim` or the harness while the real BIAS is open: on Windows both can hold 5010 and
      loopback clients reach the sim (ww18 W8; the sim now refuses, but don't test it).

## 2. BIAS through the node (5 min)

Two terminals in `ros2-poc`:

```powershell
pixi run router
pixi run bias-node -- --host 127.0.0.1 --port 5010 --video-dir D:\rec\okey-cokey
```

Third terminal:

```powershell
pixi run bias-cmd -- connect --json
pixi run bias-cmd -- startRecording --filename nodecheck.ufmf --json
pixi run bias-cmd -- getTimestamp --json          # wait ≥ 0.5 s after start: the clock reads 0 before the first frame
pixi run bias-cmd -- stopRecording --json         # expect resolved file + bytes + frame-stamp count
dir D:\rec\okey-cokey
```

- [ ] Every reply `"outcome": "ok"` (connect can take ~2.2 s on Atlas10; the node allows 15 s).
- [ ] `stopRecording` names the file BIAS really wrote (`…_cam_0_date_…_v001.ufmf`) and its frame count
      = the lines in `stamp_log_cam0.txt`.
- [ ] Unknown path: start a recording, close BIAS, `getTimestamp` returns `unknown` / `error` within
      seconds, no hang; reopen BIAS and the node's status flips back to reachable. (ww14: `unknown` after
      4.0 s.) **Then rerun `tools\bias-ufmf.ps1`**: the reopened BIAS is back on jpg.

If the rig (step 3) is already running, its own BIAS node answers `bias-cmd` the same way. ww14 ran
this step that way, with no separate router or node.

Stop the node and the router (Ctrl-C).

## 3. The graph, no FicTrac, with the dashboard (2 min)

Once: `pixi install -e viz` (foxglove_bridge, ~0.3 GB) and the Foxglove desktop app.

```powershell
pixi run rig -- --no-fictrac --bias --bias-args "--video-dir D:\rec\okey-cokey" --foxglove --viz-args "--sources bias" --stimulus-args "--panel-layout four-color"
```

Expected: `[rig] up: router, bias, bridge, stimulus, viz, foxglove — Studio → ws://localhost:8765
Foxglove → ws://localhost:8766`. In Foxglove: Open connection → Foxglove WebSocket →
`ws://localhost:8766`; Layout → Import from file → `ros2-poc\foxglove\arena-okey-cokey.json`.
**8766, not 8765.** 8765 is the Studio bridge: Foxglove connects there, drops at once, and shows
nothing. Before a run: BIAS indicator green, camera fps plotted, "Arena" grey/OK. (Without the viz env, drop
`--foxglove` and add `--stimulus`: the graph runs, there is just nothing to look at.)

## 4. Studio, served from this checkout

```powershell
cd C:\w
pixi run python .claude\nocache-server.py 8092   # the root env's Python
```

Chrome: `http://localhost:8092/arena_studio.html?p=g6_color_optomotor_smoke&rig=cshl_g6_2x10&mode=run`
(use this arena's own rig key from `configs\rigs\index.json` if it has one). Fallback if the local
server is a problem: the Next tier (`/next/arena_studio.html`, same Studio v0.97) plus
Protocol ▾ → Open… on `C:\w\protocols\g6_color_optomotor_smoke.yaml`.

- [ ] Run view → **Bridge: Connect** → `connected`. Note any Chrome local-network prompt.
- [ ] **Connect** → the controller. Firmware line in the log; note the build label. The 2×10 controller
      must run the `arena-2x10-local` build (a `main` build rejects 2×10 patterns).
- [ ] SD card mounted (Console shows a listing; ww18 H1 had an unmounted card). Upload
      `protocols\g6_color_optomotor_test_patterns\` (Patterns → Add ▾); the four
      `G6_2x10_toprow_grat20_*` names show 20 frames.
- [ ] **Direction**, once: Console → Test `green_pair_d100`. The first 10 s must turn clockwise seen
      from above, then reverse with no gap. If reversed, swap `fps_cw` / `fps_ccw` in Edit view and
      record it.
      **Okey-cokey rig: done, no test needed.** On 2026-10-22 (ww14) the arena turned out to be
      **mounted upside down**. Confirmed by eye in the smoke run: every trial the protocol calls CW
      (`fps_cw` = +80) turns **counter-clockwise seen from above**, and "CCW" turns clockwise. This
      was accepted as is, so the protocols are **not** changed. When analysing okey-cokey data,
      treat the protocol's CW/CCW labels as reversed relative to the fly's view from above.
      (The Console "Test `green_pair_d100`" entry also wasn't found on ww14; the smoke run's first
      pair shows the same thing.)

## 5. Smoke run (2 min), then the full run (16 min)

- [ ] Experimenter + genotype filled, **Run experiment** on `g6_color_optomotor_smoke`: 4 pairs at duty
      100 % (10 s CW → 10 s CCW, 5 s dark), camera connect / startRecording / getTimestamp /
      stopRecording all `ok` in the step strip.
- [ ] Watch: top row only, one color per pair, no dark gap at the CW→CCW reversal, bottom row dark.
- [ ] **Dashboard, live:** the EXPECTED display turns with the arena in the right color and reverses
      with no gap; OBSERVED follows within ~0.1 s; "Arena frame index" shows the two traces on top of
      each other; lag stays 0; arena rate reads 80 Hz in a rotation and 0 in the pauses; the arena
      health line names the pattern; condition / arena / BIAS state bars step with the protocol.
      Record any WARN/ERROR text verbatim (`/viz/arena/health`) and a screenshot.
- [ ] Then `?p=g6_color_optomotor_test` (Grace's shape): 24 pairs of 15 s CW + 15 s CCW, 10 s dark
      between pairs and across blocks, duty 25 → 50 → 100 %. Is the 25 % vs 100 % step visible?

## 6. Collect and judge

```powershell
cd C:\w\ros2-poc
pixi run export                                       # unless the Studio auto-committed
pixi run python ..\scripts\runlog-check.py runlogs\exports\<file>.jsonl
pixi run ros2 bag info runlogs\<run>.bag
```

`runlog-check` can report a run "incomplete" with trials `unknown (coverage)`, `ring_overrun`, whose
patterns and durations don't match the protocol. Those are controller activity from **before** the run,
such as Console tests while nothing drained the telemetry ring (ww14 smoke #1: 4 such trials, while all
8 run rotations passed). Judge the run by its own trials, or run it again straight after Connect
(ww14 smoke #2: OK, 8 / 8 pass, 0 unknown).

- [ ] `runlog-check` OK (smoke: 4 conditions × 2 trialParams; full: 24 × 2 = 48 trialParams).
- [ ] `/bias/reply`: smoke 1 + 4 + 1 `getTimestamp` (start, each pair, stop); full 1 + 24 + 1.
- [ ] `/bias/frames` count = the stamp log's lines; video length ≈ run length × camera fps
      (full ≈ 965 s × fps).
- [ ] **Dashboard, replay:** `pixi run fox-json -- runlogs\<run>.bag runlogs\<run>.foxglove.mcap --stimulus --panel-layout four-color`
      (finds the `.ufmf` through the run's stopRecording reply; `--ufmf <file>` otherwise). The JSON
      it prints has a `dashboard` block: `camera.images`, `camera.offset_ms`, `stimulus_messages`. Open
      the `.foxglove.mcap` in Foxglove with the same layout: camera, expected and observed display in
      sync; check one reversal (the fly's turning should flip within a few hundred ms of the display).
- [ ] Copy the bag, the export, the `.foxglove.mcap` and the `.ufmf` somewhere Michael can reach (group share).

## What to send back

The PC facts (step 0), the BIAS build and status keys, every non-ok reply verbatim, the direction
result, the two runs' `runlog-check` output, frame counts vs expected, and anything that needed a
manual step.
