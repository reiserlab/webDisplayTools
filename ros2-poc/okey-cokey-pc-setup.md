# Okey-cokey rig PC — setup checklist (bare Windows PC → ready for the test)

The PC in the okey-cokey room starts without Foxglove, without the webDisplayTools repo and possibly
without git or pixi. Work through this list **before** the run sheet
([`okey-cokey-pc-2026-10-21.md`](okey-cokey-pc-2026-10-21.md)); the run sheet assumes every box here
is ticked. Items marked **(Michael/Grace)** need a person at the PC or an admin/UAC prompt; the rest
a Claude Code session on the PC can do and check itself.

Write down what you find in each section, it goes into the results file.

**Paths.** The commands below use `C:\w` for the clone and `D:\rec\okey-cokey` for videos; use your own.
The first PC done with this list, REISERLAB-WW14 (2026-10-22), has no D: drive. There the clone is
`C:\Users\labadmin\Documents\GitHub\webDisplayTools` and the videos go to `C:\rec\okey-cokey`.
Its results, including the direction finding: [`okey-cokey-pc-ww14-setup-2026-10-22.md`](okey-cokey-pc-ww14-setup-2026-10-22.md).

## A. Access and the PC itself

- [ ] **(Grace)** Remote Desktop enabled; send Michael the PC name (Settings → System → Remote Desktop).
- [ ] PC name, Windows version (`winver`), user account; is the account a local admin? (installs below
      are per-user where possible, so admin is only needed for C.4 and maybe B.5).
- [ ] Free disk: ≥ 10 GB on C: for the tools (pixi envs ~2 GB + package cache ~8 GB), plus the video
      drive: the 16-min run at the camera's resolution × fps in uFMF (ww18's Atlas10 wrote ~24 MB/s at
      8 MP × 135 fps; a smaller camera is far less: ww14's Blackfly S BFS-U3-51S5M at 5 MP × 73 fps wrote
      ~0.5 MB/s, ~0.5 GB per full run). Note which drive gets videos (`D:\rec\okey-cokey`?).
- [ ] Power plan: High performance, sleep **off** while plugged in (a sleeping PC drops the USB serial
      link and stops the camera mid-run).
- [ ] Windows Update not about to reboot (Settings → Windows Update → pause 1 week for the test).

## B. Tools (each one: check it, install if missing, note the version)

| # | tool | check | install if missing | why |
|---|---|---|---|---|
| B.1 | **Git for Windows** | `git --version` | `winget install --id Git.Git -e` | the clone; Claude Code's CLI also runs through Git's bash |
| B.2 | **pixi** ≥ 0.69 | `pixi --version` | `powershell -ExecutionPolicy ByPass -c "irm -useb https://pixi.sh/install.ps1 \| iex"`, then open a NEW terminal | provides Python, Node, ROS 2, foxglove_bridge — nothing else to install for the software side |
| B.3 | **Chrome** (current) | Settings → About | `winget install --id Google.Chrome -e` | the Studio (Web Serial needs Chrome/Edge) |
| B.4 | **Foxglove** desktop app | Start menu "Foxglove" | not in winget. Use the signed installer `https://get.foxglove.dev/desktop/latest/foxglove-latest-win.exe`, run silently per-user with `/S /currentuser` (ww14: 3.4.2, lands in `%LOCALAPPDATA%\Programs\desktop\Foxglove.exe`). Free account sign-in on first start | the dashboard; per-user install |
| B.5 | **Claude Code** (only if a Claude session will drive the PC) | `claude --version`, or the desktop app | from claude.com/claude-code | runs the handover; the CLI needs B.1 first |
| B.6 | GitHub CLI (optional) | `gh --version` | `winget install --id GitHub.cli -e` | only for pushing results from the PC; HTTPS + a token also works |

Not needed for this test: Visual Studio Build Tools (only the optional `typed` ROS environment wants a
compiler), MATLAB, FicTrac.

## C. Lab hardware software (not provided by pixi — must already be on the PC or copied over)

- [ ] **C.1 BIAS**: which build is installed, where (`…\test_gui.exe` or a `.bat` launcher), which camera.
      The FLIR/Spinnaker build for FLIR cameras; the atlas-bench Atlas10 build (LUCID Arena backend) for
      LUCID cameras, as on ww18. **If BIAS is not on this PC, stop and tell Michael** — it cannot be
      built in the test window without its toolchain; copy a known-good build (e.g. from ww18 or the
      lab share) instead.
- [ ] **C.2 Camera SDK/driver** for that build (Spinnaker or LUCID Arena SDK) installed; the camera
      shows a live preview in BIAS.
- [ ] **C.3 BIAS external-control server** on, port 5010 for camera 0:
      `curl.exe "http://127.0.0.1:5010/?get-status"` returns `"success" : true`. Logging format **ufmf**.
      **BIAS v0.73.1 (Spinnaker) forgets its settings on every restart**: it starts as jpg →
      `%USERPROFILE%\Videos`. It also rejects `set-`/`load-configuration` ("Unable to revert to
      previous configuration") until the camera has captured once. After **every** BIAS start, run
      `powershell -ExecutionPolicy Bypass -File ros2-poc\tools\bias-ufmf.ps1 -VideoDir <video dir>`.
      It does connect → 2 s capture → load, and prints `BIAS logging: ufmf -> …`. Add
      `-Config ros2-poc\config\bias\<camera>.json` for a saved per-camera config (ww14:
      `okey-cokey-bfs-u3-51s5m.json`).
- [ ] **C.4 (Michael/Grace)** Firewall: if Windows asks to allow BIAS / `rmw_zenohd` / `foxglove_bridge`
      / Python on first start, "Private networks" is enough (everything here talks over 127.0.0.1).
- [ ] **C.5 IR backlight** switch / Arduino works by hand (the web runner does not drive it yet).
- [ ] **C.6 G6 controller** on USB: Device Manager shows a COM port appear when it is plugged in
      (Teensy serial uses the built-in Windows driver). Its firmware is the 2×10 telemetry build
      (`arena-2x10-local` / `sdfast`); the Studio shows the label at Connect.
- [ ] **C.7 SD card** in the controller is mounted (the Studio's Console lists files). If unsure, a
      ≤ 32 GB FAT32 card (ww18's exFAT 64 GB card had one slow-read burst).

## D. The repo and the environments

```powershell
git clone https://github.com/reiserlab/webDisplayTools C:\w
cd C:\w
git switch claude/okey-cokey-dashboard
pixi install                    # root env: Node + Python (tests, the local Studio server)
cd ros2-poc
pixi install --locked           # ROS 2 graph (~25 s on ww18, ~1.5 GB)
pixi install --locked -e viz    # + foxglove_bridge (~0.3 GB)
```

- [ ] Short checkout path (`C:\w`): the default env does not care, but Windows' 260-char limit bites
      the optional typed build, and short paths are easier to type over RDP.
- [ ] `pixi run test-stimulus` → `PASS: 0 failure(s)` (includes the JS panel-color check, which uses
      the ROOT env's Node — so the root `pixi install` above must have run).
- [ ] `pixi run test-stimulus-live` → `PASS` (needs ports 7447 / 8765 free: no rig, no bridge 3.4).
      **Known issue**: on a fresh clone, both of these stop with `FileNotFoundError …
      okey_smoke_violet_cw.jsonl.gz`. That fixture was never committed because `.gitignore`
      matched it (Known issues below). Skip both on a new PC; they don't block experiments.
- [ ] Optional (~1 min): `pixi run test` → 54 / 54 (the whole ROS graph + Studio emulator). ww14 gave
      51 / 54, all three failures Kinefly: UDP 60001 was held by `lsass` (Known issues below). Kinefly
      isn't used on this rig.
- [ ] `pixi run -e viz foxglove-bridge` starts and listens on 8766. Before the `pixi.toml` fix of
      2026-10-22 it exited `3221225781` (0xC0000135, DLL not found) on Windows.
- [ ] Nothing else listening: `netstat -ano | findstr ":7447 :8765 :8766 :8092 :60000 :5010"` shows only
      BIAS on 5010 (once BIAS runs).

## E. Smoke of the stack, no flies (5 min)

- [ ] Terminal 1 (`C:\w\ros2-poc`):
      `pixi run rig -- --no-fictrac --bias --bias-args "--video-dir D:\rec\okey-cokey" --foxglove --viz-args "--sources bias" --stimulus-args "--panel-layout four-color"`
      → `[rig] up: router, bias, bridge, stimulus, viz, foxglove …`
- [ ] Terminal 2 (`C:\w`): `pixi run python .claude\nocache-server.py 8092`
- [ ] Chrome: `http://localhost:8092/arena_studio.html?p=g6_color_optomotor_smoke&rig=cshl_g6_2x10&mode=run`
      → Bridge: Connect → `connected`; Connect → pick the controller's COM port.
- [ ] Foxglove → Open connection → Foxglove WebSocket → `ws://localhost:8766`; Layout → Import from
      file → `C:\w\ros2-poc\foxglove\arena-okey-cokey.json`. BIAS indicator green, camera fps plotted,
      the expected display dark, "Arena" OK.
      **8766, not 8765.** 8765 is the Studio bridge. Foxglove pointed there connects and drops
      straight away, and the rig log fills with `client connected … / client disconnected` pairs.

All green → go to the run sheet (it repeats E in context and continues with patterns, direction,
smoke run, full run, collect, replay).

## Known issues (as of 2026-10-22, ww14)

- **Missing test fixture**: `ros2-poc/tests/fixtures/okey_smoke_violet_cw.jsonl.gz` was ignored by
  `ros2-poc/.gitignore` (`*.jsonl.gz`), so `test-stimulus` / `test-stimulus-live` can't run on any
  clone. `.gitignore` now has an exception for `tests/fixtures/`. The file itself still has to be
  committed from the PC that recorded the 2026-10-14 smoke run (ww18): `git add -f` it.
- **Kinefly test port**: 60001 is inside Windows' dynamic port range (49152–65535). Any system process
  can hold it (ww14: `lsass`, `netstat -ano -p UDP | findstr :60001`), and then `pixi run test` loses its
  Kinefly checks. This is harmless for camera + arena runs. A permanent fix would move the default port
  below 49152, in step with the Kinefly fork's `--udp`.
- **`ros2 topic echo <topic> --once` can hang** on Windows with rmw_zenoh even while the topic
  publishes. Use Foxglove, or a short rclpy subscriber.

## What to record from this checklist

PC name and Windows version; admin yes/no; every tool version (B), installed or found; BIAS build + path
+ camera model + whether its status reply has the drop counters (`frameIdGaps`, `cameraSkipped`, …);
controller firmware label; SD card; both test counts; anything that needed a click, a UAC prompt or a
download, and how long the whole setup took.
