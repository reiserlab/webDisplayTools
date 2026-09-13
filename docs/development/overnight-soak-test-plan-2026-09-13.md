# Overnight soak — what exactly we are testing for (2026-09-13, candidate firmware `e59767e` + Studio v0.78)

Three questions, each with the metric, where it comes from in the log, the pass line, and the command that checks it.
The overnight run goes through the **Studio** (soak driver + bridge + simulator), not the browser-free harness:
only the Studio path exercises the run-log export ordering, the per-trial verdicts, the fault detector and the
post-mortem, which are most of what changed today. The browser-free campaign this afternoon is the pre-check.

**Run:** `protocols/soak_mode3_stress.yaml` (8 MB sine + 813 KB bar alternating, 60 s trials), simulator
`--rate 200 --seed 1 --jump-every 100 --jump-deg 90`, Studio `?advanced=1&soak=1`, File ▾ → Soak… with
`hours: 10, gapS: 10, firstFault: halt, policy: reset-continue, maxResets: 3` — one iteration ≈ 21 min, ≈ 28
iterations, ≈ 560 trials, ≈ 6 M frame commands.

## 1. Timing is perfect

| # | claim (what today's changes are supposed to guarantee) | metric | source | pass | check |
|---|---|---|---|---|---|
| T1 | **No controller wedge** (fw #50 fix: free-running refresh timer) | controller faults, resets, command timeouts | soak `iteration-end` events; `a` rows with `status null` | 0 faults, 0 resets, 0 timeouts | `wedge-scan.py soak-logs/` |
| T2 | **No display freeze** (SD fast path) | SD reads > 10 ms; per-trial verdicts | `cs` kind 4 (`sd_slow`), `cf` `sd_load_us`, `trial_quality` | 0 reads > 10 ms; every trial `pass`, 0 `unknown` | `telemetry-report.py` (stalls table + per-trial table) |
| T3 | **Request→display latency** (host 0x70 dispatch → SPI start, measured on the controller) | `req_age_us` p50 / p99 / max per file and per hour | `cf` field 9 | p99 < 5 ms, max < 10 ms at 200 Hz; no drift across the night (p50 within ±0.3 ms hour to hour) | `telemetry-report.py` per iteration file |
| T4 | **Round trip host-side** | `a`-row `dt` p50 / p99 | `a` rows | p99 ≤ 11 ms (Codex-agreed bound from #198), no upward trend | `wedge-scan.py` RTT columns |
| T5 | **Refresh cadence holds under load** | presented frames per second; `superseded` share; `timer_fail` | `cf` count / trial duration; `cf` field 10; `cs` kind 10 | ≈ commands with an index change; superseded < 2 % at 200 Hz; 0 `timer_fail` | `telemetry-report.py` (presentation section) |
| T6 | **Per-read cost, both files** (no size dependence) | SD read µs by step class (+1 / −1 / small / jump), sine vs bar | `cf` `sd_load_us` | +1 ≈ 0.62 ms; random ≤ 1.5 ms p50, ≤ 1.8 ms max, sine ≈ bar | `telemetry-report.py` step-class table |
| T7 | **Watchdog never fires** | boot count, `boot` STATE records, HEALTH `wdogFlags` "previous reset was watchdog" | ring header `boot_count` (soak `telemetry` stats), `cs` kind 1, morning `GET_HEALTH` | boot_count unchanged all night; 0 boot records; flag clear | soak events + Console health read in the morning |

## 2. The log files are complete

| # | claim | metric | source | pass | check |
|---|---|---|---|---|---|
| L1 | **Every iteration produced one committed run log** with the tail (v0.78 ordering fix) | per file: `run_metadata` (firmware label `e59767e5 … freerun sdfast`, `sd_card`, `sd_diag` 0), `stream_schema`, `trial_quality` event present, and it comes AFTER the last `cc`/`cf`/`cs` row | run-log `.jsonl(.gz)` | 28 of 28 files; `trial_quality` last among controller rows in every file | `runlog-check.py` (below) |
| L2 | **Nothing lost in the drain** | drainer stats at iteration end: `dropped`, `gaps`, `notStored`, `errors`; `cc` accepted 0x70 count vs `a` accepted count | soak `iteration-end.telemetry`; row counts | all four 0; counts equal ±1 per file | `runlog-check.py` |
| L3 | **Sequence continuity** across the night | ring `seq` of `cc`/`cf`/`cs` monotonic, no gap between files except at the ring's version/incarnation boundary (none expected) | rows field 3 | 0 gaps | `wedge-scan.py` `seq gaps` |
| L4 | **Per-trial read accounting closes** | `sd_reads` (kind 13) present for every trial and ≈ index changes + 1 | `cs` kind 13, `cc` rows | every trial has it; |reads − (index changes + 1)| ≤ 2 | `telemetry-report.py` per-trial table (`reads_fw`) |
| L5 | **Behaviour stream continuous** | FicTrac rows per trial ≈ 200 × 60 | numeric rows | ≥ 11,500 per trial | `runlog-check.py` |
| L6 | **Size and disk** | raw MB per iteration, gz MB after commit; free disk on the bridge machine | file sizes | ≈ 45 MB raw / ≈ 12 MB gz per iteration; ≥ 5 GB free before start (2.2 TB free today) | `ls -la`, `df -h` |
| L7 | **Verdict provenance** | `display_gap` events (if any) reference a trial and pattern that exist; `trial_quality.counts` add up to the trial count | events | consistent | `runlog-check.py` |

## 3. If a showstopper happens, we recover correctly

Nothing here is expected to trigger. Each row says what the log MUST show if it does, so a "recovered" night is
judged by evidence, not by the soak still running in the morning.

| # | event | expected chain | evidence that must exist | fail = |
|---|---|---|---|---|
| R1 | **Controller wedge** (commands time out) | fault detector trips (≥ 3 failed applies in 10) → run outcome `CONTROLLER_FAULT` → post-mortem: quiet, confirm 0xC2, typed probes, ring dump, crash report → `reset-continue`: 0x01 → reconnect → MAC verified → identity → soak continues | `iteration-end.outcome = fault`, `postmortem = recovered`; events `probe`, `telemetry_dump`, `crash_report`; the deferred commit contains `trial_quality` and the ring tail; next iteration starts within 2 min | any missing event; a second fault within `maxResets`; the soak halted with `postmortem = halt/error` |
| R2 | **Watchdog self-reset** (link drops mid-run) | outcome `CONTROLLER_FAULT` with `fault = link_dropped` (v0.78: decided before the outcome is derived) → self-reset path → HEALTH shows previous reset = watchdog + captured PC → ring `boot` record with the pre-reset tail intact → **panels dark after the reset** (boot blank) → soak continues, `resets` += 1 | `iteration-end.postmortem = self-reset`, `crash_report` event, `cs` kind 1 (`boot`) and kind 8 (`wdog_context`), `wedge-scan` counts one reset; morning HEALTH `prevWdogPcHex` valid | outcome stored as `ABORTED_BY_USER`; no `boot` record; the arena still lit after the reset (someone must look — it is why the drill below exists) |
| R3 | **SD stall recurs** (a read > 10 ms) | not a fault: the trial is `fail` (flagged), `display_gap` event with phase and read µs, the run and the soak continue | `display_gap`, `trial_quality.flagged_trials`, banner text in the Studio log | the trial `pass`; or the soak halting on it |
| R4 | **Simulator or bridge hiccup** | no FicTrac frames → soak `paused` (`no-frames`), waits up to 10 min, resumes; a bridge socket failure → `rows_not_stored` coverage → trials `unknown`, never `pass` | `soak.paused` / resume events; `unknown` counts explain themselves | trials `pass` through a bridge outage |
| R5 | **Drain falls behind** (background tab) | controller `dropped` > 0 → `seq_gap` coverage → affected trials `unknown` | `iteration-end.telemetry.dropped`, `unknown` trials with reason `seq_gap` | dropped > 0 with all trials `pass` |

### Recovery drill BEFORE the overnight (≈ 15 min, on the candidate build, Studio path) — exercises R2 and R3 on purpose

1. **Injected stall (R3 + the never-yet-seen Studio banner):** `await Studio.setSdDiag(3)`; run one 60 s bar trial
   (`Studio.runOnce(false)` on the standard soak protocol); expect ≥ 1 `display_gap`, the trial `fail`, the banner
   "⚠ stimulus quality: … flagged", `sd_layout` legacy+no-skip in the log; then `await Studio.setSdDiag(0)` and
   confirm `Studio.sdCard.sdDiag === 0` after a reconnect (persistence check).
2. **Injected watchdog reset (R2):** during a trial send `SET_TELEMETRY` with flags `0x31` (events on + watchdog bits
   present + starve): the controller stops kicking and resets in ~2 s → the link drops → expect outcome
   `CONTROLLER_FAULT` (`link_dropped`), post-mortem `self-reset`, `crash_report`, HEALTH previous-reset-was-watchdog,
   **and the panels dark** (look at the arena) — then the Studio reconnects and the next trial runs.
3. **Simulator kill (R4):** stop `pixi run sim` for 30 s during the soak gap; expect `paused no-frames` then resume.

If any drill step fails, the overnight does not start until it is understood.

## 4. Things changed today that the overnight does NOT test (flag, do not forget)

- Watchdog kicks inside panel firmware (ISP) updates — needs one real panel flash with the candidate build.
- Same-index skip after a DAC/LUT failure — needs an AO-mode trial with a disconnected DAC (bench).
- exFAT refusal of the legacy arm — needs an exFAT card.
- Firmware `main` port; log-format R1/R2; the deferred lists in the hand-off document §7.1.

## 5. Morning report (one pass, ~10 min)

```bash
pixi run python scripts/wedge-scan.py soak-logs/                       # T1, T4, L3, R1/R2 counts
pixi run python scripts/telemetry-report.py soak-logs/arena-log-*.jsonl*  # T2, T3, T5, T6, L4
pixi run python scripts/runlog-check.py soak-logs/arena-log-*.jsonl*      # L1, L2, L5, L7 (to be written: ordering, counts, provenance)
```
Fill the tables above with numbers, then §6 of `mode3-reliability-handoff-2026-09-14.md` ("Overnight benchmark").
Anything red → the log excerpt goes into the bench log with its ET time before anyone touches the controller.
