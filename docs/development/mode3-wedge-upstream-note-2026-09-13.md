# fw #50 — findings, fix, and upstream note (for Codex review before posting)

**Date:** 2026-09-13 09:30 ET. **Status:** DRAFT — two outward-facing texts to be reviewed adversarially before
they are posted: (A) the comment on reiserlab/LED-Display_G6_Firmware_Arena#50, (B) the upstream bug report to
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
  priority → lower exception number wins the tie-break (Arm GIC/NVIC rule), so USB is serviced between storm
  iterations; SDHC preempts outright.
- Exposure (200 Hz + 90° jumps every 100 frames, same protocol, same simulator seed): baseline `4860fef8`
  1.42 M SET_FRAME_POSITION / 1.96 h streaming / 2 wedges; fix `394dee45` 5.11 M / 7.57 h / 0 wedges (22 clean
  runs, one operator abort for the bench test, one in progress at 09:30).
- Reproducer (`tools/pit-race-repro/`): IntervalTimer at 10 kHz, loop = `begin()` → cycle-accurate wait that
  sweeps `end()` across the expiry (period ± 2 µs, one cycle step per iteration) → `end()`. Stock: no heartbeat
  after the first command, status request unanswered, USB still enumerated, 134-baud bootloader reboot works.
  PIT-masked `end()`: 5.92 M cycles / 2.72 M expiries / 10 min, no stall. Tight `end(); begin()` loop without
  the wait: 53 M cycles, 0 expiries (period restarted each iteration), no storm.
- Display side effect at 190 commands/s (145 distinct-frame requests/s): distinct frames reaching the panels
  34–45/s (baseline) → 73–75/s (fix). SD load and SPI transfer times unchanged. Host RTT median 2 → 3 ms.

## (A) Proposed comment on fw #50

> ## Night 2 (2026-09-12/13): mechanism identified and reproduced — `IntervalTimer::end()` race in the Teensy core
>
> **Two watchdog captures, both inside a two-instruction window.** With the RTWDOG diagnostic build (`4860fef8`)
> the controller resets itself ~2 s into a wedge and saves the interrupted PC. Wedge #5 (23:51) returned to
> `0x212f4`, wedge #6 (01:14) to `0x212f2`. In `IntervalTimer::end()`:
>
> ```
> 212f0  str r3,[r6,r5]   ; funct_table[index] = nullptr
> 212f2  ldr r3,[r7]      ; load channel                 <- wedge #6
> 212f4  str r1,[r3,#8]   ; channel->TCTRL = 0           <- wedge #5
> 212f6  str r2,[r3,#12]  ; channel->TFLG = 1
> ```
>
> Those are the only two return addresses that exist between "callback removed" and "channel disabled". A hung
> peripheral store would park the PC at one fixed address; an interrupt taken inside the window gives exactly
> this pair.
>
> **The race (`cores/teensy4/IntervalTimer.cpp`, core 1.160.0, same on upstream master):** `end()` nulls the
> callback *before* disabling the channel, and `pit_isr()` acknowledges a channel's `TFLG` *only when its
> callback is non-null*. If the timer expires in that window the ISR runs with a null callback, never clears the
> flag, and re-enters forever at priority 128. Thread mode (`loop()`) never runs again. USB (priority 128, lower
> IRQ number wins the tie-break) and SDHC (96) still get serviced — which is why the controller stays enumerated,
> the 134-baud bootloader trick works, and host writes stall only once the CDC receive buffers fill.
> `handleSetFramePosition` called `disarmRefreshTimer()` → `end()` on every 0x70, 100–286×/s, against a refresh
> timer expiring every 3.3 ms.
>
> **Quantitative check:** this issue's ~292 k commands per failure ⇒ ≈ 3.4 × 10⁻⁶ per disarm ⇒ an ≈ 11 ns window
> at a 3.33 ms period — one or two instruction boundaries. No other candidate predicts the rate.
>
> **Reproduced stand-alone** (`tools/pit-race-repro/`, no arena code): one IntervalTimer at 10 kHz and a loop that
> sweeps `end()` across the expiry. Stock core: main loop dead within 0.5 s, USB still enumerated, bootloader
> reboot works. Same loop with `IRQ_PIT` masked around `end()`: 5.9 M cycles / 2.7 M expiries in 10 min, no stall.
>
> **Fix build `394dee45`** (`feat/telemetry-ring-2x10`): (1) free-running refresh timer — SET_FRAME_POSITION never
> touches the PIT (arm once on SHOW_FRAME entry / rate change); (2) every remaining `disarmRefreshTimer()` masks
> only `IRQ_PIT` at the NVIC around `end()`, so a pended tick runs afterwards against an already-cleared flag;
> (3) diagnostics: PIT-interrupt trampoline + per-ISR counts, and the watchdog records which execution context it
> preempted (stacked IPSR + EXC_RETURN), so a storm would be unmistakable next time.
>
> **Result:** baseline at 200 Hz + jumps: 2 wedges in 1.42 M commands (1.96 h). Fix build, same protocol and
> rate: **0 wedges in 5.11 M commands (7.6 h, 22 clean runs)** — P ≈ 0.0007 under the baseline rate. Side effect:
> distinct frames reaching the panels at 190 commands/s rose from 34–45/s to 73–75/s (the per-command timer
> restart was starving the display).
>
> **Two separate things.** The per-command disarm/re-arm was unnecessary on our side (the refresh ISR only sets a
> flag; frame load and panel transfer are serialized in `loop()`), so it is removed regardless of the core. The
> core's `end()` is still unsafe for anyone who stops a running IntervalTimer; the NVIC guard stays in our
> firmware until the pinned core carries the fix. Upstream report: PaulStoffregen/cores (link to follow).

## (B) Proposed upstream report (PaulStoffregen/cores)

> **Title:** Teensy 4: `IntervalTimer::end()` can leave the PIT interrupt asserted forever (null-callback race in
> `pit_isr`) — thread mode never runs again
>
> **Core:** `cores/teensy4/IntervalTimer.cpp` (1.160.0 and current master).
>
> `IntervalTimer::end()` removes the callback before it disables the channel:
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
> the acknowledge, returns, and is immediately re-entered (the PIT request is still asserted). Thread mode never
> executes again. Interrupts with higher priority, or equal priority and a lower IRQ number (USB1 = 113 vs PIT =
> 122 at the default 128), keep running, so the board stays enumerated and looks alive.
>
> **Reproducer** (Teensy 4.1, 600 MHz; attached sketch): one IntervalTimer at 100 µs, `loop()` does
> `timer.begin(cb, 100); wait ≈ one period ± 2 µs (cycle counter, sweeping); timer.end();`. The stock sequence
> stops `loop()` within 0.5 s. With `NVIC_DISABLE_IRQ(IRQ_PIT); dsb; isb; timer.end(); dsb; NVIC_ENABLE_IRQ(IRQ_PIT);`
> it runs 5.9 M cycles / 2.7 M expiries in 10 min without a stall. Note the wait is essential: a tight
> `end(); begin();` loop restarts the period every iteration and never expires (0 events in 53 M cycles).
>
> **Field history:** an LED-display controller called `end()`/`begin()` per incoming frame command (100–286/s)
> against a 300 Hz timer and hung roughly once per 3 × 10⁵ calls, i.e. a window of ≈ 11 ns — consistent with the
> one-or-two instruction boundaries between the stores. Two hardware-watchdog PC captures landed on exactly
> those two addresses (`ldr channel` and `str TCTRL`).
>
> **Suggested fix** (either suffices; both is safest):
>
> 1. `pit_isr()`: acknowledge regardless of the callback —
>    `if (channel->TFLG) { channel->TFLG = 1; if (funct_table[i]) funct_table[i](); }`
> 2. `end()`: disable the channel and clear the flag first, null the callback last.
>
> Side observation while counting entries: the ISR is entered twice per expiry (`pit_irq ≈ 2 × ticks`) — the
> posted `TFLG` write has not reached the PIT when the handler returns. A read-back or `dsb` after the acknowledge
> would remove the spurious second entry.

## Questions for the reviewer

- Is the "two return addresses = interrupt inside the window" inference airtight? What else places a preempted
  thread PC at `0x212f2` (a DTCM load, no peripheral access) other than an interrupt taken there?
- Does the storm model hold given USB1 at 128 and PIT at 128 (tie-break) — is the Arm rule stated correctly?
- Is the NVIC-mask guard sufficient (pended interrupt after `end()` runs `pit_isr` with a null callback and a
  cleared `TFLG` → no storm)? Is `dsb; isb` after `NVIC_DISABLE_IRQ` needed/sufficient? Any case where
  `NVIC_ENABLE_IRQ(IRQ_PIT)` afterwards is wrong (another IntervalTimer user with the IRQ deliberately disabled)?
- Statistics: is "P ≈ 0.0007" (Poisson, 0 events in 5.11 M at 2/1.42 M) fairly stated with the caveats
  (clustering, power-cycle history, rate blocks)?
- The upstream note: anything a core maintainer would reject — tone, missing versions, is the
  double-entry observation correct and worth including, is fix 2 alone actually sufficient (a late callback
  after TCTRL = 0 is harmless?) — and does the reproducer sketch stand alone (uses `_VectorsRam`,
  `attachInterruptVector`, `ARM_DWT_CYCCNT`, `F_CPU_ACTUAL`)?
- Anything in (A) that over-claims relative to the evidence, or that Isabel/Frank would misread?
