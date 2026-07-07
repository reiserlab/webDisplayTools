# Bench testing notes — 2026-07-08 (Arena Studio 2026-07 batch)

Items from the 2026-07-07 batch (Studio v0.8→v0.12 + default-rig) that need verification or
debugging **on hardware** (arena + FicTrac bridge + course repo). The browser-only parts
(metadata pick-lists, collapsed log, paired TX/RX, footer, empty-hint, ledDrive UI/YAML) were
verified in-session; the items below could not be exercised headlessly.

## 1. ⚠ Pattern-set archive fails + drops the connection (KNOWN BUG)

**Symptom (bench, 2026-07-07):** after a completed recorded run in course mode, the SD-archive
auto-pull (`GET_SD_ARCHIVE` 0x8A, in `snapshotPatternArchive` → `commitRunLog`) aborted with
`Break received` after ~**1296 / 1730230 bytes** and **the arena connection was lost**
(`connection lost: Break received`). So it isn't a clean best-effort skip — the failed bulk
read currently disconnects the arena, which in course mode would happen after *every* run.

**Note:** the SD archive is ~1.7 MB — larger than the "patterns are small" assumption.

**First isolation step:** does **Console → Patterns → Download ZIP** (the *same* `0x8A`
`sendBulkRead` path, `csdarchive` handler) also fail on this card?
- If **yes** → it's a firmware / bulk-transfer problem with `0x8A` on large archives,
  independent of the auto-pull. Fix belongs in the transfer path (firmware or `sendBulkRead`),
  not the auto-pull.
- If **no** (Console download works) → the auto-pull's *context* is the trigger — it runs
  right after a run, during the run-log commit, possibly with the FicTrac bridge still active
  on the link. Look at ordering/quiesce/bridge state.

**Hypotheses to check:** (a) `0x8A` framing / flow-control on large (MB-scale) payloads;
(b) `quiesceDisplay()` immediately before the pull leaving a bad state; (c) the FicTrac bridge
still streaming on the serial link right after a closed-loop run; (d) a firmware-asserted
serial BREAK mid-transfer that `ArenaLink` treats as a disconnect.

**Merge state:** see the batch's final commit — the auto-pull was **[gated off / left as-is]**
before merge (record which). The `snapshotPatternArchive` code path is otherwise complete
(pull → SHA-256 → dedup `pattern-sets/<hash>/patterns.zip` → binary `directCommit`).

## 2. ledDrive — verify the % → voltage mapping with a scope (NOT yet tested)

Put a scope on the **Analog Out (0-5V)** BNC and run a condition with **LED drive** at several
percentages. Expected control voltages (digitized BuckPuck curve in `js/arena-runner-g6.js`,
`BUCKPUCK_CURVE` / `ledPercentToMv`):

| % | control voltage |
|---|---|
| 100 | ~1.65 V (full) |
| 90 | ~2.0 V |
| 50 | ~3.0 V |
| 10 | ~3.95 V |
| 0 | 5.0 V (off, past the 4.2 V shutoff) |

Confirm LED brightness tracks %. **If the curve is off**, the datasheet digitization is
approximate — replace `BUCKPUCK_CURVE` with **measured** `(mv, frac)` points (measure output
current at several control voltages per the datasheet's 0.1 Ω method) for a real photometric
calibration. It's a single array; no other code changes needed.

## 3. Closed-loop frame modulus (fix `ec09cb5`)

Run a closed-loop protocol with a multi-frame pattern (e.g. `frame2_h_ccw_200f`). The bridge
`config` line should now read `"frames":200` (was `10`), and the heading→frame mapping should
wrap over the full pattern, not every 10 frames.

## 4. SD-archive dedup (once §1 is fixed)

After the download works: run a recorded experiment → confirm `pattern-sets/<hash>/patterns.zip`
appears in the course repo. Run again with the **same** card → confirm **no** new commit
(content-hash dedup). Change/rename a pattern on the card → confirm a **new** hash/commit.

## 5. Quick course-mode confirmations

- Metadata dropdowns populate from the **course** `roster.yaml` / `genotypes.yaml` (not just
  the lab defaults) and are re-selectable; no free text accepted.
- Run log starts collapsed; paired cyan/green TX↔RX reads well during a live run.
- Default rig is **CSHL G6 — 2×10 fly-on-ball (FicTrac)** on a fresh load.
