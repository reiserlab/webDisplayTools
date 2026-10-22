# Okey-cokey rig PC setup — results, REISERLAB-WW14, 2026-10-22

Checklist: [`okey-cokey-pc-setup.md`](okey-cokey-pc-setup.md). Setup by a Claude Code session on the PC (~30 min).

## A. PC

- **REISERLAB-WW14**, Windows 11 Enterprise 10.0.26100, user `labadmin` (Administrators group; session not elevated). RDP enabled.
- Disk: C: 1474 GB free (no D: drive). Videos go to **`C:\rec\okey-cokey`**.
- Power: switched Balanced → **Ultimate Performance**. AC sleep and hibernate never; USB selective suspend off (AC).
- Windows Update: **not paused yet** (needs a person, Settings → Windows Update → pause 1 week).

## B. Tools

| tool | version | status |
|---|---|---|
| Git | 2.54.0.windows.1 | found |
| pixi | 0.70.2 | found |
| Chrome | 155.0.8059.86 | found |
| Foxglove | 3.4.2 | **installed** (per-user, silent, signed installer from get.foxglove.dev; `%LOCALAPPDATA%\Programs\desktop\Foxglove.exe`) |
| Claude Code | desktop app | found |
| GitHub CLI | — | not installed (optional) |

## C. Lab hardware software

- **BIAS** v0.73.1, Spinnaker build, `C:\Users\labadmin\Documents\FlyBowl1Rig\BIAS_exe_spinnaker_win64_v0_73_1\v0.73.1\test_gui.exe`.
  The copies in `Documents\GitHub\BIAS_exe_…` and `FlyBowl1Rig\test_gui.exe` are byte-identical. It bundles SpinnakerC 2.6.0.160.
- **Spinnaker SDK** 2.6.0.157 is installed.
- **Camera**: FLIR Blackfly S **BFS-U3-51S5M**, serial 24203703, 2448×2048 MONO8, ~73.3 fps, internal trigger. A 4 s test capture gave 294 frames.
- **External control**: port 5010, `get-status` returns `success: true`. The status reply has **no drop counters** (`frameIdGaps`, `cameraSkipped` absent), so `/viz/bias/drops` stays None.
- **Logging**: was `jpg` → `C:/Users/labadmin/Videos`; set to **ufmf** → `C:/rec/okey-cokey` over HTTP.
  This setting is lost when BIAS restarts. Saved config, now in the repo: `ros2-poc/config/bias/okey-cokey-bfs-u3-51s5m.json`.
  Note: BIAS listens on 0.0.0.0:5010, not just loopback.
- **G6 controller**: Teensy serial on **COM3** (USB VID 16C0 / PID 0483). Firmware label `c15d840a 2x10 2026-09-29 restack/panel-boot freerun sdfast`.
- SD card: 8 GB FAT32, mounted. Firewall prompts and IR backlight were not recorded in this session.

## D. Repo + environments

- Clone: `C:\Users\labadmin\Documents\GitHub\webDisplayTools`, branch `claude/okey-cokey-dashboard` @ 21f2cb2. (This PC keeps its clones in `Documents\GitHub`, not `C:\w`.)
- `pixi install` (root), `pixi install --locked`, and `pixi install --locked -e viz` together took 45 s.
- **Fix (committed in `ros2-poc/pixi.toml`)**: `foxglove_bridge` exited 0xC0000135 (DLL not found).
  The cause: `foxglove.dll` and `foxglove_cpp_shared.dll` are installed in `.pixi\envs\viz\Library\lib`, which is not on PATH.
  Fixed with `[feature.viz.target.win-64.activation.env] PATH = '%CONDA_PREFIX%\Library\lib;%PATH%'`. The lock is unchanged.
- Tests (reproduce the earlier rig's runs, so failures here don't block experiments):
  - `test-stimulus` / `test-stimulus-live`: cannot run. `tests/fixtures/okey_smoke_violet_cw.jsonl.gz` was never committed (`ros2-poc/.gitignore` matches `*.jsonl.gz`).
    `.gitignore` now excepts `tests/fixtures/*.jsonl.gz`. The file still has to be added from ww18.
  - `pixi run test`: **51 / 54**. All 3 failures come from Kinefly: UDP 127.0.0.1:60001 is held by `lsass` on this PC, so the emulator's rows never arrive. Kinefly is not used in this experiment.

## E. Stack smoke

- `pixi run rig -- --no-fictrac --bias --bias-args "--video-dir C:\rec\okey-cokey" --foxglove --viz-args "--sources bias" --stimulus-args "--panel-layout four-color"`
  → `[rig] up: router, bias, bridge, stimulus, viz, foxglove`.
- Listening: 5010 BIAS, 7447 zenoh, 8765 Studio bridge, 8766 foxglove_bridge, 8092 Studio page (HTTP 200).
- BIAS through the node (run sheet step 2, via the rig's node): `connect` / `startRecording nodecheck.ufmf` / `getTimestamp` / `stopRecording` all returned `ok`.
  BIAS wrote `C:\rec\okey-cokey\nodecheck_cam_0_date_2026_10_22_time_14_04_16_v001.ufmf` (5.0 MB, 684 frames over 9.32 s = 73.4 fps). Matching `stamp_log_cam0.txt`.
  That rate is ~0.54 MB/s, so ~0.5 GB for a 16-min run.
- Unknown path (run sheet step 2): started a recording, killed BIAS. `getTimestamp` → `outcome: unknown` ("timeout after 2.0s") in 4.0 s, no hang. After reopening BIAS the node reports `reachable: true` again.
- **BIAS restarts in jpg**: settings don't persist. `set-configuration` / `load-configuration` fail with "Unable to revert to previous configuration" until the camera has captured once.
  `ros2-poc/tools/bias-ufmf.ps1 -VideoDir C:\rec\okey-cokey [-Config config\bias\okey-cokey-bfs-u3-51s5m.json]` does connect → 2 s capture → load. Run it after every BIAS start.
- `ros2 topic echo /bias/status --once` hangs on this PC, but an rclpy subscriber receives it at 5 Hz: reachable, rtt ~12 ms.
- Studio Bridge + controller (COM3) connected. Foxglove signed in; at first it was pointed at 8765 (connect/drop loop in the rig log), then fixed to `ws://localhost:8766` with the `arena-okey-cokey.json` layout.

## Run sheet 5–6: smoke run (`g6_color_optomotor_smoke`, 14:20, no flies)

- Controller: firmware `c15d840a 2x10 2026-09-29 restack/panel-boot freerun sdfast`; SD `SD8GB` 7.99 GB FAT32.
- **Direction: the arena is mounted upside down.** Confirmed by eye: protocol "CW" trials (`fps_cw` = +80) turn **counter-clockwise seen from above**, and "CCW" trials turn clockwise.
  Accepted as is: the protocols are not changed, and no separate direction test is needed on this rig. For analysis, read the protocol's CW/CCW labels as reversed relative to the view from above.
  (The Console "Test `green_pair_d100`" entry wasn't found.)
- BIAS replies, all `ok`: connect, startRecording, 6 × getTimestamp, stopRecording.
  Video `C:\rec\okey-cokey\color_optomotor_smoke_cam_0_date_2026_10_22_time_14_20_25_v001.ufmf`: 10.2 MB, 7495 frames.
  `stamp_log_cam0.txt` has 7495 lines. The bag lasts 103.4 s.
- Bag `runlogs/arena-log-20261022-142025-918.bag`; export `runlogs/exports/arena-log-20261022-142025-918.jsonl`.
- `runlog-check`: 9 pass / 0 fail / 4 unknown. All 4 unknowns (and trial 5, 515 s idle) are controller activity from **before** the run: Console tests, with the telemetry ring overrun because nothing was draining.
  The 8 run rotations (trials 6–13) each pass with 801 frames in 10 s (80 fps), 0 stalls, 0 slow reads, max read 0.8 ms.
- Replay: `pixi run fox-json … --stimulus --panel-layout four-color` → `runlogs/arena-log-20261022-142025-918.foxglove.mcap` (107 MB, 64 s to build).
  ufmf found and indexed, 1023 camera images. `lag_frames` = 0 in all 6518 samples. Display rate 80 Hz in rotations, 0 in pauses. `/arena/health` 103 × OK, no WARN/ERROR.

## Smoke run #2 (14:47, no flies)

- BIAS: all `ok`. Video `color_optomotor_smoke_cam_0_date_2026_10_22_time_14_47_22_v001.ufmf`, 10.2 MB, 7497 frames.
- `runlog-check` on `runlogs/exports/arena-log-20261022-144722-712.jsonl`: **OK**, 8 pass / 0 fail / 0 unknown, 1 / 1 run files complete.
  This confirms run #1's unknowns were pre-run Console activity.
