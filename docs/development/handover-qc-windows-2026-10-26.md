# QC handover: three Windows lab PCs, evening of 2026-10-26

Michael remotes into each PC and pastes the matching prompt into a fresh Claude Code session opened
in that PC's webDisplayTools checkout (on ww18: `C:\Lab\GitHub\webDisplayTools`). Every test runs
**between experiments**. One ROS graph per PC at a time: never run two harnesses or two `pixi run rig`
in different folders on the same machine, Zenoh discovery crosses them.

What is being tested and why:

| PC | Target | Needs the arena? |
|---|---|---|
| ww18 (rig5-mr, G6 2×10, real FicTrac) | **PR #274** (branch `feat/rig-nodes-extraction`): `rig/` installs the shared package set from the new `reiserlab/rig-nodes` channel (`v0.2.1`); first Windows install from that channel, graph with real FicTrac, bag export | only the Studio run; everything else runs without it |
| Bergamo PC (reiserlab-bergamo1, ScanImage 2026 on the simulated vDAQ) | released `rig/` from `main` (release 2026-10-26) + the ScanImage connector through the JSON server; **#219** controller-settings assertion if the controller is attached | #219 and the 2P protocol header only |
| ww14 (okey-cokey, BIAS camera, no FicTrac) | released `rig/` from `main` + the BIAS node against the real BIAS app | no (the CW/CCW protocol run waits for #269) |

Results go into a file `C:\qc\<pc>-2026-10-26.md` on each PC (Claude writes it), then Michael pastes
or attaches it as a comment on [PR #274](https://github.com/reiserlab/webDisplayTools/pull/274). Linear
stays untouched by these sessions.

---

## Prompt 1: ww18 (rig5-mr)

```
Help me QC webDisplayTools PR #274 (branch feat/rig-nodes-extraction) on this Windows rig PC: the ROS 2 rig workspace rig/ now installs the shared package set from the new reiserlab/rig-nodes channel (v0.2.1) instead of carrying the device nodes itself. This PC has the G6 2x10 arena and a real FicTrac camera. Work between experiments. Never start two ROS graphs or harnesses on this PC at once (Zenoh discovery crosses folders). Do not touch Linear. Write every result into C:\qc\ww18-2026-10-26.md as we go (commands, timings, pass/fail, anything odd); I will post it on the PR.

Context: Production = main (release 2026-10-26, Arena Studio v0.98, rig/ renamed from ros2-poc/, rig_interfaces 0.2.0). Decision record: docs/development/rig-software-repos-and-runners.md. The rig-nodes channel is read over raw.githubusercontent.com at tag v0.2.1; rig_nodes ships console scripts rig-router, rig-fictrac-adapter, rig-bias-node, etc. The Studio talks to the graph's bridge node on ws://localhost:8765 exactly as before. Chrome 156+ may prompt for local network access when the Pages site opens ws://localhost; allow it.

Steps, stop and tell me at any failure:
1. git fetch origin && git checkout feat/rig-nodes-extraction && git log --oneline -1. Then cd rig.
2. Time `pixi install` (fresh env under rig\.pixi; note duration and size with `pixi info`). Confirm rig_nodes and ros2-distro-mutex versions in `pixi list` (mutex must be 0.19.x, Python 3.12).
3. `pixi install -e typed` (same solve group; should add rig_interfaces without any compiler). Note duration. Then `pixi run check-typed`.
4. `pixi run test` (the acceptance harness: sims + Studio emulator, ~60 s, no hardware). Record the pass count.
5. Start the graph with real FicTrac: in one terminal `pixi run rig` (router + FicTrac adapter + bridge node). Make sure FicTrac is running and sending UDP to :60000 as it does for bridge 3.4. Confirm `pixi run graph` shows the nodes and that the bridge node logs frames.
6. I will drive the browser: Production Studio https://reiserlab.github.io/webDisplayTools/arena_studio.html, hard-refresh, footer v0.98, Commit directly OFF, connect the bridge (ws://localhost:8765), confirm the FicTrac frames/status show. If the arena is attached and free: connect it, load protocols/validation/bench_closed_loop_2x10.yaml (needs the CSHL pattern bundle on the SD card) and Run experiment. Tell me what to look for at each step.
7. After the run (or after ~1 min of connected frames if no arena): `pixi run export` to get the derived behavior_v2 log, then from the repo root `pixi run python scripts/closed-loop-report.py <log>` (if there was a run) and `pixi run python scripts/runlog-check.py <log>`. Confirm the bag closed and reindexed at run end (rig/runlogs/<run>.bag/, metadata.yaml present).
8. Stop the graph. Compare against the released main workspace only if time allows: `git checkout main && cd rig && pixi install && pixi run test` (second fresh env).
9. Finish the C:\qc\ww18-2026-10-26.md with: install times/sizes, package versions, harness counts, graph+Studio observations, report numbers, and an explicit "arena run: done / not done". Last: write a "SETUP.md row" section at the end of the results file with (a) one host-table row for this PC (hostname, role, OS/hardware, what is installed, today's date + the commit or release tested, result) and (b) every machine quirk you hit tonight, one bullet each with the error text verbatim and the fix. The living per-machine setup note is reiserlab/rig-nodes SETUP.md (https://github.com/reiserlab/rig-nodes/blob/main/SETUP.md); this PC cannot push there, so Michael transfers your section.
Leave the checkout on main at the end.
```

## Prompt 2: Bergamo PC (reiserlab-bergamo1)

```
Help me QC the released ROS 2 rig workspace and the ScanImage connector on this Windows 2P PC (webDisplayTools main, release 2026-10-26, Arena Studio v0.98; rig/ is the renamed ros2-poc/). ScanImage 2026.0.0 runs here on a simulated vDAQ (MDF Documents\ScanImage-sim\MicroscopeMDF_sim.m). Work between experiments. Run ScanImage from a terminal-started MATLAB, never from a MATLAB connected to an MCP tool (libzmq aborts). One ROS graph on this PC at a time. Do not touch Linear. Write results into C:\qc\bergamo-2026-10-26.md as we go.

Context: docs/development/rig-software-repos-and-runners.md is the record; rig/README.md and rig/SCANIMAGE-DAY.md describe the workspace and the earlier Bergamo session. The ScanImage connector uses ScanImage's built-in JSON server on localhost:5555 (five allowlisted commands: setFileStem, an allowlisted set, grab, waitIdle, abort). #219 (shipped in this release) asserts the controller settings block before every run and should remove the four manual Console steps the 2P protocol header needed.

Steps, stop and tell me at any failure:
1. git fetch origin && git checkout main && git pull && git log --oneline -1 (expect "Merge pull request #272" on top of "Release 2026-10-26"). Then cd rig.
2. `pixi install` (fresh env after the rename; note duration). `pixi run test` (hardware-free harness; record the count).
3. Off-rig connector check first: `pixi run rig -- --scanimage --si-mock` in one terminal, then `pixi run scanimage-cmd -- --help` and send one setFileStem + grab + waitIdle through the mock. Record replies.
4. Real ScanImage: start MATLAB from a terminal, start ScanImage on the simulated vDAQ, enable the JSON server. Then `pixi run rig -- --scanimage` and repeat setFileStem (a path under Documents\ScanImage-sim\qc\), grab, waitIdle, abort via `pixi run scanimage-cmd`. Confirm the TIFF appears and the replies carry outcome ok, not unknown.
5. If the G6 controller is attached and the rig is free: I drive the Studio (Production URL, hard-refresh, footer v0.98, Commit directly OFF). Load the 2P protocol that has the controller: block (protocols/bergamo* or the one Hannah uses), connect the arena, and watch the Run view: #219 should show the controller settings assertion (panel mode, refresh, SPI, AO) with no manual Console steps; a Test experiment is enough. Tell me what to look for.
6. Stop the graph, abort any ScanImage grab, leave ScanImage idle.
7. Finish C:\qc\bergamo-2026-10-26.md: install time, harness count, mock vs real connector replies, TIFF present, #219 observations or "controller not attached". Last: write a "SETUP.md row" section at the end of the results file with (a) one host-table row for this PC (hostname, role, OS/hardware, what is installed, today's date + the commit or release tested, result) and (b) every machine quirk you hit tonight, one bullet each with the error text verbatim and the fix. The living per-machine setup note is reiserlab/rig-nodes SETUP.md (https://github.com/reiserlab/rig-nodes/blob/main/SETUP.md); this PC cannot push there, so Michael transfers your section.
```

## Prompt 3: ww14 (okey-cokey PC, BIAS camera)

```
Help me QC the released ROS 2 rig workspace with the real BIAS camera app on this Windows PC (webDisplayTools main, release 2026-10-26, Arena Studio v0.98; rig/ is the renamed ros2-poc/). This rig has a BIAS camera and a G6 arena but no FicTrac. Work between experiments. One ROS graph on this PC at a time. Do not touch Linear. Write results into C:\qc\ww14-2026-10-26.md as we go. Do NOT check out the okey-cokey PR #269; it is being rebased elsewhere tonight.

Context: docs/development/rig-software-repos-and-runners.md is the record; rig/README.md describes the workspace; rig/okey-cokey-pc-ww14-setup-2026-10-22.md (if present on main, otherwise skip) has this PC's earlier setup notes. The BIAS node talks to BIAS's HTTP command port (:5010 by default) and exposes /bias/cmd, /bias/reply, /bias/status; a timeout is an "unknown" outcome, never a silent success. BIAS gotcha: pass an ABSOLUTE video filename; a relative one resolves against BIAS's own working directory and capture silently never starts.

Steps, stop and tell me at any failure:
1. git fetch origin && git checkout main && git pull && git log --oneline -1. Then cd rig.
2. `pixi install` (fresh env after the rename; note duration). `pixi run test` (hardware-free harness; record the count).
3. Fake BIAS first: `pixi run rig -- --no-fictrac --bias --bias-sim` is the documented demo; if `--no-fictrac` is not a flag on main, use `pixi run rig -- --bias --bias-sim` and ignore the FicTrac adapter's idle warnings. Then `pixi run bias-cmd -- --help` and send connect, startRecording (absolute path under C:\qc\), getTimestamp, stopRecording. Record replies.
4. Real BIAS: start the BIAS app with the camera, HTTP command port on. `pixi run rig -- --bias` (no --bias-sim), then the same four commands with an absolute path under C:\qc\bias\. Wait at least 0.5 s between startRecording and getTimestamp (BIAS's clock starts at its first frame). Confirm the movie file exists and its size grows; note the BIAS status fields the node reports.
5. Optional, if the arena is attached and free: I drive the Studio (Production URL, hard-refresh, footer v0.98, Commit directly OFF), connect the bridge and the arena, and run protocols/g6_color_optomotor_smoke.yaml if it exists on main; otherwise skip. Tell me what to look for.
6. Stop the graph and BIAS recording.
7. Finish C:\qc\ww14-2026-10-26.md: install time, harness count, sim vs real BIAS replies and round-trip times, movie file path and size, any status oddities. Last: write a "SETUP.md row" section at the end of the results file with (a) one host-table row for this PC (hostname, role, OS/hardware, what is installed, today's date + the commit or release tested, result) and (b) every machine quirk you hit tonight, one bullet each with the error text verbatim and the fix. The living per-machine setup note is reiserlab/rig-nodes SETUP.md (https://github.com/reiserlab/rig-nodes/blob/main/SETUP.md); this PC cannot push there, so Michael transfers your section.
```

---

## After the night

Transfer each results file's "SETUP.md row" section into `reiserlab/rig-nodes` `SETUP.md` (host table row + per-host notes; PR reiserlab/rig-nodes#2 seeds the file) before posting the PR #274 comment.


Paste or attach the three result files as one comment on PR #274. Things that would change plans:
`pixi install` from the channel failing on Windows (blocks merging #274); a `ros2-distro-mutex` other
than 0.19 resolving (the v0.2.1 pin did not hold); harness failures; the bridge node not closing the
bag at run end; #219 asking for manual Console steps on the Bergamo header; BIAS or ScanImage replies
coming back `unknown` against the real programs.
