# Safe mode + Live oscilloscope — review & bench checklist

Work-through checklist for everything built on this branch. Delete this file once
merged — it's a working handoff doc, not a permanent reference.

**Where it lives:** branch `claude/distracted-bardeen-51d651`, 9 commits on top of
`main` (`408ce10`), **not pushed** (your E2E-before-main workflow):

- `b524cef` — safe mode (v0.14)
- `8608e4f` — live oscilloscope (v0.15)
- `a41972e` — full-width scope + behavior_v1 logging default (v0.16)
- `9ba6840` — run-logging level is a File-menu runtime setting (v0.17)
- `c4a7406` — **fix:** scope LED overlay on/off + working auto-Y (v0.18)
- `42e77eb` — **safe mode reworked:** view-everything, block-only-destructive (v0.19)
- `363f49b` — docs: safe-mode spec revised to the v0.19 model
- `5e2060b` — **fix:** FicTrac col-22 timestamp ns→ms for behavior_v1 (v0.20)
- `c454371` — run-log→scope replay adapter + offline Python bridge test

> The three items in **bold** are the fixes/reworks added after the original
> v0.14–v0.16 build; each has its own section below. Studio is now **v0.20**.

---

## 0. Decision for you (non-blocking — a sensible default is in place)

- [ ] **Log-level authority.** The runner *asserts* `behavior_v1` to the bridge at run
  start, so it wins even if the bridge was launched with `--log-frames`. Keep this
  (recommended), or switch to "CLI flag wins" (drop the `bridge.setLogLevel(...)` call at
  run start). Tell me if you want the latter.
- [ ] **Console output drives in safe mode.** By decision, the analog/digital output drives
  (`caoset`/`cdoset`/`cdohigh`/`cdolow`) stay **available** to students. Confirm that's what
  you want, or say the word and I'll add them to `SAFE_BLOCKED_CMDS`.

## 1. Automated (should already be green)

- [ ] `pixi run test` → all suites pass, including the ones added this branch:
  - `test-kinematics.js` (39/39)
  - `test-arena-runner-g6.js` — now also asserts `LED_OFF_MV` export + `ledDrive 0%→off`
  - `test-runlog-replay.js` (29/29) — the replay adapter/parser
  - `test-bridge-behavior.py` (14/14) — **offline** bridge ns→ms unit test (Python; wired
    into the same `pixi run test` chain)
- [ ] `pixi run format-check` → clean **except** a pre-existing `tests/test-protocol-roundtrip-v3.js`
  warning that is **not** from this work (nonconformant on `main` too). Leave it.

## 2. Safe mode (v0.19 — view everything, block only destructive) — browser only

Reworked from the original whole-view lockout. Reset to safe between checks with the
console: `localStorage.removeItem('studio_advanced_unlocked')`, then reload.

- [ ] Plain load shows a **🛡 Safe mode** chip. **Run / Edit / Console tabs are all
  reachable** (no 🔒 on the tabs anymore).
- [ ] **Edit is READ-ONLY:** open a protocol, switch to **✎ Edit** → you can view/inspect the
  full protocol, but every edit is a no-op and a one-line "viewing read-only" banner shows.
  (`Studio.canMutate()` returns false in safe mode.)
- [ ] **Console is USABLE:** connect, query (`info`/`ip`/SD list), run a **test trial**, step
  frames, and the **analog/digital output drives** all work.
- [ ] **Destructive Console ops are greyed + refused** (banner on click, handler does not run):
  pattern add/delete (`csdpurge`, `csdarchive`, `cloadfile`, `crawsend`, `cispcopy`),
  panel/firmware programming (`cispbatch`, `cfwpick`, `cfwflash`), controller settings
  (`setpanelmode`, `setrate`, `setspi`, `sysreset`).
- [ ] **Bench setup stays instructor-only:** the GitHub/repo/bench-id block is visible but its
  unlock padlock (🔒) is hidden; the session-rig selector stays hard-locked.
- [ ] **Unlock:** click the **🛡 Safe mode** chip → password prompt. Wrong → stays safe (banner).
  Correct (**`reiser`**) → chip becomes **🔓 Advanced · lock**, destructive Console ops
  un-grey, Edit becomes mutable, rig/GitHub unlock.
- [ ] Reload → still advanced (remembered), URL clean (no `?advanced=1`).
- [ ] `arena_studio.html?advanced=1` on a *fresh* browser (clear the key first) → prompts; on
  success the URL keeps `advanced=1`. Click **🔓 Advanced · lock** → back to safe, view forced
  to Run, gating re-applied.
- [ ] **Run-lock (all modes):** during an active run, Edit/Console tabs are disabled — STOP
  before switching views.
- [ ] **Per-bench password:** set `localStorage['studio_advanced_pw']='yourpw'`, lock, unlock
  with it (built-in `reiser` is a fallback only when the custom one is unset).

## 3. Oscilloscope — browser with the simulator (no arena needed)

Terminal 1: `pixi run bridge`  ·  Terminal 2: `pixi run sim`  (bridge first).
Run view → dock **Scope**; Connect the bridge (ws://localhost:8765) via the BRIDGE button.

- [ ] Dock shows a **Log | Scope | —** switch; Scope spans the **full width** of the Run view.
- [ ] Three rows populate live (**turning** °/s, **forward** mm/s, **heading** °), newest at the
  right; status line shows FicTrac rate + sample count + ball ⌀.
- [ ] **auto-Y (v0.18 fix):** with auto-Y **on**, each trace auto-scales to its data. Turn it
  **off** → the Y range **freezes** (feed bigger swings and the axis labels stay put; the trace
  clips instead of rescaling). Turn back **on** → resumes auto-scaling.
- [ ] Controls: **win** (smoothing), **span** (10 s/30 s/1 min/5 min), **ball ⌀**, **clear**.
- [ ] Resize the dock via the top handle; **—** collapses; the choice is remembered.
- [ ] In **safe mode** the scope is visible and works (read-only) — students can watch.

## 4. LED overlay on/off (v0.18 fix) — BuckPuck is inverted

Run a protocol that drives the LED via **`ledDrive`** (BuckPuck: 0% = LED dark = 5000 mV;
brighter = *lower* mV) with an on interval then a `ledDrive 0%` off.

- [ ] The red **LED band** turns on only when the LED is actually emitting, and a mid-run
  `ledDrive 0%` **closes** the band (previously it read `mv>0` and stayed on forever).
- [ ] A raw `setAnalogOut 0` still reads off; a raw positive mV reads on. (Threshold =
  `LED_OFF_MV`, exported from `js/arena-runner-g6.js` — one source of truth.)

## 5. FicTrac timestamp units — the ns→ms fix (v0.20) ⚠ verify on real data

Found by replaying a real recorded run: this rig's camera emits FicTrac **col-22 in
nanoseconds**, but behavior_v1 treated it as ms, so all velocity channels collapsed to ≈0
(heading, a position, was fine). The bridge now divides col-22 by `FT_TS_NS_PER_MS`.

- [ ] With the sim: `ft` deltas in the logged behavior_v1 rows are ~**8.3 ms** at ~120 Hz (real
  milliseconds), and the scope shows non-zero turning/forward.
- [ ] **On a real course rig:** connect FicTrac and confirm the scope shows realistic
  velocities (turning up to hundreds of °/s, forward in mm/s) — **not** flat zero. If flat, the
  camera's col-22 unit differs; it's the single constant `FT_TS_NS_PER_MS` in
  `fictrac-bridge/bridge.py` (you confirmed all rigs are identical ns).
- [ ] `python tests/test-bridge-behavior.py` passes (guards the constant offline).

## 6. Run-log replay adapter + the demo movie (v-latest)

`js/runlog-replay.js` turns a recorded run-log into scope samples + run-status events (it
reverses the sanitized log shape and normalizes the v0.5 `trial-running` phase). Also feeds
the future offline dashboard.

- [ ] Watch the demo movie: **`~/Desktop/arena_scope_replay.mp4`** (15 s) — a real recorded run
  (bench02, 2026-07-06) replayed onto the scope with the ns→ms fix: real turning/forward/heading
  traces **with** trial boundaries + condition labels (`sq_rev_05`, …) + the green trial-display
  spans. This is the "does it break assumptions" verification you asked for — it doesn't.
- [ ] (Optional) the module is **not** loaded by `arena_studio.html` in production — it's for
  the replay/dashboard. If you want an in-Studio "replay a recorded run" button later, say so
  and I'll add the `<script src>` + a small UI.

## 7. Bench — real arena + real FicTrac (remaining confirmable items)

- [ ] **Turning sign:** confirm CW turning reads **positive**. If inverted, it's a one-place
  flip (`turningSign:-1` in `js/kinematics.js`) — ping me and I'll wire it as a rig/scope
  setting, not a constant.
- [ ] **Forward mm/s sanity:** the fly-on-ball rig declares `ball_diameter_mm: 9`
  (`configs/rigs/cshl_g6_2x10_ball.yaml` + `index.json`); the scope's **ball ⌀** field overrides
  per session.
- [ ] **Closed-loop unaffected:** a Mode-3 FicTrac run still drives the arena correctly (the
  scope only *reads* the bridge; the frame-apply path is unchanged).
- [ ] A freshly committed course runlog parses cleanly via `runlog-replay.js` for the dashboard.

## 8. Docs to skim

- [ ] `docs/development/arena-studio-release-notes.md` — v0.14 → v0.20 entries read right.
- [ ] `docs/development/safe-mode-spec.md` — the v0.19 revision banner matches the shipped model.
- [ ] `docs/development/analysis-dashboard-plan.md` §6 + `fictrac-bridge/README.md` — the
  `behavior_v1` contract (now with the col-22 ns→ms note), so the dashboard session inherits it.

## 9. Merge

- [ ] Review the nine diffs.
- [ ] Push the branch + open a PR (or merge to `main`). Not done automatically — your call.
