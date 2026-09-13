# SD-read jitter and card stalls in Mode 3 — evidence, corrections, what shipped, and the read-free path

**Written:** 2026-09-13 (session after the fw #50 wedge campaign). **Status:** firmware `feat/sd-fastpath-2x10`
(local, off `feat/telemetry-ring-2x10`) + webDisplayTools `claude/mode3-perf-sd` (stacked on PR #198) built;
bench validation pending (§7 records it). **Reviews:** Codex gpt-6-astra plan review
(`.codex-review/report-20260913-1030-sd-stalls.md` on the branch) and two firmware diff reviews; the
"alternative perspective" brainstorm on read-free access patterns is summarised in §6.

## 1. The question this answers

Michael's request: reduce jitter *inside* the SD frame read (no RAM-preload work-around); then, once the data
showed 30–90 ms display freezes, treat those as the first-class problem — is it the card, would another card
fix it, and could a different access pattern avoid the reads altogether? Acceptable display freeze:
**5 ms target, 10 ms worst case; ≥ 30 ms is a visible stimulus artifact and should invalidate a trial.**

## 2. Evidence (75 ring-era soak logs, 9.9 M accepted 0x70s, 2026-09-12/13)

### 2.1 Per-read cost by index step (`cf.sd_load_us`, fix build `394dee45`, run 01:40)

| step class | 20-frame grating (81 KB) | 200-frame bar (813 KB) |
|---|---|---|
| +1 sequential | 620 µs | 621 µs |
| forward jump 2–9 | 1181 µs | 1461 µs |
| backward −1 / −2..−9 | 1182 µs | 1996 µs |
| jump ≥ 10 | 1191 µs | ~1960 µs |

A +1 step continues the card's open CMD18 stream. Every other step pays one stream restart (≈ 0.55 ms of card
latency, irreducible for random access). The bar pattern's extra 0.3–0.8 ms is SdFat's `FatFile::seekSet`
re-walking the FAT chain from the first cluster on backward seeks; **correction from review:** the ARM build
keeps a separate FAT cache (`USE_SEPARATE_FAT_CACHE 1`), so the cost is the chain walk crossing FAT sectors
(implies small clusters on this card — the `sd_layout` record now reports sectors/cluster), not data-read
eviction as first written.

### 2.2 The card stalls

- 716 reads > 20 ms in 197 clusters; durations quantised 23/33/41/67/89 ms; a cluster = 3–4 stalls within
  ≤ 0.5 s (≈ 160–180 ms of card time). **Displayed-frame gap = stall + ~2 ms** (measured). Worst 96 ms, i.e.
  just under the SD spec's 100 ms read timeout.
- Count-triggered, not time-triggered: every ~48k accepted 0x70s at 100, 200 and 286 Hz alike.
- **Per file:** 712/716 stalls while the 813 KB bar pattern was open, 4 while the 81 KB grating was open, at
  equal read shares (2.69 M vs 2.70 M reads). Reads of the bar pattern between clusters: **24,573 (IQR
  23.5–25.5k, n = 107)**.
- Stalls attach to non-sequential reads (+1 steps: 7 of 395 — the card acts at a new command boundary);
  position in the file matters: stall/read ratio by 20-frame bin = 0.47/0.26/0.17/0.86/1.54/1.35/1.54/1.67/
  1.20/0.95 with uniform reads (a 3–6× difference between the first ~250 KB and the rest).
- The interval sequence is unbroken across MCU resets and the 16:45 power cycle — the counter lives in the card.
- Impact: at 200 Hz roughly one 60 s bar-pattern trial in four contains a cluster; at 100 Hz about one in ten.

### 2.3 What is inferred, not proven

Card-internal read-disturb / block-refresh maintenance keyed to reads of the region holding the big file.
Vendors document exactly this mechanism (ATP: "after ~100,000 read cycles… AutoRefresh"; Swissbit: "read
commands are monitored and the content is refreshed"; Kingston: "auto-refresh read disturb protection") but no
vendor publishes the stall duration, and no public long-run per-card read-latency data exists. The small file's
immunity is **not** explained by a per-block read counter alone (candidates: the card's read cache serves an
81 KB working set; SLC vs TLC placement; block geometry). `readFrame` timing wraps seek + data + CRC and does
not by itself identify the SD transaction; logical offset is not a NAND address. The instrumentation that
shipped (§4) is what turns these into measurements.

## 3. What was rejected and why

- **Copy rotation** (k copies of the file, rotate per trial): k copies each refresh k× less often, but there are
  k of them — the same number of stalls per read. Conservation argument; all three reviewers agreed.
- **Whole-pattern RAM preload as first proposed:** the controller has **no external PSRAM** (hardware BOM +
  `.bss.extram = 0`); 390 KiB of free OCRAM2 holds at most 97 uncompressed GS16 frames. (Compressed or
  synthesised residency is a different matter — §6.)
- **Deferring the card's maintenance from the host:** SD 6.0 §4.18 does define maintenance windows
  (Performance Enhancement register, CMD48/49, A2 cards), but SdFat's SDIO driver has no ACMD13/CMD48/49
  support, the spec does not require a card to defer read-disturb refresh to the window, and the only hard bound
  is the 100 ms read timeout. Worth a capability probe later, not a plan.

## 4. What shipped today (firmware `feat/sd-fastpath-2x10`, host `claude/mode3-perf-sd`)

Firmware (0xCB flags **bit 5 `sdfast`**; ring layout **v2**):
- **A — O(1) seeks:** pattern held as an SdFat `FsFile`, `contiguousRange()` once at open (sets
  `FILE_FLAG_CONTIGUOUS` → arithmetic seeks); fragmented file → old path; `STATE(sd_layout)` says which +
  sectors/cluster. Target: bar non-sequential medians ≈ 1.18 ms, p99 ≤ 1.6 ms.
- **B — same-index skip:** a `SET_FRAME_POSITION` for the index already in `frame_buf_` (loaded by a successful
  `loadFrame`, not overwritten since, refresh timer running) is answered without an SD read (~24 % of
  closed-loop commands; effect on stall rate is measured, not claimed).
- **Attribution:** `readFrame` times seek / body / trailer; `sd_slow` threshold 20 → **10 ms**, code byte = slowest
  phase (+ error flag); `sd_slow_ctx` (kind 12) = SdFat `errorCode()` (sticky) + USDHC IRQSTAT error bits;
  `sd_reads` (kind 13) = reads while the pattern was open (`arg << code`).
- **FRAME 20 → 26 B:** `req_age_us` u32 (0x70 dispatch → SPI start; u32 so a 90 ms stall is representable),
  `superseded` (buffers replaced before any transfer, counted on every transfer), `flags` (bit0 SD read, bit1
  contiguous). Ring `kVersion` 2: a kept v1 ring re-initialises at boot instead of being truncated — drain first.
- **`GET_SD_INFO` 0xCD** (30 B): CID/CSD identity, card + FAT type, capacity, cluster size — every measurement is
  attributable to a physical card.
- Hygiene: NVIC enable-state preserved in `disarmRefreshTimer`; `armRefreshTimer` returns bool and uses
  `IntervalTimer::update()` for rate changes; 0x16/0x70/trial start refuse a display state without a timer;
  `platform = teensy@5.1.0`; dead duplicate and stale comment removed.
- `scripts/sd_stall_test.py`: browser-free card-comparison driver writing behavior_v2 rows + inline summary.

Host (Studio v0.77):
- ring-v2 decode (`cf` rows gain three optional fields; kinds 11–13), 0xCB bit 5, 0xCD decode → `run_metadata.sd_card`;
- **`js/trial-quality.js`**: per-trial **pass / flagged / unknown** from ring records in seq order (fail = read or
  request age > 10 ms; coverage gaps → unknown, never pass; dedup by seq) → `display_gap` and `trial_quality`
  run-log events + banner. Flag only; exclusion/repeat is the experimenter's decision.
- drainer per-poll budget 40 → 200 chunks (background-tab polling could not keep up with 26 B FRAMEs);
- `scripts/telemetry-report.py`: reads accounting, step-class cost table, stall clusters with spacing in commands /
  index changes / seconds, request→presentation percentiles, per-trial verdicts — for Studio and stall-test logs.

## 5. Card characterisation protocol (cards available later; the tooling is ready)

- **Never reformat the current card**: it is the baseline (identity via 0xCD). Screen candidates on other cards.
- One frozen firmware build for all comparisons.
- **Working-set test on the current card first** (no new files): `sd_stall_test.py --window 50 / 100 / 200`
  on the bar pattern → does a 50-frame working set inside the same file stall? (H-cache vs H-placement.) A GS2
  control pattern later (bytes vs reads).
- **Screening** (per card, ~25 min): FAT32 formatted on a PC (the Studio's purge → `SD.format()` → exFAT above
  32 GiB), the two soak patterns uploaded through the Studio, one 20-min run at 200 Hz (≈ 5 baseline cycles).
  Zero clusters is a *screen pass* (95 % upper bound ≈ 3/exposure), not a qualification.
- **Qualification** of a screen-passer: ≥ 3 h continuous (≈ 40 baseline cycles), a second specimen, after
  representative upload/delete/idle history; report clusters per 10⁵ reads, max stall, affected-trial rate.
  Candidates: SanDisk Industrial (SDSDQAF3), Kingston Industrial SDCIT2 (pSLC), Swissbit S-56u (pSLC), Samsung
  PRO Endurance; exact SKU + capacity recorded.

## 6. The read-free path (Michael's question: can a different access pattern prevent the reads?)

Two independent probes (a code/patterns research pass and a Codex gpt-6-astra brainstorm) converged.

**What the actual course patterns look like** (`cshl-2026-course/patterns/`, 45 files): every motion pattern
except the looming ones is an **exact +1 px/frame azimuthal roll of frame 0** (heisenberg/bar/edge/checker/
grating families; 100 or 200 distinct frames); the looming discs/annuli are 75 frames = 305 KB (48 distinct).
Compression: whole file zlib 1–4 %; **independent-frame LZ4: 200-frame bar 813 KB → 15 KB, 20-frame grating →
1 KB, even a 2,000-frame sine → 374 KB**; byte-RLE is useless for gratings/checkers.

| option | mechanism | in-trial SD reads | latency | cost | status |
|---|---|---|---|---|---|
| **R1 Complete compressed RAM cache** (independent-frame LZ4 or per-frame zlib, offset table; loaded + CRC-validated in the inter-trial interval; hard "no SD during trial" invariant; fallback = today's path with a loud flag) | pattern fits 390 KiB compressed (all course patterns do, by 10–100×) | **none** | decode (budget ≤ 0.5 ms, measure) + 0.77 ms SPI | 2–4 days fw | **recommended first** (Codex + this session) |
| R2 Declared shift synthesis (base frame + step, index → transform) | pattern declared as an exact roll (manifest or v3 header; v2 header has no free byte) | none | repack + 0.77 ms | 2–5 days | special case of R1's coverage; keeps RAM at 4 KB; needs a declaration path |
| R3 Panel-resident PSRAM | panel fw implements the specified `0x3F` write / `0x2F` status / `0x4F` mark-loaded (today only display `0x50–0x63` exists; 16- vs 24-bit index drift) | none | 0.02 ms index transport + panel latency; upload ≈ 160 ms per 200-frame pattern (both buses), ~5 s for the whole course library at power-on (not persistent) | 5–10 days panel + controller | the architectural exit; also removes the 0.77 ms transfer |
| R4 Onboard NOR flash (Teensy 4.1 8 MB program flash, `PROGMEM` / `LittleFS_Program` region) | reserve ~1 MiB per pattern; no erase/program during trials | none | flash copy + 0.77 ms (cold-read timing to measure) | 1–2 days proof | fallback for incompressible images |
| R5 Host streams frame data (`0x32`, already implemented) | host has the pattern; USB 0.8 MB/s at 200 Hz (high-speed CDC is fine) | none | USB queueing + 0.77 ms; host stalls unbounded | 0.5–2 days experiment | **cheapest discriminating experiment**: removes SD without new firmware |
| R6 Partial cache / chunk LRU / prefetch | locality | reduced, not zero; a miss still exposes 90 ms | — | 1–4 days | rejected as a solution (misses land inside trials) |
| R7 Reachable-set cache | max step ±1 during a 90 ms outage → 19/37/53 frames at 100/200/286 Hz | hides a stall only if no jump lands in the window (8–23 % chance per stall) | — | needs async SD | partial answer; not for the current architecture |

Key reasoning: a card stall during a **preload in the inter-trial interval** merely delays a trial start by
≤ 100 ms; the same stall during the trial is a 90 ms freeze. Moving every read out of the trial is the
mitigation that does not depend on the card. R1 covers the current course library outright (the 305 KB looming
patterns even fit uncompressed) and degrades gracefully to R4/R5 for incompressible images. R3 remains the
long-term direction because it also removes the 4 KB SPI transfer per frame.

Bench-afternoon sequence proposed by the brainstorm and adopted for the next session: (1) baseline clusters on
the unchanged card with the new instrumentation (today), (2) `0x32` streaming at 100/200/286 Hz from the real
host (does removing SD remove the failure? does USB meet the deadline?), (3) resident-decode proof on the
Teensy (bar pattern: decode all 200 frames, verify CRCs, max decode cycles; random indices from RAM with SD
disabled), (4) command-count vs transferred-volume discrimination (same sector trace, different transaction
grouping; hot vs quiet window), (5) maintenance-capability probe and flash-region sizing.

## 7. Bench results (filled in as they arrive)

Control iteration 1 on `3c71953` (12:06 ET; 1273 s, 20 trials, 240k accepted 0x70s) vs the baseline iteration on
`394dee45` (01:40; same card = the unbranded SD8GB, same 200 Hz + 90° jumps workload):

| quantity | baseline | new build |
|---|---|---|
| stalls > 10 ms / clusters | 15 / 4 (every ~253 s ≈ 47.4k commands) | **0 / 0** |
| bar pattern −1 / −2..−9 / jump ≥10 / +2..9, p50 | 2.00 / 2.00 / 1.98 / 1.46 ms | **1.46 ms for all four** |
| +1 sequential (both patterns) | 0.62 ms | 0.62 ms |
| grating non-sequential | 1.18 ms | 1.18 ms |
| worst SD read (bar) | 88.6 ms | **1.8 ms** |
| SD reads per accepted 0x70 | 1.00 | **0.76** (= index changes; firmware count agrees) |
| request → SPI start (`req_age_us`) | — | p50 1.73 ms · p99 2.56 ms · **max 4.8 ms** |
| trials flagged | 4 / 20 | **0 / 20** |

Reading: fix A removed the FAT-chain walk (bar backward seeks now cost the same as forward jumps); fix B removed the
repeated-index reads exactly (0.76 = the index-change rate); every frame reached the SPI bus within 4.8 ms of its
request. The stalls did not occur at all in 1273 s where ~3 clusters were expected — see the H-FAT hypothesis in the
bench log (§10, 11:55 entry): on this 4 KB-cluster card the 813 KB pattern's chain spans two FAT sectors, so the old
firmware re-read a FAT sector from the card on most backward seeks; the grating's chain fits one cached sector. If
iteration 2 stays clean, the stalls were induced by those FAT-sector reads and the contiguous-file path is the fix
for this card and workload. A back-to-back reflash of `394dee45` (stalls should return at ~24.5k bar reads) is the
causal test. **The read-free path (§6) stays valuable** — it also takes the 0.6–1.5 ms read and the card out of
the loop entirely — but it is no longer the only route to a stall-free trial.

See `mode3-wedge-soak-plan.md` §10 for the timestamped log.
