# Handover: okey-cokey rig, BIAS test + Foxglove dashboard (2026-10-21)

For a Claude Code session running **on the okey-cokey lab PC** (Windows; the room with the G6 2×10
four-color arena, an overhead BIAS camera, freely walking flies, no FicTrac). Michael's Mac has no
remote path into the rig PCs, so start the session there: open Claude Code in any folder (the
checkout does not exist yet) and paste the kickoff prompt below as the first message.

**This PC starts bare** (no Foxglove, no webDisplayTools checkout, maybe no git or pixi). Setup is
its own checklist, [`okey-cokey-pc-setup.md`](okey-cokey-pc-setup.md), done first. Claude Code
cannot install itself: a person installs the Claude desktop app (or Git for Windows, then the CLI)
over Remote Desktop; from there a Claude session can do most of the checklist and asks for the rest.
Without Claude on the PC, the checklist and the run sheet work by hand too.

Then two jobs, in this order, both on ONE run sheet:
[`okey-cokey-pc-2026-10-21.md`](okey-cokey-pc-2026-10-21.md).

1. **Test** today's protocol and BIAS on this PC.
2. **Test the camera + G6 Foxglove dashboard** on the real rig, live and on the run's replay. It was
   BUILT and tested off-rig on Michael's Mac the same day
   ([`docs/okey-cokey-foxglove-dashboard-plan.md`](docs/okey-cokey-foxglove-dashboard-plan.md), the
   status block at the top); nothing of it has met this rig, its camera or a real `.ufmf` from it.

## Kickoff prompt (paste on the lab PC)

```
Okey-cokey rig work, LAB-303. This PC may be bare (no webDisplayTools checkout, no Foxglove, maybe
no git or pixi). Start with the setup checklist; read it on GitHub until the repo is cloned:
https://github.com/reiserlab/webDisplayTools/blob/claude/okey-cokey-rig/rig/okey-cokey-pc-setup.md
It clones the repo to C:\w on branch claude/okey-cokey-rig. Then read
C:\w\rig\HANDOVER-okey-cokey-2026-10-21.md and run C:\w\rig\okey-cokey-pc-2026-10-21.md
in order, keeping C:\w\rig\okey-cokey-pc-results-2026-10-21.md as you go (one row per step:
pass/fail, timings, sizes, every error verbatim; the setup facts first).
Ask me (Michael) before every download or install, any admin/UAC step, and anything that needs a
click: the BIAS GUI, the Chrome serial-port picker, the IR backlight, Foxglove, putting flies in.
If BIAS is not on this PC, stop and tell me. Rules are in the handover's "Constraints" section.
Commit fixes and the results file to claude/okey-cokey-rig and push; open no PR.
```

## Where things stand

- **Branch `claude/okey-cokey-rig`** = release candidate 2026-10-20 rc1 (Studio v0.97, the ROS 2
  graph, the BIAS connector; on Next) plus:
  - `claude/okey-cokey-pairs`: `protocols/g6_color_optomotor_test.yaml` + `_smoke.yaml` in **Grace's
    trial shape (2026-10-21)** — each trial a CW/CCW pair, 15 s CW then 15 s CCW with no gap, then 10 s
    dark (also across block boundaries). Full run 24 pairs, 16.1 min; smoke 4 pairs (10 s per
    direction, 5 s dark), 1.7 min. Parsed and flattened with the real modules; `pixi run test --
    protocol` 106/106.
  - the dashboard (plan doc status block): `nodes/stimulus_node.py` + `stimulus_core.py` +
    `arena_display.py` (expected/observed display in the four-color LEDs, arena rate/lag/health from
    controller telemetry), BIAS rate/drops in `viz_node.py`, `rig.py --no-fictrac --stimulus`, the
    replay (`fox-json --stimulus`, `tools/ufmf.py`), `foxglove/arena-okey-cokey.json`. Mac: 54/54 +
    10/10 + harness 54/54.
- **Not on any Pages tier**: Next serves the candidate *without* the new protocol shape. Serve this
  checkout locally (`pixi run python .claude\nocache-server.py 8092` from `C:\w`) or open the YAML via Protocol ▾ → Open….
- **Background reading**: the ww18 results, `windows-results-ww18-2026-10-15.md` (every Windows finding
  is in its table; most are fixed on this branch).
- **Settled**: the okey-cokey controller runs telemetry firmware; BIAS is NOT changed now (no live
  camera in Foxglove — the BIAS window sits beside it; the replay has the camera).
- **Record in job 1**: which BIAS build (the Atlas10 fork reports drop counters, the Spinnaker build
  may not: those panels then read "no data", never 0).

## What could go wrong on this rig (look here first)

- **Windows paths and the pattern/protocol lookup**: the stimulus node finds `<pattern>.pat` under
  the repo's `protocols/` + `patterns/` and the run's protocol by its `protocol_filename` under
  `protocols/`. A protocol opened from elsewhere (Downloads) still runs, but its patterns' NAMES may
  not resolve → a gray hatched placeholder and "pattern N" in the health line. Fix with
  `--stimulus-args "--protocol-dir <dir> --pattern-dir <dir>"`, not code.
- **The camera's clock**: the replay places camera frames with the run's `getTimestamp` replies.
  `camera.offset_ms` in the converter's report should be stable; if `camera.error` says no reply
  had a value > 0, the protocol's first getTimestamp came too early (BIAS reads 0 before its first
  frame).
- **uFMF from this camera**: the reader follows BIAS's writer (v4, MONO8, index or scan). A different
  coding (e.g. RGB) is refused with a clear error: record it.
- **foxglove_bridge on Windows**: never run on Windows yet (ww18 did not install `viz`). If it fails
  to start, the rig prints it and the rest runs; record the error verbatim.
- **Load**: the stimulus node renders 800×160 PNGs at 15 Hz (a few ms each on the Mac). If the
  bridge's latency numbers (`connector_status`) get worse with it on, record both.

## Constraints

- **Never touch Production or Next**, never merge to `main`, open no PR. Code reaches `main` only
  through a release candidate, which Michael builds (`docs/development/release-process.md`).
- **No Studio changes** (`arena_studio.html`, `js/*`), **no bridge 3.4 changes**
  (`fictrac-bridge/bridge.py`), **no BIAS changes**. Everything lives in `rig/`. If a Studio
  change turns out to be needed, stop and write it up instead.
- Tests: `pixi run test`, `pixi run test-viz`, `pixi run test-stimulus` and `pixi run test-stimulus-live`
  inside `rig/` (the last needs the rig stopped), plus `pixi run test` at the repo root, all green
  before every commit. Prettier only on `*.js`, never on HTML.
- Windows habits from ww18: write text with `newline="\n"`; take durations from `perf_counter`; never
  run `bias_sim` or the harness's sim while the real BIAS is open on 5010; Ctrl-C the rig to stop it
  (the SIGBREAK handler closes the bag cleanly).
- Capture an error's full text before you try to fix it. Commit small fixes to
  `claude/okey-cokey-rig` with a message that names the step.
- American English in code, docs and commits.

## What to send back

The results file (both jobs): the PC facts, BIAS build, both runs' checks, the two test counts on
Windows, a screenshot of the live dashboard mid-rotation, the replay converter's printed report,
and anything that needed a manual step. Push `claude/okey-cokey-rig`, and end with a short
summary Michael can paste into the LAB-303 ticket.
