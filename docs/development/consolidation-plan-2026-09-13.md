# Consolidation plan — production candidate for the lab hand-off (draft 2026-09-13 15:40 ET, for Michael's review)

Goal: by tomorrow morning, ONE firmware build and ONE Studio version that the lab can flash, run and review, with
overnight benchmark data taken on exactly that build. Small changes only; every change re-reviewed; nothing rewritten.

## 1. What the candidate is

| piece | today | candidate |
|---|---|---|
| firmware | `feat/sd-fastpath-2x10` @ `75405ee` (31 commits on `arena-2x10-local`: health → ring → watchdog → free-running timer → SD fast path) | same branch + the small changes below, rebuilt, flashed for the overnight run |
| Studio | PR #198 (v0.76) + PR #202 (v0.77) | same PRs + small changes below (v0.78 if any HTML edit) |
| tools | `scripts/sd_stall_test.py`, `sd_upload_pat.py`, `sd_soak_campaign.sh` (firmware repo); `telemetry-report.py`, `wedge-scan.py`, `make-stress-patterns.js` (web) | committed, documented in the run sheet |

## 2. Review gates before the overnight flash (this evening)

1. Whole-stack Codex adversarial reviews, running now: firmware `arena-2x10-local..HEAD`, web `main..claude/mode3-perf-sd`.
   Reconcile → fix only blocking/significant items → one more Codex diff review of the fix delta → rebuild.
2. HIL on the rebuilt hex, port free: `pytest --transport=serial --port … tests/test_firmware_version.py
   tests/test_health.py tests/test_telemetry.py tests/test_lab79_sd.py --pat soak-patterns/bar_200f_gs2.pat`.
3. `pixi run test` + `format-check` (web). Studio smoke on the bench origin: connect, label `freerun sdfast`, one 60 s
   Mode-3 trial with the trial-quality banner (the v0.77 verdict path has not yet seen a real trial).

## 3. Decisions for Michael

- **Keep `SET_SD_DIAG` 0xCE in production?** Recommend **keep** (gated on flag bit 6, off at boot, restored by the
  harness) but add a Studio banner when the readback is non-zero at connect (S-1 below). Alternative: compile it out
  (`fw_sd_diag = false`) for the release build — loses the lab's ability to reproduce the stall on demand.
- **Merge target for firmware:** PR against `arena-2x10-local` now (fast-forward, what the CSHL controllers run);
  port to `main` (per-board `-DARENA_HW_*` after #48) as a follow-up PR that supersedes #53. Needs your go to push.
- **Web:** merge #198 then #202 as they are (stack), or squash into one PR? Recommend as they are — the commit history
  is the review trail; release notes v0.76/v0.77 are the reading guide.

## 4. Small changes proposed (only these unless the reviews find more)

| id | repo | change | why |
|---|---|---|---|
| F-1 | fw | `SET_SD_DIAG` bit0 refused (status 1) when the volume is exFAT | the arm is a silent no-op there (Codex rounds 3/4) |
| F-2 | fw | README: causal result + "production = flags 0"; `scripts/` section lists the three bench tools | hand-off |
| S-1 | web | Studio: banner "SD diagnostic switches are ON (arm N)" when `GET_SD_INFO` byte 29 ≠ 0 at connect / run start | a stray arm would silently degrade every trial |
| S-2 | web | run sheet: browser-free campaign path (upload + `sd_soak_campaign.sh`) as the default overnight tool; Studio path as the alternative | it is what ran tonight |
| S-3 | web | CLAUDE.md: one line on `sd_soak_campaign` / `sd_upload_pat` and on "stalls were FAT access — never re-introduce chain-walking seeks" | institutional memory |

## 5. Overnight run (on the candidate)

`scripts/sd_soak_campaign.sh PORT "<sine idx> 36" 200 <until 08:00>` — 10-min alternating segments of the 8 MB sine and
the 813 KB bar at 200 Hz, Mode 3 random walk + 90° jumps, from ~21:00 to 08:00 (~66 segments, ~8 M commands). Morning:
`telemetry-report.py soak-logs/sdstall-*-camp-200-*.jsonl` + `campaign-*.log`. Pass = 0 reads > 10 ms, 0 reboots,
req_age max < 10 ms; per-file read cost tables are the benchmark numbers for the hand-off.

## 6. Documentation to update before hand-off

firmware README (F-2), web release notes (S-1), `soak-handoff-2026-09-14.md` (S-2, morning results), CLAUDE.md (S-3),
`sd-read-jitter-2026-09-13.md` §7 result (done), fw #54 / web #201 closing comments, memory.
