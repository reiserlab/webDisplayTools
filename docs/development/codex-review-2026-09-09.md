# Codex cross-review of the pending merge-plan work — 2026-09-09

**Scope (four diffs, eight Codex passes, all completed):**

| Diff | Files / lines | Reviewers |
|---|---|---|
| Run-log stack: #186 Studio v0.72 + #188 readers v0.73 vs main | 24 / 3758 | Claude (independent), Codex GPT-5.5 standard, Codex GPT-5.5 adversarial |
| Analog stack: #190 Analog In S1 v0.74 + #191 calibration S2 v0.75 vs main | 8 / 1714 | same |
| #193 gzip-aware `build-runlog-index.py` (merged, `7b4e533`) | 3 / 241 | same |
| Firmware F1 #46 + F2 #47 (`feat/ai-calibration`) vs main | 9 / 705 | same |

Method: Claude wrote an independent review of each diff BEFORE Codex ran (files listed
in § 5), then reconciled. Rule from Michael: **true bugs get fixed, suggestions get
discussed.** § 1 is fixed and pushed; § 2–3 are for discussion; nothing else was changed.

## 1. Fixed and pushed (true bugs — agreement, or a Codex claim Claude verified in code)

| # | Issue | Who flagged | Where fixed |
|---|---|---|---|
| 1 | `js/runlog-replay.js` lost strict mode: the new `const Fmt` declarations pushed `'use strict'` out of the directive prologue (Prettier's `('use strict');` was the tell) — the whole replay IIFE ran in sloppy mode | Claude · Codex-std · Codex-adv | #188 branch |
| 2 | **Loopback sweep recorded readings against unapplied AO levels.** The Console `send()` helper returns the reply frame even on a non-ok status (it logs the reason), so `if (!ok)` only caught transport failures; with Analog Out in `frame_number` mode every `SET_AO_VOLTAGE` is refused and the sweep would still "succeed" | Codex-std (blocking) · Codex-adv; verified by Claude against `send()` | #190 branch (decode status, abort with a hint naming the AO mode; report a refused/unknown restore) |
| 3 | Analog In poller ignored the Console's own FicTrac closed loop (`bridge.apply`, 0x70 at ~100 Hz outside the runner) — a 10 Hz read interleaved into that stream adds frame-latency jitter | Claude (closed loop) · Codex-std (Console trials, see § 2) | #190 branch (gate on `bridge.apply`) |
| 4 | Firmware: a mis-sampled two-point record with a small span implies hundreds of volts; `GET_ANALOG_IN` cast that to `int16` and **wrapped** | Codex-std · Codex-adv (Claude noted the marginal-span case) | fw #47 (clamp to the field) |
| 5 | Firmware: `SET_ANALOG_CAL` ran while the display was active — sampling the input Mode 4 follows, mutating the record the control loop reads every sample, writing EEPROM + SD. Every other SD-writing command refuses unless stopped | Claude · Codex-std · Codex-adv | fw #47 (`CE_DISPLAY_ACTIVE` guard + HIL test) |
| 6 | `scripts/controller_info.py` decoded capability bits 0–4 only (missing `io_ext`, `ai_cal`) | Codex-std | fw #47 |
| 7 | Dashboard hover called `text.length` "bytes" | Claude · Codex-std | #188 branch (≈, annotated) |

#191 was rebased onto the fixed #190 (footer conflict resolved); full suites green on
#188 and #190; both firmware environments build. **Everything in § 1 still needs the
bench gates (B1–B4) — none of it has run on hardware.**

## 2. For discussion — Codex raised, not changed

### Run-log stack
- **`directCommitLarge` has no retry on a non-fast-forward ref update** [all three]. Another rig
  committing between the ref read and the PATCH fails the >30 MiB commit (blob/tree/commit
  become harmless orphans; the log stays on the bridge). Small fix: re-read ref, rebuild
  tree/commit with the same blob, retry ≤3, plus a mocked test. Only multi-hour or `full`
  logs take this path.
- **Ack not correlated to its request** [adv]: `log_control_ack` resolves every waiter; a
  late ack from a previous enable, or a slow bench exceeding the 800 ms wait, can label a
  run with the wrong `run_metadata.log_format` (the file's `frame_schema` stays right). A
  request id in `log_control` (bridge + client) would close it.
- **"Flipping the default to v2/.gz before a bench run"** is Codex-adv's strongest argument
  against merging. That is exactly gate B1 in the merge plan: #186 + #188 merge together only
  after a real run round-trips through the bridge, the commit path, the dashboard and the
  replay viewer.
- Browser-side truncated-gzip prefix inflation is untested (Node path is) [Claude · adv];
  `readRunlogPrefixText` returns `''` on failure, which reads as "no metadata" rather than
  "cannot inflate here" [adv]. B1's catalog check covers it; a console warning is cheap.
- No 100 MiB preflight before base64-encoding a huge blob [adv]; several full-size copies
  in memory during a large commit [std · adv]. Fine for behavior logs; note for `full`.
- The vendored decoder copy is a standing maintenance tax [adv] — known, test-enforced.

### Analog stack
- **Switch AO to programmable for the sweep and restore the mode afterwards** [std · adv]
  versus the abort-with-hint that was implemented. The rig-I/O code already clears
  `frame_number` before 0xA0; doing it inside the sweep silently changes rig state — your call.
- **Sweep verdict ignores offset** [adv]: a perfectly linear AI reading AO + 1000 mV is "ok".
  For a loopback, |offset| is diagnostic; adding `|offset| ≤ 150 mV` to the ok criterion is
  one line.
- **Console-started Mode 2/4 trials don't pause the poller** [std]. The link is idle during
  those (controller-timed), so it is harmless, but a console-trial flag would match the
  stated "a run owns the link" rule.
- Calibration writes: default 500 ms timeout vs ~10–50 ms of firmware work [std] (fine
  unless the SD is slow; rig-I/O uses 2000 ms); no double-click lock; no read-before-write
  backup of the previous record so "Clear" is only reversible to nominal [adv].
- Release note says calibration is "recorded in the run log"; it is `bridge.log` only while
  bridge logging is active [std] — wording, or also write to `activeRunLog`.
- `caisweep` is `guardDestructive`'d but not in `SAFE_BLOCKED_CMDS` although it flashes the
  LED [adv] — policy decision.
- Architecture: analog I/O ownership is now split across the I/O panel, the Analog In panel
  and rig-I/O apply [adv].

### #193 index builder
- Codex-std's "blocking" — *the dashboard still filters `.jsonl` only* — was reviewed against
  main. #188 replaces those filters with `isRunlogName` (`.jsonl|.jsonl.gz`); it confirms
  the must-land-together rule and is harmless today (no `.gz` runs exist yet).
- **Corrupt gzip is silently indexed as an "incomplete" run** [std · adv · Claude minor]:
  `inflate()` returns `''` on error. Add an `error` field to the row (and a stderr line) so a
  damaged upload is visible — small, worth doing.
- Whole-file inflate of a huge `.gz` in the Action [std · adv]: a 1 h run is ~4 MB; a
  multi-hour `full` log could be ~30 MB → ~300 MB of text. A size cap is cheap.
- No per-file isolation in the `--github` loop; `_put_index` retries with a fresh sha but
  stale content (pre-existing) [adv]; `format_version` unchanged although `file` may end in
  `.gz` and `size` is compressed [adv] — consumers handle it.

### Firmware
- **Mode 4 catch-up `while` loops are unbounded** and the 100× gain makes bursts larger
  [std · adv]. The loops pre-date F1; at unity gain ±1000 fps and a 2 ms tick is ≤ 2
  iterations, but a stalled loop (SD read) catches up in a burst. Bounded modulo arithmetic
  is a small change with no effect in normal operation — recommend; discuss timing.
- **Tighten `ainCalValidate`** (require `raw_open` near the top of range, e.g. ≥ 2048) so a
  wrong physical state cannot produce a "valid" record [std · adv · Claude]. The Studio warns
  at < 3000 counts; the firmware could refuse.
- **The G3-faithful 100× gain change is a one-way door** [adv]: decided 2026-09-07 in the
  analog plan; Codex's point stands that once users retune gains, reverting breaks the other
  way. Bench CL2 confirms the number; no G6 Mode 4 protocols exist in the field yet.
- `0xA4` growing 4 → 5 bytes [adv]: verified no sibling repo (pyDisplayTools, maDisplayTools,
  Modular-LED-Display, G4.1 controller) consumes it; accepted.
- `test_deadband_round_trip` writes EEPROM + SD on every default run [std · adv]; SD mirror
  is remove-then-write (not atomic) [adv]; EEPROM address 0 has no allocation registry [adv];
  exact-length enforcement for 0xA5/0xA6/0xA7 [std minor].

## 3. Where Codex's two passes disagree

- **Run-log stack:** standard → merge with the small fixes; adversarial → block flipping the
  producer default until ack correlation, retry and one bench round trip are proven.
  Tradeoff = gate B1 (already the plan).
- **Analog stack:** standard → one blocking bug (fixed) plus fixes; adversarial → don't merge
  the calibration layer as designed (state ownership, no backup, offset-blind verdict).
  Tradeoff: S2 is inert without `ai_cal` firmware; gate B4 exercises it on the bench first.
- **Firmware:** standard → fixable in place; adversarial → split into raw-read/capability,
  calibration, and gain-change PRs with a version boundary. Tradeoff: F1/F2 are both
  unbenched; gates B3/B4 decide before anything ships to a rig.

## 4. Open questions for Michael

1. Sweep: keep abort-with-hint, or auto-switch AO to programmable and restore the mode?
2. Add |offset| to the loopback verdict?
3. Bound the Mode 4 catch-up loop now (tiny) or after bench B3?
4. Tighten `ainCalValidate` in firmware (raw_open ≥ 2048)?
5. `directCommitLarge` retry — now, or when a >30 MiB run first appears?
6. #193: mark corrupt gzip rows with an `error` field (small) — do it?
7. Gate `test_deadband_round_trip` behind the destructive flag?

## 5. Raw outputs (scratch worktrees, not committed)

Per diff: `.codex-review/claude-analysis-<ts>.md`, `codex-diff-review-*/standard.md`,
`adversarial.md`, `diff.patch`, `meta.json`, under the review worktrees `cr-runlog`,
`cr-analog`, `cr-idx`, `cr-fw` in this session's scratchpad. Codex ran `gpt-5.5`; every
pass exited 0.
