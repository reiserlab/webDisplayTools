# Handover — Mode-3 performance session (SD access timing, presentation latency, deferred work)

**Written:** 2026-09-13 09:45 ET, at the end of the fw #50 wedge campaign's second night. **For:** a fresh
session that optimizes the controller's Mode-3 path (SD access timing first), works the deferred lists, and then
resumes bench testing. **Read first:** this file, then `mode3-wedge-soak-plan.md` §10 (bench log),
`codex-review-2026-09-13-mode3-wedge-fix.md` (what four Codex passes said about the fix build),
`telemetry-performance-handover-2026-09-12.md` (the earlier parallel-session brief: telemetry metrics + SD-jitter
proposal — still valid, this file supersedes its "state of the bench" parts).

## 1. Where things stand

- **The wedge is explained and reproduced.** `IntervalTimer::end()` in the Teensy core nulls the callback before
  disabling the PIT channel; `pit_isr()` acknowledges the flag only when the callback is non-null → interrupt storm,
  `loop()` never runs again. Stand-alone reproducer: firmware `tools/pit-race-repro/` (stock: dead < 0.5 s;
  PIT-masked `end()`: 5.9 M cycles clean). Two watchdog PC captures on the arena sit inside the window.
- **Fix build `394dee45`** (firmware branch `feat/telemetry-ring-2x10`, LOCAL ONLY — never pushed): free-running
  refresh timer (0x70 no longer disarms/re-arms), `IRQ_PIT` masked at the NVIC around every remaining `end()`,
  PIT ISR trampoline + per-ISR counts, watchdog context capture (STATE kinds 8/9/10 in the ring). 0 wedges in
  5.1 M commands / 7.6 h at 200 Hz vs 2 in 1.09 M on the baseline. **It is on the bench controller now.**
- **Host** (webDisplayTools branch `claude/mode3-wedge-soak`, PR #198, pushed): Studio v0.76 fault lifecycle,
  soak driver, telemetry ring host side, decode for the new firmware fields (0xCB bit 4 `freeRunningTimer`,
  ISR ids 4–7, STATE kinds 8/9/10), `scripts/wedge-scan.py`. All tests green (`pixi run test`).
- **Outward items pending Michael:** the fw #50 comment and the PJRC report — final texts in
  `mode3-wedge-upstream-note-2026-09-13.md` (Codex-reviewed). Not posted.
- **Close-out plan** (`mode3-wedge-closeout-plan.md`, tracker web #201): ≤ 2 stacked PRs per repo; firmware F2
  must collapse the GET_HEALTH `ver` churn (1→5 were bench iterations) to ONE version and move bench-only verify
  fields to a diag opcode; deferred hardening on fw #54 (three comments today); host deferrals on web #200/#201.

## 2. The performance picture (measured tonight, 200 Hz + 90° jumps, GS16, 2×10)

| Quantity | Value | Source |
|---|---|---|
| Commands delivered | 190/s (host-limited; sim 200 Hz) | `cc` rows |
| Distinct-frame requests | 145/s (76 % of commands change the index) | `cc` payloads |
| Distinct frames transmitted (baseline → fix) | 34–45/s → 73–75/s | `cf` rows (FRAME = index/pattern change transmitted; repeats not logged) |
| Refresh timer | 300 Hz GS16 (3.33 ms), 1 kHz GS2 | `refresh_rate_gs16_default` |
| SD `readFrame` (grating, 20 frames) | median 1.08 ms, p99 1.49 ms | `cf.sd_load_us` |
| SD `readFrame` (bar, 200 frames) | median 1.39–1.46 ms, p99 2.3–2.4 ms | same |
| `sd_slow` (> 20 ms) bursts | 32–89 ms, ~18 per 20-min run, up to 5 within 4 s | `cs` kind 4; wedge #5/#6 both had an 89 ms read in their last minute (coincidence under the storm mechanism) |
| SPI transfer per frame | 0.77 ms | `cf.spi_us` |
| Host RTT (0x70) | median 2 → 3 ms, p99 8–9 → 11 ms after the fix (more transfers compete in `loop()`) | wedge-scan table |

**The gap to close:** 145 distinct requests/s → 75 transmitted/s. With a 300 Hz tick, frames replaced between two
ticks are never shown (expected ceiling ≈ 300·(1−e^(−145/300)) ≈ 115/s); the rest are ticks the main loop misses
while it is inside a 1–2 ms SD read + reply. The `loop()` order is command → `loadFrame` (SD, synchronous) →
`serviceDisplay` (transfer at the tick, spins on DMA completion).

## 3. Candidate work, in the order I would take it

1. **Pattern in RAM for Mode 3 (biggest win, removes SD from the hot path entirely).** A 2×10 GS16 frame is
   2·10·400 px · 4 bit = 4 000 B; a 200-frame pattern is 800 KB → fits the PSRAM the controller already uses for
   0x3A/0x3B (`handleDisplayPsramIndex`/`handlePsramPlay`). Preload the pattern into PSRAM at trial start
   (`enterPatternMode`, or on `TRIAL_PARAMS`), make 0x70 a memcpy from PSRAM (or point the transfer at the PSRAM
   frame directly). Expect `sd_load_us` → tens of µs and the `sd_slow` bursts gone from the streaming path.
   Cost: pattern open latency (800 KB at ~10 MB/s SD ≈ 80–100 ms, once per trial — check against the ITI).
   Codex's P12/E-list cautions apply: state latest-request-wins explicitly; measure request→presentation age.
2. **Refresh-tick service policy.** Today `refreshFlag` is a boolean (coalesces ticks). With SD out of the way the
   loop is fast enough to service every tick; if not, consider transferring at the tick from the ISR-visible
   buffer only when a new frame is ready (skip redundant retransmits of an unchanged frame — check whether the
   panels need periodic refresh at all in persistent mode).
3. **Presentation-latency instrumentation** (Codex U10): a FRAME record already carries `sd_load_us`/`spi_us`; add
   command-receive → transfer-start latency (or log the request seq that a transfer presents) so request age and
   superseded requests can be measured. Then the analysis: age distribution, superseded fraction, per pattern.
4. **Stale-display policy when input stops** (bridge/FicTrac drop): hold vs blank vs error — decide and implement
   (host side already has a freshness pause in the soak driver; the controller has none).
5. **Firmware hygiene from the reviews (small):** preserve the `IRQ_PIT` enable state in `disarmRefreshTimer()`
   (`NVIC_IS_ENABLED` before, restore after); `armRefreshTimer` should return success and callers should not
   acknowledge a display state without a timer; pin `platform = teensy@5.1.0` in the main `platformio.ini`;
   `IntervalTimer::update()` for rate changes; remove the unused `classify_exc_return` duplicate in
   `scripts/soak_mode3.py`; stale "~20 cycles masked" comment in `Health.cpp`.
6. **Deferred lists:** fw #54 (ring hardening + today's three comments: display-cadence HIL tests, ISR-marker
   persistence, saturation flag, linker reservation, capsule, `soak_mode3.py` 0xCB + ring drain); web #200/#201.
7. **Then test again:** soak recipe below; compare `cf` rate and `sd_load_us` per build; a telemetry-off control
   night is still owed (Debug ▾ `studio_telemetry` off).

## 4. Bench state and procedures

- Controller: CSHL 2×10, MAC 04:E9:E5:12:91:E2, `/dev/cu.usbmodem121699401`, firmware `394dee45` (0xCB flags 0x1C).
  Soak stopped 09:40; Studio connected idle in the Claude-in-Chrome tab (`localhost:8091/arena_studio.html?advanced=1`).
- Processes: `python3 .claude/nocache-server.py` (port 8091), bridge 3.1 `fictrac-bridge/bridge.py --log-dir soak-logs`,
  sim `fictrac_sim.py --count 0 --rate 200 --seed 1 --jump-every 100 --jump-deg 90`. Logs in `soak-logs/`
  (untracked, ~1.5 GB; wedge captures under `soak-logs/wedges/`).
- **Flash (bootloader route, no button):** Studio must release the port first (`Studio.stopSoak(); await
  Studio.session.stop(); await Studio.session.disconnect()`), then firmware `scripts/flash_bootloader_route.sh
  <hex>` (or `-b` to reboot only). Then `await Studio.session.reconnect()`; `Studio.firmware` shows the SHA.
  Resolve PCs only against the ELF of the build that was running (`arm-none-eabi-addr2line -e … -f -C`).
- **Soak:** protocol `soak_mode3_card.yaml` is loaded in the tab (sha 49313f52…); `Studio.startSoak({iterations:0,
  hours:H, gapS:10, firstFault:'halt', policy:'reset-continue', maxResets:3})`. Recipe to rebuild it: fetch
  `/protocols/soak_mode3_closed_loop.yaml`, swap `frame2_h_ccw_200f`/ID 4 → `p3_heisenberg_ts`/36 and
  `grating_sq`/ID 2 → `course_grating_36deg`/5, `Studio.loadProtocol(txt,'soak_mode3_card.yaml','local')`. The
  page needs the `window.__framesRepatch` hook (frames 200/20 for the two card patterns) until #201's "frame count
  from GET_PATTERN_INFO 0x88" lands. `scripts/soak-wedge-watch.sh` exits on a fault/post-mortem or a stalled log.
- **Starve test** (watchdog + context capture): `SET_TELEMETRY 0x31` → reset in ~2 s → reconnect →
  `Studio.drainTelemetry()`; expect STATE kind 8 code 0xF9/0xE9 arg 0.
- **Reproducer:** firmware `tools/pit-race-repro/` (`pio run -e teensy41`), host driver `host/repro.py u|g <secs>`.
- Analysis: `pixi run python scripts/wedge-scan.py soak-logs/*.jsonl`; per-pattern `cf`/`cc` rates: see the
  snippet in the bench log entry of 01:41 (rx-time windows, not `t_us` — `t_us` restarts at a reset).

## 5. Rules that bit us (keep)

- Never Prettier the HTML; bump the Studio footer on every HTML edit. Codex CLI needs `< /dev/null` when
  backgrounded. macOS has no `timeout`. Python buffers stdout when backgrounded (use `-u`). A tight
  `end(); begin()` loop never expires the timer — any timer-race test needs the disarm swept across the expiry.
- GET_HEALTH `ver` is a wire byte, not a log version — do not bump it per bench iteration again.
- Log everything to `mode3-wedge-soak-plan.md` §10 with ET timestamps; memory file
  `~/.claude/projects/-Users-reiserm-Documents-GitHub-webDisplayTools/memory/mode3-wedge-fw50.md` has the running notes.
