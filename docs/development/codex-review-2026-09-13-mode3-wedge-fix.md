# Codex (gpt-6-astra) plan review — wedge #5 evidence + free-running-timer fix — reconciliation

**Reviewed document:** `mode3-wedge-evidence-2026-09-13.md` (00:10 ET). **Run:**
`.codex-review/codex-plan-review-20260913-003729-27353/` (standard + adversarial; a first launch stalled
on stdin and was relaunched with `< /dev/null`). Claude's independent analysis, written first:
`.codex-review/claude-analysis-20260913-evidence.md`. Firmware under review: `4860fef` (baseline) and the
free-running candidate `eca07f6` on `feat/telemetry-ring-2x10`.

## The finding that changes the picture (verified)

Codex pointed at the Teensy core's `IntervalTimer`. Checked in the installed core
(`framework-arduinoteensy` 1.160.0, `cores/teensy4/IntervalTimer.cpp`):

```c
void IntervalTimer::end() {
    funct_table[index] = nullptr;   // 1. callback removed FIRST
    channel->TCTRL = 0;             // 2. channel disabled          <- captured PC 0x212f4
    channel->TFLG = 1;              // 3. flag cleared
    ...
}
static void pit_isr() {
    // the flag is cleared ONLY when the callback is non-null
    if (funct_table[0] != nullptr && channel->TFLG) { channel->TFLG = 1; funct_table[0](); }
    ...
}
```

If the PIT interrupt is taken between store 1 and store 2 (the timer expires in that window), `pit_isr`
runs with a null callback, does not clear `TFLG`, returns, and is immediately re-entered — an interrupt
storm at the PIT's NVIC priority (128) for as long as the main context would need to execute store 2,
which it never gets to do. Consequences, all matching what we saw:

| Observation | Storm reading |
|---|---|
| PC parked on `channel->TCTRL = 0`, main context never advances | the interrupted context's return address is exactly store 2 |
| watchdog IRQ (priority 0) still runs and captures | it preempts the storm; a capture during the storm's exception tail-chain sees the main frame |
| USB stays enumerated; 134-baud bootloader route works (#2–#4) | `IRQ_SDHC1` is at priority 96 (preempts the storm); `IRQ_USB1` (113) shares priority 128 with the PIT (122) and wins the NVIC tie-break (lower IRQ number first) on every storm iteration — both ISRs still run, only thread mode is starved (corrected 01:15: the first draft said both were at 128) |
| host USB *writes* stall 1–3 s, then silence | the CDC rx buffers fill (nobody in `loop()` drains them), the device NAKs, the host write blocks |
| breadcrumb `OP_CMD`/0x70 before the SD marker (#2–#4), `cmd_disarm_timer` (#5) | the disarm is the first step of `handleSetFramePosition`, before `loadFrame` |
| no CPU fault, empty crash record, display holds the last frame | nothing faults; the refresh callback is null so nothing refreshes |
| power cycle vs MCU reset intervals | not explained and not needed — MCU reset clears the PIT; the interval pattern reads as chance |

**Quantitative check.** Isabel's aggregate: ~292 k good 0x70s per failure → per-disarm probability
≈ 3.4 × 10⁻⁶. With a 300 Hz GS16 refresh (3.33 ms period) that is a window of ≈ 11 ns ≈ 7 cycles at 600 MHz.
The exposed window is one or two instruction boundaries plus interrupt recognition — the same order of
magnitude. No other mechanism on the table predicts the failure rate at all. Our own five wedges (33 k to
~750 k commands apart at 100–200 Hz) sit in the same range.

**What it does not yet prove.** One capture. In a storm, most watchdog captures would land *inside*
`pit_isr` (handler context); ours shows the main context, which the tail-chain/late-arrival path
allows but does not make the most likely outcome. The discriminator is cheap: capture the stacked
xPSR (IPSR field: 0 = thread, 138 = PIT handler) and the watchdog handler's `EXC_RETURN` at the next
capture, and count PIT interrupt entries. Both are in the follow-up firmware commit (below).

## Findings table

| # | Finding (Codex) | Verdict | Action |
|---|---|---|---|
| P1 | **[High]** `IntervalTimer::end()` null-callback / `TFLG` race → PIT interrupt storm; the PC does not prove a stalled store. | **VERIFIED** in the installed core; quantitative fit to the failure rate (above). | Evidence doc §2 rewritten as competing explanations; storm is now the leading reading, bus hang the alternative. |
| P2 | **[High]** The race survives at the remaining `disarmRefreshTimer()` sites (STOP/ALL_OFF, pattern entry, streaming entry, ALL_ON, error glyph). Free-running only reduces exposure. | **VERIFIED** | Follow-up firmware commit: `disarmRefreshTimer()` masks interrupts (PRIMASK save/restore + DSB) around `end()`. Nothing else inside the critical section. |
| P3 | **[High]** The A/B (free-running vs baseline) is not a clean mechanism discriminator: SPI traffic, turnaround and host backpressure all change; a disappearing wedge does not uniquely implicate PIT churn. | **ACCEPTED** | Mechanism proof moves to (a) the context capture at the next wedge, (b) a bench stress reproducer (tight `end()`/`begin()` loop against a fast timer — should wedge the baseline core in seconds), (c) a "mechanism arm" build = baseline scheduling + safe disarm only. Soak statistics are the fix's *reliability* evidence, not its *mechanism* evidence. |
| P4 | "Watchdog touches only OCRAM" is false (`micros()` reads DWT, `sealIsr()` does cache maintenance); SD silence is parser silence, not SD-peripheral evidence. | **ACCEPTED** | Evidence doc corrected. |
| P5 | Shrinking intervals / power-cycle observation mixes recovery methods, firmware, rates; does not identify external state. | **ACCEPTED** | Kept as provisional; under P1 it needs no explanation. |
| P6 | Timer lifecycle contract missing (arm from stopped state, same-rate no-op, rate change, failed load, `begin()` return value ignored). | **PARTIAL** | `eca07f6` already tracks `armed_hz_` (same rate → no PIT access; different → re-begin) and arms on SHOW_FRAME entry/rate change; ALL_ON/error/ALL_OFF paths keep their arm/disarm (agent's audit table in the fw README). `begin()`'s boolean still ignored → fw #54. |
| P7 | Acceptance tests beyond a wedge-free soak (rates × transitions × failed reads × forced-window interrupt). | **DEFERRED** (close-out) | Listed for PR F2; the forced-window interrupt test is the stress reproducer of P3(b). |
| P8 | Strengthen the capture: stacked xPSR, `EXC_RETURN`, stack address; keep ELF + core version per build. | **VERIFIED+FIXING** | Follow-up commit: xPSR + `EXC_RETURN` in the `'H6IR'` record, surfaced at boot as ring STATE kind 8 (no GET_HEALTH change, no version churn); PIT ISR trampoline (ISR id 7) with a saturating count surfaced as STATE kind 9. ELFs kept per SHA. |
| P9 | Separate performance acceptance from reliability acceptance; FRAME records exclude repeated transfers, so count total SPI transfers too. | **ACCEPTED** | Morning analysis reports refresh ISR count, PIT entries, transfers, changed frames, accepted 0x70s, SD reads, RTT, telemetry loss separately. |
| P10 | Predefine matched exposure blocks and a stopping rule; zero failures in T h ⇒ 95 % upper bound ≈ 3/T per hour; one night is weak against a 7 h clean baseline stretch. | **ACCEPTED** | Plan: matched 100 Hz blocks primary, 200/286 Hz secondary, cold-start vs post-wedge blocks separated, clean hours reported as censored exposure. Mechanism evidence (P3) carries the weight, not the night count. |
| P11 | Alternatives: schedule refresh deadlines in `loop()`; GPT/TMR only with scheduling policy held constant; frame preparation vs presentation split. | **ACCEPTED** (recorded) | Not for this campaign; fw #54 discussion. The free-running change is kept as the display-starvation fix on its own merits. |
| P12 | Free-running still permits long freezes (an 88 ms SD read = 26 refresh periods); no maximum frame age; overload contract undefined. | **ACCEPTED** (recorded) | Pre-existing; the SD-jitter work is the parallel session's (handover doc). |
| P13 | Malformed/stale requests re-enter transition paths; a clean valid-input soak does not exercise them. | **ACCEPTED** | With P2 the transition paths are safe by construction; still on the F2 test list. |
| P14 | Reversibility: code trivially reversible; skipped/late stimuli are not. Treat data collected under the new timing policy as attributable. | **ACCEPTED** | 0xCB flags bit 4 identifies the variant in every run log. |

## Decisions taken tonight (autonomous, under Michael's standing order)

Michael's order: at the next near-identical wedge, flash the free-running build and continue soaking;
have Codex adversarially review the evidence, the fix and the new firmware. Under P1/P2 the build to
flash is **`eca07f6` + the follow-up commit** (safe disarm at the remaining sites, PIT ISR count, watchdog
context capture). Codex diff review of `4860fef..eca07f6` is running; the follow-up gets its own diff
review before flashing. Until a wedge, the soak continues on `4860fef8` at 200 Hz + jumps.

## For the morning (Michael's call)

1. **Stress reproducer** (10 min of bench time, definitive if positive): a debug build that hammers
   `refreshTimer.end(); begin()` with the timer at a few kHz — the baseline core should storm within
   seconds; with the PRIMASK-guarded disarm it should not. Positive reproduction beats any number of
   clean soak hours.
2. **Mechanism arm** for one night: baseline per-command disarm kept, safe disarm only — if it is clean
   while disarming 200×/s, the race is the wedge.
3. **Upstream**: the core bug is reportable to PJRC (`IntervalTimer::end()` ordering / `pit_isr` flag
   clear). Hold until the reproducer confirms.
4. **fw #50 comment** with the mechanism, the quantitative check and the discriminators — outward-facing,
   so not posted tonight.

## Firmware diff review 1 — `4860fef..eca07f6` (free-running refresh + driver-vector ISR markers)

**Run:** `LED-Display_G6_Firmware_Arena-ring/.codex-review/codex-diff-review-20260913-004245-34339/`.
Verdict from Codex: keep the timer policy; do not flash the combined patch as-is. Every fixable item went
into the follow-up commit `5e6a78c` (reviewed separately below).

| # | Finding | Verdict | Action |
|---|---|---|---|
| D1 | `isrEnterLite/isrExitLite` read-modify-write the shared lite record without masking; a nested wrapped ISR loses a count and leaves the checksum inconsistent (Codex reproduced it in a model). | **VERIFIED+FIXED** (`5e6a78c`) | Both hooks are PRIMASK-preserving critical sections; still no cache flush per interrupt. |
| D2 | Tests verify declarations (0xCB bit 4, accepted ISR id range), not free-running behaviour; the frame-storm test sleeps longer than a refresh period. | **DEFERRED** (fw #54) | Display-cadence HIL tests listed; the bench measures FRAME/ISR-count progress directly tonight. |
| D3 | The trampoline banner uses `DBG_PRINTF`, gated on a flag that is false during `setup()` — unreachable. | **VERIFIED+FIXED** | `SentinelPrint` boot path. |
| D4 | The watchdog IRQ overwrites `isr_last` with `ISR_WDOG`, losing the identity of what was active; lite markers are not flushed when the hang is with interrupts masked. | **VERIFIED+FIXED** (identity) / **ACCEPTED** (persistence) | Prior `isr_last` captured into the `'H6IR'` record and surfaced in STATE kind 8; the un-flushed-marker case falls back to the watchdog PC (fw #54). |
| D5 | `armRefreshTimer` ignores `IntervalTimer::begin()`'s boolean → a failed allocation becomes a sticky "already armed". | **VERIFIED+FIXED** | `armed_hz_` committed only on success; failure leaves it 0 and records `STATE(telemetry, 0xED, rate)`. |
| D6 | New test asserts every `OP_CMD_DISARM` breadcrumb has arg 0; records written by the base firmware carry 0x70 (wedge #5's). | **VERIFIED+FIXED** | Test accepts {0, 0x70}. |
| D7 | Use `IntervalTimer::update()` for rate changes (LDVAL only) instead of `begin()`. | **DEFERRED** (fw #54) | Rate changes are per-trial; with the guarded `end()` the race is closed regardless. |
| D8 | README claims: "0x70 never touches the PIT" (showError/rate changes/transitions still do), "≤ one refresh period" latency (unbounded by SD + loop work), geometry-protection justification (PSRAM paths change `block_byte_count_` without disarming). | **VERIFIED+FIXED** (wording) | Steady-state wording; latest-request-wins with measured, not guaranteed, latency; kept disarm sites = explicit transition semantics. |
| D9 | `soak_mode3.py` does not request 0xCB, so pyserial logs would not carry the variant bit. | **DEFERRED** (fw #54) | Not used tonight (Studio path carries `run_metadata.firmware`). |
| D10 | Split instrumentation from the timer change; pin the core version; vector ownership is an undocumented dependency. | **ACCEPTED** (recorded, fw #54) | One controller, campaign build; `wrapPitVector()` re-installs after every `begin()`, which is the one known re-attach. |
| D11 | STOP disarms before its dark frames — if the disarm hangs, blanking never runs. | **VERIFIED** | Exactly the storm case; closed by the guarded `end()` in `5e6a78c`. |
| D12 | No new frame-buffer race under the main-loop model. | agrees | — |

## Firmware diff review 2 — `eca07f6..5e6a78c` (guarded disarm, PIT marker, watchdog context)

**Run:** `.codex-review/codex-diff-review-20260913-005700-46985/`. Codex: no blocker; the guarded `end()`
addresses the race; the diagnostics needed another pass. Folded into a third amended commit (agent round 3).

| # | Finding | Verdict | Action |
|---|---|---|---|
| E1 | The FULL hooks (`isrEnter/isrExit`, refresh + DMA) mutate the record before `sealIsr()` masks; a nested lite-hook ISR (SDHC at 96) loses a total count; `isrExit()` writes `ISR_NONE` instead of restoring the enclosing id, so the PIT trampoline's marker is clobbered after the refresh callback. | **VERIFIED+FIXING** | Full hooks save/restore like the lite hooks; whole update masked, then seal. |
| E2 | PRIMASK masking around `end()` also masks the watchdog IRQ — if the alternative reading (stalled peripheral store) were true, the hang would happen unmasked-capture-free. | **VERIFIED+FIXING** (adopted) | Mask only `IRQ_PIT` at the NVIC (+ DSB/ISB) around `end()`; the watchdog stays live. A pended PIT interrupt runs afterwards with a null callback and a cleared `TFLG` — no storm. |
| E3 | `STATE(telemetry, 0xED, rate)` for a failed `begin()` decodes as a telemetry configuration. | **VERIFIED+FIXING** | New STATE kind 10 `timer_fail` (arg = rate); host decode landed. |
| E4 | README's storm model says USB/SDHC share 128; SDHC is 96. | **VERIFIED+FIXING** | fw README + this doc + evidence §2b corrected. |
| E5 | Decoders recognise only EXC_RETURN 0xF9/0xF1; FP-stacked returns are 0xE9/0xE1. | **VERIFIED+FIXING** | Mode from bit 3; host `excReturnMode` + wedge-scan consistency flag. |
| E6 | The retained ISR record moved (0x2027FF20 → 0x2027FEC0) without invalidating the old location — rollback could harvest a stale record. | **VERIFIED+FIXING** | Clear the old location's magic at boot; kind 8/9 emission gated on this boot's SRC_SRSR watchdog bit. |
| E7 | The pre-reset window (~128 bus clocks) now has to checksum 23 words and flush 3 lines; unverified. | **ACCEPTED+MITIGATING** | Context fields first, sealed and flushed first; bench starve test (`SET_TELEMETRY 0x31`) immediately after flashing must yield a decodable kind-8 record before the soak restarts. |
| E8 | `armRefreshTimer` returns void; callers acknowledge a display state with no timer. | **DEFERRED** (fw #54) | One PIT timer in the firmware; failure is theoretical. |
| E9 | Count saturation (≈ 10 days at 300 Hz) without a flag; 32-bit wrap. | **DEFERRED** | Diagnostic build; boots are hours. |
| E10 | Instrumentation latency (masked sections on every refresh/DMA/USB/SDHC/PIT entry) unmeasured. | **ACCEPTED** | Diagnostic build; the stock control night is the isolation. |
| E11 | `soak_mode3.py` does not drain the crash records after reset. | **DEFERRED** | Studio path drains them (`afterReconnect`). |
| E12 | No last-known-good capsule; a reset mid-writeback loses context and counts together. | **DEFERRED** (fw #54) | E7's ordering limits the loss to the counts. |
| E13 | "Split mitigation from diagnostics." | **REJECTED** for tonight | One controller, standing order; recorded for PR F2. |
