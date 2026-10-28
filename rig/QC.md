# QC — the five-minute release validation (`pixi run qc`)

One command on a rig PC checks a webDisplayTools build end to end — the candidate on
[`/next/`](https://reiserlab.github.io/webDisplayTools/next/) before it is promoted, or what Production
serves after — in about five minutes of wall time. You watch and say "looks right" at each step; everything
except two clicks is scripted. It replaces the hour of hand-driven QC of 2026-10-27/28
(`docs/development/handover-qc-windows-2026-10-26.md`, the three prompts; results on
[PR #274](https://github.com/reiserlab/webDisplayTools/pull/274)).

The code is `rig/qc/qc.py`; the per-rig rows and the checklist text are `rig/qc/profiles.toml`; the pure
helpers are `rig/qc/qclib.py` (tested by `tests/test-rig-qc.py` at the repository root). The release
tiers themselves: `docs/development/release-process.md`.

## What to type

From the rig's webDisplayTools checkout, in `rig\` (PowerShell on the lab PCs; the rig is detected from the
hostname, `--rig` overrides):

```powershell
cd C:\Lab\GitHub\webDisplayTools\rig
pixi run qc -- --tier next
```

| where | command | profile |
|---|---|---|
| **ww18** (`reiserlab-ww18`, G6 2×10 fly-on-ball, real FicTrac) | `pixi run qc -- --tier next --rig ww18` | FicTrac through `fictrac.bat` on `rig05_vfov28_2026-09-22`; `bench_closed_loop_2x10`; Foxglove `arena-fictrac.json`; `typed` + `viz` environments |
| **ww14** (`reiserlab-ww14`, okey-cokey camera rig, BIAS + G6, no FicTrac) | `pixi run qc -- --tier next --rig ww14` | the `okey-cokey-start.ps1` flags; `g6_color_optomotor_smoke` (~2 min); BIAS must already be running (port 5010) — the pre-check drives the bias connector; Foxglove `arena-okey-cokey.json` |
| **Bergamo 2P PC** | `pixi run qc -- --tier next --rig bergamo` | `--scanimage` against ScanImage's JSON server (5555); `g6_2x10_2p_diagnostics` |
| this Mac (dry run, no controller) | `pixi run qc -- --tier next --rig mac` | FicTrac-MacOS on the looped sample video; the Studio run is skipped, the pre-check's run is judged |

Through a **Claude Code session (Remote Control)**: add `--auto`. Nothing then waits for Enter — each step
advances when its automated check holds, the `LOOK >` lines are what you confirm in chat, and the session
reads the pass/fail table at the end. Without `--auto`, Enter moves on at each `LOOK >` and anything you type
is kept as a remark in the validation note.

Other switches: `--tier prod` (what Production serves), `--sha <commit>` (a build not deployed yet, or a
Next placeholder), `--no-browser` (pre-check + reports only), `--no-foxglove`, `--skip-install`,
`--skip-requires`, `--keep-browser`, `--rm-worktree`, `--qc-root DIR`, `--lna-prompt`, `--list-rigs`.

## The two clicks

1. **Web Serial port picker.** When the script prints `CLICK >`, click **Connect** in the Studio and pick the
   controller (`G6_Arena`; on some PCs it enumerates as "USB Serial (COMn)"). Chrome only allows this on a
   user gesture, so it cannot be scripted. The script waits up to 5 minutes.
2. **Local network access (once per PC, only with `--lna-prompt`).** Chrome ≥ 142 asks a public page for
   permission before it may open `ws://localhost`. The QC Chrome profile bypasses that check (the flag the
   Foxglove app runs with); the rig's everyday Chrome asked once and remembers. Pass `--lna-prompt` to see the
   prompt and click **Allow** instead.

The bridge Connect, the protocol load, **Run experiment** and the export are driven over Chrome's DevTools
protocol, so you never click them. If DevTools cannot attach, the script falls back to printing the hand-driven
steps (bridge Connect → Connect → Run experiment → confirm the NEXT dialog) and waits for the run's bag to close.

## What happens, step by step

| step | automated check | you look at |
|---|---|---|
| 1 preflight | pixi ≥ 0.80, git, Chrome; ports 7447 / 8765 / 60000 (+ 8766) free; the rig's services up (BIAS on ww14, ScanImage on Bergamo) | — |
| 2 candidate | the tier's `build.json` → commit SHA; `git fetch` + a **scratch worktree** at exactly that commit (`<qc-root>\wt\<sha7>`) | the build label printed (`candidate 2026-10-28-rc2`, PRs …) |
| 3 install | `pixi install --locked` in the worktree — its own environment, the rig's checkout and `.pixi` are never touched; `typed` / `viz` where the profile says so | — |
| 4 graph | the candidate's `pixi run rig` with the rig's flags (flags that build does not know are dropped with a warning), bags + logs under the dated QC folder; Foxglove opened on `ws://localhost:8766` | the rig window lists its nodes; Foxglove shows the layout (import `rig/foxglove/<layout>.json` once) |
| 5 fictrac | FicTrac started (or found running); frames counted at the gateway; the simulator takes over when the camera gives none | FicTrac tracking; the printed frames/s |
| 6 pre-check | `tests/studio_emulator.py`: the Studio's exact bridge conversation (hello_ack ≥ 3.4, behavior_v2 ack, an epoch of frames, export; on ww14 also the BIAS connector) — **a broken candidate fails here**, before any browser | all PASS |
| 7 browser | Chrome (QC profile) on the tier's `arena_studio.html?mode=run&rig=…`; build SHA in the page = the candidate; footer; protocol loaded; no console errors; bridge connected with frames; **your click**; firmware + panels; **Run experiment** | the Studio; the arena during the run (the rig's `look` line says what the display should do) |
| 8 reports | `pixi run export` (closes the bag), `metadata.yaml`, `runlog-check.py`, `closed-loop-report.py` (idx mismatch ≤ 1 %), `bench-check.py` with the rig's holds + channel + build | the numbers |
| 9 teardown | FicTrac / simulator / graph stopped, Chrome closed, ports free again | the pass/fail table |

At the end the script prints the table, writes `summary.md` and `validation-note.md` into the dated folder and
prints the exact command that posts the note:

```powershell
cd C:\Lab\GitHub\webDisplayTools; pixi run tiers -- validate --rig ww18 --by "Michael" --notes-file "C:\qc\2026-10-28\validation-note.md"
```

Exit code 0 means every automated check passed; the `LOOK` rows are yours.

## Where things land

| | Windows | Mac |
|---|---|---|
| dated run folder (`qc.log`, `graph.log`, `fictrac.log`, `runlogs\` bags + live logs, `exports\`, `reports\`, `bias\`, `summary.md`, `validation-note.md`) | `C:\qc\<YYYY-MM-DD>\` | `~/qc/<YYYY-MM-DD>/` |
| scratch worktree of the build (+ its `.pixi` environments) | `C:\qc\wt\<sha7>\` | `~/qc/wt/<sha7>/` |
| QC Chrome profile (no course token, telemetry ring on) | `C:\qc\chrome-profile\` | `~/qc/chrome-profile/` |

**Disk:** a worktree environment is ~1.6 GB (`default`), +0.3 GB for `viz`; with a warm pixi cache the install
takes 10–15 s. Worktrees are kept for re-runs (`--rm-worktree` removes one at the end; `git worktree prune`
after deleting by hand). The rig's own `rig\.pixi` is never re-synced by QC.

## Safety on a rig PC

- **Refuses to start while anything is on 7447 / 8765 / 60000** (a running `pixi run rig`, bridge 3.4, another
  FicTrac receiver) — stop that first. One Zenoh graph per host; never between experiments on a rig that is
  mid-run.
- The rig's checkout is read only (`git fetch` + `git worktree add`); the candidate runs from the scratch
  worktree with its own environment and writes only under the QC root.
- The QC Chrome profile holds no course token, so a run is **not** committed to the course repo; the log comes
  out through `pixi run export` into the QC folder instead.
- Everything the script started is stopped in teardown (SIGINT → TERM → KILL, in reverse order) and the ports
  are checked free; Ctrl-C does the same.

## Adding a rig

One `[rigs.<name>]` table in `rig/qc/profiles.toml`: `hosts` (for detection), `rig_flags`, `envs`,
`studio_rig` (a name from `configs/rigs/index.json`), `protocol` (`key` = a `protocols/index.json` key loaded
through `?p=`, or `path` = loaded through the page), `fictrac` (`none` | `real` with `cmd`/`cwd`/`process`/
`fallback` | `sample`), `requires` (ports that must answer first), `precheck`, `foxglove.layout`, `reports`
(`closed_loop`, `holds`), and `checklist` lines that override the defaults by id. `tests/test-rig-qc.py`
checks every row has what `qc.py` reads.

## Known limits

- The run-log judge needs the controller telemetry ring on — the QC profile sets it before the page loads; the
  first run in a brand-new profile can still carry a ring backlog (ww18, 2026-10-27), so re-run if
  `runlog-check` complains about pre-run rows.
- `--tier prod` on a build whose `rig/pixi.lock` predates pixi 0.80 fails at the install step with pixi's
  "lock file not up-to-date" (issue #280); that is the build's state, not a QC bug.
- FicTrac on this Mac runs the 10 s sample video looped (ffmpeg) at 50 fps; without ffmpeg frames last 10 s.
- Foxglove is opened on the connection by deep link; the layout is imported by hand once per PC.
