# Arena Studio wireframe v6 — Console rail + plain-label pass

**Artifact:** [`arena-studio-wireframe-v6.html`](arena-studio-wireframe-v6.html) · v6.2, 2026-07-04
**Baseline:** Arena Studio **v0.5 on `main` @ `8bc97e6`** (PR #139 squash — the CSHL course-pipeline line).
Wireframe conventions from v5. **This rev is directly executable against current main** (see §8).
**Scope:** Console view (primary) + Edit toolbar/Settings + top bar. Run view and the three-zone designer are unchanged apart from the relocated `cond · blk` chip.

**v6 → v6.1 (user review, 2026-07-04):** tool rail moved to the **left** edge (tools first, work
area after); the Console **log is always visible** — the status strip is its one-line header
(Copy/Clear at right), the timestamped log sits below, and clicking the header collapses it only
when room is needed.

**v6.1 → v6.2 (user review, same day):** the per-mode panels merged back into ONE **Arena Trial**
box (Modes 2/3/4 all send the same TRIAL_PARAMS — the mode picker dims the fields that don't
apply: rate = 2, gain = 4, start frame = 3/4; auto-stop works in any mode). **Step frames** stays
its own box. All boxes compacted to ~one row with **Start/Stop right-aligned**; the pattern
listing scrolls inside its panel. **Default layout = the realistic bench screen**: everything
open except I/O and Panel firmware — Patterns + Arena Trial + Step frames + Test display +
FicTrac + the always-on log fit a laptop screen at once (verified at 1280×800).

Preview: serve the repo (`python -m http.server 8091`) and open
`/docs/development/arena-studio-wireframe-v6.html`. Dev toggles (bottom right):
`✎ simulate edit` · `🐙 GitHub` · `⏳ simulate busy` (cycles the 7 mutex states) · `① design notes`
(shows the numbered rationale badges). The top-bar `?` is the proposed **product** help toggle.

## 1. What changed (one paragraph)

The Console's wall of cards becomes a **left-hand rail** of 7 named tool buttons — Patterns ·
**Arena Trial** · Step frames · Test display · I/O · Panel firmware · FicTrac. Clicking opens
that panel in the stage (several may be open; each has ✕); the default layout opens everything
except I/O and Panel firmware, and it all fits one screen. Device memory and the pattern picker
**merge**: the card listing *is* the picker (SD | PS-RAM toggle kept; the listing scrolls inside
the panel), and the selection is consumed read-only by Arena Trial and Step frames. **Arena
Trial** is the one trial-params box — Modes 2/3/4 in a single row (mode picker dims
non-applicable fields; ▶ Start / ■ Stop right-aligned) — while **Step frames** keeps the
Mode-3 stepping workflow, killing the "Load (mode 3)" confusion. All hex/opcodes/issue refs
leave the visible surface: **panel-title hover** shows the commands, and a global **? Help
mode** explains every control on hover. Busy operations **lock** everything they conflict with
(🔒 + busy chip) instead of confirm dialogs; STOP never locks. The bottom is a **one-line status
header + always-visible log** (collapsible only on demand; raw-hex moves into Debug ▾); the
11 KB footer changelog is cut to one line. The Edit toolbar drops to tabs · edited dot ·
undo/redo · Settings (file ops live only in File ▾ with standardized labels), and the Settings
drawer shrinks to Experiment + read-only Rig/"Rig provides" + Pattern set, with the plumbing
under **Advanced…**.

## 2. MATLAB-restore ledger

Nothing is removed from the **YAML**; only editing UI is hidden when repo-connected.
The YAML writer must auto-fill what the UI no longer asks for:

| Cut from default UI | v6 auto-fill (YAML writer) | Restore path (standalone / local MATLAB) |
|---|---|---|
| Rig path field + Browse… | `rig:` ← session rig's repo-relative path (`configs/rigs/<rig>.yaml`) | Settings → Advanced… (field + Browse…) |
| Built-in rig dropdown | ← session rig (top bar) | Settings → Advanced… |
| `pattern_library` field | ← colocated `<protocol>_patterns/` folder | Settings → Advanced… (free path) |
| Plugin add/remove/config UI | `plugins:` ← copied from the rig YAML's `plugins:` block | Settings → Advanced… (registry add/remove) |
| `date_created` + "Today" button | ← today, set on first save | Settings → Advanced… |
| `author` free field | ← Experimenter (roster datalist; free text accepted) | same field |

**Advanced… auto-opens when the Studio is not repo-connected**, so standalone/local-MATLAB
use sees the classic fields without hunting.

## 3. Mutex matrix (the busy model)

HARD = a bulk transfer owns the serial line (display quiesced) — everything else locks.
SOFT = a state-owning activity — only conflicting *starts* lock.
Always live in every state: STOP (see flash remap), status strip + log, Disconnect, mode tabs, help.

| Busy source (code hook) | Tier | Locks | Stays live | Status-strip text |
|---|---|---|---|---|
| SD write — Add/Purge (`quiesceDisplay()` → 0x8D loop) | HARD | all other panels + rail; All on/off; menus | STOP (abort after current file); Patterns' own progress; log | `⏳ writing SD 3/8 · grating_20px.pat → card` |
| SD → ZIP (0x8A) | HARD | same | STOP (abort) | `⏳ reading card → ZIP · 41%` |
| Panel flash / ISP batch (`ispBusy()`) | HARD | everything incl. All on/off | **STOP remaps** to "stop after current panel" — never interrupt mid-flash | `⚡ programming panel 7/20 — do NOT power off` |
| Timed trial armed (`autoStopTimer`) | SOFT | Patterns; Test display; Step frames; firmware; FicTrac *Activate* | **All on/All off (pre-empt: stops the trial — shipped semantics)**; STOP; Arena Trial's own Stop; I/O; FicTrac Connect; Controller queries | `▶ playing grating_20px · Mode 2 · 30 Hz · auto-stop in 7 s` |
| Sequence run from Run view (`session.running`) | SOFT-strict | every panel; All on/off; raw send | STOP (stops the sequence — replaces the `guardDestructive` confirm) | `▶ running <name> · step 3/15 · 1:12 / 4:30 — STOP interrupts` |
| FicTrac closed loop active (`stepperLoaded` + bridge) | SOFT | Arena Trial; Test display; Patterns; firmware; Step frames' controls (panel stays open as a live frame monitor) | **I/O (whole panel)**; FicTrac's own gain/deactivate; All on/off + STOP (kills the loop); queries | `∞ closed loop · FicTrac 60 Hz · frame 143/200 · gain 1.8` |
| Disconnected | — | all rail + bench strip | Connect, help, log | `disconnected — Connect to enable the bench` |

The wireframe encodes this table as the `BUSY[]` array driving `⏳ simulate busy`.
Existing hooks to build on: `quiesceDisplay`, `ispBusy`, `guardDestructive` (retired → locks),
`Studio.session.running`, `consoleState.stepperLoaded`, `autoStopTimer`.

## 4. Label renames (old → new)

| Surface | v0.5 | v6 |
|---|---|---|
| Console card | `device memory · SD 0x80/0x82/0x84/0x86/0x8D · PS-RAM` + the picker rows of `pattern + trial params` | **Patterns** (merged; opcodes on title hover) |
| Patterns | `Upload ▾` | `Add ▾` |
| Patterns/File ▾ | `From library…` / `From course repo…` | `From Library…` / `From Repo…` |
| Patterns | `↙ ZIP` / `Purge all` | `Download ZIP` / `Purge…` |
| Console card | `pattern + trial params` + `Send trial params` | **Arena Trial** — one box, modes 2/3/4 in one row; mode picker dims non-applicable fields (rate = 2, gain = 4, start frame = 3/4); `▶ Start` / `■ Stop` right-aligned |
| Arena Trial | `rate` / `dur (s)` / `init` | `rate (Hz)` (negative = reverse) / `auto-stop (s)` (0 = until Stop, any mode) / `start frame` |
| Console card | `frame stepper · mode 3 · 0x70` | **Step frames** (own box, kept) |
| Step frames | `Load (mode 3)` | `Load pattern` |
| Console card | `stream frame · STREAM_FRAME 0x32` | **Test display** |
| Test display | `Paste…` / `Load .bin/.pat…` | `Paste frame…` / `From local file…` (⚠ collision flag: rename to `Stream file…` if it misleads) |
| Console card | `hardware I/O · 0x1B/0x1C · 0xA0 · 0xA4 · 0xAA (G6)` | **I/O** |
| Console card | `panel firmware · 0xE0 upload · 0xC8 flash · 0xC9 verify · 0xE3 info` | **Panel firmware**; `Choose…` → `Choose image…` |
| Console card | `fictrac bridge · closed-loop Mode 3 (#131)` | **FicTrac**; `activate` → `Activate closed loop` |
| Console | `raw + log` card | status header + always-visible log (collapsible on demand); raw-hex → Debug ▾ |
| Console | `Stop` pill | bench-strip `■ STOP` (distinct, never locked) |
| Console | inline `ALL_ON 0xFF · ALL_OFF 0x00 · STOP 0x30` hint | removed (opcodes on hover) |
| File ▾ | `Open… (Import YAML)` | `Open local file…` |
| File ▾ | `Open from library…` / `Open from course repo…` | `Open from Library…` / `Open from Repo…` |
| File ▾ | `Save → local file` | `Save` (destination line explains local vs repo) |
| File ▾ ← Edit toolbar | `Export YAML` / `Import from YAML…` / `Load demo ▾` / `⟲ Reset` | `Save copy (download)…` / `Copy conditions from another protocol…` / `Open demo…` / `Reset protocol…` |
| Settings ← Edit toolbar | `Pattern Set…` | `Build pattern set…` (in the Settings drawer) |
| Edit toolbar | `Quick Start` link | help bar (visible in ? Help mode) |
| Top bar | `G6_2x10 · fw v1` device line | removed — fw/MAC/port on the status-dot hover |
| Top bar | `⚡ Plugins · N` chip | removed — Settings "Rig provides" (run-time skip/exec info: see issue 8) |
| Top bar | `9 cond · 1 blk` + doc summary | chip on the Run view sequence card |

## 5. Functionality accounting

- **Moved/renamed, function identical:** everything in §4 plus all Controller ▾ / Debug ▾ items
  (Debug ▾ *gains* raw-hex), per-row SD ⬇/✕, ↻ pattern-info re-query, disconnected web-library
  browsing, kiosk locks, GitHub block.
- **Same capability, different access:** busy = locks instead of confirm dialogs; fw/MAC/port on
  hover; pattern picked from the listing (raw pat-idx box gone — Debug ▾ raw-hex covers arbitrary
  bytes); Quick Start in the help bar; `date_created` editing in Advanced…. (The log stays ALWAYS
  VISIBLE per v6.1 — it only *gains* an optional collapse and loses its engineer heading + inline
  raw-hex row. Arena Trial keeps mode/rate/gain/start/auto-stop exactly as v0.5's trial-params
  card — auto-stop works in any mode, as before.)
- **True cuts (each in a draft issue):** Expand/Collapse-all buttons; the ~11 KB footer changelog
  (→ release-notes doc); the Plugins chip (declared list → Settings; **run-time "skipped vs
  executed" info has no v6 home yet** — issue 8); the top-bar doc summary text.

## 6. Draft GitHub issues (post after wireframe approval)

1. **Console: left-rail tool layout** — rail (left edge, 7 tools) + stage of compact one-row
   boxes (actions right-aligned) + bench strip + status header with always-visible log; default
   layout opens everything except I/O and Panel firmware (fits one screen); retire the
   collapsible tier, `raw + log` card, and Expand/Collapse-all. (wireframe v6 §①⑥⑪⑫)
2. **Console: merge device memory + pattern picker into a Patterns panel** — the listing is the
   picker (scrolls in-panel); console-wide selection consumed by Arena Trial + Step frames;
   `Add ▾` source trio; SD | PS-RAM toggle; relabels (Download ZIP, Purge…). (§②)
3. **Console: Arena Trial box + Step frames split** — trial params stay ONE box (modes 2/3/4,
   mode-aware field dimming, plain-language rate/auto-stop/start frame, ▶ Start · ■ Stop at
   right); Step frames keeps the Mode-3 stepping workflow with the `Load pattern` rename;
   retire the pat-idx box. (§④⑤)
4. **Console: busy/mutex enforcement** — implement the §3 matrix on the existing hooks; locks
   replace the `guardDestructive` confirm; STOP remap during ISP; busy chip + reasons. (§⑨⑫)
5. **Chrome: opcode hovers + global ? Help mode; strip inline hex** — default-on panel-title
   command tooltips; managed `data-help` tooltip helper replacing scattered ⓘ/title=; remove all
   inline opcodes/issue refs; Quick Start → help bar. (§⑭)
6. **File ▾ standardization + Edit toolbar diet** — Open local file/Library/Repo trio; Save copy;
   Copy conditions from another protocol; Reset/demo relocation; toolbar → tabs·dot·undo/redo·
   Settings; `Build pattern set…` into Settings. (§③⑰)
7. **Settings: repo-connected simplification + Advanced fallback** — Experiment / read-only Rig /
   "Rig provides" chips; auto-fill per the §2 MATLAB ledger; Advanced… auto-opens when not
   repo-connected. (§⑯)
8. **Footer changelog → release-notes doc; top-bar cleanup** — one-line footer; remove device
   line (→ status-dot hover), Plugins chip, doc summary (→ Run sequence card). Includes designing
   a Run-view home for the run-time "plugin skipped vs executed" info the chip used to carry. (§⑮⑱)

## 7. Open flags (decide at review)

- **"From local file…" collision** — same words mean *write to card* (Patterns → Add ▾) and
  *stream to display* (Test display). Fallback name: `Stream file…`. (§⑦)
- **`Build pattern set…` placement** — mocked in the Settings drawer per request; File ▾ is the
  alternative if it feels buried. (§⑰)
- **File ▾ write items outside Edit** — mocked as *dimmed* (structure visible); v0.5 *hides* them.

## 8. Reconciliation to `main` (why this rev is directly executable)

The design was drafted against the `claude/stoic-hugle-d04ca9` tip (`57902a6`); that work has
since landed on **main as PR #139 (squash `8bc97e6`)**. Diffing `57902a6 → main` for
`arena_studio.html` + `js/` shows **no Console or Edit UI drift** — every element this wireframe
redesigns exists on main exactly as inventoried. The only deltas (already on main, no wireframe
action needed, but implementers should know them):

1. **Run view layout polish** — the run-log strip is bottom-anchored and capped at 40 vh
   (sequence list takes the flexible middle; `min-height` 150 px), and the metadata Notes field
   defaults roomy (`#mNotes{min-height:38vh}`, meta panel scrolls). The v6 Console log region
   should reuse this "capped, never squeezes the content above" pattern.
2. **Firmware manifest schema** — chooser entries now use the nested `bin: {file, sha256}` form
   (PR #138 alignment), not `isp_file`/`isp_sha256`. Affects the Panel-firmware `Choose image…`
   implementation, not its UI.
3. Footer timestamp `13:49 ET`; version string still `Arena Studio v0.5`.

Implementation of the 8 issues in §6 therefore targets **current `main`** directly; the hooks
named in §3 (`quiesceDisplay`, `ispBusy`, `guardDestructive`, `Studio.session.running`,
`consoleState.stepperLoaded`, `autoStopTimer`) are all present on main.

## 9. Real-code slice — `arena_studio_v6.html` (the drift proof)

To prove the redesign lands in main's *real* aesthetic (not the standalone wireframe's parallel
one), the Console rail was built **inside a copy of the actual tool**: `arena_studio_v6.html` at
the repo root, made from `arena_studio.html` @ `8bc97e6`, so it loads the real `js/` modules and
renders with main's real components. This file is a **proof artifact, not for merge as-is** (its
footer says so); it's the reference for the eventual in-place implementation.

**What it demonstrates**
- The Console is re-laid-out into a **left rail + stage of compact one-row panels** (Patterns ·
  Arena Trial · Step frames · Test display · I/O · Panel firmware · FicTrac) + a **bench strip**
  (Controller ▾ / Debug ▾ / All on / All off / ■ STOP) + an **always-visible bench log** pinned
  at the bottom (collapsible on demand; raw-hex moved into Debug ▾).
- **Arena Trial** = the real "pattern + trial params" card, renamed, with the mode picker now
  **dimming the fields that don't apply** (rate = mode 2, gain = mode 4, start = 3/4); **Step
  frames** is the real frame stepper with `Load (mode 3)` → `Load pattern`.
- Default layout opens everything except I/O + Panel firmware; it fits a 1280×800 laptop.
- **Zero aesthetic drift by construction:** only *additive* containers were introduced
  (`.rail/.stage/.panel/.bench-strip/.status-strip/.log-drawer`, scoped to `.console-view`).
  Every button/input/menu reuses main's shipped primitives (`.pill/.cmenu/.cgroup/.crow/.seg2/
  .thumb/.sdtable/.clog`) and main's exact tokens — because it is the real file.

**How the real wiring was preserved (the low-risk part)**
- `data-cmd` handlers are **delegated on `#consoleView`** (`arena_studio.html:3829`), so
  re-parenting the buttons into the rail/stage kept them working. Every id the handlers read/write
  (`cMode/cRate/cGain/cInit/cDur/cPat/cPatName/cSdBody/cFrame/…`) was preserved verbatim.
- The four live-state spans the JS updates unguarded (`cSdSum/cIoSum/cFwSum/cFtSum`) became the
  **rail buttons' sub-lines**, so the existing code now drives the rail state for free
  (e.g. "SD (4)" under Patterns, "ws · connected" under FicTrac). `cStepSum` was unused → dropped.
- The two expand/collapse handlers were null-guarded (their buttons are gone).
- Rail / panel-✕ / log-collapse are **non-form elements** (`div`/`span`), so they work while the
  connect-gating `<fieldset disabled>` is active — matching today's ability to expand/collapse
  console cards before connecting. The panel *contents* stay disabled until connect.
- Verified in-browser: the ES-module block runs (no import failure), Edit (3 zones) + Run render,
  rail toggles + panel-✕ + mode-dimming + log-collapse all work, no console errors.

**Patterns panel — listing IS the picker (2nd review pass):**
- The SD/library **listing is the picker**: clicking a row selects it (green highlight + `▸`
  marker) by driving the now-hidden `cPatName` and dispatching its `change` — reusing the real
  `applyPatPick` (sets `cPat`, renders the thumb, queries 0x88). The separate dropdown is gone.
- Two-column body: **left** = SD|PS-RAM toggle + toolbar (Refresh · ↻ info · Add ▾ · Download ZIP
  · Purge…) + the listing; **right** = a **large preview** (~190×140) + the 0x88 info line only.
  Removed from the box (streamlined): the repeated pattern-name label, the "N patterns" count
  (`cSdCount` hidden; the count still shows on the rail sub), and the RHS ↻ (moved to the left
  toolbar). Net: shorter box, bigger preview.
- Offline, the built-in library is mirrored into clickable rows so the picker works before connect
  (verified: 4 built-in patterns select + preview swaps). Connected, the live SD rows (with their
  download/delete buttons) are the picker; my row-select ignores clicks on those buttons.

**Bench log — always visible, resizable, snaps:**
- Layout: the panels area (`console-main`) is content-height and the **log fills the space below
  the last panel** by default (log = `flex:1 1 auto`). A draggable divider (`.log-resizer`, grip,
  `ns-resize`) resizes it; on release it **snaps** to ~30/46/62/80% of the console area. The
  status strip is the log header (Copy / Clear / ▾ hide log). Verified: drag up shrank panels
  554→403 px and grew the log; snap applied; no errors.

**Not in the slice (still per the issues / bench):**
- Global **? Help mode**, top-bar cuts, and the Edit-view toolbar/Settings diet — those are the
  standalone wireframe's proposals (issues #5–#8); the slice is Console-only.
- Bench-hardware verification (real Connect + send) — the slice was verified structurally +
  in-browser only.

Preview: `arena_studio_v6.html` from the repo root on the dev server (port 8091).

## 10. FOLDED INTO `arena_studio.html` (v0.6, 2026-07-04 night) — slice retired

User-approved decision: the slice **was folded in-place into `arena_studio.html`** and
`arena_studio_v6.html` deleted (the ~353-line diff applied cleanly; the v6slice.py regen
scripts are obsolete). Footer is now ONE line + `arena-studio-release-notes.md` (issue 8's
footer half, done). Same session also shipped:

- **THE PICKER BUG (the "listing is the picker" clicks did nothing on the bench):** connected
  SD rows carry the RAW filename (`001_all_on.pat`) in `data-name`, but the picker options
  are keyed by the LOGICAL name (`all_on`) — the row-click `option.value === tr.dataset.name`
  comparison never matched on real hardware. The offline mirrored rows use option values,
  which is why offline testing said "works". Fix: normalize through `Studio.sdLogicalName`
  in the row-click + `markSelRow`, and have the picker-rebuild observer also re-sync the
  highlight/chip (`populatePatDropdown` auto-picks without dispatching `change`).
  Verified against a simulated connected listing; **one bench click-through still wanted.**
- **? Help mode** (wireframe issue #5's product form): top-bar ? toggle → managed tooltip
  reading curated `data-help` (~100 controls, end-user voice, native engineer `title=`
  suppressed while shown) + a dismissible first-steps card per view. All content is
  JS-applied from the `HELP` map in the v6 glue classic script — no HTML churn.
- **Open lands in Edit** (user ask): `Studio.loadProtocol` gained `opts.landIn`
  (default `'edit'`); the two `initFromUrl` loads pass `'run'` so shared links still open
  in Run. File ▾ trio labels standardized (issue #6's label half).
- **W/C badge fix**: `conditionPatternInActiveSet` now also consults the Console picker set
  (`Studio.patternIndexByName`) and the opened repo protocol's colocated listing
  (`Studio.repoPatternNames`, filled by `registerRepoPatternPreviews`, cleared on every
  load, repainted via `Studio.editor.repaintLibrary`).
- **Locked-checkbox visibility**: `.gh-check` checkboxes are custom-drawn so a checked
  "Commit directly" stays green under the kiosk lock.
- **Index page**: two big cards (Pattern Designer + Arena Studio, custom SVG icons) over
  Specialty / Legacy groups (legacy = console, v3 designer, old designer, with supersede
  notes).
- **Pattern Designer** (pattern_editor.html v0.10, renamed from Pattern Editor): LOAD ▾ trio
  (local / Library / Repo pickers — repo browses the shared `patterns/` area + every
  protocol `_patterns/`), ⇪ Save to Repo… destination modal (shared `patterns/` library OR
  `protocols/<bench>/<proto>_patterns/`, overwrite confirm), URL state `?arena=` + `?repo=`
  (read: apply+lock / session repo override; write: replaceState on arena change/load), and
  the Studio's top-bar **Patterns ↗** handover link (arena+repo in the URL, token via
  same-origin storage + the new tab's sessionStorage copy).

**Draft-issue status:** #1–#3 shipped (this fold), #4 busy/mutex still open, #5 shipped
(Help), #6 labels shipped / toolbar diet open, #7 Settings diet open, #8 footer+release-notes
shipped / top-bar cuts (device line, ⚡ chip, doc summary) still open. Re-scope the postings
to the open remainder: **busy/mutex enforcement (#4), Edit toolbar diet (#6b), Settings
repo-connected simplification (#7), top-bar cuts + plugin-skip info home (#8b).**
