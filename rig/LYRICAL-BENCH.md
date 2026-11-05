# Lyrical bench session on a lab PC — handover

**Goal.** Run the rig graph on ROS 2 Lyrical Luth (RoboStack, Python 3.14) on a Windows rig PC
for the first time: install, the no-hardware suites, one Studio run against real FicTrac if a
camera is there, then an overnight soak. Nothing here touches what the rig runs: the `default`
environment and its lock are unchanged, and the Lyrical environment is a separate directory you
can delete afterwards. Record: rig-nodes `docs/ros-distro-switch.md` (what differs, what blocks a
migration, Mac results); this page is the PC procedure. Not during an experiment, and never with
another graph or bridge 3.4 on the same PC (one Zenoh router per host).

## 0. Before you start (5 min)

- [ ] pixi ≥ 0.83: `pixi --version`; otherwise `pixi self-update` (replaces one binary, touches no environment).
- [ ] Visual Studio 2022 Build Tools with **MSVC v143 x64/x86** (Desktop C++): the Lyrical
      environment compiles `rig_interfaces` from source because the published channel is Jazzy-only.
      ww18 has it (`rig/WINDOWS-TEST.md`, 2026-10-15). Check: `vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.
- [ ] Short build root, once per checkout (MAX_PATH): in `rig\`, `pixi config set --local detached-environments C:\px`.
- [ ] The branch: `git fetch origin && git checkout rig/ros-distro-switch` in the webDisplayTools checkout
      (PR [#294](https://github.com/reiserlab/webDisplayTools/pull/294); its `lyrical` environment builds
      rig-nodes `main` from git, pinned in the lock to the merge commit of
      [rig-nodes#8](https://github.com/reiserlab/rig-nodes/pull/8) — network needed; no rig-nodes checkout needed).
- [ ] Nothing on ports 7447 / 8765 / 60000: `netstat -ano | findstr ":7447 :8765 :60000"` prints nothing.

## 1. Install (expect 2–5 min; write the time down)

```bash
cd rig
pixi install --locked -e lyrical
pixi run -e lyrical python -m rig_nodes.runtime
```

The second command prints what the environment is (`ros_distro: lyrical`, `rmw 0.10.6`,
`ros2_distro_mutex: 0.22.0 lyrical_30`, `python 3.14.x`, the package versions); paste it into the
results file. If the install fails on the `rig_interfaces` build, the error text verbatim into the
results file is the result — do not fix the PC's compiler setup mid-session.

## 2. No hardware (≈ 5 min)

```bash
pixi run -e lyrical check-typed        # 8 typed messages import + serialize
pixi run -e lyrical test-gateway       # 5 checks
pixi run -e lyrical test               # the arena harness: whole graph, simulators, emulator, crash phase (≈ 60–90 s; 63 checks on the Mac)
```

Record the counts. A failure in `test` is worth a second run before calling it (the harness has
timing-sensitive phases); two failures are a finding.

## 3. One real run (≈ 15 min, only if FicTrac and a controller are at hand)

```bash
pixi run -e lyrical rig                # router + FicTrac adapter (UDP 60000) + gateway; add -- --bias for the camera node
```

Start FicTrac as usual (the sample video is fine), open **Production** Studio
(`https://reiserlab.github.io/webDisplayTools/arena_studio.html?mode=run`), Connect, run any short
closed-loop protocol, export. Record: frames seen vs applied in the gateway's shutdown line, the
`runlog-check` of the export, controller 0x70 count vs host, anything odd in the Console. Without a
controller, skip the Studio and run `pixi run -e lyrical rig -- --sim` + `pixi run -e lyrical studio-emulator`
instead (what the harness does, by hand).

## 4. The soak (overnight)

First a six-minute smoke so the Windows stop path (CTRL_BREAK through the process group) is seen
working before anyone leaves it overnight:

```bash
pixi run -e lyrical soak -- --hours 0.1 --every 1
```

Expect `N/N emulator runs ok` and `graph clean exit` on the last line. Then the real thing:

```bash
pixi run -e lyrical soak -- --hours 8 --every 10          # simulated FicTrac at 100 Hz + BIAS simulator
pixi run -e lyrical soak -- --hours 8 --every 10 --fictrac  # real FicTrac on 60000 instead of the simulator
```

`tests/soak_graph.py` keeps one graph running for the whole time and drives a recorded run through
the gateway every 10 minutes with the Studio emulator (the Studio's exact conversation), then stops
the graph the way a rig does. It refuses to start if the ports are taken. Results land in
`rig\runlogs\soak-<stamp>\`: `soak.json` (every run: ok / applied frames / seconds; the gateway's
shutdown accounting; `stop`), `rig.log`, one report per run. What a problem looks like in `soak.json`:
`timed_out: true` or `ok: false` on a run (an rmw hang or a stuck gateway), `applied` dropping over
the night, `stop` not starting with `clean`, or the graph exiting on its own. Leave the PC alone
while it runs; the Studio must stay disconnected (the emulator owns the gateway).

For comparison, the same command in the `default` environment (`pixi run soak -- --hours 8 --every 10`)
is the Jazzy baseline; if there is a second night, run it.

## 5. Results and cleanup (10 min)

- Results file: `rigs/<rig-id>/lyrical-bench-<date>.md` in the private `reiserlab/arena-experiments`
  (rig records left this repository on 2026-10-29, LAB-227): the runtime print, install time, the
  counts from steps 2–3, the `soak.json` summary line and the `summary_lines`, every error verbatim.
  Attach `soak.json`.
- Then in rig-nodes (a small PR on top of #8 or after it): the host table row in `SETUP.md` and a
  line in `docs/ros-distro-switch.md` §8 with the PC's results.
- Cleanup: `rmdir /s /q rig\.pixi\envs\lyrical` (or leave it; it is 1–2 GB and harms nothing).
  The `default` environment was never touched; `pixi install --locked -e default` confirms.

## Known already

- The one Lyrical-only defect found so far was in `rosbag2_py` (positional stamps bound to a new
  `sequence_number` argument) and is fixed on the branch; the recorder test checks it.
- rig-nodes' CI Lyrical job passed on win-64 and linux-64; one host-sampler disk-busy check flaked
  on osx-arm64 once (timing, not Lyrical).
- The rig-nodes channel publishes Jazzy only; the `lyrical` environment always builds from git.
- Do not `pixi update` on the rig PC; a changed lock is a finding to report, not a fix.
