# Setting up this rig workspace (arena side)

Machine setup, the install recipe, the host table and every per-machine quirk live in
**[`reiserlab/rig-nodes` → `SETUP.md`](https://github.com/reiserlab/rig-nodes/blob/main/SETUP.md)**:
rig PCs install the shared package set with or without the web tools, so that is where an
install problem is recorded and looked up. Update your machine's row there after every install
or QC pass. This page holds only what exists because of the arena application.

## What this workspace adds on top of the package set

- `cd rig && pixi install --locked` installs the package set pinned in `rig/pixi.toml`
  (environments: `default` String topics, `typed` adds `rig_interfaces`, `viz` adds Foxglove,
  `dev` swaps the pins for a sibling `../../rig-nodes` checkout). Run every `pixi run …` from
  `rig/`, not the repository root: the root has its own `pixi.toml` for the web tools and
  `pixi run` there provisions that workspace instead.
- `pixi run rig` is the one command a rig PC runs (router + FicTrac adapter + the Studio
  gateway; `--bias`, `--scanimage`, `--kinefly`, `--foxglove` add nodes; `--sim` and the
  `*-sim` flags add simulators). The gateway serves `ws://localhost:8765`, which is what the
  Studio connects to. Bridge 3.4 (`pixi run bridge` at the repository root) is the legacy path
  for course rigs and must be stopped first; both want 8765.
- Harness: `pixi run test` (and `pixi run -e typed test`) runs the whole graph with simulators
  and the Studio emulator; it is also the cross-repository smoke for the installed package set.

## The Studio and the gateway

- **Production Studio** is `https://reiserlab.github.io/webDisplayTools/arena_studio.html`; it
  connects to `ws://localhost:8765` from the Run view (bridge Connect) or the Console. Hard-refresh
  after a release and check the footer version. Never open `/next/` on a rig PC mid-experiment.
- **A branch test without Pages:** `python3 -m http.server 8080` from the repository root, then
  `http://localhost:8080/arena_studio.html?mode=run`. Without an arena controller the Studio
  connects and shows FicTrac frames but applies nothing; `rig/tests/studio_emulator.py` speaks
  the Studio's exact conversation (hello, config, log_control, epochs, log_export) and is the
  no-browser check.
- **Web Serial** needs Chrome or Edge and a user click on the port picker; everything else
  (bridge connect, metadata, Run) is scriptable. On Windows the G6 controller enumerates as
  "USB Serial" (`COMn`).
- **Course repo:** run logs commit to the configured course repository only when a token is
  stored (⚙ Settings → GitHub); without one, `pixi run export` asks the running gateway for the
  run's log. Token types: `docs/development/data-repo-token-runbook.md`.
- **Protocols and patterns** for a rig live in the course repo under `protocols/<rig-id>/`
  with colocated `*_patterns/`; the Studio's session rig must match the arena the SD card's
  patterns were made for (a 4×10 firmware build rejects every 2×10 pattern).

## Records

Dated results from past sessions on each machine (kept as records; the living summary is the
rig-nodes host table): `windows-results-ww18-2026-10-15.md`, `scanimage-day-2026-10-16.md`,
`SCANIMAGE-DAY.md`, `WINDOWS-TEST.md`, and the okey-cokey PC notes that land with PR #269.
