# Arena Studio — release notes

The Studio's footer used to carry the full changelog inline; it now shows one line and the
history lives here. Newest first. (Per-session engineering detail stays in
`arena-studio-handover.md` and the design docs — this file is the user-facing what-changed list.)

## v0.7 — 2026-07-05 · Edit toolbar + Settings diet (wireframe v6 issues 6/7/8)

- **Edit toolbar** is now just: Designer | YAML tabs · ● edited · ↶ ↷ · Settings ▾.
  Everything else moved into **File ▾**: Open demo… (picker over the 13 bundled demos),
  Save copy (download)… (was Export YAML), Copy conditions from another protocol… (was
  Import from YAML…), Reset protocol…. **Save = Ctrl+S / Cmd+S or File ▾ → Save** (the
  toolbar 💾 was removed); the toolbar "Import YAML" button was dropped as redundant with
  File ▾ → Open local file… (which also carries provenance + lands in the editor).
  Build pattern set… moved into Settings; Quick Start moved to the ? Help card.
- **Settings drawer, repo-connected**: three small sections — Experiment (name ·
  experimenter with the course-roster suggestions · date, auto-set on first save) · Rig
  (read-only "uses bench rig …" with a ≠ bench warning when the protocol differs, the
  arena line, and "rig provides" plugin chips) · Pattern set (Build pattern set… + the
  colocated-folder hint). Everything else — built-in rig dropdown, rig path + Browse…,
  pattern_library, an editable date, and the full plugin editor — lives under
  **Advanced…**, which auto-opens when the Studio is not repo-connected
  (standalone / local-MATLAB use).
- **New protocols pre-fill from the session rig**: File ▾ → New seeds `rig:` with the
  bench rig's path, declares the rig's enabled plugins, and stamps `date_created` with
  today. Opened protocols are never rewritten (the top-bar mismatch chip still owns
  disagreement); an empty `date_created` is stamped on first save.
- **Top bar slimmed**: the arena/firmware device line moved onto the status-dot hover;
  the ⚡ Plugins chip is gone (declared plugins → Settings; run-time skipped/executed
  lines were always in the run log); the "N cond · M blk" summary moved onto the Run
  view's sequence card (and no longer disappears on narrow windows).
- **? Help mode covers the editor**: hover tips on the toolbar, all three zones,
  Variables, the YAML tab, the Settings sections, and the relocated File ▾ items.
- Footer link now points at the **GitHub repo** (this release-notes file lives there
  under docs/development/). The Pattern Designer lost its orange top banner — it has
  the same one-line version/date/GitHub footer as the other tools now.
- **Studio ⇄ Designer are first-class neighbors**: an always-visible
  "Pattern Designer ↗" in the Studio's top bar and "Arena Studio ↗" in the Designer's
  header. The links reuse each other's tab — clicking focuses the existing tab instead
  of opening duplicates, so the Studio keeps its arena connection and the Designer
  keeps unsaved work; only a first click opens a tab (handing over arena + repo).
  The ⚙ gear menu is gone — replaced by an "Other tools" link on both pages (one
  reused index tab); its glyph moved onto the Editor's "⚙ Settings ▾" button.

## v0.6 — 2026-07-04 · Console de-clutter (tool rail)

- **Console re-laid-out for bench use** (wireframe v6.2 made real): a left rail of 7 tool
  buttons — Patterns · Arena Trial · Step frames · Test display · I/O · Panel firmware ·
  FicTrac — opens compact one-row panels in the stage (several at once, each with ✕).
  Default layout opens everything except I/O and Panel firmware and fits a 1280×800 laptop.
- **Patterns panel = device memory + picker merged.** The SD (or built-in library) listing IS
  the picker: click a row to select (green highlight + ▸), with a large preview and the
  pattern-info line on the right. Toolbar: Refresh · ↻ info · Add ▾ · Download ZIP · Purge….
  The separate name dropdown and raw pat-idx box are gone; Debug ▾ raw-hex still covers
  arbitrary bytes.
  - Fix over the first slice: connected SD rows list raw filenames (`001_all_on.pat`) while
    the picker keys logical names (`all_on`) — row clicks now normalize through
    `sdLogicalName`, so picking works on real hardware, and the auto-picked row is
    highlighted after every SD refresh.
- **Arena Trial** — the one trial-params box (Modes 2/3/4 all send TRIAL_PARAMS); the mode
  picker dims fields that don't apply (rate = mode 2, gain = mode 4, start frame = 3/4;
  auto-stop works in any mode). ▶ Start / ■ Stop right-aligned. **Step frames** keeps the
  Mode-3 stepping workflow ("Load (mode 3)" → "Load pattern").
- **Bench strip + always-visible log**: Controller ▾ / Debug ▾ / All on / All off / ■ STOP on
  one strip; the timestamped bench log is pinned below the panels, fills the remaining
  height, and has a drag divider that snaps (~30/46/62/80%); collapsible only on demand.
  Raw-hex moved into Debug ▾.
- **? Help mode** (top-bar ?): hover any control for a plain-language explanation, plus a
  dismissible "first steps" card per view. Written for end users — no opcodes or internals
  (those stay on the regular engineer hovers when Help is off).
- **Opening a protocol lands in the Editor** (inspect before running); shared `?p=`/`?repo=`
  links still open in Run. File ▾ labels standardized: Open local file… / Open from Library… /
  Open from Repo….
- **W/C pattern badges fixed for repo protocols**: a condition now badges W when its pattern
  resolves on the SD card, in the pattern library, or in the opened protocol's colocated
  `_patterns/` folder (previously only a hand-loaded Pattern Set counted, so repo protocols
  showed C everywhere).
- **"Commit directly to default branch" stays visibly green when the kiosk lock disables it**
  (custom-drawn checkbox — the native disabled checkbox was nearly invisible).
- **"Patterns ↗" top-bar link** opens the Pattern Designer in a new tab with this session's
  arena + repo handed over (`?arena=` + `?repo=`); the GitHub sign-in carries over via
  same-origin storage.
- **Footer changelog** replaced by this document (one-line footer).

First bench-review fixes (2026-07-05):

- **Bench log never squeezes the panels**: the log scrolls inside whatever space is
  below the panels (flex-basis 0); only the drag divider changes the split.
- **GitHub repo defaults to the course repo** (`reiserlab/cshl-2026-course`) on a
  never-configured bench — sign-in is all a fresh bench needs. An explicit clear of
  the field sticks (falls back to PR-saves on reiserlab/webDisplayTools).
- **Pattern Designer "Save to Repo → shared library" fixed**: `patterns/` added to
  the GitHub path allowlist (it refused the new destination).
- **Panel-number overlays are row-major for G6** in all three places that draw them —
  the Pattern Designer's 2D grid, its 3D view, and the standalone Arena 3D View —
  matching the arena's own Panel map figure (bench-confirmed): 1–10 along the bottom
  panel row, 11–20 across the top.
- **Console Add ▾ → From course repo… now offers the shared pattern library** as its
  leading source (patterns/, where the Pattern Designer saves) alongside the protocol
  sets — pick one pattern or upload the whole folder. Bare directory listings
  (`patterns`, `protocols`) are now readable through the token guard.

## v0.5 — 2026-07-04 · course data pipeline

Course data pipeline: repo/bench-id settings (visible-but-locked in all views, GitHub
sign-in/out) + direct commit (protocols/<bench-id>/ + runlogs/<bench-id>/), universal bridge
run-logging (gated recorded runs, run_metadata line, auto-commit of the exported JSONL),
course roster.yaml + genotypes.yaml + dynamic source links (load on sign-in, no arena
needed), MAC cross-check chip, missing-pattern preflight (block) + name-mismatch warning, SD
pattern names matched by logical name (NNN_ index prefix + .pat tolerated, so one card holds
several protocols' sets), Console SD Upload ▾ (single pattern or whole set — from local
file/folder, library, or course repo, picked by protocol; uploaded bytes feed picker
previews, so "Load set…" is retired; per-file confirm log + settle pause + 1 retry for
reliability), manual "⇪ Push log" to re-commit a run log the auto-commit skipped/failed
(with a screen-greying upload modal that holds the exact error on failure; export timeout
now names a stale bridge build), io_ext caps resolved before the rig-I/O apply (no
first-connect race) + role options re-gate on GET_CONTROLLER_INFO + "Apply I/O roles" honors
session overrides, File ▾ in all views (Open pickers everywhere; write/settings Edit-only),
Console Debug ▾ + Controller ▾ advanced (panel mode / rig I/O) locked by default, Run view
has a FicTrac bridge strip (connect + live counts mirrored from the Console, one shared
connection; closed-loop indicator pulses green while active; gain/config stay in Console), a
live elapsed/estimated-total run timer under the step counter, and hides the per-condition
"▶ Test" buttons during a run, Run-view log is capped at 40vh (bottom-anchored, never
squeezes the launch card + sequence; sequence takes the flexible middle) and Notes defaults
roomy (~38vh, meta-panel scrolls), Open from library/course repo pickers, promote-to-shared
with hash guard, ?repo= links.

## v0.4 and earlier

- **v0.4** — session rig (top bar, locked) + mismatch chip + `?rig=` + rig `io:` power-on
  defaults incl. roles via SET_DIO_ROLE/SET_AO_MODE on io_ext firmware, capability-gated
  (#135; I/O names match the board silkscreen — Digital IO 1/2, ports 1-based) · negative
  frame_rate = Mode-2 reverse (int16, fw #4).
- **v0.3** — URL state read/write (#107) · Edit 💾 Save.
- **v0.2** — full three-zone Edit (embedded v3 designer + YAML tab, §6 canMutate chokepoint).
- **v0.1** — Run + unified run-log + metadata · full Console (bench).
