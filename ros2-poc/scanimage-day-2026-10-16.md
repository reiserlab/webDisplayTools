# ScanImage day 2026-10-16: results log

Plan: [SCANIMAGE-DAY.md](SCANIMAGE-DAY.md) (the two-hour version). PC: `REISERLAB-BERGA` (reiserlab-bergamo1).
Branch `claude/ros-studio-plan-b-c44942` @ `cff5835`. Times are ET.

| Time | Step | What | Result | Notes |
|---|---|---|---|---|
| 12:5x | 0:00 | Fresh clone of webDisplayTools to `Documents\GitHub\webDisplayTools`, `git switch claude/ros-studio-plan-b-c44942` | ok | git via GitHub Desktop (`app-3.5.8\resources\app\git\cmd\git.exe`); not on PATH |
| 12:5x | 0:00 | pixi was not installed; installed pixi 0.82.0 with the official installer (`~\.pixi\bin`, user PATH) | ok | winget not available on this PC |
| 12:55 | 0:00 | `pixi install --locked` in `ros2-poc` (default env) | ok, 27 s | cold install |
| 12:56 | 0:00 | `pixi run test` (harness) | **53/53 PASS**, 51 s | plan expected 52 (the bag-recovery check from cff5835 adds one). Skipped: JS reader check (no root pixi env). String topics (no MSVC), as expected. Frame lag p50 0.65 / p99 1.04 ms |
| 13:0x | prep (arena not up yet) | Pattern folder vs protocol `variables:` | ok | 4 GS16 `.pat` (81338 B each), names match the four anchors |
| 13:0x | §6 prep | `tools/led_sweep_si.py --dry-run` | **crashed, fixed** | `UnicodeEncodeError` printing `→` on a cp1252 console (plain `python`, no `PYTHONUTF8`; the operator's terminal Python 3.14 would hit it). Fix: reconfigure stdout/stderr to UTF-8 in `main()`. Re-run: plan printed, nothing sent. The `pixi run` CLIs are unaffected (`PYTHONUTF8=1` in pixi.toml) |
| ~13:00 | 0:15 | Michael: MATLAB R2025b, ScanImage idle, `hJ = most.network.json.Server(5555)`, logging on, `logFilePath = F:\ImagingData\2026-10-16\led_sweep`, `bidirectional = false`, `channelSave = [1 2]` | ok | no errors |
| 13:02 | 0:20 | `pixi run rig -- --scanimage` | ok | router 7447, fictrac adapter, scanimage node → 127.0.0.1:5555 (status 1 Hz), bridge-node 3.4 on ws://127.0.0.1:8765; 1 ms system timer granted. Zenoh config deprecation WARNs (harmless) |
| 13:02 | 0:20 | `scanimage-cmd -- ping` | **ok, 0.41 ms** | `acqState: idle`. CLI also prints a zenohc "Error closing session: close operation timed out" on exit (harmless, ~10 s exit delay) |
| 13:03 | 0:20 | `scanimage-cmd -- status --json` | **failed → fixed** | ScanImage 2026.0.0: `hSI.hDisplay.lastFrameNumber` throws `Index exceeds array bounds.` (Display/get.lastStripeData line 434) until the first acquisition after ScanImage starts. The snapshot raised on it → status `ok:false`, every 1 Hz status line `reachable:false`, and an UNKNOWN reconcile on the first grab of the day would have failed too. Fix (`scanimage_node.py _snapshot`): acqState must read; other props that error → `null` + `errors{}`. Harness 53/53 after the fix |
| 13:05 | 0:20 | re-run after restart: ping, status | **ok** | ping 1.1 ms; status: idle, logFileCounter 1, stem `file`, path `F:\ImagingData\2026-10-16\led_sweep`, loggingEnable true, lastFrameNumber null (no acquisition yet); 6 gets 8.2 ms total |
