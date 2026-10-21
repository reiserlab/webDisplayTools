# Handover: okey-cokey rig, BIAS test + Foxglove dashboard (2026-10-21)

For a Claude Code session running **on the okey-cokey lab PC** (Windows; the room with the G6 2×10
four-color arena, an overhead BIAS camera, freely walking flies, no FicTrac). Michael's Mac has no
remote path into the rig PCs, so start the session there: open Claude Code in a checkout of
`reiserlab/webDisplayTools` and paste the kickoff prompt below as the first message.

There are two jobs, in this order:

1. **Test** today's protocol and BIAS on this PC: [`okey-cokey-pc-2026-10-21.md`](okey-cokey-pc-2026-10-21.md).
2. **Implement and test** the dashboard, phase 1 then 1b then 2:
   [`docs/okey-cokey-foxglove-dashboard-plan.md`](docs/okey-cokey-foxglove-dashboard-plan.md).

## Kickoff prompt (paste on the lab PC)

```
Okey-cokey rig work, LAB-303. Read ros2-poc/HANDOVER-okey-cokey-2026-10-21.md first and follow it.
Branch: git fetch && git switch claude/okey-cokey-pairs (clone to a short path such as C:\w if this
PC has no checkout yet; install pixi if missing, asking me before any admin/UAC step).
Job 1: run ros2-poc/okey-cokey-pc-2026-10-21.md in order, keeping
ros2-poc/okey-cokey-pc-results-2026-10-21.md as you go (one row per step: pass/fail, timings,
sizes, every error verbatim). Stop and ask me (Michael) before anything that needs a click: the
BIAS GUI, the Chrome serial-port picker, the IR backlight, or putting flies in.
Job 2: on a new branch claude/okey-cokey-dashboard cut from claude/okey-cokey-pairs, implement
ros2-poc/docs/okey-cokey-foxglove-dashboard-plan.md phases 1, 1b, 2 in that order, each tested
(harness first, then on this rig) and committed separately. Rules are in the handover's
"Constraints" section. Push both branches when done; open no PR.
```

## Where things stand

- **Branch `claude/okey-cokey-pairs`** = release candidate 2026-10-20 rc1 (Studio v0.97, the ROS 2
  graph, the BIAS connector; on Next) plus three commits:
  - `protocols/g6_color_optomotor_test.yaml` + `_smoke.yaml` now use **Grace's trial shape
    (2026-10-21)**: each trial is a CW/CCW pair, 15 s CW then 15 s CCW with no gap, then 10 s dark (also
    across block boundaries). The full run is 24 pairs, 16.1 min; the smoke run is 4 pairs, 10 s per
    direction, 5 s dark, 1.7 min. Parsed and flattened with the real modules (no blocking errors, no
    warnings); `pixi run test -- protocol` 106/106.
  - The run sheet and the dashboard plan (linked above).
- **Not on any Pages tier**: Next serves the candidate *without* the new protocol shape. Serve this
  checkout locally (`python .claude\nocache-server.py 8092`) or open the YAML via Protocol ▾ → Open….
- **Background reading for job 1**: the ww18 results, `windows-results-ww18-2026-10-15.md` (every
  Windows finding is in its table; most are fixed on this branch). For job 2: the plan's "What exists
  today" table, which has file:line refs.
- **Not settled yet; the defaults below apply unless Michael says otherwise**:
  1. Live camera in Foxglove: **no** for now (no phase 3; the BIAS window sits beside Foxglove). Replay
     camera (phase 2): yes.
  2. Controller telemetry: check it in job 1. Look for the firmware line at Connect and whether the
     Studio starts the telemetry poller (GET_FIRMWARE_VERSION flag bit 2). Record the answer; phase 1
     must work either way, falling back to expected display only, with health = command status.
  3. BIAS build: record which one in job 1 (the Atlas10 fork reports drop counters, the Spinnaker
     build may not). Missing keys mean "not reported", never 0.

## Job 2: implementation notes

Build in this order; each phase ends green before the next starts.

**Phase 1** (plan §A, §B without color, §C, §E):
- `nodes/bridge_node.py`: also *publish* `/arena/browser` (String, reliable, depth 50), the same record
  it already writes to the bag. Keep the bag write exactly as it is.
- `nodes/stimulus_core.py` (pure, no rclpy): stimulus state from `/arena/browser` records (runner
  status events + trialParams `a` echoes + `cf` telemetry rows); expected index for Mode 2
  `(init + round(fps·(t − t_start))) mod n`; observed index, display rate and lag from `cf` rows;
  diagnostic level. Read the row/event formats from `docs/development/telemetry-logging-reference.md`
  (the format authority) and `js/arena-telemetry.js`'s header comment (the `cf` schema). Remember that
  `cf` rows are 8 or 11 elements long.
- `nodes/stimulus_node.py`: a thin rclpy wrapper; `--pattern-dir`; publishes the topics in the plan's
  table; `/arena/display` as `foxglove.CompressedImage` PNG reusing `tools/patfile.py` and the rendering
  in `tools/tiff_run_to_mcap.py` (`display_png`), moved into a shared helper rather than copied.
- `nodes/viz_node.py`: feed the `arena` diagnostic from the new topics; add the BIAS
  `fps_from_count` / `drops` / `rtt_ms` topics.
- `nodes/rig.py`: `--stimulus` (and include it with `--foxglove`), passing `--pattern-dir`.
- `foxglove/arena-okey-cokey.json`: the layout in plan §E (the camera panel can stay empty until
  phase 2).
- Tests: extend `tests/test_ros2_poc.py` / `tests/test_viz_node.py`. `tests/studio_emulator.py` already
  drives runs: make it send a Mode-2 trialParams + a stream of `cf` rows and assert expected vs
  observed index, the rate (≈ |fps|) and the diagnostic levels (including the no-telemetry
  fallback). Put unit tests for `stimulus_core` beside it.
- On the rig: `pixi run rig -- --bias --foxglove --stimulus …`, Foxglove (desktop app) →
  `ws://localhost:8766` → import the layout; run the smoke protocol. Pass if the expected display
  turns, reverses with no gap, goes dark in the pauses, and shows the condition name; the arena rate
  reads ≈ 80 Hz during rotation and 0 in the dark (with telemetry); the BIAS fps and indicators are
  live. Take a screenshot for the results file.

**Phase 1b**: a Python port of the minimum of `js/panel-color.js` (layout table, `bankAt(row, col) =
2·((row+1)%2)+(col%2)` in host coordinates, the four-color layout), and a test that runs the JS module
under the root pixi Node and compares bank assignments cell by cell, so the two copies can't drift.
Duty scales the brightness. Pass: each of the four patterns renders in its own color, top row only.

**Phase 2** (plan §D replay, §F): extend `nodes/foxglove_json.py` to replay `stimulus_core` over a bag's
`/arena/browser` records. Add `tools/ufmf_to_mcap.py`: read the run's `.ufmf` (write a small reader;
test it on a real recording from this PC) and write a sidecar MCAP with `/camera/image` JPEG timed by
the bag's `/bias/frames` stamps, downsampled (default 10 Hz, half resolution, both flags). Pass: today's
smoke run opens in Foxglove with the camera, the expected display and health in sync. Spot-check sync
on the reversal: the fly's turning should flip within a few hundred ms of the display's.

## Constraints

- **Never touch Production or Next**, never merge to `main`, open no PR. Code reaches `main` only
  through a release candidate, which Michael builds (`docs/development/release-process.md`).
- **No Studio changes** (`arena_studio.html`, `js/*`) and **no bridge 3.4 changes**
  (`fictrac-bridge/bridge.py`). Everything lives in `ros2-poc/`. If a Studio change turns out to be
  needed, stop and write it up instead.
- Tests: `pixi run test` and `pixi run test-viz` inside `ros2-poc/`, plus `pixi run test` at the repo
  root, all green before every commit. Prettier only on `*.js`, never on HTML.
- Windows habits from ww18: write text with `newline="\n"`; take durations from `perf_counter`; never
  run `bias_sim` or the harness's sim while the real BIAS is open on 5010; Ctrl-C the rig to stop it
  (the SIGBREAK handler closes the bag cleanly).
- Capture an error's full text before you try to fix it. Commit small fixes found in job 1 to
  `claude/okey-cokey-pairs` with a message that names the step.
- American English in code, docs and commits.

## What to send back

The results file for job 1; per phase: what was built, test counts, the rig screenshot, and anything
that needed a manual step or went against the plan. Push `claude/okey-cokey-pairs` and
`claude/okey-cokey-dashboard`, and end with a short summary Michael can paste into the LAB-303 ticket.
