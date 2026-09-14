# SD card comparison — quick, browser-free, minimal hands (2026-09-14)

**Goal.** Put a number on two candidate cards against the course card (the baseline) with the production firmware
(`781efe2` / PR #56) in under an afternoon, with Michael's hands needed only to swap cards. Not a qualification (see the
archived causal-test plan §I.3 for what that would take); a screen with the same build, patterns, host and harness on all
three cards.

Cards: **course card** (baseline — never reformatted, it is the control), **SanDisk High/Max Endurance**, **Gigastone MLC**.
Record the exact SKU, capacity and the `GET_SD_INFO` identity (CID/MID/PNM, FAT type, cluster size) per card — the
harness prints it at start.

## Why this is informative even though the fast path is on

With the fast path (arm 0) the baseline card is nearly clean (one card-internal event per ≈ 3 M reads on the 8 MB sine,
none on course-sized files), so a 20-minute arm-0 run cannot separate cards. The discriminating test is **arm 1**
(`--sd-diag 1`: the legacy FAT-chain seek the old firmware used). On the baseline card it produced a stall cluster every
≈ 24.5 k reads of the bar (≈ 4 clusters per 10⁵ reads, 23–91 ms each). A card that does **not** stall under arm 1 has a
different read-disturb/maintenance behaviour and is the better card regardless of firmware; a card that stalls at the same
rate tells us the fix is the firmware, not the card. Arm 1 is refused on exFAT (the library flags exFAT files contiguous at
open), so candidate cards must be **FAT32**.

## Per card (≈ 45 min, unattended after step 3)

0. Studio must release the port first: in the Studio tab console `Studio.session.disconnect()` (or Disconnect).
1. **Format FAT32 on the Mac** (candidate cards only, never the course card):
   `diskutil list` → find the card → `diskutil eraseDisk FAT32 ARENA MBRFormat /dev/diskN` (32 KiB clusters by default —
   record it; 4 KiB on the course card). Cards above 32 GB ship exFAT and must be reformatted this way.
2. Power the controller down, swap the card, power up (the card is mounted at boot). No evidence is lost: this is not a
   fault investigation.
3. Upload the two patterns browser-free (firmware checkout, `scripts/`):
   `pixi run python scripts/sd_upload_pat.py --port $PORT --file soak-patterns/sine_2000f_gs16.pat --name sine_2000f_gs16`
   and the same for `036_p3_heisenberg_ts.pat` as `p3_heisenberg_ts` (from the course repo `patterns/`). The tool prints the
   1-based index; the harness takes the index. A one-pass upload is contiguous — the harness's `sd_layout` line confirms it.
4. Three runs, one command each (the harness restores the controller's diag flags on exit):
   | run | command | what it measures |
   |---|---|---|
   | R1 | `sd_stall_test.py --port $PORT --pattern <bar idx> --hz 200 --minutes 10 --sd-diag 1` | FAT-chain stalls (the card's read-disturb behaviour); baseline ≈ 5 clusters in 120 k reads |
   | R2 | `… --pattern <bar idx> --hz 200 --minutes 10 --sd-diag 0` | production path on the bar: per-read cost, any stall |
   | R3 | `… --pattern <sine idx> --hz 200 --minutes 20 --sd-diag 0` | production path on the 8 MB file: per-read cost, random-seek max, card-internal events |
5. `pixi run python scripts/telemetry-report.py soak-logs/sdstall-*.jsonl` (webDisplayTools) over the three files.

Run the **baseline card last** (R1 + R2 only, 20 min) so the three cards see the same build and host on the same day. Its
earlier numbers (2026-09-13 causal test, arm 1: 24.5 k reads per cluster; arm 0: 0 stalls / 482 k) are the sanity check.

## The table to fill

| card (SKU, GB, FAT, cluster) | R1 clusters / 10⁵ reads | R1 max stall | R2 read p50 / max | R3 read p50 / max | R3 reads > 10 ms |
|---|---|---|---|---|---|
| course card (baseline) | ≈ 4 (2026-09-13) | 91 ms | 1.46 / 1.8 ms | 1.39 / 1.8 ms | 0 in 240 k (1 per ≈ 3 M overnight) |
| SanDisk Endurance | | | | | |
| Gigastone MLC | | | | | |

Decision rule for the course: a candidate is **worth swapping in** only if R1 is clearly below baseline (a card that never
stalls even under the old access pattern is insurance against any future FAT touch) AND R2/R3 are no worse. Equal R1 →
keep the course cards; the firmware fix is what matters.

## Notes

- A wrapper `scripts/sd_card_compare.sh` (upload → R1 → R2 → R3 → report, absolute deadlines like `sd_soak_campaign.sh`)
  belongs in the firmware repo on its own branch, not in PR #56.
- Do not run this on the lab's controllers today; it is a bench-only activity on the macOS bench controller.
- The 0xCE diag switch stays in the production build for exactly this use (decision 2026-09-13).
