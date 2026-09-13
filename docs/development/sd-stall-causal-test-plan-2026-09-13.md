# Causal test plan — did the contiguous-seek fix remove the SD-card stalls? (bench, ~70 min)

**Written:** 2026-09-13 12:45 ET. **Status:** code ready (firmware `feat/sd-fastpath-2x10` with `SET_SD_DIAG` 0xCE,
built, Codex review round 3 in progress; Studio v0.77 `Studio.setSdDiag`), **bench test pending** (Michael: no time
today). **Prerequisite:** flash the reviewed 0xCE build (firmware tip after `35bb196`; run a Codex diff review of anything
newer first) via `scripts/flash_bootloader_route.sh` (port released by the Studio first), verify 0xCB flags bit 6
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

Arm 0 is already measured (0 in 2 iterations). The **phase byte** is the fingerprint: under H-FAT the stall lands
inside the seek (FAT-sector read), under H-data inside the body read — visible in arm 3 with a single stall.

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
- The read-free path (`sd-read-jitter-2026-09-13.md` §6) remains the way to remove the 0.6–1.5 ms read and the card
  from the loop entirely; it is no longer required to reach the 10 ms bound.
- fw #54: close the "card housekeeping" mitigation thread with this result; the card-comparison protocol becomes
  optional.

## 6. If H-FAT is rejected

Arm 1 clean but arm 3 stalls ⇒ B (read count) is what matters ⇒ H-count: the card's counter is per read; the
read-free path becomes the priority again and the card comparison matters. Arm 3 clean ⇒ the card changed (or the
morning's upload moved something) ⇒ characterise afresh with `sd_stall_test.py` before any conclusion.


## 7. Extended validation campaign (multi-hour, later) — patterns × modes × speeds

Purpose: after the causal test, establish the **operating envelope** of the fast-path build with the per-trial
quality verdicts as the acceptance metric (target 5 ms, worst case 10 ms, ≥ 30 ms invalidates), not just "no wedge".
Each cell below is one soak protocol (Studio, `?soak=1`, behavior_v2 logging, telemetry on) analysed with
`scripts/telemetry-report.py`; the firmware stays fixed for the whole campaign.

| axis | levels | why |
|---|---|---|
| pattern size / geometry | grating 20 f (81 KB) · bar 200 f (813 KB) · looming 75 f (305 KB) · a 2,000-frame sine (8 MB, GS16) · a GS2 200-frame pattern (213 KB) | FAT-chain length (1 → 2 → 16 FAT sectors), file span, frame size (1 vs 4 KB reads) |
| mode | **3** (host-stepped, sim random walk + jumps) · **2** (controller-timed open loop at the pattern's frame rate) · 3 with a *sequential* index sweep | Mode 2 is the sequential-read control (no seeks at all, should be stall-free at any size); Mode 3 random is the stress; sequential Mode 3 separates seek cost from command load |
| speed | Mode 3: 100 / 200 / 286 Hz commands; Mode 2: 50 / 100 / 200 fps | read rate (stall recurrence is count-based), tick starvation (300 Hz refresh), USB load |
| duration | ≥ 1 h per cell (≈ 3 iterations); the bar-pattern cells ≥ 3 h (≈ 40 baseline stall cycles) | zero clusters in 1 h ⇒ 95 % upper bound ≈ 3 clusters/h; the long cells are the "still clean after N× the old period" evidence |
| card | current card (baseline, never reformatted) first; candidates later via `sd_stall_test.py` screens | keep the card fixed while the firmware envelope is measured |

**Predictions under H-FAT (fast path):** no stall in any cell; per-read cost 0.62 ms sequential / 1.2–1.5 ms random
for every size (the 8 MB sine included); `req_age_us` max < 5 ms at 100–200 Hz, some frames over 5 ms at 286 Hz
(tick coalescing, not SD); Mode 2 `superseded` ≈ 0. **Fail signatures to watch:** any `sd_slow` in the 8 MB or
GS2 cells (a data-region disturb with size/geometry dependence), phase `body` with error bits (driver), `unknown`
trials (coverage — drain budget at 286 Hz).

**Order:** bar 200 f, Mode 3, 200 Hz, 3 h (continuation of today's evidence) → 8 MB sine Mode 3 200 Hz 1 h →
Mode 2 controls (bar 100 fps, sine 100 fps) 1 h each → 286 Hz Mode 3 bar 1 h → 100 Hz Mode 3 bar 1 h (course
rate) → GS2 + looming 1 h each. Roughly one bench day. Report per cell: the `telemetry-report.py` tables +
`trial_quality` counts, into `sd-read-jitter-2026-09-13.md` §7.

Things the campaign will need that do not exist yet: the 2,000-frame sine and GS2 200-frame patterns on the card
(upload via the Studio, contiguous — check `sd_layout` bit0), a Mode-2 soak protocol (trialParams mode 2 with
`frame_rate`, no FicTrac plugin), and the frame-count-from-0x88 fix (#201) so the `__framesRepatch` hook is not
needed for new patterns.
