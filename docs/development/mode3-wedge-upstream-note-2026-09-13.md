# fw #50 — findings, fix, and upstream note (for Codex review before posting)

**Date:** 2026-09-13 09:30 ET. **Status:** REVIEWED (Codex run `codex-plan-review-20260913-093121-1139`, reconciliation below) — final texts ready for Michael: (A) the comment on reiserlab/LED-Display_G6_Firmware_Arena#50, (B) the upstream bug report to
PJRC (PaulStoffregen/cores). Reviewers should attack the correctness of the mechanism claim, the evidence chain,
the fix, the statistics, and anything in the upstream note that a core maintainer would push back on.

Supporting material: `mode3-wedge-evidence-2026-09-13.md` (§2b/§2c), `codex-review-2026-09-13-mode3-wedge-fix.md`
(four prior Codex passes), `mode3-wedge-night2-scan-2026-09-13.md` (per-run table), firmware
`tools/pit-race-repro/` (reproducer, commit `3ae478d` on `feat/telemetry-ring-2x10`), fix build `394dee45`.

## Facts the texts rest on

- Installed core: `framework-arduinoteensy` 1.160.0, `cores/teensy4/IntervalTimer.cpp`. `end()`:
  `funct_table[index] = nullptr; channel->TCTRL = 0; channel->TFLG = 1; …`. `pit_isr()`:
  `if (funct_table[0] != nullptr && channel->TFLG) { channel->TFLG = 1; funct_table[0](); }` (×4 channels).
  Upstream master has the same ordering (checked 2026-09-13 against the raw GitHub file).
- Watchdog captures on the baseline build `4860fef8` (RTWDOG pre-reset IRQ, priority 0, stacked frame read from
  MSP): wedge #5 PC `0x212f4`, wedge #6 PC `0x212f2`, both LR `0x212eb`, both with breadcrumb
  `cmd_disarm_timer`/0x70 and ISR marker "watchdog". Disassembly of the running ELF: `212f0 str` (callback
  nulled), `212f2 ldr` (channel pointer), `212f4 str` (TCTRL = 0), `212f6 str` (TFLG = 1).
- NVIC priorities in the firmware: PIT 128 (IRQ 122), USB1 128 (IRQ 113), SDHC1 96, ENET 64, RTWDOG 0. Equal
  priority → lower exception number wins the tie-break (Cortex-M NVIC exception-priority rule), so USB is serviced between storm
  iterations; SDHC preempts outright.
- Exposure in the 200 Hz + 90° jumps block only (same protocol, same simulator seed; the 23:14–23:36 run at
  286 Hz is excluded): baseline `4860fef8` **1.09 M** SET_FRAME_POSITION / 1.73 h streaming / 2 wedges (7 runs:
  4 completed, 2 wedged, 1 host-side transient); fix `394dee45` 5.11 M / 7.57 h / 0 wedges (22 completed runs,
  one operator abort for the bench test, one in progress at 09:30). The baseline's 286 Hz run (329 k, no wedge)
  is additional clean baseline exposure at a different rate and is left out of the comparison.
- Reproducer (`tools/pit-race-repro/`): IntervalTimer at 10 kHz, loop = `begin()` → cycle-accurate wait that
  sweeps `end()` across the expiry (period ± 2 µs, one cycle step per iteration) → `end()`. Stock: no heartbeat
  after the first command, status request unanswered, USB still enumerated, 134-baud bootloader reboot works.
  PIT-masked `end()`: 5.92 M cycles / 2.72 M expiries / 10 min, no stall. Tight `end(); begin()` loop without
  the wait: 53 M cycles, 0 expiries (period restarted each iteration), no storm.
- Display side effect at 190 commands/s (145 distinct-frame requests/s): distinct frames reaching the panels
  34–45/s (baseline) → 73–75/s (fix). SD load and SPI transfer times unchanged. Host RTT median 2 → 3 ms.

## Reconciliation of the Codex review (09:34 ET)

| # | Finding | Verdict | Applied |
|---|---|---|---|
| U1 | The "same-rate" baseline exposure included the 23:14 run at 286 Hz (329 k commands). | **VERIFIED** | Baseline restated as the 200 Hz block only: 1.09 M / 1.73 h / 2 wedges. |
| U2 | `P ≈ 0.0007` treats a rate estimated from two events as known; the exact conditional comparison is `(E_b/(E_b+E_f))²`. | **VERIFIED** | Now: "if both builds had the same rate, the chance that both wedges fall in the baseline block is ≈ 3 %"; plus the 95 % upper bound on the fix build (≈ 0.4/h, 0.6 per million commands). |
| U3 | "Either fix suffices / both is safest" over-claims: `inplace_function` destroys the callable before marking it empty, so an interrupt during teardown can call a callable being destroyed; disable-first also needs a barrier before the callback teardown. | **VERIFIED** | Upstream note now states the invariant and proposes: disable + acknowledge + barrier BEFORE touching the callback, AND unconditional acknowledge in the ISR; presented as candidates the reproducer has not tested individually. |
| U4 | Wording: "0x70 never touches the PIT"; FRAME counts are controller-recorded SPI frame changes, not optical output. | **VERIFIED** (repeat of an earlier finding) | Both texts corrected. |
| U5 | The two PCs "match the window" — not exclusive proof; the baseline captures lack context fields; the 11 ns is an inferred effective window under a uniform-phase assumption the baseline (timer restarted per command) violates. Remove "no other candidate predicts the rate". | **VERIFIED** | Rewritten: PCs match the window; the stand-alone reproduction is the mechanism evidence; 11 ns marked as an order-of-magnitude consistency check. |
| U6 | Double-entry (`pit_irq ≈ 2 × ticks`) causal explanation untested. | **ACCEPTED** | Dropped from the upstream note; kept in the reproducer README as an unexplained observation. |
| U7 | The NVIC guard re-enables `IRQ_PIT` unconditionally; preserve the entry enable state. | **ACCEPTED** (fw follow-up) | Recorded for the close-out commit (`NVIC_IS_ENABLED` before, restore after). Single PIT owner today. |
| U8 | Provenance for upstream: pin the platform, give core/compiler versions, build command, transcripts. | **VERIFIED** | Reproducer `platformio.ini` pinned to `teensy@5.1.0`; versions in the note (framework-arduinoteensy 1.160.0, toolchain 1.110301.0 = GCC 11.3.1, PlatformIO platform teensy 5.1.0). Transcripts in the README. |
| U9 | "Pinned core" claim — `platformio.ini` of the firmware is not pinned. | **VERIFIED** | Wording changed; pinning added to the handover list. |
| U10 | (Adversarial) Wedge-free operation and more distinct frames do not validate presentation timing (request-to-presentation latency, superseded requests, stale-display policy when input stops). | **ACCEPTED** | One sentence added to the #50 comment; the whole topic is the next session's brief (handover doc). |
| U11 | (Adversarial) Reproducer tests the workaround, not the two upstream patches; lifecycle tests (4 channels, destruction, pending IRQ, disabled IRQ) missing. | **ACCEPTED** (deferred) | Upstream note says so explicitly; fw #54 test list. |

## (A) FINAL — comment on fw #50

> ## Night 2 (2026-09-12/13): mechanism identified and reproduced — `IntervalTimer::end()` race in the Teensy core
>
> **Two watchdog captures inside a two-instruction window.** With the RTWDOG diagnostic build (`4860fef8`) the
> controller resets itself ~2 s into a wedge and saves the interrupted PC. Wedge #5 (23:51) returned to `0x212f4`,
> wedge #6 (01:14) to `0x212f2`. In `IntervalTimer::end()`:
>
> ```
> 212f0  str r3,[r6,r5]   ; funct_table[index] = nullptr
> 212f2  ldr r3,[r7]      ; load channel                 <- wedge #6
> 212f4  str r1,[r3,#8]   ; channel->TCTRL = 0           <- wedge #5
> 212f6  str r2,[r3,#12]  ; channel->TFLG = 1
> ```
>
> Both addresses sit between "callback removed" and "channel disabled" — exactly where an interrupt taken inside
> the race window would leave the thread's return address (the second one is a plain RAM load, so no peripheral
> access was in flight). The captures match the mechanism; the stand-alone reproduction below is what establishes it.
>
> **The race (`cores/teensy4/IntervalTimer.cpp`, framework-arduinoteensy 1.160.0, same ordering on upstream
> master):** `end()` nulls the callback *before* disabling the channel, and `pit_isr()` acknowledges a channel's
> `TFLG` *only when its callback is non-null*. If the timer expires in that window the ISR runs with a null
> callback, never clears the flag, and re-enters forever at priority 128. Thread mode (`loop()`) never runs again.
> USB (priority 128; the lower exception number is taken first between equal priorities) and SDHC (96) are still
> serviced — which is why the controller stays enumerated, the 134-baud bootloader trick works, and host writes
> stall only once the CDC receive buffers fill. `handleSetFramePosition` called `disarmRefreshTimer()` → `end()` on
> every 0x70, 100–286×/s, against a refresh timer with a 3.3 ms period.
>
> **Order-of-magnitude check:** this issue's ~292 k commands per failure corresponds to an effective window of
> ≈ 11 ns per disarm at a 3.33 ms period — one or two instruction boundaries — under a uniform-phase assumption
> (the baseline restarted the timer on every command, so the true phase distribution depends on command spacing).
>
> **Reproduced stand-alone** (`tools/pit-race-repro/`, no arena code, Teensy 4.1 @ 600 MHz): one IntervalTimer at
> 10 kHz and a loop that sweeps `end()` across the expiry. Stock core: `loop()` dead within 0.5 s, USB still
> enumerated, bootloader reboot works. Same loop with `IRQ_PIT` masked around `end()`: 5.9 M cycles / 2.7 M
> expiries in 10 min, no stall. A tight `end(); begin()` loop without the wait never fails — it restarts the period
> every iteration and the timer never expires, which is the same starvation that capped our display rate.
>
> **Fix build `394dee45`** (`feat/telemetry-ring-2x10`): (1) free-running refresh timer — a successful steady-state
> 0x70 at an unchanged refresh rate leaves the PIT running (the timer is armed on SHOW_FRAME entry and on rate
> changes; error paths and transitions still touch it); (2) every remaining `disarmRefreshTimer()` masks only
> `IRQ_PIT` at the NVIC around `end()`, so a pended tick runs afterwards against an already-cleared flag;
> (3) diagnostics: PIT-interrupt trampoline + per-ISR counts, and the watchdog records which execution context it
> preempted (stacked IPSR + EXC_RETURN).
>
> **Result (200 Hz + 90° jumps, same protocol and simulator seed):** baseline `4860fef8` — 2 wedges in 1.09 M
> commands (1.73 h). Fix build — **0 wedges in 5.11 M commands (7.6 h, 22 clean runs)**. If both builds had the
> same failure rate, the chance that both wedges fall in the baseline block is about 3 %; the 95 % upper bound on
> the fix build's rate is ≈ 0.6 per million commands (≈ 0.4/h) versus the baseline's observed 1.8 per million.
> Side effect: controller-recorded distinct frames transmitted to the panels at 190 commands/s rose from 34–45/s to
> 73–75/s (the per-command timer restart was starving the display). This says nothing yet about
> request-to-presentation latency or which requests get superseded — that is the next piece of work.
>
> **Two separate things.** The per-command disarm/re-arm was unnecessary on our side (the refresh ISR only sets a
> flag; frame load and panel transfer are serialized in `loop()`), so it is removed regardless of the core. The
> core's `end()` remains unsafe for anyone who stops a running IntervalTimer; the NVIC guard stays in our firmware
> until the core version we build against carries a fix. Upstream report: PaulStoffregen/cores (link to follow).

## (B) FINAL — upstream report (PaulStoffregen/cores) — **HELD for Frank's review** (Michael, 09:55 ET); (A) posted as https://github.com/reiserlab/LED-Display_G6_Firmware_Arena/issues/50#issuecomment-5653672436

> **Title:** Teensy 4: `IntervalTimer::end()` can leave the PIT interrupt permanently asserted (null-callback path
> in `pit_isr`) — thread mode never runs again
>
> **Versions:** PlatformIO platform `teensy@5.1.0`, `framework-arduinoteensy` 1.160.0 (`cores/teensy4/IntervalTimer.cpp`;
> the same ordering is in current master), toolchain GCC 11.3.1 (`toolchain-gccarmnoneeabi-teensy` 1.110301.0),
> Teensy 4.1 at 600 MHz, default build flags.
>
> **The sequence.** `IntervalTimer::end()` removes the callback before it disables the channel:
>
> ```c
> funct_table[index] = nullptr;
> channel->TCTRL = 0;
> channel->TFLG = 1;
> ```
>
> and `pit_isr()` acknowledges a channel's flag only when its callback is present:
>
> ```c
> if (funct_table[0] != nullptr && channel->TFLG) { channel->TFLG = 1; funct_table[0](); }
> ```
>
> If the timer expires between the first two stores, the ISR is entered with `funct_table[i] == nullptr`, skips
> the acknowledge, returns, and is immediately re-entered because the PIT request is still asserted. Thread mode
> never executes again. Interrupts of higher priority, or equal priority with a lower exception number (USB1 = 113
> vs PIT = 122 at the default 128), keep running, so the board stays enumerated and looks alive.
>
> **Reproducer** (sketch attached; `pio run -e teensy41`; serial 115200; commands `u` stock / `g` guarded / `?`):
> one IntervalTimer at 100 µs; `loop()` does `timer.begin(cb, 100)`, waits ≈ one period ± 2 µs with the cycle
> counter (the offset sweeps one cycle per iteration so `end()` scans across the expiry), then `timer.end()`.
> A heartbeat prints every 500 ms.
>
> - `u` (stock `end()`): no heartbeat after the command; `?` unanswered; USB still enumerated; a 134-baud
>   bootloader reboot works. Dead within 0.5 s, repeatable.
> - `g` (same loop, `NVIC_DISABLE_IRQ(IRQ_PIT); dsb; isb; timer.end(); dsb; NVIC_ENABLE_IRQ(IRQ_PIT);`):
>   5.92 M cycles, 2.72 M expiries, 10 minutes, no stall.
> - Control: a tight `end(); begin();` loop without the wait never fails (53 M cycles, 0 expiries) — `begin()`
>   restarts the period before it can expire.
>
> **Field history:** an LED-display controller called `end()`/`begin()` on every incoming frame command
> (100–286/s) against a 300 Hz timer and hung about once per 3 × 10⁵ calls; two hardware-watchdog PC captures
> landed on the two instruction boundaries between the stores above.
>
> **Invariant the fix should establish:** an asserted channel flag must never become unserviceable because the
> callback state changed. Two changes, which I have not tested individually in the core (the reproducer tests the
> NVIC guard):
>
> 1. `pit_isr()`: acknowledge the flag regardless of the callback —
>    `if (channel->TFLG) { channel->TFLG = 1; if (funct_table[i]) funct_table[i](); }`.
> 2. `end()`: disable the channel and clear the flag first, add a barrier (or read `TFLG` back) so the peripheral
>    writes complete, then release the callback. Note `funct_table` holds an `inplace_function`, whose null
>    assignment destroys the stored callable before marking it empty — so the callback must not be reachable from
>    the ISR while it is being torn down; masking `IRQ_PIT` for that step is the simplest guarantee.
>
> Happy to turn this into a PR against `teensy4/IntervalTimer.cpp` if useful.
