# fw #50 — evidence after the first watchdog capture, and the proposed fix (for review)

**Date:** 2026-09-13 00:10 ET. **Status:** for Codex adversarial review before the fix is flashed.
Companion: `mode3-wedge-soak-plan.md` §10–11 (bench log), `mode3-wedge-status-2026-09-12.md`.

## 1. The five reproductions on this bench (one CSHL 2×10 controller, simulator-driven Mode 3)

| # | When | Firmware | Rate | Streaming before | Recovery | Breadcrumb / PC |
|---|---|---|---|---|---|---|
| 1 | 09-12 00:19 | course build (unknown) | 100 Hz | ~70 min (iter 4) | power cycle | none (no instrumentation) |
| 2 | 09-12 15:44 | ring `c47ee684` | 100 Hz | 2 h 06 m | bootloader route | `OP_CMD`/0x70, SD marker never set |
| 3 | 09-12 16:27 | `c47ee684` | 100 Hz | 33 m | bootloader | same |
| 4 | 09-12 16:36 | `c47ee684` | 100 Hz | 5.5 m | bootloader, then **power cycle** | same; slowest SD read that boot only 3.4 ms |
| 5 | 09-12 23:51 | wdog `4860fef8` | 200 Hz + jumps | 7 h 06 m after the power cycle (12 clean iterations at 100 Hz, 3 at 286 Hz, then 15 min at 200 Hz) | **watchdog self-reset, 2 s** | `cmd_disarm_timer`/0x70; **PC 0x212f4 = `IntervalTimer::end()` at `channel->TCTRL = 0`**, LR 0x212eb (return from the `funct_table[i] = nullptr` call); ISR marker = watchdog IRQ ran |

Common to all instrumented cases: host sees ≥3 consecutive 0x70 timeouts with USB *writes* stalling 1–3 s; then total
silence to every probe (0xC2, 0x33, 0x72, 0x88, 0xE3, 0x01), from Chrome and from pyserial; USB stays enumerated;
the display holds its last frame. No CPU fault (the core's fault handler would reboot in 8 s; the crash record is
empty). Ring records up to the hang are ordinary; SD loads ≤ 2.4 ms in the final minute for #2–#4; #5 had three
`sd_slow` records (32, 41, 88 ms) in the final minute. The slowest SD read of the boot was 88–90 ms in #2, #3, #5 and
3.4 ms in #4, so a slow SD read is not a prerequisite.

Intervals: after MCU-only recoveries the intervals shrank 126 → 33 → 5.5 min; after the power cycle, 7 h clean
through 7 further MCU resets (flashes, watchdog tests). Reading: some state outside the MCU (SD card, panels, host
USB) is degraded by a wedge and cleared only by power; two episodes, not yet a result.

## 2. What the PC says

`IntervalTimer::end()` (Teensy core) is: `funct_table[index] = nullptr; channel->TCTRL = 0; channel->TFLG = 1;
nvic_priorites[index] = 255; NVIC_SET_PRIORITY(IRQ_PIT, min); channel = 0;`. The stacked PC is the store to the PIT
channel's control register. The watchdog's pre-reset interrupt ran (ISR marker), so the core was taking interrupts;
the main context nevertheless did not progress past that store for 2 s. Interpretation: the write to the PIT never
completed — a **hung peripheral (IPS/AIPS) bus transaction**. That also explains the simultaneous USB and SD silence
(their register accesses queue behind it) while the watchdog ISR, which touches only OCRAM, could still run.

Open question: does the **PIT itself** hang (the handler does `end()` + `begin()` on every 0x70 — `PIT_MCR`
rewrite, channel rescan, NVIC priority rewrites, 100–286×/s), or does **another bus master** (USDHC/SD DMA, LPSPI
DMA, USB) hang the bus and the PIT store is merely the first CPU access to block? The three earlier breadcrumbs
(`OP_CMD` before the SD marker = the same disarm site) fit either.

### 2b. Competing explanation — the `IntervalTimer::end()` race (Codex review 00:41, verified 00:45)

Reconciliation: `codex-review-2026-09-13-mode3-wedge-fix.md`. In the installed Teensy core (1.160.0)
`IntervalTimer::end()` nulls the callback **before** disabling the channel (`funct_table[i] = nullptr;
channel->TCTRL = 0; channel->TFLG = 1;`), and `pit_isr()` clears a channel's `TFLG` **only when its callback is
non-null**. A PIT interrupt taken between the first two stores runs the ISR with a null callback, never clears
the flag, and re-enters forever at priority 128: the main context is starved with its return address exactly at
`channel->TCTRL = 0` — the captured PC. `IRQ_SDHC1` is configured at priority 96 (it preempts the storm outright) and `IRQ_USB1` (113) shares
priority 128 with the PIT (122) and wins the NVIC tie-break on equal priority, so both ISRs still run (USB stays enumerated, the
134-baud bootloader route works, the CDC rx buffers fill and host writes stall 1–3 s); only `loop()` never runs
again. Quantitatively: Isabel's ~292 k commands per failure ⇒ ≈ 3.4 × 10⁻⁶ per disarm ⇒ an ≈ 11 ns window at a
3.33 ms refresh period — the width of one or two instruction boundaries. This reading needs **no hung bus**;
§2's "the watchdog touches only OCRAM" premise was also wrong (its handler reads the DWT cycle counter and does
cache maintenance), so the bus-hang reading rests on the PC alone. One caveat: in a storm most watchdog captures
would land inside `pit_isr` (handler context), ours shows the main context, which the exception tail-chain path
allows but does not favour — a single sample. Discriminators at the next capture: stacked xPSR IPSR field (0 =
thread, 138 = PIT handler), the watchdog handler's `EXC_RETURN`, and a PIT interrupt-entry count (all in the
follow-up firmware commit). Consequence for §3: the free-running change removes the hot-path `end()` (exposure
÷ 10⁴) but STOP/ALL_OFF, pattern entry, streaming entry, ALL_ON and the error glyph still call it — the follow-up
guards `disarmRefreshTimer()` by masking only `IRQ_PIT` at the NVIC around `end()` (the watchdog IRQ stays live, so a
genuinely stalled store would still be captured) — the race is closed at every site.

## 3. Proposed fix: free-running refresh timer

Arm the refresh timer once when the display enters SHOW_FRAME (or when the rate changes); disarm only on
STOP/ALL_OFF/state exit; SET_FRAME_POSITION only loads the frame. Rationale: the refresh ISR sets a flag; both the
panel transfer and the SD load run in `loop()`, so they are serialized and the disarm never protected anything. Two
effects: (a) removes all PIT register traffic from the 0x70 hot path — if the wedge disappears the churn was the
trigger, if it persists the next watchdog PC moves to the real blocker (SD read / USB write); (b) fixes the observed
display starvation (at 286 Hz only ~20 frames/s reached the panels because every command restarted the 3.3 ms period;
median command spacing 3 ms).

Alternatives considered: (i) keep disarm/arm but only when the rate changes — same PIT traffic on state entry, so a
weaker version of the same; (ii) bound the wait — there is no software wait to bound; a hung bus write cannot be
timed out from software, only the watchdog recovers it; (iii) move the refresh to a different timer block (GPT/TMR)
— discriminates PIT-specific vs bus-wide, but a bigger change; keep as the follow-up if the PC moves to another PIT
access.

## 4. What the review should attack

- Is "hung bus write" the only reading of a PC parked on a peripheral store with interrupts still served? (Store
  buffer semantics on Cortex-M7: the store retires into the write buffer, the exception entry stacks to DTCM, so the
  ISR can run while the write is pending — consistent?) What else parks a PC on a store for 2 s?
- Could the captured PC be misleading (stale, off by one instruction, from the wrong stack frame)? LR = return from
  the inplace_function call immediately preceding — consistent with the PC.
- Is removing the disarm safe for frame-buffer integrity in every mode (Mode 2 playback, PSRAM playback, streaming,
  rate changes, the all-on/all-off transitions)?
- Does the fix risk masking the bug (a bus hang elsewhere becoming rarer/later) rather than discriminating it?
- Anything in the shrinking-interval / power-cycle observation that argues for a specific peripheral (SD card
  internal state, panels' SPI slaves, host USB)?
- The A/B design: what exposure at which rate is needed before "no wedge on the free-running build" means something,
  given the 7 h clean stretch we just saw on the unfixed build after a power cycle?
