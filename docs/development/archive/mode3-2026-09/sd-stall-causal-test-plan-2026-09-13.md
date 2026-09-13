# Causal test plan — did the contiguous-seek fix remove the SD-card stalls? (bench, ~70 min)

**RESULT 2026-09-13 15:11 ET — H-FAT CONFIRMED.** Four 6-minute bar-only arms on `75405ee` at 200 Hz (table in
`mode3-wedge-soak-plan.md` §10): arm 3 = 2 clusters at the baseline spacing (worst 91 ms), arm 2 = 0 slow reads with
the identical read count, arm 1 = 1 cluster with the skip on, arm 0 = 0. The FAT access was the cause; the skip is
irrelevant to the stalls.

**Written:** 2026-09-13 12:45 ET; updated 14:15 ET. **Status:** code ready and **reviewed** (firmware
`feat/sd-fastpath-2x10` tip `75405ee`: `SET_SD_DIAG` 0xCE, Codex rounds 3 + 4 reconciled in the ring worktree's
`.codex-review/report-20260913-fw-round4.md`; Studio v0.77 `Studio.setSdDiag`), **bench test pending**.
**Prerequisite:** flash `75405ee` (built `.pio/build/teensy41-performance/firmware.hex`; anything newer needs its own
Codex diff review) via `scripts/flash_bootloader_route.sh` (port released by the Studio first), verify 0xCB flags bit 6
(`sdDiag`), label `… freerun sdfast`, and `GET_SD_INFO` byte 29 = 0. The legacy-seek arm only reproduces the FAT-chain
walk on FAT16/32 volumes (the bench card is FAT32); byte 29 bit 2 reports the mode actually applied to the open file.

## 1. What we know and what is still only correlational

Same card (unbranded `SD8GB`, 8 GB SDHC, FAT32, **4 KB clusters**), same workload (200 Hz + 90° jumps, alternating
the 813 KB bar pattern id 36 and the 81 KB grating id 5):

| build | iterations | commands | reads > 10 ms | clusters | reads/cmd |
|---|---|---|---|---|---|
| `394dee45` (free-running timer, old seek path) | 19 + 5 (night) | 5.15 M | 716 in 197 clusters | one per ~24.5k bar reads | 1.00 |
| `3c71953` (contiguous seeks **A** + same-index skip **B**) | 2 | 482k | **0** | **0** (≈ 6 expected) | 0.76 |

Two things changed at once (A and B), and the build also changed the instrumentation. The working hypothesis
**H-FAT**: on 4 KB clusters the bar pattern's cluster chain (~200 entries, 800 B) spans **two FAT sectors**; SdFat's
`FatFile::seekSet` walks the chain from the first cluster on every backward seek and its one-sector FAT cache misses
whenever the walk crosses the sector boundary → a FAT-sector read from the card on most backward seeks (~12k per 24.5k
pattern reads). Those two sectors were the card's read-disturb hot spot; the grating's 80 B chain fits one cached
sector, hence its immunity. **A** removes every FAT read (arithmetic seeks); **B** only removes 24 % of data reads.

Competing explanations still open: **H-count** (any 24 % reduction in reads merely stretched the cycle; we stopped
too early — but 482k commands at 0.76 = 367k reads ≈ 15 baseline cycles, so this needs the count to be per something
else), **H-data** (the data region is the hot spot and something else about the new build changed its access), and
plain luck (P ≈ 0.003).

## 2. Design — four arms on ONE build, switched at iteration boundaries, no reflash

`SET_SD_DIAG` 0xCE (`Studio.setSdDiag(flags)`): bit0 = legacy seek (the next pattern open skips `contiguousRange()`
→ the old FAT-chain walk), bit1 = no same-index skip (every 0x70 reads). Every `sd_layout` record carries the arm
(bits 2/3), `GET_SD_INFO` byte 29 reports it, `run_metadata.sd_card.sd_diag` and an `sd_diag` event mark the switch.

| arm | flags | A (contiguous seeks) | B (same-index skip) | H-FAT predicts | H-count predicts | H-data predicts |
|---|---|---|---|---|---|---|
| 3 — **positive control first** | 3 | off | off | clusters every ~24.5k bar reads, **`sd_slow` phase = `seek`** | clusters every ~24.5k | clusters, phase `body` |
| 1 — the decisive arm | 1 | off | **on** | clusters at ~24.5k bar reads (unchanged: B does not touch the FAT), phase `seek` | clusters every ~32k (24.5k/0.76) | clusters every ~32k, phase `body` |
| 2 — the control for B | 2 | **on** | off | **0 clusters** | clusters every ~24.5k | clusters every ~24.5k |
| 0 — production | 0 | on | on | 0 | clusters every ~32k | clusters every ~32k |

Arm 0 is already measured (0 in 2 iterations). **Correction (bench 14:47 ET):** the phase byte is NOT the H-FAT
fingerprint. For a non-contiguous file SdFat's `FatFile::read` calls `fatGet` at every cluster crossing (a 4 KB frame
almost always straddles two 4 KB clusters), so the FAT-sector read happens inside the **body** phase; `seekSet` only
walks the chain on backward seeks. The 15 s arm-3 smoke run on `75405ee` reproduced a cluster (32.5 / 41.3 / 95.4 ms,
all phase `body`, `sd_slow_ctx` = no driver error) after ~600 reads. Under H-FAT arms 3 and 1 stall (phase body),
**arm 2 is the decisive arm**: contiguous flag on, skip off → no FAT access at all → 0 clusters; H-count/H-data
predict clusters at the baseline spacing. The arms were shortened to 6 min each (bar-only, ~70k reads ≈ 3 baseline
periods) via `scripts/sd_stall_test.py --sd-diag N --minutes 6` (browser-free).

**Exposure and stopping rule.** One soak iteration ≈ 1250 s ≈ 120k bar-pattern commands ≈ 4–5 baseline cycles.
- Arm 3 (20 min): must reproduce ≥ 2 clusters — if it does not, the card's behaviour has changed since last night
  (its own counter, or a placement change from the `conftest.pat` upload/delete this morning) and the rest of the day's
  arms are uninterpretable → stop and rethink.
- Arm 1 (20 min): ≥ 2 clusters with phase `seek` ⇒ H-FAT confirmed; 0 clusters ⇒ H-FAT rejected (B or luck).
- Arm 2 (20 min): 0 clusters (95 % upper bound ≈ 3 per iteration) ⇒ B is irrelevant to the stalls; clusters ⇒ H-count.
- Order 3 → 1 → 2 → back to 0. Total ≈ 70 min including the 10 s gaps; no flash between arms.

Every arm: same simulator (`--rate 200 --seed 1 --jump-every 100 --jump-deg 90`), same protocol
`soak_mode3_card.yaml` (ids 36/5, frames 200/20 via the `__framesRepatch` hook), same rig `cshl_g6_2x10_ball`.

## 3. Procedure (Studio v0.77 on the granted origin, Claude-in-Chrome or the console)

```js
// after connect: identity + baseline state
Studio.firmware              // must end with "freerun sdfast" (build with 0xCE: see the bench log for its SHA)
Studio.sdCard.sdDiag         // 0
// arm 3 (positive control): legacy seek + no skip, then one iteration
await Studio.setSdDiag(3);
Studio.startSoak({iterations:1, gapS:10, firstFault:'halt', policy:'reset-continue', maxResets:3});
// wait for the soak "end" event (≈ 21 min), then:
await Studio.setSdDiag(1);   // arm 1: legacy seek, skip ON
Studio.startSoak({iterations:1, gapS:10, firstFault:'halt', policy:'reset-continue', maxResets:3});
// … end … 
await Studio.setSdDiag(2);   // arm 2: contiguous seeks, skip OFF
Studio.startSoak({iterations:1, gapS:10, firstFault:'halt', policy:'reset-continue', maxResets:3});
// … end …
await Studio.setSdDiag(0);   // back to production
```

Note the arm applies **from the next pattern open**; switching at an iteration boundary (soak ended) guarantees the
whole iteration runs under one arm. Each iteration's `run_metadata.sd_card.sd_diag` and every `sd_layout` record say
which arm it was.

## 4. Analysis (per iteration file)

```bash
pixi run python scripts/telemetry-report.py soak-logs/arena-log-<arm3>.jsonl soak-logs/arena-log-<arm1>.jsonl soak-logs/arena-log-<arm2>.jsonl
```
Read off: `Card stalls` (count, clusters, spacing in commands / index changes, **phases**), `Reads accounting`
(fw reads/cmd: 1.00 in arms 3/2, 0.76 in arm 1; layout column shows `LEGACY-SEEK arm` / `NO-SKIP arm`), the
step-class table (arm 3/1: bar −1 back to ~2.0 ms, arm 2/0: 1.46 ms), `req_age_us` (arms with stalls: max ≈ stall
+ 2 ms), and the per-trial verdicts. Log every step in `mode3-wedge-soak-plan.md` §10 with ET stamps; add the
result table to `sd-read-jitter-2026-09-13.md` §7.

## 5. If H-FAT is confirmed — consequences

- The stalls were **firmware-induced** (a read-disturb hot spot on the FAT sectors created by the chain walk), not an
  intrinsic property of the card; the contiguous-seek path is the fix for every pattern whose chain spans > 1 FAT
  sector (any pattern > ~512 KB on 4 KB clusters, > 4 MB on 32 KB clusters). Fragmented files must be flagged
  (`sd_layout` bit0 = 0) and made contiguous (`preAllocate` on upload, or re-upload).
- Course cards: check cluster size with `GET_SD_INFO`; a 32 KB-cluster format keeps even 4 MB patterns in one FAT
  sector — but the fast path makes that moot.
- **Next firmware step (Michael, 13:40 ET): drop the contiguity precondition by caching the file's cluster chain in
  RAM at pattern open** — read the FAT once per open (in the inter-trial interval), store it as a list of contiguous
  extents (a contiguous file is one extent; an 8 MB file on 4 KB clusters is at most 2000 entries = 8 KB), and turn
  every frame seek into table lookup + sector arithmetic. Random access is then O(1) inside any pattern file, fragmented
  or not, and the FAT is never touched during a trial; `sd_layout` bit0 becomes informational. Small change in
  `SdManager` (SdFat exposes the FAT lookup and cluster→sector helpers its own seek uses); implement after the causal
  test so the production arm measured here stays the one on the card. Ensuring contiguity at upload (`preAllocate`
  on 0x8D, or the Studio's purge-and-reupload set flow) stays worthwhile for sequential read speed but stops being a
  correctness condition.
- The read-free path (`sd-read-jitter-2026-09-13.md` §6) remains the way to remove the 0.6–1.5 ms read and the card
  from the loop entirely; it is no longer required to reach the 10 ms bound.
- fw #54: close the "card housekeeping" mitigation thread with this result; the card-comparison protocol becomes
  optional.

## 6. If H-FAT is rejected

Arm 1 clean but arm 3 stalls ⇒ B (read count) is what matters ⇒ H-count: the card's counter is per read; the
read-free path becomes the priority again and the card comparison matters. Arm 3 clean ⇒ the card changed (or the
morning's upload moved something) ⇒ characterise afresh with `sd_stall_test.py` before any conclusion.


## 7. Multi-hour campaign (later) — stress first, controls second

**Design principle (Michael, 13:30 ET): test the worst case, not the grid.** Under H-FAT the per-read cost is
independent of file size once the file is contiguous, and a bigger file at a higher command rate can only make a
hidden problem MORE visible (longer chain, wider seeks, more reads per hour). So the campaign is two overnight
soaks plus one short control, all judged by the per-trial `trial_quality` verdicts (target 5 ms, worst case 10 ms,
≥ 30 ms invalidates) and `scripts/telemetry-report.py` — not a patterns × modes × speeds matrix.

| # | protocol (repo) | what | why it is the stress | duration |
|---|---|---|---|---|
| S1 | `protocols/soak_mode3_stress.yaml` | **8 MB sine (2000 × 4 KB frames, GS16) alternating with the 813 KB bar**, Mode 3, simulator at **286 Hz** with 90° jumps, gain 18 on the sine (one revolution sweeps the whole file; a jump = 2 MB seek) | longest FAT chain (16 sectors), widest seeks, highest read rate, the bar keeps continuity with the file that stalled | **2 h** (Michael 14:30: overnight is overkill here — ≈ 6 iterations ≈ 2 M commands ≈ 30× the old stall period) |
| S2 | same protocol, simulator at **200 Hz** — **the overnight run on the consolidated build** (`docs/development/soak-handoff-2026-09-14.md`) | the course/lab rate on the same files, with the fault detector, post-mortem and watchdog all armed: one run exercises the telemetry ring, the free-running refresh timer (ISR guard), the watchdog and the SD fast path together | separates "286 Hz saturates the 300 Hz refresh" (expected: some `req_age` > 5 ms, no SD stall) from SD effects; the hand-off evidence for the lab | overnight |
| C1 | `protocols/soak_mode2_open_loop.yaml` | Mode 2, controller-timed **200 fps**, same two files, no host stepping | the sequential-read control: no seeks at all. H-FAT ⇒ clean at any size; a per-read counter (H-count) ⇒ stalls recur at the same read spacing | 1 h (≈ 3 iterations), when convenient |

Dropped from the earlier grid (implied by S1/S2 under H-FAT, or low information): 100 Hz Mode 3 (slower than S2),
looming/GS2 cells (a smaller read is not a harder case; the GS2 bar generated by `make-stress-patterns.js` stays
available as a 1 KB-read probe if S1 shows a size dependence), sequential Mode-3 sweeps (C1 covers sequential reads).

**Predictions.** H-FAT / fast path: **zero `sd_slow` in S1, S2, C1**; per-read 0.62 ms sequential, 1.2–1.5 ms random,
for the 8 MB file too; `req_age_us` max < 5 ms at 200 Hz, some frames 5–10 ms at 286 Hz (refresh-tick coalescing —
a controller-throughput finding, not an SD one); Mode 2 `superseded` ≈ 0. **Fail signatures:** any `sd_slow` in the
8 MB cells with phase `body` (a data-region disturb that scales with file span — would re-open the card question);
`sd_layout` bit0 = 0 for either file (fragmented upload — re-upload before drawing conclusions); `unknown` trials
(drain coverage at 286 Hz — raise the drain budget, not the verdict).

**Prerequisites (all in the repo now):** the two patterns from `pixi run node scripts/make-stress-patterns.js`
(`soak-patterns/sine_2000f_gs16.pat` 8.1 MB, `bar_200f_gs2.pat` 213 KB; upload through the Studio Console so each
is written in one pass), the Studio soak driver's open-loop mode (v0.77, protocols without a FicTrac plugin skip the
simulator-frames gate), the Studio's frame-count resolution from the uploaded bytes (no `__framesRepatch` needed when
the upload happens in the same Studio session; otherwise #201's 0x88 frame count). Order: S1 overnight first — if it
is clean, S2 and C1 are confirmation; if it is not, the `sd_slow` phase byte and the file it lands on decide what
comes next. **Sequence for the next bench session:** causal arms (70 min) → S1 (2 h) → S2 overnight on the same build.
