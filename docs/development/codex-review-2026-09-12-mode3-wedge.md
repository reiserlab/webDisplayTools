# Codex (gpt-6-astra) adversarial review — Mode-3 wedge campaign status + branch diff — reconciliation

**Date:** 2026-09-12 · **Reviewer model:** `gpt-6-astra` (standard + adversarial passes, both runs) ·
**Inputs:** `docs/development/mode3-wedge-status-2026-09-12.md` (plan/status review, run
`codex-plan-review-20260912-114033-86155`) and the branch diff `main...claude/mode3-wedge-soak`
(5,597 lines, 31 files, run `codex-diff-review-20260912-114034-86380`). Claude's independent
analyses were written first: `claude-analysis-20260912-status.md`, `claude-analysis-20260912-diff.md`.

Verdict legend: **VERIFIED+FIXED** (reproduced against the code, fixed on the branch this pass),
**ACCEPTED** (correct; addressed in docs/plan), **PARTIAL** (correct in part; what was done and what
was not), **DEFERRED** (correct; not done now, with reason), **REJECTED** (with evidence).

## A. Status / plan review (what changed since the approved plan, bench results, T4 plan)

| # | Codex finding | Verdict | Action |
|---|---|---|---|
| A1 | Post-reset order re-enters the SD path (probes) before reading the evidence (breadcrumb, ring). | **VERIFIED+FIXED** | `studio-postmortem.js resetAndReconnect`: identity → GET_HEALTH → ring drain (`afterReconnect`) → *then* `probeOnce('post-reset')`. Duplicate drain in `run()` removed. Documented as §4b "manual capture procedure" and the LAB-212 primitive. |
| A2 | Telemetry ack must mean *stored*, not *parsed*. | **VERIFIED+FIXED** | Drainer advances `lastSeq/ackSeq` only when `onRecords` returned non-false; `notStored` counter; Studio's sink returns the bridge's acceptance (`logRows` → boolean, false when not logging/connected); `drainAll` stops on a refusal. Tests: refusal keeps the cursor, retry re-sends the same ack, records counted once. |
| A3 | FRAME `sd_load_us` as u16 saturates at 65 ms; the 129 ms tail already seen would not fit. | **VERIFIED+FIXED** | Both sides u32 (firmware FRAME record 20 B; host decoder `plen ≥ 10`, `u32(p+4)`, `spi u16(p+8)`); fixture uses 129000. |
| A4 | Analyzer should show the *previous boot's* records that arrive after the boot record (post-reboot drain). | **VERIFIED+FIXED** | `wedge-scan.py`: at every `cs boot` record the preceding tail is snapshotted (`_ctl_pre_boot`) and printed per boot under `--verbose`, alongside the pre-onset tail. |
| A5 | Ring at a fixed OCRAM address: heap can grow into it; commit ordering under reset. | **ACCEPTED** (firmware) | Ring firmware (`ac4c08f`): `__brkval ≥ base−4 KiB` guard at begin/append/`service()`; on collision the ring is disabled and header flag bit 2 set (host shows "RING DISABLED"); commit order eviction→record→header each cache-flushed (OCRAM is write-back); boot keeps a valid header and truncates at the first inconsistent record; static_asserts on the address range vs breadcrumb/CrashReport. Pre-T4 gate §4c requires an interrupted-write test on the bench. |
| A6 | Background-tab throttling: 8 chunks per poll cannot keep up with 286 Hz production (~10 KB/s). | **VERIFIED+FIXED** | `maxChunks` default 40 (≈7 KB/poll, ~70 KB/s at 10 Hz; ≥ 7 KB/s at a 1 Hz throttled poll); `maxBytes` 178 = the firmware's clamped budget (196 − 18 B header). |
| A7 | "H3 (host/Chrome) out" is overstated — pyserial saw the wedge, it did not *cause* nothing. | **ACCEPTED** | Status doc §2/§3: H3 *narrowed* (not needed to observe; not excluded as a trigger) pending the pyserial soak arm from a clean boot. |
| A8 | T4 ≠ T1: an events-only soak validates one operating point, not drain capacity; keep a synthetic T1. | **ACCEPTED** | Firmware synthetic producer (SET_TELEMETRY bit 7 + rate; header flag bit 3); plan §4.3 keeps a reduced T1 (5/12.6/50 KB/s, fg/bg tab, pyserial vs Chrome) for a soak break. |
| A9 | Time-box the instrumented arm; a stock control night runs regardless of another wedge; compare exposure, not iterations. | **ACCEPTED** | Plan §4.4: ≤ 2 nights or 40 iterations, then stock `arena-2x10-local` night + pyserial night; exposure (streaming hours, delivered 0x70s) is the unit; censored clean exposure reported. Soak iteration-end rows now carry `applied_0x70` and `duration_s`. |
| A10 | The bootloader recovery route is provisional (HID attach failed once on macOS; Windows lab PCs untested). | **ACCEPTED** | Documented as provisional in §2/§4b; LAB-212 keeps it as the *candidate* primitive; an on-device WDOG the ring survives is the complement. |

## B. Diff review (`main...claude/mode3-wedge-soak`)

| # | Codex finding | Verdict | Action / evidence |
|---|---|---|---|
| B1 | **Fault run exports/commits before diagnostics finish**; the terminal event fires before `stopAcked` is computed, and the export closes the bridge file. | **VERIFIED+FIXED** | Runner: the terminal event is now emitted from `finally` *after* the best-effort STOP, so the serialized summary carries `stopAcked` (254/254 runner checks). Studio: `onRunFinished` defers the auto-commit when the outcome is `CONTROLLER_FAULT`; `handleControllerFault` runs the deferred commit in its `finally`, after probes + ring dump. |
| B2 | **"Recovered" accepted a missing MAC and one fast answer among timeouts.** | **VERIFIED+FIXED** | Identity requires a decoded ok 0xC2 reply and, when the unit's MAC is known, the same MAC (a MAC-less reply fails). Recovered additionally requires `timeouts === 0`, `errors === 0`, `failedRequired === 0` (SD-image probes 0xE3/pattern_info are `optional`: their *latency* is the datum). New tests: MAC-less reply → `reset-failed`; one answer + timeouts → `reset-failed`. |
| B3 | Ack advances before storage (same as A2). | **VERIFIED+FIXED** | See A2. |
| B4 | Tagged telemetry rows (`cc`/`cf`/`cs`) are parsed as FicTrac samples by the replay reader (hex string as heading). | **VERIFIED+FIXED** | `js/runlog-replay.js` and the dashboard `analysis-core.js` skip string-tagged arrays other than `"a"` (which the normalizer already decodes). Tests in both suites. Rule added to CLAUDE.md: readers must treat any string-tagged array row as a stream, not a sample. |
| B5 | `health` capability ≠ telemetry; SET_TELEMETRY on health-only firmware = unknown opcode + error glyph (violates the no-blind-probe rule). | **VERIFIED+FIXED** | The 0xC2 capability byte is full (bit 7 = health). Firmware (`ac4c08f`): GET_FIRMWARE_VERSION `flags` bit 2 = ring compiled in; host decodes `telemetry` and gates SET_TELEMETRY **only** on it. Post-mortem: capability-gated probes are *skipped and recorded* when capabilities are unknown (0xC2 dead); test asserts 0xCA/0xCB are never sent blind. The Console's manual "Controller health" button stays user-initiated. |
| B6 | Reconnect skips identity when cached `firmwareVersion`/`controllerId` exist — a reflashed controller keeps its MAC. | **VERIFIED+FIXED** | `identityOnConnect` never short-circuits; `firmwareVersion` is cleared and re-read on every link-up (0xC2/0xCB are ~2 ms RAM reads). |
| B7 | Post-mortem ownership is advisory: an in-flight drain continues; analog polling ignores the flag. | **VERIFIED+FIXED** | Drainer exposes `idle()`; `handleControllerFault` stops the poller and awaits `idle()` *before* the quiet period; `aiCanPoll` yields to `_activePostmortem`; the poller restarts only after a recovered, identified link. |
| B8 | Instrumentation runs on every compatible connection with no off switch (no telemetry-off comparison arm). | **VERIFIED+FIXED** | Debug ▾ "Telemetry ring: on/off" (remembered, `studio_telemetry`); `run_metadata.telemetry` already records `ring-10hz`/`off`; `stopTelemetry()` shutdown path when the firmware lacks the ring or refuses 0xA8 (fixes the "poller keeps running on incompatible firmware" case). |
| B9 | Analyzer and live detector disagree: rejects + declared fault → `clean`. | **VERIFIED+FIXED** | `wedge-scan.py` captures the runner's `summary.fault` (and `phase: 'fault'`); outcome `fault-declared` when no timeout signature; `declared_fault` column. Test with rejects + declared fault. |
| B10 | Malformed `["cc"]` row: bridge writes it, analyzer crashes with IndexError. | **VERIFIED+FIXED** | Bridge `write_rows` enforces per-tag minimum lengths (`cc` 7, `cf` 8, `cs` 7; generic 2); analyzer drops and counts rows shorter than 4 (`ctl_malformed`). Tests both sides. |
| B11 | Soak preflight freshness only; a simulator that dies mid-trial yields a normal "completed" iteration. | **VERIFIED+FIXED** | Iteration-end records `applied_0x70` and `duration_s`; below 5 Hz average (or 1000 total) the outcome is `unexercised`, logged and warned, never counted as clean exposure. |
| B12 | A timed-out write is not cancelled: `Promise.race` releases the queue while the `WritableStream` may still deliver (e.g. STOP crossing the recovery boundary). | **DEFERRED** | Correct. The observed wedge had writes completing (USB ACKed) with total silence, so this does not affect night-1 evidence. Mitigation already present: quiet period + `flushRx` before the confirm probe, and reconnect tears the streams down. Proper fix = transport generation invalidated on write timeout (refuse ordinary sends until reconnect). Proposed as a follow-up issue in the status doc; not built this pass. |
| B13 | Tests establish component behavior, not lifecycle (adapter test hand-supplies `stopAcked`). | **PARTIAL** | B1's fix makes the real terminal event carry `stopAcked`; the runner suite exercises the emit-after-STOP order. A true runner→adapter→export integration test (and a browser test of deferred commit) is still owed — listed in the pre-T4 gate. |
| B14 | Session-owned lifecycle (`running → stopping → diagnosing → finalizing → idle`) instead of HTML orchestration through globals. | **DEFERRED** | Agreed as the right shape for the self-healing runner (LAB-212 / #197); the deferred-commit + exclusive-link fixes above are the minimal version. Recorded in the #197 design notes rather than refactoring `ArenaSession` during the campaign. |
| B15 | Ship telemetry as an opt-in sidecar until readers support tagged streams. | **REJECTED** (with B4 fixed) | Both known readers (Studio replay, dashboard analysis-core) now skip tagged rows, with tests; `stream_schema` is declared per file; the ring is off by default when the firmware lacks it and one click off otherwise. The sidecar's cost (a second artifact per run) outweighs the remaining risk for bench-local soak logs. Third-party readers of `behavior_v2` should follow the CLAUDE.md rule. |
| B16 | Python suites not run in the sandbox. | n/a | Run here: `test-wedge-scan.py` 101/101, `test-bridge-behavior.py` 128/128, full `pixi run test` green. |

## C. Not changed on Codex's advice (with reasons)

- **Halt-first on the campaign's first fault** stays (Michael's decision; evidence over uptime).
- **Frame-cache fix candidate stays held** until a breadcrumb/ring readout points at a spin.
- **Flashing the ring firmware waits for a human at the bench** (night-1 lesson; HalfKay HID attach was intermittent once).

## D. Follow-ups this review created

Tracked: deferred items B12/B13/B14 → [reiserlab/webDisplayTools#200](https://github.com/reiserlab/webDisplayTools/issues/200); firmware deferrals → [reiserlab/LED-Display_G6_Firmware_Arena#54](https://github.com/reiserlab/LED-Display_G6_Firmware_Arena/issues/54).

1. Pre-T4 evidence gate (status doc §4c) — bench items: interrupted-write test, background-tab drain budget, recovered-dump fixture.
2. Proposed issue: transport generation on write timeout (B12).
3. Integration test runner→adapter→export for `stopAcked` and the deferred commit (B13).
4. Session-owned lifecycle as the design basis for LAB-212 (B14).
