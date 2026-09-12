# Mode-3 wedge (fw #50) — status, results, and plan for continued testing

**Date:** 2026-09-12 12:00 ET. **Author:** Michael + Claude. **For review:** what has changed since
the approved plan (`~/.claude/plans/let-s-please-combine-the-composed-scroll.md`, reviewed by Codex
2026-09-11), what the first bench day produced, and what we intend to do next. Companion docs:
`mode3-wedge-soak-plan.md` (findings, campaign spec, bench log § 10, T4 design § 11),
`controller-telemetry-ring-buffer-proposal.md` (the original ring design, PR #192).

## 1. What the original plan said, and what happened to it

| Plan item | Status |
|---|---|
| Fail closed on repeated 0x70 timeouts, CONTROLLER_FAULT outcome, faulted runs commit | **Shipped** (Studio v0.76, PR #198). Bench: a wedge stopped the run within 1.5 s. Gap found on the bench: controller REJECTS (status 1) were not counted; fixed the same morning. |
| Post-mortem probes (quiet → confirm → 60 s window → policy) | **Shipped**, exercised on the real wedge: all probes silent. |
| `ArenaLink.reconnect()` from granted ports | **Shipped**, worked on hardware 4× (same port and after re-enumeration, 6–8 ms). |
| Studio soak driver, halt-first | **Shipped**. Harness bugs found and fixed live: protocol's `fictrac.disconnect` killed the logger; remembered v1 log level overrode the soak; stop reason misreported; soak restart needed the bridge reconnected. |
| `wedge-scan.py` analyzer | **Shipped**; found a 6th, earlier occurrence (rig2, 2026-07-11) in the course repo; reproduced the issue's control-run numbers exactly. |
| Firmware GET_HEALTH + reset-surviving breadcrumb | **Shipped** (PR #53), flashed, verified: counters live, breadcrumb survives SYSTEM_RESET **and** the bootloader reboot. |
| Firmware frame-cache candidate | **Held** (Codex: don't alter the suspected access pattern before a baseline). Baseline now exists. |
| Self-healing runner | **Issues only** (#197, LAB-212) as planned. |
| Ring buffer (T1–T6) | Was "unchanged, later". **Now being built** (T1 scope) because Michael wants the performance/ring concept validated in parallel, and because a ring in reboot-surviving RAM is a crash dump for the wedge. T2/T3 skipped (need AD3/Saleae, Michael unavailable for several days). **T4 = soak on ring firmware** is the next bench step. |
| Pyserial soak driver | **Shipped** (`scripts/soak_mode3.py`, dry-run tested), **not yet run on hardware** (one controller; Studio arm first). |
| New since the plan: firmware build identity | **Shipped** both sides (GET_FIRMWARE_VERSION 0xCB; `run_metadata.firmware`), flashed, verified in a live log. Permanent feature per Michael. |

## 2. Bench results (one controller, CSHL 2×10, simulator at 100 Hz, Studio soak)

- **Night 1 (course firmware, unidentified build):** smoke + 3 clean 20-min iterations, then a **wedge at 187.8 s into iteration 4** (frame 78 of the 200-frame pattern; 18,128 clean commands before it). ≈ 374k good 0x70s over ~70 min of streaming before failure.
- **The wedged controller was silent, not slow:** zero bytes to Chrome probes at 5/10/20 s, to a closed-and-reopened port, and to **pyserial outside Chrome**. USB stayed enumerated; the display held its last frame. **0x01 SYSTEM_RESET got no ack** (parser lives in the stuck `loop()`); only a power cycle recovered it. ⇒ the browser is **not needed to observe** the wedged state (pyserial saw the same silence), so "Chrome can't receive replies" is out — but whether browser traffic *triggers* the state is untested until the pyserial soak arm runs from a clean boot; the fault looks like `loop()` stopped (an unbounded spin), not a slow path.
- **Two mistakes on our side:** (a) Claude flashed fw #53 without a human at the bench; the 134-baud reboot put the Teensy into HalfKay **without an HID interface attaching on macOS 26**, so no loader could see it and the arena was offline until Michael pressed the button in the morning. The same path worked twice later that morning — intermittent, cause unknown. (b) fw #53 targets `main`, which is compiled for **4×10**; on the 2×10 card every trial failed (`CE_ARENA_MISMATCH`). Fixed by cherry-picking onto `arena-2x10-local` (`feat/controller-health-2x10`).
- **Day 2 (health firmware 22b756dd, 2×10):** **12 clean iterations, ~1.45 M frame commands, 07:05–11:16, no fault**; now continuing on the build-identity firmware. Health counters showed a **129 ms** worst SD frame read during clean runs (RTT median 2 ms, p99 4 ms) — a rare slow SD tail exists.
- **Recovery primitive confirmed:** 134-baud reboot → HalfKay → `teensy_loader_cli -b` (boot-only) restarts the program in ~5 s **and the breadcrumb/OCRAM survive it**. This is what LAB-212 should use; 0x01 cannot work on a stuck loop.
- Two host-side findings for #199 / future: one out-of-range 0x70 per trial whose frame count differs (bridge cfg race); the Studio tab was in the background during the wedge (timer throttling explains 1 s-aligned timeout durations; not causal).

## 3. Current hypotheses

| # | Mechanism | Status after night 1 |
|---|---|---|
| H1 | SDIO polled-busy latch / SD path stall (unbounded `SDHC_PRSSTAT_BREN` spin, 1 s busy timeouts) | Alive. The 129 ms SD read tail is consistent; a stuck spin explains total silence. |
| H2 | USB-CDC reply path / loop stall elsewhere (`transferPanelSet` spin on `dmaComplete_`, `usb_serial_write` TX timeout) | Alive. Total silence fits a stuck loop anywhere. |
| H3 | Host/Chrome | **Narrowed**: not needed to *observe* the wedge (pyserial saw the same silence). Not excluded as a *trigger* — needs the pyserial soak arm from a clean boot. |
| H4 (new) | Something about the health firmware or its base changed the odds (12 clean iterations vs a wedge in 4) | Cannot be separated yet: the pre-flash build is unidentified, and 12 iterations is within Isabel's ~1-in-10-experiments rate. Needs a stock `arena-2x10-local` control soak. |

The discriminator we now have and did not before: **the breadcrumb + ring after a bootloader reboot** — which op the loop was inside (SD read / SPI transfer / USB write / command) and the last seconds of records.

## 4. Plan for continued testing (next 3–5 days)

1. **Now:** soak continues on `22b756dd` (health + version). At the next wedge: probes → 134-baud reboot → `-b` → reconnect → GET_HEALTH (`prev_breadcrumb`, `prev_slow_op`) → report.
2. **When the ring firmware lands (today):** flash at the next iteration boundary; **T4** = the same soak with the 10 Hz ring drain (rows `cc`/`cf`/`cs` into the run log); at the next wedge the post-reboot drain is the crash dump. Also gives the first per-frame SD-load and SPI-time distributions (performance data the ring was for).
3. **T1 retained in reduced form** (Codex: T4 validates one operating point, not capacity): the firmware gets a synthetic producer (SET_TELEMETRY flag bit7 + rate) so a 30-min drain test at 5 / 12.6 / 50 KB/s, foreground and background tab, pyserial vs Chrome, can run in a soak break. T4's drainer stats (bytes/s, chunks/poll, gaps, drops, `notStored`) are logged but labelled events-only workload validation.
4. **Control arms, TIME-BOXED (Codex):** instrumented soaking gets at most **2 nights or 40 iterations, whichever first**, then one night on **stock `arena-2x10-local`** (no health/ring code; build SHA recorded externally since it has no 0xCB) and one night of the **pyserial driver** from a clean boot (removes the browser as a *trigger*). Compare **exposure** (streaming hours, delivered 0x70 count, matched protocol/card/rate), not iteration counts; report censored clean exposure. Then alternate arms. A control is run whether or not another instrumented wedge has occurred.
5. **Firmware fix candidates only after a breadcrumb/ring readout points at a spin:** bound the `dmaComplete_` and `SDHC_PRSSTAT_BREN` waits (timeout → STATE record + error glyph instead of a hang), SD re-init path, then the frame cache. A hardware watchdog (WDOG) that resets into a state the ring survives is the on-device complement to the host bootloader route.
6. **Get the five reported wire logs** off bench03/rig03-sr; run `wedge-scan.py` on them.
7. **Not now:** T2/T3 (instruments), TICK/analog yoking, clock fit, self-healing runner (LAB-212) — the latter waits for the recovery primitive to be exercised on a real wedge.

## 4b. Manual capture procedure at the next wedge (until self-healing exists)

Evidence first, SD last. Someone at the keyboard (not necessarily at the bench):
1. Let the Studio post-mortem finish its 60 s probe window (all timeouts expected) — do NOT power-cycle.
2. Release the port (Studio Disconnect). From the shell: open the port at 134 baud (`serial.Serial(port,134)`; close) → wait 4 s → check HalfKay HID is present (`ioreg -c IOHIDDevice | grep 5824`). **No HID within 20 s ⇒ stop; leave it for a human; do not power-cycle (RAM evidence).**
3. `teensy_loader_cli --mcu=TEENSY41 -b -v` (boot-only) → CDC back within ~15 s.
4. Studio `reconnect()` (granted port) → identity (0xC2 MAC must match) → **GET_HEALTH first** (prev breadcrumb + slowest op) → **ring drain** (`Studio.drainTelemetry('post-reboot')`, raw blocks kept in the `telemetry_dump` event) → only then any SD-touching probe or a new trial.
5. Archive the log file + the exact firmware SHA before restarting the soak.
A hang that stops USB interrupt handling defeats step 2 (the 134-baud reboot runs from the USB ISR); then it is the button, and the evidence is gone — the case for an on-device hardware watchdog that the ring survives.

## 4c. Pre-T4 evidence gate (Codex): what must be true before T4 results count
- Ring memory reserved or heap-guarded at runtime (`__brkval` check; ring disabled + flagged on collision).
- Record-then-header commit ordering with per-append cache flush; interrupted-write test (reset mid-append, then drain).
- FRAME SD duration is u32 (the 129 ms tail must be representable).
- Ack advances only after the bridge accepted the rows (`logRows` false ⇒ withhold); bridge ≥ 3.1 on every bench.
- A recovered-dump fixture: pre-wedge records arriving after the boot record are attributed to the previous boot (`wedge-scan --verbose` prints them per boot).
- Drain budget under background-tab throttling ≥ production rate (40 chunks/poll ≈ 7 KB/poll).

## 5. Questions for the reviewer

- Is running the soak on instrumented firmware (health + ring) before a stock control night the wrong order, given the evidence-first priority?
- Is the reboot-surviving ring at a fixed OCRAM address (below the breadcrumb, outside every linker section, heap growing toward it) an acceptable risk for a diagnostic build? What would you require before it ships to course controllers?
- The 12-clean-iterations observation: what would make it evidence rather than noise?
- Anything in the recovery route (134-baud → HalfKay → boot-only) that makes it unsuitable as the self-healing primitive on Windows lab PCs?

## 6. Review outcome (2026-09-12 12:00 ET)

Both Codex passes (status/plan + branch diff) are reconciled in `.codex-review/report-20260912-status.md`: what was verified and fixed on the branch, what was accepted into this plan (§4.3 T1, §4.4 time-box, §4b capture procedure, §4c gate), what was deferred (write-timeout transport generation; session-owned run lifecycle → LAB-212) and the one rejection (opt-in telemetry sidecar — both readers now skip tagged rows, tested). The ring firmware is `ac4c08f` on `feat/telemetry-ring-2x10`; the host gates SET_TELEMETRY on its 0xCB flag bit 2, so the health-only build running tonight is never sent 0xA8.

**12:20 ET addendum:** the ring firmware code itself was then Codex-reviewed (`LED-Display_G6_Firmware_Arena-ring/.codex-review/report-20260912-ring.md`). Flash is go after the bounded fix commit (reference-drainer handshake, HIL test corrections, ack/incarnation guard, heap guard coverage, exact-size boot repair); dual headers / linker reservation / PSRAM frame identity are deferred to the ship-to-course gate.
