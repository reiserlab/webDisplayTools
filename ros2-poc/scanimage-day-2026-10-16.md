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
