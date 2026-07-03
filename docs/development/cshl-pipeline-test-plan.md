# CSHL 2026 — full test plan & end-to-end walkthrough

Everything that landed 2026-07-03 across the two build sessions, organized so
you can budget time. Two arcs shipped:

- **Session 1 (#135, merged #137)** — session rig identity + rig `io:` power-on
  defaults + firmware MAC in 0xC2. Hardware/bench items live in
  [`135-bench-checklist.md`](135-bench-checklist.md) and are **already
  bench-signed-off** (2026-07-03); this plan references them, doesn't repeat
  them.
- **Session 2 (course data pipeline, Arena Studio v0.5 + Pattern Editor
  v0.9.41)** — the GitHub course-data flow. This is the arc that still needs a
  real end-to-end pass on hardware.

## Where the risk actually is (what's verified vs. what isn't)

| Layer | Status |
|---|---|
| Unit / logic (761 checks, `pixi run test`) | ✅ passing |
| Browser behavior against a **mocked** GitHub API | ✅ verified (dev session) |
| **Live** push/pull to `reiserlab/cshl-2026-course-data` (protocol, .pat, promote+guard, runlog, roster, >1 MB) | ✅ verified via the real API (dev session, artifacts cleaned) |
| Session-1 hardware (MAC, rig lock, framescan, AO idle, DIO boot) | ✅ bench-signed-off (135 checklist) |
| **Full end-to-end on YOUR bench: connect → run → auto-commit runlog** | ⛔ **not yet — this is the main thing to do** |
| Multi-browser / multi-bench concurrency | ⛔ not yet |
| Guest account + shared PAT on real benches | ⛔ human setup (see Prereqs) |
| Negative `frame_rate` Mode-2 reverse (fw #4) | ⛔ 135 checklist §C2, still open |

So: the code paths are proven in isolation and against the real repo from one
browser. What remains is **the integration** — real arena + real bridge + real
SD patterns, one clean run producing a committed log — plus the human account
setup and the couple of deferred hardware items.

---

## Prerequisites — the one-time instructor setup

Do these once before the test week. Budget ~1–2 h the first time.

### P1. Guest account + shared PAT
- Create a dedicated GitHub account for the course (e.g. handle `cshl-2026` —
  usernames can't contain spaces, so "CSHL 2026" becomes the *display name*).
- Add it to the repo: **Settings → Collaborators → Add** `reiserlab/cshl-2026-course-data`
  with **Write**. (Or ask me to run `gh api -X PUT
  /repos/reiserlab/cshl-2026-course-data/collaborators/<handle> -f permission=push`
  once the handle exists.)
- From that account, generate a **fine-grained PAT** scoped to **only this
  repo**, permission **Contents: Read and write**. This one token goes on all
  benches. Students never see it.

### P2. Repo — DONE
- `reiserlab/cshl-2026-course-data` exists (private), seeded with `README.md`,
  `roster.yaml` (4 test students: michael/frank/isabel/anna_marie), and the
  `protocols/shared/` + `runlogs/` skeleton. Edit `roster.yaml` for the real
  bench layout when known.
- ⚠ **Do NOT enable branch protection** on `main` — benches commit directly.

### P3. Per-bench Studio config (repeat on each bench laptop)
Arena Studio → **File ▾**:
1. GitHub **Sign in…** → paste the shared PAT → answer **YES** to "Remember
   this token" (localStorage; a sessionStorage-only token dies when the tab
   closes — a classic footgun for a kiosk bench).
2. **Repo** = `reiserlab/cshl-2026-course-data`.
3. **Bench id** = `bench01`…`bench07` (must match `roster.yaml`).
4. Check **"Commit directly to default branch"**.
Expected: the save label reads **"Save → course repo"** and the destination
line names `…/protocols/<bench-id>/`.

### P4. Bridge + SD + firmware (per bench)
- `pixi run bridge` running on the bench machine (the run gate requires it).
  Use `pixi run sim` alongside it if you want synthetic FicTrac frames for a
  closed-loop test; **a plain `pixi run bridge` with no fly is enough to
  exercise the whole logging + commit pipeline.**
- SD card loaded with the curriculum patterns (names must match what the
  protocols reference — see the preflight test P?/2.7).
- Controller flashed from firmware `main` (post-#137: MAC in 0xC2 + io_ext).

---

## Part 1 — Session-1 hardware (reference)

Already bench-signed-off 2026-07-03. Re-run only if you reflash or change
benches. Work through [`135-bench-checklist.md`](135-bench-checklist.md):
- **§A** firmware MAC in 0xC2 (feeds the roster cross-check below)
- **§B** session rig lock across Run/Edit/Console + `?rig=`
- **§C** rig `io:` power-on defaults (DIO roles, AO 5 V idle)
- **§E** extended I/O command set (io_ext capability gating)
- **§C2** negative `frame_rate` Mode-2 reverse — **still open**, verify when convenient
- **§D** regression sweep

Deferred (not blocking the course): Digital IO 2 trigger-pulse semantics and
Analog-In / Mode-4 calibration (`ai: in` stays locked until that AD3 session).

---

## Part 2 — Pipeline dry-run (browser only, no fly, ~30–45 min)

Fastest confidence pass. Needs a bench laptop with the arena connected (for the
connect-time and preflight bits) but **no fly and no recorded run**. Each step
lists the expected result; all were verified against the mock + live repo in
the dev session, so a failure here means an environment/config issue, not a
code regression.

**2.1 Settings persist across reload.** Configure P3, reload the page.
→ Repo, bench id, and direct-commit checkbox come back; save label still
"Save → course repo".

**2.2 Roster prefill + datalist.** Connect the arena (bench id = `bench01`).
→ Experimenter auto-fills **michael**; the experimenter dropdown lists
michael/frank/isabel/anna_marie; the "source" note names
`…/roster.yaml`.

**2.3 MAC cross-check chip.** With bench id = `bench01` on the dev-bench
controller (MAC `04:E9:E5:12:91:E2`) → **no chip**. Temporarily set the bench
id to `bench02` (frank, no MAC in roster) → still no chip (unknown MAC is not a
mismatch). To force the chip: put a *wrong* MAC on the matching roster entry
and reconnect → amber **⚠ bench ≠ roster**.

**2.4 Save a protocol → course repo.** Open any protocol (📂 or "Open from
library…"), fill experimenter+genotype, **File ▾ → Save**.
→ Banner "✓ Saved to …/protocols/`<bench-id>`/`<name>`.yaml"; the URL becomes
`?repo=reiserlab/cshl-2026-course-data&p=protocols/<bench-id>/<name>.yaml`.
Confirm the file appears in the repo on GitHub.

**2.5 Open from course repo.** File ▾ → **"Open from course repo…"**.
→ Picker lists your bench's saves + anything under `protocols/shared/`.
Selecting one loads it and reproduces the `?repo=…` URL.

**2.6 Open-from-library.** File ▾ → **"Open from library…"** → lists the site's
own curriculum (`protocols/index.json`), loads read-only with `?p=<key>`.

**2.7 Missing-pattern preflight.** Load a protocol that references a pattern
NOT on this bench's SD (or pull the SD).
→ The green **Run experiment** button is disabled with
"Pattern "X" not on SD — upload it via Console → SD upload…". Upload/refresh
→ the block clears.

**2.8 Bridge gate.** With `pixi run bridge` **stopped**, try to arm a recorded
run. → Blocked: "Bridge not connected — recorded runs are logged through it".
Start the bridge → the block clears.

**2.9 Promote to shared + collision guard.** With a saved protocol open, File ▾
→ **"Promote to shared (course)…"**.
→ Banner lists the promoted YAML + any `_patterns/*.pat`. Re-promote unchanged
→ "(already shared)" (idempotent). If a *different* protocol already occupies
that shared name, it's **blocked** with "a DIFFERENT file already exists…".

**2.10 Pattern editor push.** Pattern Editor → generate/modify a pattern →
**"⇪ Push to course repo"** → enter a protocol name.
→ Committed to `protocols/<bench-id>/<protocol>_patterns/<file>.pat` (uses the
same stored PAT/repo/bench-id; no separate sign-in). Verify the `.pat` on
GitHub, then re-open the owning protocol in the Studio and confirm the pattern
thumbnail renders (repo byte-source preview).

**2.11 `?repo=` share link, signed out.** Open a `?repo=…&p=…` link in a
browser with no token. → A banner points you to sign in + "Open from course
repo…" (it does not silently fail).

---

## Part 3 — Full end-to-end WITH hardware + bridge (the main event)

This is the piece that hasn't run on real hardware yet. ~30–60 min for the
first clean pass.

**Setup:** arena connected (Web Serial, Chrome/Edge), SD loaded with the
protocol's patterns, `pixi run bridge` running, bench configured per P3.

**3.1 Arm.** Open a curriculum protocol, confirm experimenter (auto-filled from
roster) + genotype, confirm the sequence + patterns resolve (no preflight
block). Green **Run experiment** should be enabled.

**3.2 Run.** Click **Run experiment**. Watch:
- The run log streams runner phases; the bridge log records in parallel.
- At start, a `run_metadata` line is sent to the bridge (run id, experimenter,
  protocol sha, rig id, arena config).

**3.3 Complete.** Let the sequence finish (don't STOP).
→ On completion the Studio exports the bridge log and **auto-commits** it to
`runlogs/<bench-id>/<protocol>__<experimenter>__<stamp>__<runid>.jsonl`,
with a banner "✓ Run log committed…". Open it on GitHub and confirm:
- the `run_metadata` line is near the top,
- the runner phase events + any FicTrac frames are present,
- the filename has **no colons** (Windows-clone safe).

**3.4 Abort does NOT commit.** Start another run, hit **STOP** mid-sequence.
→ Run log shows aborted; **no** file is committed to `runlogs/`. (Aborted and
"Test experiment" runs never auto-commit — by design.)

**3.5 Closed-loop variant (optional).** Run a Mode-3 FicTrac protocol with
`pixi run sim` (or a real fly) feeding the bridge. → The arena tracks heading;
the committed log includes the FicTrac frames. (Mode-4/analog + AI calibration
is the deferred item — not expected to work yet.)

**3.6 GitHub-down resilience (optional).** Temporarily kill network after the
run completes. → Banner: "Run log commit failed … saved locally only, on the
bridge machine." Confirm the `arena-log-*.jsonl` exists in the bridge's working
dir (or `--log-dir`). Restore network; you can re-commit by re-running the
export (the bridge re-serves the same file until the next run).

---

## Part 4 — Multi-bench & edge cases (~30 min, do once)

**4.1 Two benches, no collision.** Configure a second laptop as `bench02`, save
the same-named protocol from both. → They land at `protocols/bench01/…` and
`protocols/bench02/…` independently; no 409s, no overwrite.

**4.2 Promote collision across benches.** Both benches promote a *different*
protocol under the *same* shared name. → The second is blocked (hash guard),
not silently clobbered.

**4.3 Bench-id unset.** Clear the bench id, try to save / commit a runlog.
→ Blocked with "bench id not set — see instructor". (Never a colliding write.)

**4.4 Large pattern.** Push a `.pat` > 1 MB (long GS16 pattern). → Commits and
re-reads byte-exact via the raw media type. (Most G6 patterns are < 1 MB; the
Contents JSON path handles those, raw handles the big ones.)

---

## Part 5 — End-to-end use cases ("day in the life")

How the pieces compose in real use. Read this to picture the flow; the parts
above are how you verify each hop.

### UC1 — Instructor sets up a bench (once per bench, pre-course)
Sign in with the shared PAT (remember it) → set repo + bench id + direct
commit → connect the arena (roster prefills the experimenter, MAC chip confirms
the right controller) → start `pixi run bridge`. The bench is now a course
kiosk: students never touch tokens or settings.

### UC2 — Student runs a pre-loaded curriculum protocol (the bulk of the week)
Student opens a curriculum protocol ("Open from library…" or a shared
`?repo=…` link the instructor handed out), fills genotype, hits **Run
experiment**. The SD already has the matching patterns (pre-loaded), the bridge
is up, the roster filled the experimenter. On completion the run log
auto-commits to `runlogs/<bench-id>/`. **Nothing to configure — it just runs
and records.** This is 80% of course activity.

### UC3 — Student modifies a pattern and runs it
Pattern Editor → tweak a grating → **⇪ Push to course repo** (lands in
`protocols/<bench-id>/<proto>_patterns/`) for provenance. To actually display
it: **Console → SD upload** the `.pat` onto this bench's card (manual for the
course week). Back in Run view, the preflight now resolves the pattern → run →
the log (with the modified pattern's name) auto-commits. Repo→SD one-click sync
is the named post-course follow-on.

### UC4 — Student authors/modifies a protocol
Edit view → change conditions/sequence → **Save** (→ `protocols/<bench-id>/`).
The save is the run-gate's provenance anchor (a recorded run requires a saved,
non-dirty protocol), so saving to the course repo is the natural step before a
recorded run — no extra "force save."

### UC5 — Promote a good protocol so every bench can use it
Instructor (or a student) opens their `protocols/<bench-id>/<name>.yaml` →
**Promote to shared** → it (and its patterns) copy to `protocols/shared/`.
Other benches see it in "Open from course repo…". The hash guard means two
students promoting the same name can't silently clobber each other.

### UC6 — Central analysis (future)
Every completed run's log sits under `runlogs/<bench-id>/` in one repo — a
clone gives you every experiment's full record (metadata + arena/runner/FicTrac
events) for the not-yet-built shared analysis tool. Nothing to build now; the
data is already being collected in the right shape.

---

## Suggested time budget

| Block | Est. | When |
|---|---|---|
| P1 guest account + PAT | 20 min | before test week |
| P3/P4 configure 1 bench + bridge + SD | 20 min | first bench |
| Part 2 dry-run (1 bench) | 45 min | first, catches config issues cheaply |
| Part 3 full end-to-end (1 bench) | 60 min | the main validation |
| Part 4 multi-bench/edge | 30 min | once, with a 2nd laptop |
| Part 1 hardware re-check | (done) | only if reflashing |
| Roll out remaining benches | 20 min each | after 1 bench is proven |

Recommended order: **P1 → P3(config) → Part 2 → Part 3 → Part 4 → roll out.**
Do Part 2 before Part 3 — it catches token/repo/bench-id mistakes in seconds,
before you've got a fly on the ball.
