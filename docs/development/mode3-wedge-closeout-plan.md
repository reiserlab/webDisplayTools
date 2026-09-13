# fw #50 campaign — close-out and PR consolidation plan

**Status:** open task, target 2026-09-13. **Owner:** Michael + Claude. **Tracker:** webDisplayTools issue
"Consolidate the fw #50 campaign into reviewable PRs" (filed 2026-09-12 17:35 ET; see the issue for the
checklist). Michael's rule: **at most two stacked PRs per repo**, each explainable on its own; not the
30 + 13 commits as they landed under bench pressure.

## What exists right now (2026-09-12 17:35 ET)

| Repo | Branch | Size | State |
|---|---|---|---|
| webDisplayTools | `claude/mode3-wedge-soak` (PR #198, draft-ish) | 30 commits, 38 files, +6.1k lines | tests green; Prettier clean; every commit pushed |
| LED-Display_G6_Firmware_Arena | `feat/telemetry-ring-2x10` (off `arena-2x10-local`) | 13 commits | not a PR yet; PR #53 (`feat/controller-health`, off `main`) covers only GET_HEALTH + soak script |

Bench: one CSHL 2×10 controller, firmware `320e26d` to be flashed at the 17:52 boundary; soak logs in
`soak-logs/` (gitignored, ~0.5 GB), wedge captures under `soak-logs/wedges/`.

## Proposed PR structure

### webDisplayTools

**PR A — fail-closed fault lifecycle + soak harness** (the fw #50 host response; no telemetry ring)
- `js/fictrac-bridge-client.js` fault latch (≥3 of 10), `logRows`; `js/arena-runner-g6.js` `fault()`, terminal
  event after STOP, `stopAcked`; `js/arena-session.js` fault routing, link facade, `reconnect`, `flushRx`,
  `send({silent})`, reject→throw; `js/arena-link.js` `reconnect()` via `getPorts`, write deadline;
  `js/studio-postmortem.js` (probes, halt/reset-continue, self-reset path, evidence-first order);
  `js/run-log.js` + `js/studio-runlog-adapter.js` `CONTROLLER_FAULT`; `js/studio-url-state.js` `soak`;
  `arena_studio.html` fault banner, `handleControllerFault`, deferred commit, `runOnce`, soak driver,
  link-drop-as-fault, identity on every link-up, GET_HEALTH/0xCB readouts; `js/arena-wire-g6.js`
  health/version/frame-position encoders (the ring/telemetry opcodes go to PR B);
  `scripts/wedge-scan.py` + tests; `protocols/soak_mode3_closed_loop.yaml`; `fictrac_sim.py` walk/jump flags;
  docs: `mode3-wedge-soak-plan.md`, status doc, release notes v0.76 entry, CLAUDE.md fault-lifecycle rules.
- Reviewers can read it as: "a wedged controller stops the run, is probed, is logged, and the soak driver
  reproduces it overnight."

**PR B (stacked on A) — controller telemetry ring, host side**
- `js/arena-telemetry.js` (parse, drainer with ack-means-stored + rearm, poller), wire 0xA8/0xA9/0xCC
  encoders + HEALTH v2–v4 tails, Studio `initTelemetry`/`drainTelemetry`/`readCrashReport`/telemetry
  toggle/poller gating, bridge 3.1 `rows` + `ROW_MIN_LEN`, readers skip tagged rows (`runlog-replay.js`,
  dashboard `analysis-core.js`), wedge-scan controller columns and pre-boot tails, CLAUDE.md ring rules,
  the two Codex reconciliation docs, the telemetry handover doc.
- Reviewers can read it as: "the ring's rows enter the behavior_v2 log and every reader stays correct."

Squash strategy: `git rebase -i main` on a fresh branch per PR, grouping by the file lists above; keep
the two reconciliation reports and the bench log as-is (they are the audit trail). Re-run
`pixi run test` + `pixi run format-check` after each squash. Footer timestamp bumps collapse into the
final commit of each PR.

### Firmware (`LED-Display_G6_Firmware_Arena`)

**PR F1 — health + build identity** (already PR #53 off `main`; retarget/rebase decision needed because
the bench ran the `arena-2x10-local` cherry-picks): GET_HEALTH 0xCA (v1 layout), reset-surviving breadcrumb,
GET_FIRMWARE_VERSION 0xCB + `scripts/build_version.py`, `scripts/soak_mode3.py`, tests, README.
Base-branch gotcha (`main` = 4×10) must be in the PR description.

**PR F2 (stacked on F1) — telemetry ring + diagnostic watchdog**
- Ring (0xA8/0xA9, OCRAM 0x2026F000, records, ack cursor, heap guard, exact-size repair), 0xCB flags bits 2/3,
  GET_CRASHREPORT 0xCC, sub-op + ISR breadcrumbs (separate `'H6IR'` record), RTWDOG (clock gate, empirical
  500 Hz, 2 s / 30 s long-op window, pre-reset PC capture, SET_TELEMETRY bits 4–6), tests, drain script, README.
- **Before opening:** collapse the GET_HEALTH payload tag to ONE new version (today's `ver 1→4` were bench
  iterations — the tag is a per-command wire byte, not a log version); move the bench-only watchdog verify
  fields (`wdog_cs_*`, `wdog_tick_hz`, `wdog_verify`) out of GET_HEALTH into a diagnostic opcode or drop
  them; decide `HEALTH_WATCHDOG` default for course controllers (fw #54 discussion).
- Deferred hardening stays in fw #54 (dual ring headers, linker reservation, cursor epoch, PSRAM/stream
  FRAME identity, versioned crash envelope, temp-file pattern replacement, recovery-mode boot).

## Also on the close-out list

- Update Linear **LAB-212** (self-healing): bootloader route validated on real wedges (×3), hardware
  watchdog self-reset built and proven, Studio self-reset path, what a Chrome-only recovery needs, scientific
  resume still open. Update **LAB-149** with the ring's bench status (already partly done 12:31).
- fw #50: post the morning analysis (wedge intervals, post-power-cycle exposure, any watchdog-captured PC
  resolved with `arm-none-eabi-addr2line`).
- fw #54: add the health-tag collapse and the diagnostic-opcode split.
- Morning analysis of the night's logs: `wedge-scan.py soak-logs/*.jsonl`, the round-trip decomposition
  (index-matched pairing), telemetry-on vs -off exposure comparison; then the stock `arena-2x10-local`
  control night (time-boxed per the status doc §4.4).
- Parallel session's deliverables (telemetry metrics spec, SD-jitter proposal, `scripts/telemetry-report.py`)
  land on their own branch; reconcile with PR B's file list before either merges.
