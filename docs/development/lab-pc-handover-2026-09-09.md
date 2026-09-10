# Lab-PC handover — bench-testing the run-log v2 stack (+ optional analog), 2026-09-09

**For a fresh Claude session on the lab Windows PC.** Read this file first, then
`docs/development/merge-bench-plan-2026-09-08.md` (the full gated checklist) and
`docs/development/codex-review-2026-09-09.md` (what was just fixed and what is still open).
The Mac session that wrote this may still be running; treat GitHub as the source of truth for
branch state, not this file.

## Status after the bench day (2026-09-10 19:13 ET) — read this before § 0

| Item | Result |
|---|---|
| Gate B1 (run-log v2) | **passed 1–9** on `rig05-mr` with the sim; #188 merged (`f744e12`), #186 closed; Pages v0.73 |
| Gate B2 (Analog In S1) | **passed** (software) on a course 10-10 controller; #190 merged (`880ffd5`); Pages v0.74 |
| #191 (calibration S2) | rebased onto main, CI green, **held** for gate B4 |
| fw #48 (12-18 variant) | reviewed + approved with nits; **flashed on the 12-18 arena**; LED column sweep confirmed |
| 12-18 analog | AI1 OK (+5.5 % gain, +300 mV offset); **AI2 stage-2 divider wrong (0.79×)** — inspect R179/R181 |
| fw #46/#47, B3/B4 | not started; need #48 merged first (rebase `constants.h`/`README.md`), then the 12-18 board |
| Lab PC | pixi, gh (`mbreiser`), FicTrac (`C:\Lab\GitHub\fictrac`, `pixi-build` branch, Spinnaker 4.4 detected; still needs the rig `config.txt` from the labadmin install), firmware clone + `C:\Lab\GitHub\fw-48` worktree |

Gotchas learned on this PC (add to § 6 mentally):

- **Git Bash `TZ='America/New_York' date` prints UTC here** (MSYS has no tzdata) — the CLAUDE.md
  recipe is wrong on Windows. Use PowerShell:
  `[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date),'Eastern Standard Time')`.
  (#190's footer stamp `16:50 ET` is really 12:50 ET; superseded when #191 lands.)
- **Retargeting a PR base does not trigger CI** (`pull_request: edited`); gate locally with
  `pixi run test` on the head sha, or push a commit.
- **Rebasing a child of a squash-merged parent:** `git rebase --onto origin/main <parent-tip>`,
  not a plain rebase (patch-ids no longer match → add/add conflicts).
- **`pixi run test` needs `PYTHONUTF8=1` on Windows** — the Python tests print `→` and die with
  `UnicodeEncodeError` under cp1252. A `[activation.env]` fix is stashed on this checkout
  (`git stash list`), destined for its own PR.
- **Firmware upload on Windows:** `scripts/find_teensy.py` is Linux-only → pass
  `-- --upload-port COMx`; `teensy_loader_cli` cannot soft-reboot on Win32 and waits — the board
  only entered HalfKay once the **arena was powered**. #48 renames the tasks:
  `deploy-12-18-performance`, `deploy-10-10-performance` (§ 5 below is stale on this point).
- Windows shows stale "Unknown" COM entries for previously plugged controllers; the live one is
  the `Status OK` port (`Get-PnpDevice | ? InstanceId -match VID_16C0`).
- `pixi run <task>` refuses to start while `pixi.toml` has conflict markers — resolve it with
  `.pixi/envs/default/python.exe` directly.

## 0. Goal for the bench day, in priority order

1. **Land the run-log v2 + gzip stack** (#186 Studio v0.72, #188 readers v0.73): one real run
   through the bridge → `.jsonl.gz` in the data repo → dashboard + replay open it → merge.
   Highest priority. Everything else is optional today.
2. Minimal Analog In check (#190) if 10 minutes remain.
3. Firmware F1/F2 + calibration UI (#46/#47/#191): only with a LAB-209-reworked board; skip otherwise.

## 1. Install on the lab PC (Windows)

Already there: FicTrac. Add:

| What | Why | How |
|---|---|---|
| **Git for Windows** | clone both repos | `winget install Git.Git` |
| **pixi** | the ONLY dev tool either repo needs — it fetches Node, Prettier, Python, websockets (web tools) and PlatformIO + the Teensy toolchain (firmware) on first `pixi run` | PowerShell: `iwr -useb https://pixi.sh/install.ps1 \| iex`, then reopen the terminal |
| **Google Chrome** (or Edge) | Web Serial — the Studio talks to the Teensy from the browser; localhost counts as a secure context | winget or installer |
| **GitHub CLI `gh`** (optional) | merging/retargeting PRs from the terminal; the web UI works too | `winget install GitHub.cli` then `gh auth login` |
| **Claude Code** | the new session | desktop app / installer |
| Teensy USB driver | none needed on Windows 10/11 (USB-CDC is in-box); PlatformIO installs the Teensy loader | — |
| Optional, analog only: Digilent WaveForms (AD3), a DMM, a BNC cable | bench gates B2–B4 | Digilent site |

Repos to clone (any folder; keep them siblings):

```powershell
git clone https://github.com/reiserlab/webDisplayTools.git
git clone https://github.com/reiserlab/LED-Display_G6_Firmware_Arena.git
```

One-time in each: `pixi install` (web tools) — the firmware repo installs on first `pixi run`.
A data-repo token for the Studio's GitHub sign-in: org members use a fine-grained PAT scoped to
`reiserlab/cshl-2026-course`; the shared course guest account needs a CLASSIC token
(`docs/development/data-repo-token-runbook.md`). The bench id is set in the Studio's File ▾ menu.

## 2. Branch state (as of 2026-09-09 ~09:50 ET; verify with `gh pr list`)

| PR | Branch | Contains | State |
|---|---|---|---|
| #186 | `claude/runlog-behavior-v2-studio` | Studio v0.72: gzip commits, behavior_v2 default, bridge ack | on main, CI green, **do not merge alone** |
| #188 | `claude/runlog-behavior-v2-readers` | v0.73: `js/runlog-format.js`, dashboard/replay readers, `index.json` filter fix, strict-mode fix — **includes #186's commit** | based on #186's branch; rebased onto main; suites + corpus gates green |
| #190 | `feat/console-analog-in` | Analog In panel S1 v0.74 + sweep refusal fix + closed-loop gating + offset criterion | on main, CI green |
| #191 | `feat/console-analog-cal` | calibration UI S2 v0.75 + 2 s timeouts + click lock | based on #190; rebased |
| fw #46 | `feat/ai-12bit-g3-gain` | F1: 12-bit ADC, G3 gain (100 fps/V at unity), 0xA4 flags | on fw main; never run on hardware |
| fw #47 | `feat/ai-calibration` | F2: EEPROM calibration 0xA5–0xA7 + display-active guard + int16 clamp + O(1) Mode 4 skipping + plausibility-checked points | based on #46; builds; never run on hardware |
| #192 | `claude/data-logging-ring-buffer-9f400b` | docs only: telemetry proposal, merge plan, review, this file | merge any time |

Already on main: bridge 3.0 (#183, behavior_v2), runlog-index Action (#187) + gzip support
(#193, #194) — the data repo's `.github/scripts/build-runlog-index.py` is a byte-identical copy
of `scripts/build-runlog-index.py` @ main (installed 2026-09-09).

## 3. Step-by-step: gate B1 (run-log v2 end to end) — ~45 min

Serve the readers branch locally (Pages serves only main):

```powershell
cd webDisplayTools
git fetch origin
git checkout claude/runlog-behavior-v2-readers
pixi run serve          # http://localhost:8000  (leave running)
```

Second terminal, same checkout:

```powershell
pixi run bridge         # WebSocket :8765, FicTrac UDP :60000
```

| # | Do | Pass |
|---|---|---|
| 1 | Open `http://localhost:8000/arena_studio.html`; connect the arena (Web Serial chooser → the Teensy COM port); connect the bridge (`ws://localhost:8765`); sign in to GitHub; set the bench id | Footer says **v0.73**; Console FicTrac panel's log-level mirror reads `behavior_v2` with no ⚠ |
| 2 | Start FicTrac on the rig (or `pixi run sim` in a third terminal if no fly/ball is available) | Bridge stats show frames arriving |
| 3 | Run a short protocol, ≥ 2 conditions, ≥ 60 s, ideally including a Mode 3 (FicTrac) condition | Run banner: `run logging to JSONL (behavior_v2)`; run completes |
| 4 | Watch the commit line at run end | `✓ run log committed: runlogs/<bench>/<name>.jsonl.gz (X MB → Y KB gzip)`; file visible in the data repo |
| 5 | Data repo → Actions → runlog-index | Green; that folder's `index.json` gained a row with `duration_s` |
| 6 | `http://localhost:8000/dashboard/data-browser/` → browse the repo → open the new run | Listed with start + duration, size column shows `gz`, plots render |
| 7 | Same dashboard: open an older v1 `.jsonl` run | Opens as before |
| 8 | Replay viewer on the new `.gz` (Studio → replay, or `arena_replay_viewer.html`) | Timeline builds |
| 9 | `pixi run bridge -- --convert <downloaded .gz> out.jsonl` then `--convert out.jsonl back.jsonl.gz` | Converter reports identical canonical JSON |

**Merge (only after 1–9 pass):**

```powershell
gh pr edit 188 --repo reiserlab/webDisplayTools --base main      # retarget; CI starts
gh pr checks 188 --repo reiserlab/webDisplayTools --watch
gh pr merge 188 --repo reiserlab/webDisplayTools --squash --subject "feat(run logs): behavior_v2 + .jsonl.gz — Studio v0.72 commit path + v0.73 readers (#186, #188)"
gh pr close 186 --repo reiserlab/webDisplayTools --comment "Landed via #188 (its branch contained this commit)."
```

Why this order: #188's branch already contains #186's commit. Squash-merging #186 first would leave
#188 conflicting (that exact thing happened with #183). Never `--delete-branch` a PR that is
another PR's base. After the merge: hard-refresh Pages (Ctrl+Shift+R) and repeat step 6 from
Pages; every bench then does `git pull` + restarts `pixi run bridge`.

Skip today: forcing the >30 MiB Git-Database commit path (no UI hook; unit-tested).

## 4. Minimal Analog In check (#190) — 10 min, any board

```powershell
git checkout feat/console-analog-in      # restart pixi run serve if it caches
```

Console → left rail **Analog In**. Pass: live readout at 10 Hz; status says `paused — run
active` during any trial and `live` after; the rail chip updates. With a BNC cable from Analog Out
to Analog In 1: **Run sweep**. On a reworked board expect `ok`; on an un-reworked board expect
`fail` plus the LAB-209 message — both are UI passes. If AO is in `frame_number` mode the sweep
aborts with a hint (that is the new, correct behavior). Then `gh pr merge 190 --squash` and
`gh pr edit 191 --base main` (do not merge #191 until F2 is on hardware).

## 5. Firmware F1/F2 (only with the reworked board) — gates B3/B4

```powershell
cd LED-Display_G6_Firmware_Arena
git fetch origin && git checkout feat/ai-12bit-g3-gain
pixi run deploy-performance         # compile + upload (auto-detects the Teensy; close any monitor first)
pixi run test-serial                # HIL pytest over USB-CDC (add -- --port COMx if auto-detect fails)
```

B3 (F1): 0xA4 is 5 bytes with the 12-bit flag; analog plan § 5.1 T1 ground cap ≈ 0 mV; T2
linearity −10…+10 V vs a DMM within 30 mV; CL2: Mode 4, gain 10, +1 V → AO `frame_number`
sawtooth = **100 fps**, −1 V reverses, gain 5 → 50 fps. Pass → merge fw #46, retarget #47.

B4 (F2): `git checkout feat/ai-calibration`, deploy, `pixi run test-serial`
(`AI_CAL_DESTRUCTIVE=1` for the EEPROM-writing tests — bench board only). From the Studio
(#191, advanced mode): two-point calibration per channel — the firmware now REFUSES an implausible
point (open must read near full scale, ground mid-range) and refuses any calibration while the
display runs; ±5 V vs DMM within 20 mV; power-cycle keeps the record; Clear → flags 0;
`/config/analog_cal.json` appears on the card; Mode 4 zero input + deadband → no drift.
Pass → merge fw #47, then #191.

## 6. Gotchas that bit this week

- **PR CI runs only when the base is `main`** — retarget, wait for green, then merge.
- **Squash-merging a stacked PR's parent leaves the child conflicting** — rebase the child (git drops
  the duplicate commit) rather than merging main in.
- **`pixi.toml`'s `test =` is one line**; every PR that adds a test conflicts with every other —
  resolution is always "keep every test".
- **The Studio footer** (`Arena Studio vX | YYYY-MM-DD HH:MM ET · GitHub`) conflicts on every
  rebase of #191 — keep v0.75 with a fresh ET timestamp. Never Prettier the HTML.
- A `cmd | tail -1` chain hides a failed `git rebase`; check `git diff --diff-filter=U` before pushing.
- Pages serves main only; bench-test branches via `pixi run serve`. Hard-refresh after deploys
  (ES-module cache).
- macOS Chrome loses bytes on bulk SD reads (#153) — Windows Chrome is unaffected.
- The Console `send()` helper returns the reply frame even on a firmware error status — always
  decode the status (`Wire.decodeResponse`), never test truthiness.

## 7. What to report back

Per gate: pass/fail per row, the run's `.jsonl.gz` path in the data repo, any ⚠ text from the
run banner, and — for analog — the sweep summary line and calibration record. Anything failing:
the Console log (Copy button) and the bridge terminal output.

## 8. Open items nobody should be surprised by

`codex-review-2026-09-09.md` § 2: large-commit retry (before the first multi-hour run), ack
correlation, Console-trial poller gate, auto-switch AO mode, safe-mode policy for the sweep.
Telemetry ring-buffer proposal (`controller-telemetry-ring-buffer-proposal.md`) awaits the
group's § 6 decisions; its bench work (T1–T6, L1–L4) starts after that, on a test firmware branch.

## 9. Time permitting: a tiny bench launcher (so nobody types commands at the rig)

A small window with a few buttons and a status line, nothing more. Purpose: the experimenter
should never open a terminal to start FicTrac or the bridge.

Buttons:

- **Launch FicTrac** — runs the FicTrac executable with the rig's config file.
- **Configure FicTrac** — runs FicTrac's interactive configuration routine (`configGui`, the
  click-on-the-ball ROI/mask tool) on the same config file.
- **Launch bridge** — runs `pixi run bridge` from the webDisplayTools checkout (optionally with
  the FicTrac port if it differs from 60000).
- **Open Studio** — opens the Studio URL in Chrome (Pages, or `pixi run serve` + localhost when
  bench-testing a branch).

Status line per process: not running / running (pid) / exited with code N, plus the last few
lines of the bridge's output (it prints the log file name and `[cfg] applied …`). Buttons turn
into **Stop** while a process runs; closing the window asks before killing children.

Keep it boring:

- Python + tkinter, run from the webDisplayTools pixi environment (`pixi run launcher`), so there is
  nothing to install beyond what § 1 already lists. A `.bat` on the desktop can start it.
- One small config file next to it (`launcher.json`): path to the FicTrac executable and config
  GUI, path to the rig's FicTrac config, path to the webDisplayTools checkout, FicTrac UDP port,
  Studio URL. First run: if a path is missing, a file picker asks once and saves it.
- Subprocesses via `subprocess.Popen`; read their stdout on a thread into the status box; never
  block the UI. No auto-restart, no daemons, no tray icon.
- Lives in `fictrac-bridge/launcher.py` (same folder as the bridge, same pixi env) with a pixi task
  `launcher = "python fictrac-bridge/launcher.py"`. A short section in `fictrac-bridge/README.md`.
- Windows-first, but nothing Windows-specific in the code beyond the default executable name.

Not for today unless B1 is done and merged. It changes nothing in the run-log path, so it can
land as its own small PR whenever.
