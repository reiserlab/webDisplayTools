# CSHL 2026 — full test plan & end-to-end walkthrough

Everything that landed 2026-07-03 across the two build sessions, organized so
you can budget time. Two arcs shipped:

- **Session 1 (#135, merged #137)** — session rig identity + rig `io:` power-on
  defaults + firmware MAC in 0xC2. Hardware/bench items live in
  [`135-bench-checklist.md`](135-bench-checklist.md) and are **already
  bench-signed-off** (2026-07-03); this plan references them, doesn't repeat
  them.
- **Session 2 (course data pipeline, Arena Studio v0.5 + Pattern Editor
  v0.9.42)** — the GitHub course-data flow, including the Console **Upload ▾**
  menu that fills the SD card straight from the course repo (or the library, or
  a local file/folder). This is the arc that still needs a real end-to-end pass
  on hardware.

## Where the risk actually is (what's verified vs. what isn't)

| Layer | Status |
|---|---|
| Unit / logic (763 checks, `pixi run test`) | ✅ passing |
| Browser behavior against a **mocked** GitHub API | ✅ verified (dev session) |
| **Live** push/pull to `reiserlab/cshl-2026-course` (protocol, .pat, promote+guard, runlog, roster, >1 MB) | ✅ verified via the real API (dev session, artifacts cleaned) |
| Console **Upload ▾** fills the SD from the repo/library (fetch + list verified; 0x8D/0x83 SD write is proven separately) | ⛔ combined path not yet on hardware (Part 3 / 2.12) |
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

### P1. Guest account + shared PAT (step by step)

The benches share ONE token so students never handle credentials. Put that
token on a dedicated course account (not a personal one) so it can be revoked
in one place and its writes are attributed to a course identity.

**1a. Create the guest GitHub account** (browser, ~5 min)
1. Sign out of GitHub (or use a private window).
2. Go to <https://github.com/signup>.
3. **Username**: GitHub usernames cannot contain spaces, so "CSHL 2026" can't
   be the handle — use e.g. **`cshl-2026`** (checked 2026-07-03: available).
   Set the *display name* to "CSHL 2026" later under Settings → Profile.
4. **Email**: use a course/shared inbox you control (needed for the
   verification code and for password resets). A personal alias works too.
5. Verify the email, finish signup. Skip the paid plan (Free is fine; private
   repos allow unlimited collaborators on Free).
6. (Recommended) Settings → Password and authentication → enable 2FA, and
   store the recovery codes with the shared inbox.

**1b. Add the guest account as a collaborator** (from *your* account)
- GitHub UI: `reiserlab/cshl-2026-course` → **Settings → Collaborators and
  teams → Add people** → enter `cshl-2026` → role **Write** → send invite.
- Or CLI:
  ```
  gh api -X PUT /repos/reiserlab/cshl-2026-course/collaborators/cshl-2026 \
    -f permission=push
  ```
  (I can run this for you once the account exists — just tell me the handle.)
- **The guest account must accept the invite**: sign in as `cshl-2026`, open
  the emailed invitation (or <https://github.com/notifications>), Accept.
- Org note: if `reiserlab` restricts outside collaborators, an org owner may
  need to approve the invite first.

**1c. Generate the shared fine-grained PAT** (signed in as `cshl-2026`)
1. Settings → Developer settings → **Fine-grained tokens** → **Generate new
   token**.
2. **Token name**: `cshl-2026-benches`.
3. **Expiration**: set it to just past the course (e.g. the Monday after) so a
   forgotten token can't linger.
4. **Resource owner**: `cshl-2026` (the guest account itself).
5. **Repository access** → **Only select repositories** →
   `reiserlab/cshl-2026-course`. (If the repo isn't listed, the invite in
   1b wasn't accepted yet.)
6. **Permissions** → Repository permissions → **Contents: Read and write**
   (leave everything else "No access"). Metadata auto-selects read-only —
   that's fine.
7. Generate; **copy the `github_pat_…` string now** (shown once). Store it in
   the shared inbox / a password manager.
8. This single token is what you paste into each bench in P3. Students never
   see it.

**1d. Revoke path** (know it before the course): signed in as `cshl-2026` →
Developer settings → Fine-grained tokens → the token → **Revoke**. All benches
stop writing immediately; issue a new one and re-paste per P3.

### P2. Repo — DONE
- `reiserlab/cshl-2026-course` exists (private), seeded with `README.md`,
  `roster.yaml` (test entries: michael/frank/isabel/hannah_marie + guest) and a
  course `genotypes.yaml` (lab set + wild-type + none), plus the
  `protocols/shared/` + `runlogs/` skeleton. Edit `roster.yaml` for the real
  bench layout when known.
- ⚠ **Do NOT enable branch protection** on `main` — benches commit directly.

### P3. Per-bench Studio config (repeat on each bench laptop)
Arena Studio → **File ▾** (the GitHub settings are visible in all views but
**locked by default** — kiosk-safe so students can't change them):
1. Click the **🔒 lock** in the GitHub block to **unlock** it (🔓).
2. GitHub **Sign in…** → paste the shared PAT → answer **YES** to "Remember
   this token" (localStorage; a sessionStorage-only token dies when the tab
   closes — a classic footgun for a kiosk bench).
3. **Repo** = `reiserlab/cshl-2026-course`.
4. **Bench id** = `bench01`…`bench07` (must match `roster.yaml`).
5. Check **"Commit directly to default branch"**.
6. Click the lock again to **re-lock** (🔒). It re-locks automatically on the
   next page load, so students can't alter the token/repo/bench id.
Expected: the save label reads **"Save → course repo"** and the destination
line names `…/protocols/<bench-id>/`.

Console note: the **Debug ▾** menu (SPI clock, refresh rate, **Reset
controller**) and the lower half of the **Controller ▾** menu (**panel display
mode** + **rig I/O** roles) are likewise **locked by default** — click
**Unlock** inside each to use those advanced controls; they re-lock on the next
load. To switch course accounts on a bench, unlock the GitHub block and use
**Sign out** (clears the stored token), then sign in with the new PAT.

### P4. Bridge + SD + firmware (per bench)
- `pixi run bridge` running on the bench machine (the run gate requires it).
  Use `pixi run sim` alongside it if you want synthetic FicTrac frames for a
  closed-loop test; **a plain `pixi run bridge` with no fly is enough to
  exercise the whole logging + commit pipeline.**
- SD card loaded with the curriculum patterns (names must match what the
  protocols reference — see the preflight test 2.7). You can load them straight
  from the repo now: **Console → device memory → SD card → Upload ▾ → From
  course repo**, pick the protocol, and its colocated `_patterns/` set uploads
  to the card (see 2.12). The `NNN_` filename prefixes are preserved, so the SD
  scan order (= pattern_ID) stays correct.
- Controller flashed from firmware `main` (post-#137: MAC in 0xC2 + io_ext).

---

## Part 1 — Session-1 hardware (reference)

Already bench-signed-off 2026-07-03. Re-run only if you reflash or change
benches. Work through [`135-bench-checklist.md`](135-bench-checklist.md):
- **§A** firmware MAC in 0xC2 (feeds the roster cross-check below)
- **§B** session rig lock across Run/Edit/Console + `?rig=`
- **§C** rig `io:` power-on defaults (DIO roles, AO 5 V idle)
- **§E** extended I/O command set (io_ext capability gating)
- **§C2** negative `frame_rate` Mode-2 reverse — **Console path bench-verified
  (2026-07-03); the editor→Run path is still to do** (author a protocol with
  `frame_rate: -30`, run it, confirm reverse playback)
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
michael/frank/isabel/hannah_marie/guest; the genotype dropdown shows the
course list (incl. wild-type / none); both "↗ source" links point at the
course repo's `roster.yaml` / `genotypes.yaml`.

**2.3 MAC cross-check chip.** With bench id = `bench01` on the dev-bench
controller (MAC `04:E9:E5:12:91:E2`) → **no chip**. Temporarily set the bench
id to `bench02` (frank, no MAC in roster) → still no chip (unknown MAC is not a
mismatch). To force the chip: put a *wrong* MAC on the matching roster entry
and reconnect → amber **⚠ bench ≠ roster**.

**2.4 Save a protocol → course repo.** Open any protocol (📂 or "Open from
library…"), fill experimenter+genotype, **File ▾ → Save**.
→ Banner "✓ Saved to …/protocols/`<bench-id>`/`<name>`.yaml"; the URL becomes
`?repo=reiserlab/cshl-2026-course&p=protocols/<bench-id>/<name>.yaml`.
Confirm the file appears in the repo on GitHub.

**2.5 Open from course repo.** File ▾ → **"Open from course repo…"**.
→ Picker lists your bench's saves + anything under `protocols/shared/`.
Selecting one loads it and reproduces the `?repo=…` URL.

**2.6 Open-from-library.** File ▾ → **"Open from library…"** → lists the site's
own curriculum (`protocols/index.json`), loads read-only with `?p=<key>`.

**2.7 Missing-pattern preflight + name-mismatch warning.** Load a protocol that
references a pattern NOT on this bench's SD (or pull the SD).
→ The green **Run experiment** button is disabled, naming the unresolved
pattern and pointing at the Console SD upload. Fill the SD (2.12: **Upload ▾ →
From course repo**) or Refresh → the block clears. SD names are matched by
*logical* name, so `all_on` resolves against `001_all_on.pat` on the card.
→ Separately, if a pattern NAME isn't on the SD but the command still carries a
numeric `pattern_ID`, the run is **not** blocked — it falls back to that index
— but a non-blocking **warning** flags it (it would play whatever sits at that
index, not the named pattern). Both only consider sequence-reachable conditions.

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

**2.12 Fill the SD from the course repo (Upload ▾).** Connect the arena.
Console → device memory → SD card → **Upload ▾** (the button is disabled until
connected):
- **Pattern set (folder) → From course repo…** → pick a protocol → its whole
  colocated `_patterns/` set uploads to the card (per-file progress in the
  status line), then the SD list refreshes. **Single pattern → From course
  repo…** picks one file from a protocol's set instead.
- **From library…** does the same against the site's own curriculum
  (`protocols/index.json` → the tools repo's `_patterns/`); **From local
  file/folder…** uploads off the bench disk. Library/repo sources need GitHub
  sign-in (a banner says so if you're signed out); an empty/missing
  `_patterns/` reports "No colocated patterns for this protocol".
→ Uploaded filenames keep their `NNN_` prefix (SD scan order preserved), the
picker previews render straight from the just-uploaded bytes (the old
"Load set…" folder step is retired), and 2.7's preflight now resolves the
pattern. **This is the new "fill the SD from the repo" capability** — the
combined fetch→SD-write path is the one thing to confirm on real hardware
(Part 3).

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

## File size limits (measured 2026-07-03)

Logs are the largest files, so the ceiling matters. There are two size-
sensitive hops; I measured both against the real services:

| Hop | Verified up to | Binding limit |
|---|---|---|
| Bridge → browser (WebSocket `log_export`) | **50 MB round-trips fine** | not the bottleneck |
| Browser → GitHub (`directCommit` PUT) | **35 MiB OK; 40 MiB rejected** | **~35 MiB per file** |

**The binding constraint is GitHub's Contents API: ~35 MiB per committed
file.** Measured: 5 / 10 / 25 / 30 / 35 MiB all commit (201) and pull back
byte-exact via the raw media type; 40 / 50 / 75 / 100 MiB all fail with HTTP
422 *"Sorry, the file is too large to be processed. Consider creating/updating
the file in a local clone and pushing it to GitHub."* The true cutoff sits
between 35 and 40 MiB. (The WebSocket `log_export` hop was tested to 50 MB with
no issue — the bridge's `WS_MAX_SIZE` only caps *inbound* browser→bridge
messages, which are tiny; the outbound export is uncapped and memory-bound.)

**What that means for logs.** One committed file = **one experiment**: the
Studio rotates a fresh bridge log on every recorded-run start (`setLogging(true)`
→ new `arena-log-*.jsonl`), so the relevant size is *per run*, not per session.
Rough back-of-envelope with default logging (frame index + timestamp per
FicTrac frame, ~65 bytes/line):

- 100 Hz × 10 min ≈ 6000 lines/min → **~4 MB per 10-minute run** — comfortable.
- A ~90-minute continuous run would approach the ceiling; a typical trial does not.
- `bridge.py --log-frames` (full 25-field record per frame) is **~3–4× larger**
  and could blow the ceiling on a long run — **leave it off for the course**
  (it's off by default). It's a debugging switch, not a course setting.

**Failure is graceful, never data loss.** If a run log ever exceeds the ceiling,
`directCommit` gets the 422 and the Studio shows *"Run log commit failed … saved
locally only, on the bridge machine"* — the full `arena-log-*.jsonl` still exists
in the bridge's working dir (or `--log-dir`). You can push it later from a local
clone (plain `git push` allows up to 100 MB/file, well above the API path).

**If logs do get too big**, in rough order of preference:
1. Keep runs bounded (per-run rotation already does most of this).
2. Never enable `--log-frames` for course runs.
3. Trim event verbosity or decimate per-frame telemetry (deferred design item —
   measure real course logs first; the 4 MB/10-min estimate suggests it won't be
   needed).
4. Binary-encode the frame stream (larger change; last resort).

**Test it yourself (Part 3 follow-on):** after a real run, check the committed
`.jsonl` size on GitHub. If you want to probe the ceiling again, do it in a
throwaway repo — big blobs stay in git history permanently even after the file
is deleted, so don't probe against the course repo.

---

## Part 5 — End-to-end use cases ("day in the life")

How the pieces compose in real use. Read this to picture the flow; the parts
above are how you verify each hop.

### UC1 — Instructor sets up a bench (once per bench, pre-course)
Sign in with the shared PAT (remember it) → set repo + bench id + direct
commit → connect the arena (roster prefills the experimenter, MAC chip confirms
the right controller) → **pre-load the curriculum patterns onto the SD**
(Console → device memory → Upload ▾ → From course repo → pick each curriculum
protocol; its `_patterns/` upload in one step) → start `pixi run bridge`. The
bench is now a course kiosk: students never touch tokens or settings.

### UC2 — Student runs a pre-loaded curriculum protocol (the bulk of the week)
Student opens a curriculum protocol ("Open from library…" or a shared
`?repo=…` link the instructor handed out), fills genotype, hits **Run
experiment**. The SD already has the matching patterns (pre-loaded), the bridge
is up, the roster filled the experimenter. On completion the run log
auto-commits to `runlogs/<bench-id>/`. **Nothing to configure — it just runs
and records.** This is 80% of course activity.

### UC3 — Student modifies a pattern and runs it
Pattern Editor → tweak a grating (or build a frame animation and hit the pane's
**💾 Save .pat**) → **⇪ Push to course repo** (lands in
`protocols/<bench-id>/<proto>_patterns/`) for provenance. To display it, pull
the set onto this bench's card: **Console → device memory → Upload ▾ → From
course repo → pick the protocol** — its `_patterns/` upload to the SD in one
step (the repo→SD sync that used to be a post-course follow-on now ships,
per protocol). Back in Run view, the preflight resolves the pattern → run → the
log (with the modified pattern's name) auto-commits.

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
