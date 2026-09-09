# Merge + bench plan, Tue 2026-09-08 – Wed 2026-09-09

Written 2026-09-07 18:20 ET after merging #187 (runlog-index Action) and #183 (bridge
`behavior_v2`) to `main` (`bb8078d`). Everything below is a checklist; tick items as they
land. Gates are explicit — a PR merges only when its gate row is green.

## State at start

| PR | What | Base | Needs before merge |
|---|---|---|---|
| **#186** Studio v0.72 gzip commits + v2 default | webDisplayTools | main (retargeted; **conflicts** — rebase) | rebase onto main (plan-doc conflict is trivial: #183 squashed the same text), CI green, bench gate B1, merge **together with #188** |
| **#188** readers v0.73 (`js/runlog-format.js`) | webDisplayTools | #186 branch → retarget to main after #186 | rebase (dashboard `app.js`, `index.html`, `tests/test-analysis.js` conflict with #184/#185), CI green, bench gate B1 |
| **#190** Console Analog In S1 v0.74 | webDisplayTools | main | rebase after #186/#188 (Studio HTML, release notes, pixi.toml), bench gate B2 |
| **#191** analog calibration UI S2 v0.75 | webDisplayTools | #190 | retarget after #190; needs fw F2 on hardware; bench gate B4 |
| **#178** data-repo registry | webDisplayTools | main | rebase; **bump v0.72 → v0.76** (collides with #186); rig checklist in the PR |
| **#175** Isabel's closed-loop bias | webDisplayTools | main | Isabel rebases (runner + tests + Studio conflicts, 10 behind); confirm still wanted |
| **fw #46** F1 12-bit ADC + G3 gain | firmware | main | bench gate B3 on a **LAB-209-reworked board** |
| **fw #47** F2 EEPROM calibration 0xA5–0xA7 | firmware | #46 | retarget after #46; bench gate B4 |
| telemetry ring-buffer proposal (docs, branch `claude/data-logging-ring-buffer-9f400b`) | webDisplayTools | main | open the PR; no conflicts (new file) |

Rules that bit today: **PR CI runs only when the base is `main`** — retarget, then wait for
green, then merge. **Squash-merging a stacked PR's parent leaves the child conflicting**
(its branch carries the pre-squash commit); rebase the child, don't merge-in main. **Never
`--delete-branch` on a PR that is another PR's base** — GitHub closes the child (recovered
today by restoring the ref, reopening #186, retargeting, deleting again). Pages serves
`main` only → bench-test branches by serving a worktree locally
(`python -m http.server 8080`) with that branch's bridge (`pixi run bridge`).

Prerequisites to line up **before** Tuesday: (1) a controller board with the LAB-209 divider
rework (Frank) — without it every analog test saturates above 0 V and gates B3/B4 cannot run;
(2) a rig with FicTrac + bridge for gate B1 (any course bench, or the office 2×10 with the
simulator `pixi run sim`); (3) the AD3 + a BNC cable for the AO→AI loopback and the Mode 4
fps meter.

## Day 1 — Tuesday 2026-09-08: run-log stack, then Studio S1

### Morning (desk)

- [x] ~~Codex cross-review of all pending work~~ — done 2026-09-09 morning, see
      `docs/development/codex-review-2026-09-09.md`: 7 true bugs fixed and pushed (#188 strict
      mode; #190 sweep refusal + closed-loop gating, #191 rebased; fw #47 calibration guard +
      mV clamp + controller_info bits); design suggestions listed for discussion.
      Also rebased #186/#188/#190/#191 onto main afterwards: #193 and the two stacks all add
      a test to the one-line `test =` task in pixi.toml, so #188 and #190 conflicted with main
      until merged by hand (both tests kept). Whichever of #188/#190 merges second will hit
      the same one-line pixi.toml conflict once more — the resolution is always "keep every
      test".
      Second pass (Codex discussion items 4/6/7/8/9/10) done and pushed: #190 (offset
      criterion), #191 (2 s cal timeout + click lock, rebased again), fw #47 (O(1) Mode 4
      skipping, plausibility-checked cal points, gated deadband test), #194 merged + installed
      (damaged-gz rows carry `error`).
- [ ] **Course benches:** `git pull` + restart `pixi run bridge` (bridge 3.0 is on main; an
      old bridge still works with old Studios, the ack just becomes visible).
- [x] ~~Rebase #186 onto main~~ — done 2026-09-07 evening (clean: git dropped the
      already-squashed bridge commit); full suite green; force-pushed.
- [x] ~~Rebase #188 onto the rebased #186~~ — done 2026-09-07 evening. Three dashboard
      files resolved: kept #184/#185's column registry and per-folder `index.json` lookup,
      swapped the `.jsonl` filters for `F.isRunlogName`, ported the readers' gz-aware size
      label/hover into the `size` column, kept both test blocks; fresh cache stamps
      `?v=20260907-1`. Dashboard test + full suite green, Prettier clean; force-pushed.
      #188 still bases on #186's branch — retarget → main after #186 merges.
- [x] ~~Index builder is gzip-blind~~ — fixed 2026-09-07 evening in a follow-up PR to #187
      (`fix/runlog-index-gzip`): `.jsonl.gz` read whole + inflated, head/tail parsing
      unchanged; index byte-identical for all 149 v1 logs in the course clone; 9 gz twins of
      real logs identical apart from `file`/`size`; 17-check test in `pixi run test`.
      Merged as #193 (main `7b4e533`) and installed byte-identical into
      `cshl-2026-course/.github/scripts/` (commit `37d003e`); a `workflow_dispatch` full
      rebuild ran green on the live repo — every folder "index.json unchanged — skipped",
      i.e. the new script reproduces the existing indexes exactly. Gate B1's last checkbox
      now only needs a real `.gz` run to appear in an index.
- [x] ~~Corpus gates~~ — run 2026-09-07 evening on the rebased #188 against the
      fast-forwarded clone (174 logs now): bridge round trip **174/174**, dashboard parity
      **174/174**. The first parity run failed on the 12 `runlogs/<folder>/index.json` files
      (#187's catalogs) because the shared `isRunlogName` accepted bare `.json` and #188 uses
      it for directory listings — fixed on the #188 branch (filter is `.jsonl|.ndjson` + `.gz`;
      a user-dropped `.json` still loads), vendor copy synced, test updated, suite green.
- [x] ~~Merge #189~~ — merged 2026-09-07 evening.

### Afternoon (rig) — **gate B1: v2 end to end**

Serve the #188 worktree locally; bridge from the same worktree.

- [ ] Studio banner names the bridge-acknowledged level `behavior_v2`.
- [ ] Short P3-style run (≥ 2 conditions, ≥ 60 s) → log contains `["a", …]` rows and
      frame rows; `bridge.py --convert` round trip is canonical-JSON identical.
- [ ] Run-log commit lands as `runlogs/<bench>/<name>.jsonl.gz`; size line shows raw → gz.
- [ ] Force the > 30 MiB path once with the threshold override → one blob/tree/commit/ref.
- [ ] Dashboard (served from the #188 worktree) opens the `.gz` from the repo **and** from a
      local file; a v1 run of the same protocol gives identical P3 page values.
- [ ] Replay viewer and the Alt replay picker open the `.gz`; an old v1 `.jsonl` still opens.
- [ ] `runlog-index` Action produced/updated `runlogs/<bench>/index.json` after the commit.

Pass → **merge #186 and #188** (retarget #188 to main first; squash each; do not delete
#186's branch until #188 has been retargeted). Hard-refresh Pages, repeat the dashboard open
from Pages. Then rebase `feat/console-analog-in` onto main (Studio HTML + release notes +
pixi.toml), bump nothing (v0.74 is still next), push → #190 CI.

### Late afternoon — **gate B2: S1 on today's firmware** (any board)

- [ ] Analog In panel: live readout at 10/5/2 Hz, pauses with a visible reason during a run
      and when disconnected; no log flooding (state changes only).
- [ ] AO→AI loopback sweep: on a reworked board the verdict is `ok`; on an un-reworked board
      the panel names the LAB-209 signature (flat ≈ +10 V) — either result is a pass for the UI.
- [ ] `pixi run test` green; tooltips + HELP entries present on every new control.

Pass → **merge #190**; retarget #191 → main (do not merge yet).

## Day 2 — Wednesday 2026-09-09: firmware F1/F2, then S2, then cleanup

### Morning (bench, reworked board, AD3) — **gate B3: F1**

- [ ] Flash `feat/ai-12bit-g3-gain` (`pio run -e teensy41-performance -t upload`); run the
      HIL suite: `pytest tests/test_io_roles.py tests/test_commands.py` — 0xA4 is 5 bytes,
      12-bit flag set.
- [ ] Analog plan § 5.1 T1 ground-cap → ≈ 0 mV; T2 linearity −10…+10 V in 2 V steps (AD3 as
      source, DMM as truth) → residual ≤ 30 mV; T3 noise at 12-bit (std of 100 reads ≤ 2 LSB).
- [ ] CL2: Mode 4 with gain 10, +1 V DC → AO `frame_number` sawtooth on the AD3 shows
      **100 fps**; −1 V reverses; gain 5 → 50 fps.

Pass → **merge fw #46**; retarget #47 → main; flash `feat/ai-calibration`.

### Midday — **gate B4: F2 + S2**

- [ ] `pytest tests/test_analog_cal.py` (with `AI_CAL_DESTRUCTIVE=1` on the bench board).
- [ ] From the Studio (#191 worktree, advanced mode): C1 two-point per channel → DMM at ±5 V
      within 20 mV; C2 power-cycle + SD swap keeps the record; Clear → flags 0; C3
      `/config/analog_cal.json` appears on the card.
- [ ] Mode 4 CL1: zero input, deadband 20 mV → no drift over 60 s.
- [ ] S2 UI: Read table, guided steps, deadband set/clear, `needs ai_cal firmware` text on a
      pre-F2 controller.

Pass → **merge fw #47**, then **merge #191**.

### Afternoon (desk)

- [ ] Rebase **#178** onto main, bump to **v0.76**, run its rig checklist items that need no
      hardware; merge if green (the course benches keep their stored repo — verify once).
- [ ] Message Isabel about **#175**: rebase needed; confirm the bias feature is still on the
      fall plan; offer to pair on the runner conflicts.
- [ ] Open the **telemetry ring-buffer proposal PR** from `claude/data-logging-ring-buffer-9f400b`
      (docs only). Ask the group for the § 6 decisions.
- [ ] Release notes: one entry per merged Studio version; footer versions monotonic
      (v0.72 #186 → v0.73 #188 → v0.74 #190 → v0.75 #191 → v0.76 #178).
- [ ] Update `CLAUDE.md` gotchas only if something new bit (the three rules above are
      candidates).

## If a gate fails

- B1 fails on the dashboard → merge #186 anyway is **not** allowed (v0.72 writes `.gz` that
  no reader opens); fix #188 first or hold both.
- B3 fails on linearity → likely an un-reworked board (LAB-209), not F1; check T1 first.
- B4 fails on persistence → EEPROM path; the SD mirror is write-only by design and is not
  the source of truth.
- Anything on macOS Chrome bulk reads → #153, unrelated to these PRs; note and move on.

## Not in these two days

Ring-buffer test firmware (T1–T6, L1–L4) — starts after the group has the proposal;
oscilloscope analog trace set (S4); Isabel's #175 rebase (hers).
