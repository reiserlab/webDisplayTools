# ROS 2 PoC: Windows rig test (LAB-303)

The one acceptance item still open after the Mac run (see `README.md` → "Mac results") is
**Windows**, where most rig PCs live. This is a step-by-step for one session on a rig PC with a
G6 controller, BIAS (the Windows `bias_gui.exe` with a FLIR camera) and, if present, FicTrac.
Budget: about an hour. **A failure with its verbatim error text is as valuable as a pass**: copy
the text before trying anything to fix it.

Nothing here touches bridge 3.4 or the Studio. `ros2-poc/` is its own pixi workspace.

## 0. Before starting

- Repo: `reiserlab/webDisplayTools`, branch `claude/ecstatic-noether-art3qx` (draft PR #252).
  `git fetch && git switch claude/ecstatic-noether-art3qx`.
- Stop bridge 3.4 if it is running (the terminal with `pixi run bridge`): the PoC binds the same
  ports. FicTrac itself may keep running; it only *sends* to UDP 60000.
- `pixi --version` (anything recent). PowerShell, not Git Bash, for the `Measure-Command` timing.
- Chrome version (Settings → About). Note it; LAB-304's local-network-access prompt is Chrome-version dependent.
- Ports must be free: `netstat -ano | findstr ":7447 :8765 :60000 :60001 :5010"` prints nothing except BIAS on 5010.

## 1. Install (timed)

```powershell
cd ros2-poc
Measure-Command { pixi install --locked | Out-Default }
```

Record the wall time and whether anything had to be done by hand. Then the one Windows-only
check the README flags: does pixi expand `$PIXI_PROJECT_ROOT` in `[activation.env]`?

```powershell
pixi run python -c "import os; print(os.environ['ZENOH_ROUTER_CONFIG_URI'])"
```

Expected: a real path ending in `ros2-poc\config\zenoh-router.json5`. If it prints the literal
`$PIXI_PROJECT_ROOT/...`, the individual `router` / `*-adapter` tasks will use the stock IPv6
config (or fail); `pixi run rig` is unaffected because `rig.py` sets both paths itself.
**Write down which of the two you saw.**

## 2. Middleware (three terminals)

```powershell
pixi run router       # terminal 1: expect "Zenoh can be reached at: tcp/127.0.0.1:7447"
pixi run listener     # terminal 2
pixi run talker       # terminal 3
```

Pass: every `Publishing: "Hello World: N"` has a matching `I heard` within a few ms. Ctrl-C all
three (Ctrl-C in the talker/listener prints an `rcl_shutdown already called` traceback on macOS
too; that is the stock demo nodes, not a failure). Note whether the router keeps running after
Ctrl-C (`tasklist | findstr rmw_zenohd`); on POSIX `ros2 run` does not forward the signal and
`rig.py` works around it with process groups.

## 3. Acceptance harness

```powershell
pixi run test -- --keep
```

Expected: `29 / 29 checks passed` in about 30 s and a line `artifacts kept in …`. Keep that
directory (it has `summary.md`, the exported log and `proc-logs\`). Windows-specific things it
exercises for the first time: child processes in their own group (`CREATE_NEW_PROCESS_GROUP`),
`CTRL_BREAK_EVENT` as the stop signal, `TerminateProcess` for the mid-run adapter kill, and
console encoding (`PYTHONUTF8=1` from the workspace). If it fails, send `summary.md` plus the
whole `proc-logs\` folder.

## 4. The rig with the unmodified Studio and the controller

```powershell
pixi run rig -- --sim --sim-args "--model fly --kp 2 --seed 1"
```

Expected: `[rig] up: router, fictrac, bridge, sim — Studio → ws://localhost:8765`. Then in Chrome:
<https://reiserlab.github.io/webDisplayTools/arena_studio.html>

1. Run view → **Bridge: Connect**. Expect `connected · rx N`, the scope scrolling, and note whether
   Chrome shows a **local-network-access prompt** (none appeared on the Mac, Chrome 155).
2. **Connect** (top right) → pick the controller in the serial-port picker.
3. Open a Mode-3 closed-loop protocol with a constant bias (`fictrac_bias_test.yaml` from the
   site library). **Check the pattern first:** Console → SD listing must show the protocol's
   pattern *by name* with more than one frame. On the Mac bench card slot 4 held a 1-frame test
   pattern, so the display sat on frame 0 until the protocol was re-pointed at a 20-frame
   grating. If the card differs, edit the pattern name / `pattern_ID` in Edit view to a rotating
   pattern that is on the card (any frame count > 1 works; the report checks the mapping, not
   the pattern).
4. Fill experimenter / genotype / age / sex / fly #, **Run experiment**, let it finish, let it
   auto-commit (bench id and token must be set as for any course run).
5. Fetch the committed `.jsonl.gz` from `runlogs/<bench>/` in the course repo and run both
   readers from `ros2-poc` (the scripts are stdlib Python, the workspace Python is fine):

```powershell
pixi run python ..\scripts\closed-loop-report.py <file>.jsonl.gz
pixi run python ..\scripts\runlog-check.py <file>.jsonl.gz
```

Pass: three epochs, idx mismatch 0.00 % (≤ 1 boundary row), `runlog-check` prints `OK` with the
firmware line. Also compare with the bridge node's own file in `ros2-poc\runlogs\` (gunzip the
committed one; they were byte-identical on the Mac).

If the rig has **real FicTrac**: repeat step 4 once without `--sim` with FicTrac running and a
ball; the adapter log should show its line rate.

## 5. Real BIAS on Windows

BIAS must have its external-control HTTP server on. In the camera window: the server menu
(port shows as `Port (5010)...` for camera 0); enable it. Check from PowerShell:

```powershell
curl.exe "http://127.0.0.1:5010/?get-status"
```

Expected: `[ { "command" : "get-status", "success" : true, "value" : { "capturing" : …, "connected" : …, "frameCount" : …, "framesPerSec" : …, "logging" : …, "timeStamp" : … } } ]`
(the Mac port's shape; note any extra or missing key). Then, with the rig from step 4 still up,
in a new terminal:

```powershell
pixi run bias-node -- --host 127.0.0.1 --port 5010
```

and in another, **using an absolute path** for the video (on the Mac a relative name resolved
against BIAS's own working directory and capture silently never started; the node now warns):

```powershell
pixi run bias-cmd -- connect --json
pixi run bias-cmd -- startRecording --filename C:\Users\<rig>\Videos\poc.avi --json
curl.exe "http://127.0.0.1:5010/?get-status"        # capturing true, frameCount rising
pixi run bias-cmd -- getTimestamp --json
pixi run bias-cmd -- stopRecording --json
dir C:\Users\<rig>\Videos\
```

Record: every reply (`--json` prints it), the `value` of `get-video-file` versus the file(s)
actually written (the Mac port wrote `<stem>_cam_0_date_…_v001\movie.mjpg` and a
`stamp_log_cam0.txt`; the Windows BIAS with Spinnaker may write the `.avi` it was asked for),
`start-capture` round-trip in ms, and whether the camera preview went live.

**Unknown-outcome path** (the LAB-303 semantics): start a recording, then close BIAS while the
node polls. Expect `/bias/status` lines with `reachable:false`, and a `bias-cmd -- getTimestamp`
to come back `outcome: "unknown"` or `error` (exit code 3 or 1), never a hang. Restart BIAS:
status must flip back to `reachable:true` without restarting the node.

If a Studio run is in progress while you do this, the status and reply lines land in that run's
committed log as `{"type":"connector","src":"bias",…}` events (60 status + 3 replies on the Mac).

## 6. Kinefly

No Windows build of the fork exists; `pixi run kinefly-sim` exercises the adapter path
(`pixi run rig -- --kinefly` first). Expected: `N KF/1 frames published, 0 rejected` in the
adapter log. Skip if short on time; the Mac covered the real fork.

## 7. Shutdown and student mistakes

- Ctrl-C the rig terminal. Expected: children stop in reverse order, `[rig] stopped`, **no
  Python traceback, no orphan `rmw_zenohd.exe`** (`tasklist | findstr rmw_zenohd`).
- Start `pixi run rig` twice: the second must exit with code 2 and name the ports in one line.
- Start `pixi run rig` while bridge 3.4 holds :8765 / :60000: same one-line refusal naming 3.4.

## What to send back

- Step 1 wall time, the `$PIXI_PROJECT_ROOT` result, `pixi info` output.
- Step 3: `summary.md` (and `proc-logs\` on any failure).
- Step 4: the committed run file name, both reader outputs, whether the Chrome prompt appeared.
- Step 5: the `--json` replies, the `get-status` body, what BIAS wrote on disk, the unknown-path behavior.
- Step 7: pass/fail per line.
- Any error text, verbatim, with the step number. Small fixes can go straight onto the PR branch.

## Plan B additions (2026-10-14 evening) — what changed for this test

`pixi install` now also **builds `interfaces/arena_interfaces`** (three `.msg` types) through
pixi's preview build feature with the RoboStack `pixi-build-ros` backend. On Windows that build
needs **Visual Studio 2022 Build Tools (C++ workload)** on the PC; pixi cannot install them.
Record, verbatim: (a) whether `pixi install --locked` succeeds without them, how long it took, and
the first error if not; (b) with them installed, the same. If the build cannot be made to work in
30 minutes, run the graph with the String fallback instead:

```powershell
# in ros2-poc\pixi.toml, comment out the line   arena_interfaces = { path = "interfaces/arena_interfaces" }
pixi install
pixi run rig -- --bridge-args "--typed off" --fictrac-args "--typed off"
```

The bridge node now records every run into `runlogs\<run>.bag\` (MCAP) and `log_export` returns the
log **converted from the bag**; the live NDJSON stays beside it as a shadow. After a Studio run:

```powershell
pixi run convert -- runlogs\<run>.bag --out converted.jsonl        # must equal the shadow .jsonl apart from kf/BIAS line timing
pixi run test                                                       # 46 checks incl. the SIGKILL crash phase
```

Record `pixi run test`'s summary table, the `[test] crash (...)` lines, and the bag size vs the
`.jsonl` size.
