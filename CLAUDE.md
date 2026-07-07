# Claude Code Guidelines for webDisplayTools

## Scope of This File

**CLAUDE.md** is for **how to work with the code** — architecture, patterns, gotchas, testing procedures, and coding conventions. It should NOT contain roadmap items, feature wishlists, or project planning.

Roadmap and planning content belongs in:
- **`docs/development/ROADMAP.md`** — roadmap, milestones, changelog, and open items

**Review needed (future session):** Audit existing CLAUDE.md sections for roadmap content that has leaked in (e.g., "Future Improvements" lists, "Testing Required (Next Session)" checklists). Move planning items to the roadmap file and keep CLAUDE.md focused on technical reference.

## Versioning

Use simple two-digit versions for all web tools (e.g., `v1`, `v2`, `v6`). No semantic versioning (1.0.0) needed.

Format in footer: `Tool Name vX | YYYY-MM-DD HH:MM ET · GitHub` — ONLY the tool name/version, an ET timestamp, and a GitHub repo link. NEVER put a changelog, release-notes summary, or "what changed" keywords in the footer (that content lives only in the release-notes file).

Example: `Arena Editor v2 | 2026-01-16 14:30 ET · GitHub`

**IMPORTANT**: Always include timestamp in Eastern Time (ET) to distinguish multiple updates per day. Update the timestamp whenever the page is modified.

**To get current time**: Run `TZ='America/New_York' date "+%Y-%m-%d %H:%M ET"` in Bash to get the actual current time. Never guess or make up timestamps.

## Design System

All tools use a consistent dark theme:
- Background: `#0f1419`
- Surface: `#1a1f26`
- Border: `#2d3640`
- Text: `#e6edf3`
- Text dim: `#8b949e`
- Accent: `#00e676` (green)
- Hover: `#00c853`
- Fonts: JetBrains Mono (headings), IBM Plex Mono (body)

## Tooltip Guidelines

When editing web tools, audit all buttons and controls in the modified code sections:

1. **Every interactive element needs a tooltip** - buttons, tabs, inputs, sliders
2. **Use the `title` attribute** for simple tooltips
3. **Be descriptive but concise** - explain what happens when clicked/changed
4. **Include keyboard shortcuts** if applicable (e.g., "Save pattern (Ctrl+S)")
5. **Update tooltips when behavior changes** - stale tooltips are worse than none

**Standard tooltip patterns:**
- Buttons: "Action description" (e.g., "Capture current frame to clipboard")
- Toggles: "Enable/disable feature" (e.g., "Show panel boundaries")
- Inputs: "Parameter name: valid range" (e.g., "Wavelength: 10-360 pixels")
- Tabs: "View name" (e.g., "3D arena preview")

**Audit checklist when touching UI code:**
- [ ] All buttons have tooltips
- [ ] All tabs have tooltips
- [ ] All sliders/inputs have tooltips with valid ranges
- [ ] Tooltips match current behavior (not outdated)

## Architecture

- All web tools are standalone single-page HTML files
- No build process required
- Vanilla JavaScript preferred
- Dependencies via CDN or vendored under `js/vendor/` (e.g. `yaml`); no runtime npm
- Web outputs must match MATLAB outputs exactly

### Dev environment (pixi — the only tool you install)

Dev tooling is managed by **pixi** (`pixi.toml` at the repo root). pixi provides
Node, Prettier, Python, and `websockets` from conda-forge — **there is no npm,
`package.json`, or `node_modules`.** A contributor only installs pixi.

```bash
pixi install          # one-time: provisions Node + Prettier + Python
pixi run test         # full JS test suite (node)
pixi run format       # Prettier --write over **/*.js
pixi run format-check # Prettier --check (matches the old CI check)
pixi run bridge       # FicTrac closed-loop bridge (see fictrac-bridge/)
pixi run sim          # FicTrac data simulator
```

The test suite's only third-party JS dep, `yaml`, is **vendored** (browser build
only) at `js/vendor/yaml/browser/` and serves both the browser (via the import
map in `experiment_designer_v3.html`) and Node — no Node-specific build is
committed. The v3 modules `import 'yaml'` (a bare specifier); under Node that's
resolved to the vendored browser build by `tests/vendor-yaml.register.mjs` (a
`--import` resolve hook), which the `test` task wires in for the v3 suite.
`require()`-ing that ESM build is why `nodejs >= 22.12` is pinned. When bumping
the vendored `yaml`, replace only `js/vendor/yaml/browser/` (+ `LICENSE`).

### Code Formatting

This project uses **Prettier** for consistent JavaScript formatting. Configuration is in `.prettierrc`.

**Style rules:**
- Single quotes (`'string'`)
- No trailing commas
- 4-space indentation
- 100 character print width
- Semicolons required

**Commands:**
```bash
pixi run format       # Format all JS files
pixi run format-check # Check formatting
pixi run prettier --write path/to/file.js  # Format a single file
```

**Before committing:** Run `pixi run format` on any modified JavaScript files to ensure consistent style.

**⚠ Prettier is scoped to `**/*.js` ONLY — never run `prettier --write` on the `*.html` tools.** The `format`/`format:check` scripts target JS by design. The HTML tools are hand-formatted; their embedded `<script>` blocks do NOT match Prettier's HTML-indentation rules, so `prettier --write some_tool.html` reflows the entire file (e.g. ~8,800-line churn on `experiment_designer_v3.html`). Edit HTML by hand and match the surrounding style. (No CI workflow runs Prettier, so a stray HTML format won't be caught automatically.)

### Shared Modules

Some JavaScript modules are shared between multiple tools and must support different loading patterns:

**Arena Session — the single connection broker** (`js/arena-session.js`, Stage A of the Arena Studio unification):
- Owns ONE `ArenaLink` + ONE `ArenaRunner` per page and multicasts the link callbacks (`log`/`error`/`disconnect`) to subscribers via `on(event, fn)`. Run mechanism: `runTrial` / `runSequence` / `stop` / `running`; lifecycle: `connect` / `disconnect` / `connected` / `send`. Page-wide singleton via `ArenaSession.shared()`.
- **Must stay a classic `<script src>` module** (window-global + CommonJS dual-export, **no bare ES `export`**), loaded AFTER `arena-wire-g6.js` / `arena-link.js` / `arena-runner-g6.js` and BEFORE any `<script type="module">` that reads `window.ArenaSession`. This keeps Connect/STOP/run-state alive even if a stale ES-module import fails (the catastrophic-cache gotcha) — never move connection ownership into the module block.
- Both `arena_console.html` and `experiment_designer_v3.html` use `window.ArenaSession.shared()` instead of constructing their own `ArenaLink` (the console uses only connect/send/events; the designer uses the run mechanism). On involuntary disconnect the broker calls `runner.abort()` (public, added to `arena-runner-g6.js`) — falling back to the legacy private `_clear()` to tolerate a stale-cache runner. Tests: `tests/test-arena-session.js` (`pixi run test` runs the full suite; run a single file with `pixi run node tests/test-arena-session.js`).

**Pat-Parser Dual Export Pattern** (`js/pat-parser.js`):
- Icon generator loads via `<script src="js/pat-parser.js">` → requires `window.PatParser`
- Pattern editor loads via `import PatParser from './js/pat-parser.js'` → requires ES6 export
- Solution: Export both ways with clear comments explaining the dual export strategy

```javascript
// Export for browser (global) - for <script> tags (icon generator)
if (typeof window !== 'undefined') {
    window.PatParser = PatParser;
}

// ES module export - for import statements (pattern editor)
export default PatParser;
```

**Important**: When modifying shared modules, test with ALL tools that depend on them.

**Arena Config Helper Functions** (`js/arena-configs.js`):

The `getConfigsByGeneration()` function returns objects, NOT simple strings:

```javascript
// CORRECT - configs is array of { name, label, description, arena } objects
const configsByGen = getConfigsByGeneration();
for (const [gen, configs] of Object.entries(configsByGen)) {
    configs.forEach(config => {
        console.log(config.name);   // "G6_2x10"
        console.log(config.label);  // "G6 (2×10) - 360°"
        console.log(config.arena);  // { generation, num_rows, num_cols, ... }
    });
}

// WRONG - treating config objects as strings will break dropdown population
configs.forEach(name => {
    option.value = name;  // BUG: name is an object, not a string!
});
```

This pattern has caused bugs multiple times. Always use `config.name` for the value and `config.label` for display text.

## Arena Studio (`arena_studio.html`) — the primary tool

**Policy (2026-07-02):** the Studio is the **primary development path**. The
standalone tools it absorbed — `arena_console.html` and
`experiment_designer_v3.html` — are in **maintenance mode**: bug/safety fixes
only, no new features. Do NOT dual-implement features for parity; record the
delta in **`docs/development/arena-studio-parity.md`** (the ledger + the
retirement gate — the standalones eventually become redirect stubs to
`arena_studio.html?mode=console` / `?mode=edit`). Prefer pushing logic into
shared dual-export `js/` modules whenever a feature is touched — a shared-module
fix flows to every page automatically; two hand-written HTML pages never will.

### Architecture (one page, three script layers)

1. **Classic substrate** (`<script src>`): wire/link/runner/session/run-log/
   pattern-set/pat-encoder/pat-preview/bin-classifier + `js/studio-*.js`
   helpers. Connection + STOP must stay here (ES-import-failure gotcha).
2. **Classic Studio shell + ConsoleView** (inline classic scripts): `window.Studio`
   (`session` = the ONE `ArenaSession.shared()`, `mode`, `importMode`,
   `canMutate()`, `rawLog`/`clog`, `onRunStatus` — the single runstatus sink),
   plus all Console bench handlers.
3. **ONE `<script type="module">` block**: shared imports at top (duplicate
   import bindings are a module-level SyntaxError — there is exactly one import
   set for the spine AND the embedded designer), Studio run/file/GitHub code,
   the **embedded v3 designer as an IIFE** (`(function EditView() {...})()`),
   then `initFromUrl()` last.

### Rules when editing the Studio

- **§6 chokepoint:** `pushUndo()` returns `Studio.canMutate()` (= Edit mode and
  not importMode) and every designer mutation site is `if (!pushUndo()) return;`.
  Any NEW protocol-mutation entry point must go through it (or `_pushUndoSnapshot()`
  + an explicit Edit-mode gate, as `commitImport` does). Never add a mutation
  path that skips the gate; the tripwire `console.warn` is the audit.
- **Doc state has one source of truth:** the embedded designer's `experiment`
  (`_doc`). `Studio.syncFromEditor` (called from `renderAll`, `loadYamlText`,
  and `setDirty`) recomputes `Studio.currentDoc` (sha over `_doc.toString()`,
  rig, source), the top-bar chips, and the Run-view sequence. `dirty` means
  "text ≠ last load/save" (`savedText` baseline), NOT a snapshot-captured flag.
- **Display quiesce:** firmware refuses SD-write + ISP commands
  (0x8D/0xE0/0x8A/0xC8/0xC9) unless the display is stopped (`CE_DISPLAY_ACTIVE`,
  status 10). Any new handler for a guarded op must `await quiesceDisplay()`
  first. STOP also blanks panels (they latch frames) — a persistent on-arena
  display during ISP is impossible on current firmware; progress maps blink.
- **Console conventions:** SD listing owns the pattern picker once connected
  (`Studio.onSdListing`); the web library is thumbnails-only. `send()` logs the
  firmware's ASCII error payload on non-ok status — keep that for new ops.
  New `.cmenu` popups: the document click-away closer ignores clicks inside
  `.cmenu-pop`; one-shot `.cmenu-item`s (not in a `.cmenu-row`) auto-close.
- **Metadata / controlled-vocab sourcing (THE rule):** when a **course repo is
  configured AND signed in**, ALL metadata vocabularies load from that repo (its
  root-level YAML) and their ↗ source links repoint there — the connected repo is
  the source of truth. When not (offline / not signed in), fall back to the
  **webDisplayTools site library** at `configs/metadata/*.yaml`. Today this covers
  experimenter (`roster.yaml`), genotype (`genotypes.yaml`), and fly age/sex/number
  (`ages.yaml`/`sexes.yaml`/`fly_numbers.yaml`). Wiring: `populateMetaDatalists()`
  loads the site fallback at page start; `Studio.refreshCourseMeta()` (on sign-in /
  repo change / connect) overrides from the repo via `fetchCourseRoster` /
  `fetchCourseGenotypes` / the generic `fetchCourseVocab(file, key, srcId, apply)`.
  **Any NEW controlled vocab MUST follow this course-first, site-fallback pattern:**
  add a site YAML under `configs/metadata/`, load it in `populateMetaDatalists`, AND
  add a `fetchCourseVocab(...)` call in `refreshCourseMeta` + seed the file into the
  course repo root. The course repo (`reiserlab/cshl-2026-course`) is PRIVATE, so
  the course override needs a token; the site files are same-origin (always work).
- **Session rig (#135, v0.4):** `Studio.currentRig` (`{name, arenaConfig,
  explicit}`) is THE bench rig for all three views — one top-bar selector,
  locked by default. Always change it via the module block's
  `setSessionRig(name, {explicit})`, never by assigning `Studio.currentRig`:
  it enforces explicit-beats-derived (a protocol load never overrides a
  user/`?rig=` choice — the mismatch chip surfaces disagreement instead),
  invalidates the rig-`io:` cache, and mirrors explicit picks into the URL
  (`encodeApp`'s `rigKey`; derived rigs stay out — clean-URL rule). Console
  geometry consumers read `Studio.currentRig.arenaConfig`. Rig `io:` power-on
  defaults: `parseRigIo` (js/plugin-registry.js, tolerant, suite N12io) +
  `Studio.applyRigIo()` (module block; called from `initFromController`,
  optional-guarded so connect survives a failed module load). fw-gated roles
  come from `RIG_IO_ROLES.fwGated` — grey them in UI, never send them.
  **DIO naming convention:** the board BNC silkscreen is the vocabulary —
  "Digital IO 1 (5V)" / "Digital IO 2 (5V)" — and rig `io:` `port` is 1-BASED,
  equal to both the silkscreen number and the 0xAA wire channel (one number
  everywhere; `parseRigIo` rejects `port: 0` with a warning). Label new I/O UI
  with the silkscreen names, not DO1/DO2/J3/J4 refdes.
- **Wire module exports:** `js/arena-wire-g6.js` defines more than it exports —
  when adding encoders/decoders, add them to the export list AND a test; audit
  with `Object.keys(require('./js/arena-wire-g6.js'))` vs the page's `Wire.*`
  uses (a missing export throws silently inside async handlers).
- URL state ([#107](https://github.com/reiserlab/webDisplayTools/issues/107),
  read+write): `js/studio-url-state.js` (`mode` ∈ run|edit|console; a shared
  `p` forces `edit`→Run on fresh loads, never `console`). Write side:
  `Studio.updateUrl` mirrors `{mode, currentDoc.protocolKey}` — user mode
  switches PUSH (Back/forward = view history), doc-identity changes REPLACE
  (one call in `syncFromEditor`); popstate restores MODE ONLY, then
  canonicalizes the visited entry (doc identity never time-travels). `p` =
  registry provenance (`protocolKey` set only by a validated `?p=` load, kept
  across edits/saves); `history.state.mode` marks an own-refresh and may
  override the shared-`p` force. `initFromUrl` + popstate wrap `setMode` in
  `Studio._urlSuppress`. URL writing is NOT a protocol mutation — never route
  it through `pushUndo`. Any NEW shareable state must flow through
  `encodeApp()` + `Studio.updateUrl` (never hand-build `location.search`).
- **Console v6 layout (v0.6):** left rail of 7 tool panels (`data-panel` =
  patterns/trial/step/test/io/fw/fictrac) + bench strip + always-visible resizable log;
  the SD/library **listing IS the pattern picker** (row click drives the hidden `cPatName`).
  GOTCHA: connected SD rows carry RAW filenames in `data-name` while picker options key
  LOGICAL names — always normalize row↔option comparisons through `Studio.sdLogicalName`
  (offline mirrored rows use option values, so offline tests pass without it).
- **Open lands in Edit:** `Studio.loadProtocol(text, name, source, opts)` switches to Edit
  after a successful load unless `opts.landIn === 'run'` (only the `initFromUrl` `?p=`/
  `?repo=` loads pass that). Never re-add an unconditional force-to-Run.
- **? Help mode:** top-bar `?` toggles `body.helpmode`; a managed tooltip shows curated
  `data-help` text (applied from the `HELP` map in the v6 glue classic script — extend the
  map, don't scatter attributes) and suppresses the native engineer `title=` while shown.
  Content rule: end-user voice, shipped features only, no opcodes/issue refs/design history.
  Per-view "first steps" cards are created by `helpCard()` in the same script.
- **Footer is ONE line and carries ONLY** the tool name/version + ET timestamp + a GitHub
  repo link (e.g. `Arena Studio v0.9 | 2026-07-07 00:03 ET · GitHub`). NEVER put a
  changelog, release-notes summary, or "what changed" keywords in the footer — this is a
  recurring mistake. The changelog lives ONLY in
  `docs/development/arena-studio-release-notes.md` — add an entry there for user-visible
  changes.
- Bump the footer version/timestamp on every edit; never Prettier the HTML.

## Pattern Designer (`pattern_editor.html`)

Renamed from "Pattern Editor" (v0.10, 2026-07-04); the FILENAME stays `pattern_editor.html`
(bookmarks/links). It shares the Studio's GitHub settings via same-origin storage
(`studio_gh_pat` in sessionStorage/localStorage, `studio_gh_repo` + `studio_bench_id` in
localStorage) — no auth UI of its own. Repo layout: free-standing patterns in `patterns/`
(shared library) or protocol-colocated `protocols/<bench-id>/<proto>_patterns/`.

- **URL state:** `?arena=<config>` (validated via `getConfig`, applies + LOCKS the arena
  selector) and `?repo=owner/name` (validated via `StudioUrlState.isSafeRepo`, session-only
  override — never written to localStorage). Written back via `updateUrlState()`
  (replaceState) on arena change / pattern load. The Studio's top-bar **Patterns ↗** link
  builds this URL at click time from `Studio.currentRig.arenaConfig` + the stored repo.
- **File ops:** LOAD ▾ menu = Open local file… / Open from Library… (site
  `patterns/<config-lowercase>/MANIFEST.txt` via `window.PatternSet.parseManifestTxt`) /
  Open from Repo… (two-step picker: `patterns/` + every `*_patterns/` dir under
  `protocols/<bench-id>|shared/`). All three sources funnel into `loadPatternBuffer()`.
  ⇪ Save to Repo… = destination modal (library vs protocol) → `GH.directCommit` with an
  exists-check overwrite confirm.
- Classic deps added for this: `js/pattern-set.js`, `js/studio-url-state.js` (both
  dual-export; same files the Studio loads).

## CI/CD Validation

Web calculations are validated against MATLAB reference data:
1. MATLAB generates `reference_data.json`
2. Copy to `data/` directory
3. GitHub Actions runs validation on push
4. Tolerance: 0.0001

## Panel Specifications

Standard panel generations:
- G3: 32mm width, 8x8 pixels (circle LEDs)
- G4: 40.45mm width, 16x16 pixels (circle LEDs)
- G4.1: 40mm width, 16x16 pixels (rotated rectangle LEDs)
- G6: 45.4mm width, 20x20 pixels (rotated rectangle LEDs)
Note: G5 is deprecated and no longer supported.

Arena radius formula: `cRadius = panelWidth / (tan(alpha/2)) / 2` where `alpha = 2*PI/numPanels`

### LED Specifications
- G4.1, G6 use SMD LED packages with rectangular shapes rotated 45° on the panel
- G3, G4 use circular LED visualization

## Arena 3D Viewer (`arena_3d_viewer.html`)

### Key Implementation Details
- Uses Three.js r182 with OrbitControls (ES6 modules)
- Renderer requires `preserveDrawingBuffer: true` for screenshot functionality
- LED meshes stored in `ledMeshes[]` array for efficient animation (color-only updates)
- Pattern rotation uses `state.phaseOffset` to shift pattern, not world rotation
- Controls disabled during auto-rotate for performance

### State Object
```javascript
state = {
    panelType: 'G6',      // G3, G4, G4.1, G6
    numCols: 12,          // panels around (from 2D editor URL params)
    numRows: 3,           // panels vertically
    activePanels: null,   // array of active column indices, null = all
    pattern: 'allOn',     // 'allOn', 'grating', 'sine'
    gratingPixels: 20,    // pixels on/off (must be integer divisor)
    sineWavelength: 120,  // wavelength in pixels (must be integer divisor)
    phaseOffset: 0        // current phase for rotation animation
}
```

### Pattern Constraints
- Grating and sine wavelengths must be integer divisors of total azimuth pixels
- This ensures patterns tile seamlessly around the arena
- Use `getIntegerDivisors()` to populate valid options

### Screenshot Filenames
Format: `arena_{gen}_{cols}c{rows}r_{pattern}[_stats]_{timestamp}.png`
Example: `arena_G6_12c3r_sine120_stats_2026-01-17T10-30-45.png`

### URL Parameters
- `gen`: Panel generation (G3, G4, G4.1, G6) - defaults to G6
- `cols`: Number of columns (panels around) - defaults to 10
- `rows`: Number of rows (panels vertically) - defaults to 3
- `active`: Comma-separated 0-based indices of active panels (omitted if all active)

When accessed from the Arena Layout Editor, all parameters are passed through. When accessed directly from the index page, defaults are used (G6, 10 columns, 3 rows, all active).

## TODO / Future Improvements

### Angular Resolution Display
The current 3D viewer shows "average" angular resolution, which is simply total field of view divided by number of pixels. This is not accurate because each pixel subtends a different angle depending on its position.

A proper implementation should:
- Calculate per-pixel angular resolution
- Show a histogram of resolution values
- Display min, max, and median resolution
- Consider both azimuth (constant) and vertical (varies with elevation) components

The azimuth resolution is constant (360° / total_azimuth_pixels), but vertical resolution varies based on viewing angle from center - pixels near the vertical center subtend smaller angles than those at the top/bottom edges.

### Icon Generator Arena Mapping
**Status:** ✅ FIXED as of 2026-02-02

The regex in `inferArenaFromPath()` was updated to handle partial arena names like `G6_2x8of10`:
```javascript
const arenaPattern = /G(6|4\.1|4|3)[_-](\d+)[x×](\d+)(?:of(\d+))?/i;
```

### Spherical Pattern Generation
**Status:** ✅ VERIFIED WORKING as of 2026-02-03

Detailed byte-for-byte comparison with MATLAB confirmed the JavaScript implementation is correct:
- `cart2sphere`, `sphere2cart`, and `rotateCoordinates` match MATLAB exactly
- All motion types (rotation, expansion, translation) with rotated poles produce identical output

**Bug Fix (2026-02-03):** A JavaScript falsy-value bug in the UI was causing `poleElevation = 0` to be silently converted to `-90`. The expression `parseFloat(value) || -90` evaluates to `-90` when value is `0` because `0` is falsy. Fixed by adding `parseFloatWithDefault()` helper using `Number.isFinite()`. Pattern Editor v0.9.7 now correctly handles Pole El = 0 and produces concentric rings matching MATLAB.

### Load Pattern Feature
The 3D viewer supports loading `.pat` files directly:

**Supported Formats:**
- G6: 17-byte header with "G6PT" magic, 20x20 panels, GS2 (binary) and GS16 (4-bit grayscale)
- G4: 7-byte header, 16x16 panels, subpanel addressing

**UI Controls:**
- "Load .pat File" button opens file picker
- Pattern info displays filename, dimensions, frames, grayscale mode
- Frame slider scrubs through multi-frame patterns
- Play/Pause button with FPS dropdown (5, 10, 15, 20, 30 FPS)
- "Clear Pattern" button returns to synthetic patterns

**Implementation Files:**
- `js/pat-parser.js` - Pattern file parser module (use `PatParser.parsePatFile()` method)
- Pattern loading integrated into `arena_3d_viewer.html`

## Pattern Validation

### Programmatic Testing
Use `window.testLoadPattern(url)` for automated pattern validation:

```javascript
// In browser console or via Claude Chrome extension
await testLoadPattern('/test_patterns/grating_G6.pat');
// Logs: Generation, dimensions, frames, grayscale mode
// Returns true if load succeeded
```

### Verification Checklist
After loading a pattern, verify in console output:
- ✓ Generation detected correctly (G6 vs G4)
- ✓ Panel dimensions match expected (20×20 for G6, 16×16 for G4)
- ✓ Total pixels = rows × cols × panelSize²
- ✓ Frame count matches expected
- ✓ Pixel values in valid range (0-1 for GS2, 0-15 for GS16)

### Orientation Verification
Patterns should display with:
- Row 0 at bottom (not flipped vertically)
- Column 0 at correct azimuth position
- Gratings aligned properly (vertical stripes appear vertical)

Use corner marker test patterns to verify:
```javascript
// Bottom-left corner should be brightest
console.log('Pixel (0,0):', patternData.frames[0][0]);
console.log('Pixel (0,max):', patternData.frames[0][totalCols-1]);
```

## Browser Testing with Claude Chrome Extension

The Claude in Chrome extension enables automated browser testing without manual interaction.

### Setup
1. Start local HTTP server: `python -m http.server 8080`
2. Use Chrome extension tools to navigate and interact

### Available Tools
| Tool | Purpose |
|------|---------|
| `tabs_context_mcp` | List open tabs |
| `navigate` | Go to URL |
| `read_page` | Get page content |
| `javascript_tool` | Execute JS in page context |
| `read_console_messages` | Get console output |
| `computer` (screenshot) | Capture visual state |

### Testing Workflow

**1. Navigate to test page:**
```
navigate to http://localhost:8080/arena_3d_viewer.html
```

**2. Execute test JavaScript:**
```javascript
// Load pattern
await testLoadPattern('/test_patterns/grating_G6.pat');

// Verify playback controls
document.getElementById('frameSlider').max;
document.getElementById('playPauseButton').textContent;
```

**3. Capture and verify screenshot:**
- Take screenshot with `computer` tool (action: screenshot)
- Use Read tool to view screenshot image
- Verify UI elements render correctly

**4. Check console for errors:**
- Use `read_console_messages` to check for JavaScript errors
- Verify pattern validation output

### Example Test Session
```
1. Start server: python -m http.server 8080
2. navigate → http://localhost:8080/arena_3d_viewer.html
3. javascript_tool → await testLoadPattern('/test_patterns/grating_G6.pat')
4. read_console_messages → verify no errors, check pattern info
5. computer screenshot → capture visual state
6. Read screenshot → verify pattern displays correctly
```

### UI Element IDs for Testing
| Element | ID | Purpose |
|---------|-----|---------|
| Pattern load button | `loadPatternBtn` | Trigger file picker |
| Pattern info display | `patternInfo` | Shows loaded pattern details |
| Frame slider | `frameSlider` | Multi-frame navigation |
| Frame label | `frameLabel` | Current frame display |
| Play/Pause button | `playPauseButton` | Playback control |
| FPS dropdown | `fpsSelect` | Playback speed |
| FOV slider | `fovSlider` | Camera field of view |
| Clear button | `clearPatternBtn` | Reset to synthetic patterns |

### Testing Gotchas

**Browser Caching with GitHub Pages:**
- GitHub Pages and browser caching can prevent updated JS files from loading
- Symptoms: "X is not defined" errors for recently added exports/functions
- Solutions:
  - Hard refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)
  - Clear browser cache for localhost:8080 or GitHub Pages domain
  - Add cache-busting query params: `<script src="file.js?v=2">`
  - For local testing, use `python -m http.server` with hard refresh
- Always verify changes are visible in browser DevTools → Sources tab before debugging

**CRITICAL: ES6 Module Import Failures are Catastrophic:**

When an ES6 `import` statement fails, the **entire** `<script type="module">` block stops executing. This is different from regular script errors - there's no partial execution.

**How this breaks the Pattern Editor:**
1. Developer adds new import: `import { newFunction } from './module.js'`
2. Developer adds `newFunction` to module.js exports
3. Local testing works (fresh files loaded)
4. Push to GitHub
5. GitHub Pages serves **cached old** module.js (without new export)
6. Import fails silently → entire module stops → arena dropdown empty, no events attached

**Symptoms:**
- Arena dropdown is empty (most obvious)
- No JavaScript functionality works at all
- Console shows: `SyntaxError: The requested module does not provide an export named 'X'`

**Prevention rules:**
1. **Never add new imports without testing on GitHub Pages** after deployment
2. **Wait for cache to clear** (or use hard refresh) before declaring success
3. **Test Pattern Editor loads** after any change to shared modules (icon-generator.js, pat-parser.js, arena-configs.js)
4. **If adding new exports to shared modules**, consider whether they're truly needed in the importing file

**Recovery:**
- Remove the failing import
- Push fix immediately
- Hard refresh on GitHub Pages to verify

## Pattern Editor 3D Viewer Rules

**CRITICAL: The 3D viewer MUST fully rebuild its geometry whenever the arena configuration changes or a new pattern is loaded.** This means:

1. **Arena config changes** (dropdown selection, pattern load auto-detect) → call `threeViewer.reinit(config, specs)` to rebuild all panel/LED geometry
2. **`_buildArena()` must NEVER reset the camera position** — only the initial `init()` call sets the camera to top-down. Rebuilds preserve the user's current view.
3. **Track which arena config the 3D viewer was last built with** using `threeViewerArenaConfig`. Compare on every `init3DViewer()` call and reinit if stale.
4. **If `init()` fails** (scene is null), destroy the viewer and retry on next attempt — never leave a half-initialized viewer that silently ignores all controls.

These rules prevent stale geometry bugs where the 3D viewer shows an old arena after config changes.

## Pattern Editor Migration Plan

The Pattern Editor is being developed in phases. The full migration plan is saved at:

**Plan file:** `~/.claude/plans/fuzzy-waddling-harbor.md`

This plan covers:
- Two-pane layout (tools left, viewer right)
- Tool tabs: Generate, Frame to Pattern, Combine
- Viewer tabs: Grid/Edit, 3D, Mercator, Mollweide
- Frame clipboard for capturing and sequencing frames
- 7 implementation phases over ~6-7 weeks

**Current status:** Pattern Editor v0.9 complete. All major features implemented: Grid/Edit mode, 3D viewer, pattern generation, tabbed clipboard (frames/patterns), frame animation mode, sequence builder, pattern combiner. Pending: MATLAB reference validation, manual testing, polish.

### Testing Required (Next Session)

The following UI improvements were made on 2026-02-02 and need testing on GitHub Pages:

1. **Pattern Editor v0.9**:
   - [ ] GENERATE button visually larger and bolder
   - [ ] Clipboard tabs switch between Frames and Patterns view
   - [ ] "↓ Frame" capture button works, switches to Frames tab
   - [ ] "↓ Pat" capture button works, switches to Patterns tab
   - [ ] Clipboard clears when arena dropdown changes
   - [ ] Clipboard clears when arena unlocked (with confirmation)
   - [ ] Animate tab mode toggle works (Frame Shifting vs Frame Animation)
   - [ ] Frame Animation: "Add All Clipboard Frames" populates sequence
   - [ ] Frame Animation: Preview button generates pattern
   - [ ] Frame Animation: Save .pat downloads file
   - [ ] Image tab shows placeholder

2. **Icon Generator v0.9** (was v0.8):
   - [x] No arena dropdown visible (removed)
   - [x] Loading `G6_2x10_*.pat` file shows "✓ Detected: G6 (2×10)"
   - [x] Loading file without arena in name shows error AND manual dropdown
   - [x] Manual arena dropdown allows selection when auto-detect fails
   - [ ] "Select Folder..." button opens folder picker
   - [ ] Selecting folder with .pat files loads them with arena from folder name
   - [x] Test patterns still work (use G6_2x10 default)

**GitHub Issue:** [#6 - additional web tools for making patterns](https://github.com/reiserlab/webDisplayTools/issues/6)

## Experiment Designer

### Architecture (v0.9 — 2026-04-10)
- 3-zone layout: settings panel (280px left), editor with tab bar (flex right), filmstrip with lane view (bottom)
- Single `<script type="module">` importing from `js/arena-configs.js`, `js/protocol-yaml.js`, `js/plugin-registry.js`
- Data model: `experiment` object with `experiment_info`, `arena_info`, `rig_path`, `plugins[]`, `experiment_structure`, phases with `commands[]`, and `conditions[]` with `commands[]`
- Undo/redo: snapshot-based history stack (JSON.stringify/parse of `experiment`, max 50 entries)

### Shared Modules
- **`js/protocol-yaml.js`** — YAML parser (`simpleYAMLParse` with inline comment stripping), v1/v2 generators, string helpers. Dual-export (window.ProtocolYAML + ES6 module). Used by HTML, both test files.
  - `yamlStr(str)` — double-quotes strings for YAML
  - `yamlPath(str)` — single-quotes paths (no escape sequences, safe for Windows backslashes)
- **`js/plugin-registry.js`** — Built-in plugin definitions (LEDControllerPlugin: 7 commands, BiasPlugin: 7 commands incl. connect), controller command definitions (6 commands), lookup functions for dropdown population. Dual-export.
  - Plugin config fields use `rigDefined: true` for fields already in rig YAML (ip, port) — these are NOT auto-included in exports
  - `createPluginEntry()` skips fields with empty string defaults

### Data Model (v2 commands)
Conditions and phases use **command arrays** as the primary data model:
```javascript
condition = {
    id: "string",
    commands: [
        { type: "plugin", plugin_name: "camera", command_name: "getTimestamp" },
        { type: "controller", command_name: "trialParams", pattern: "...",
          duration: 10, mode: 2, frame_index: 1, frame_rate: 10, gain: 0 },
        { type: "wait", duration: 3 },
        { type: "plugin", plugin_name: "backlight", command_name: "setRedLEDPower",
          params: { power: 5, panel_num: 0, pattern: "1010" } },
    ]
}
phase = { include: true/false, commands: [ ...same format... ] }
experiment.plugins = [
    { name: "backlight", type: "class", matlab: { class: "LEDControllerPlugin" }, config: { ... } },
    { name: "camera", type: "class", matlab: { class: "BiasPlugin" }, config: { ... } }
]
experiment.rig_path = "./configs/rigs/test_rig_1.yaml"
```
Helper functions: `cmdFindTrialParams(commands)`, `condGetDuration(cond)`, `condGetPattern(cond)`, `phaseGetDuration(phase)`.

**Duration formula**: `max(trialParams.duration, sum_of_waits)` — shows the actual wall-clock time. If waits exceed trialParams duration, the condition runs longer than the pattern display (visible to the user as a mismatch).

**Shared command helpers** (used by Commands tab, Table view, and phase editor):
- `buildAddCommandOptions()` — returns HTML `<option>`/`<optgroup>` string for add-command dropdowns
- `createCommandFromSelectValue(value)` — parses `"controller:trialParams"` / `"wait:wait"` / `"plugin:backlight:setRedLEDPower"` into a command object
- `createPluginCommand(pluginName, commandName)` — builds plugin command with default params from registry schema

### YAML Export (v2)
- Generates protocol v2 via `generateV2Protocol()` from `js/protocol-yaml.js`
- `rig:` field replaces inline `arena_info`
- **All string values use single quotes** via `yamlPath()` — pattern filenames, paths, plugin string params — prevents Windows backslash escape issues
- **Empty optional plugin params are omitted** — e.g., an empty `pattern` field is not exported (would cause MATLAB errors)
- **Plugin param types respected**: input handlers consult `getCommandParams()` schema — string-typed params like `pattern: "1010"` are kept as strings, not coerced to numbers
- `plugins:` section lists enabled plugins with class/config — only user-set config values are exported (empty = omit)
- Conditions export full command arrays including plugin commands with params
- Phases export command arrays directly

### Editor Tabs
Two tabs in the right panel, both views of the same data model:
1. **Commands** (was "Visual" in v0.6) — Command card editor with color-coded cards (green=controller, gray=wait, blue=plugin), inline field editing, "Add Command" dropdown, up/down reorder arrows, delete buttons
2. **Table** — Fully editable spreadsheet view with collapsible sections, inline field editing, add/move/delete commands, condition reorder/remove, Expand All/Collapse All buttons

### Bottom Filmstrip + Lane View
The bottom timeline area is a unified scroll container:
- **Block strip**: Colored blocks (green=condition, gray=phase, dark=ITI) with drag-to-reorder conditions
- **Lane view**: Always-visible SVG showing controller spans (green bars), plugin events (blue dots), and wait bars (gray) across all blocks
- **Fixed lane labels**: Left column (70px) with lane names stays visible during scroll
- Block strip and lane SVG share the same scroll parent for perfect alignment
- Block widths use `Math.max(48, duration * pxPerSecond)` — lane SVG must match this + account for 2px CSS gap between blocks
- Clicking any filmstrip block switches to the Commands tab

### Undo/Redo System (v0.9)
- **Snapshot stack**: `undoStack[]` and `redoStack[]` store `JSON.stringify(experiment)` snapshots (max 50)
- **`saveSnapshot()`**: Called before every mutation. Pushes current state to undoStack, clears redoStack.
- **`_restoring` guard**: Boolean flag set during `restoreSnapshot()` (wrapped in try/finally). Prevents focus events on re-rendered inputs from calling `saveSnapshot()` and clearing the redo stack.
- **Selection clamping**: `restoreSnapshot()` clamps `selection.index` to valid bounds after restoring, since the restored state may have fewer conditions.
- **Text inputs**: Snapshot on `focus` (not `input`) — one undo step per field visit, not per keystroke. Browser native Ctrl+Z still works inside inputs.
- **Reset button**: Clears conditions/phases/plugins to defaults, keeps settings (experiment_info, arena, rig_path). Clears both undo/redo stacks. Shows confirm dialog.
- **Keyboard**: Ctrl+Z/Cmd+Z (undo), Ctrl+Y/Cmd+Y/Ctrl+Shift+Z (redo) — only fires when focus is not in INPUT/TEXTAREA/SELECT.

**When adding new mutation sites**: Always call `saveSnapshot()` before the mutation. For new text inputs, add a `focus` event listener that calls `saveSnapshot`.

### Key Implementation Notes
- **Must use `<script type="module">`** to import shared modules
- Mode 2 (Constant Rate): `gain` fixed at 0, `frame_rate` editable
- Mode 4 (Closed-Loop): `frame_rate` fixed at 0, `gain` editable
- `handleTrackClick` calls `switchEditorTab('commands')` then `renderEditor()` — always shows Commands tab on block click
- `computeLaneData()`: trialParams fires controller autonomously (doesn't advance clock), wait advances clock, plugin commands are instantaneous
- **Phase initialization must deep-clone**: `{ include: false, commands: JSON.parse(JSON.stringify(DEFAULT_PHASE.commands)) }` — shallow spread shares the commands array reference
- Plugin config uses `setPluginConfig()` helper that deletes empty values and removes config object when empty

### Related Files
- `experiment_designer.html` — Main tool (v0.9)
- `experiment_designer_quickstart.html` — Step-by-step guide (v0.9)
- `js/protocol-yaml.js` — Shared YAML parser/generator (added `yamlPath`)
- `js/plugin-registry.js` — Plugin definitions + command schemas (BiasPlugin: connect command added)
- `tests/test-protocol-roundtrip.js` — 137 CI checks (10 suites, v1+v2 + bug regression)
- `tests/generate-roundtrip-protocol.js` — YAML + manifest generator for MATLAB
- `tests/fixtures/v2_*.yaml` — V2 YAML test fixtures from maDisplayTools
- `docs/development/experiment-designer-v06-testing.md` — Manual testing checklist
- `docs/development/protocol-roundtrip-testing.md` — Roundtrip testing architecture
- GitHub Issues: [#33](https://github.com/reiserlab/webDisplayTools/issues/33), [#53–60 closed](https://github.com/reiserlab/webDisplayTools/issues?q=is%3Aissue+is%3Aclosed) (tooltips, bugs, undo/redo, connect cmd, param backfill)

### Testing & Validation (v0.9)

**Automated:** `node tests/test-protocol-roundtrip.js` — 137 checks across 10 suites (v1+v2 parse/generate roundtrips + bug #55-58 regressions). Run after any change to `protocol-yaml.js` or the data model.

**Manual testing checklist (import a v2 YAML like `full_experiment_test.yaml` to populate):**

Phase independence:
- [ ] Edit pretrial commands → intertrial/posttrial must NOT change
- [ ] Each phase independently editable with different commands

Plugin commands:
- [ ] Adding `setRedLEDPower` shows power, panel_num, pattern fields with defaults
- [ ] Adding `turnOffLED` shows NO parameter fields
- [ ] Plugin params appear in exported YAML

YAML export:
- [ ] Paths use single quotes (check with Windows-style path like `C:\Users\lab\patterns`)
- [ ] `critical` does NOT appear in backlight config
- [ ] Camera ip/port/frame_rate/video_format NOT in export unless user-set
- [ ] Backlight port NOT in export unless user-set

Table view:
- [ ] All fields editable inline (duration, mode, FR/gain, pattern, plugin params)
- [ ] Add Command dropdown works for conditions and phases
- [ ] Up/down arrows reorder commands
- [ ] Up/down arrows in section headers reorder conditions
- [ ] X button removes conditions (only when >1)
- [ ] Expand All / Collapse All buttons work

Filmstrip + lane view:
- [ ] Clicking a block switches to Commands tab
- [ ] Lane view labels stay fixed on left during scroll
- [ ] Lane SVG aligns with blocks above (check across zoom levels)
- [ ] White separator lines in gaps between blocks
- [ ] Zoom in/out and Fit update both blocks and lanes
- [ ] Selected block highlighted in lane view

**Known issues from 2026-04-08 session:**
- **Last-block lane alignment**: Minor drift may still be visible at certain zoom levels on the last block. Root cause was `totalWidth` not accounting for min-width clamping (`Math.max(48, ...)`) — fixed, but may need further tuning with complex experiments.
- **GitHub Pages caching**: After pushing, the arena dropdown appeared empty until hard refresh (`Cmd+Shift+R`). This is the standard ES6 module caching issue — always hard refresh after deploy.
- **CSS `content: '\u2807'` escape**: Unicode escapes in CSS `content` property rendered as literal text on some browsers. Fixed by using the literal character `⠇` instead.
- **Filmstrip delete button removed**: Was too easy to accidentally delete a condition when double-clicking to select. Conditions can now only be removed from the Table view or the Commands tab's "Remove" button.
- **Phase shallow copy bug**: `{ ...DEFAULT_PHASE }` shares the `commands` array reference between pretrial/intertrial/posttrial. Must use `JSON.parse(JSON.stringify(...))` for deep clone.
- **Visual editor first-click alert**: The table view's `.btn-row-delete` class overlapped with visual editor delete buttons, causing a "Phase 3" alert on first click. Fixed by giving visual editor buttons a separate `.cmd-delete-btn` class.

## v3 Experiment Designer — D4 Cross-Library Import

`experiment_designer_v3.html` (the v3 editor) lets a user open a **second** v3
protocol YAML and copy selected conditions — with the anchors and plugin
declarations they transitively depend on — into the currently-loaded protocol,
preserving comments/aliases. This is "D4" (the library-copy feature). The v3
editor's general architecture lives in the handoff docs (see below); this section
documents D4 specifically.

### Module split
- **`js/v3-import.js`** (new in D4) — the cross-doc substrate + staging buffer +
  commit pipeline. **Dual-export** (window global `V3Import` + ES named exports +
  CommonJS for tests), mirroring `js/protocol-yaml-v3.js`.
- **`js/protocol-yaml-v3.js`** — D4 added node-based inserters
  `ensureTopLevelSection`, `docInsertConditionNode`, `docInsertVariableNode`,
  `docInsertPluginNode` (preserve comments/aliases, unlike the JS-object-building
  `docInsertCondition`).

### v3-import.js API (what the UI drives)
- **Primitives:** `collectAliasReferences`, `resolveAlias` (via
  `alias.resolve(doc)` — **not** name lookup), `cloneNodeAcrossDocs` (one shared
  `aliasRewriteMap`), `yamlNodeStructuralEquals` + `sortedJson` (recursive key
  sort, used only on the plugin-merge path).
- **Staging:** `createStagingBuffer` (duplicate-anchor preflight; filename-derived
  prefix), `addToStaging` (visited-set transitive anchor closure + per-batch
  dependency registry), `removeFromStaging`, `setStagingPrefix` (recompute planned
  names; per-item overrides persist), `setItemTargetName`, `setAnchorPlannedName`,
  `setPluginPlannedName`, `refreshStagingValidation`, `commitStaging`.

### The anchor/plugin asymmetry (the core product rule)
- **Anchors namespace by default** (`&dur_short` → `&prefix__dur_short`). They're
  data aliases — safe to prefix.
- **Plugins MERGE by default** when `matlab.class` + `config` match (identity =
  all plugin fields except `name`, plus same `rig` when both are config-less);
  namespace only on mismatch. Plugins are runtime resources (cameras, controllers)
  — duplicating one is a real runtime bug. The built-in `log` plugin is always
  left as-is.
- Imported nodes are **comment-stamped** `# imported from <source>` for provenance.

### `commitStaging` contract (important for UI wiring)
- **Atomic:** validates first (throws `V3ImportError` `COMMIT_BLOCKED` with
  `.blocking`), snapshots `yours._doc.toString()`, and rolls back on any
  mid-commit throw (`COMMIT_FAILED`). All-or-nothing.
- **Does NOT call `pushUndo`** — the UI wrapper does, once, so the whole batch is
  a single undo step. Validate *before* `pushUndo` so a blocked attempt leaves no
  spurious undo entry; on a `COMMIT_FAILED` throw, `undoStack.pop()` (nothing
  changed).
- Handles bare-ref appending internally when `staging.addBareRefs` is true.

### Import-mode UI (in `experiment_designer_v3.html`)
- `enterImportMode` / `exitImportMode` / `commitImport` swap the three-zone layout:
  `#libraryZone` → "yours" locked, `#sequenceZone` → read-only "import source"
  pane, `#inspectorZone` → staging-item detail / source preview. A top
  `#importBanner` carries the editable prefix, staged count, "append bare refs"
  toggle, and Cancel/Commit.
- **`renderConditionList(listEl, conditions, opts)`** is the shared row renderer
  extracted from `renderLibrary`; reused by the locked "yours" pane and the
  read-only "theirs" pane. `opts`: `getUsage`, `isSelected`, `onRowClick`,
  `extraButtons`, `draggable`, `rowClass`, `emptyText`.
- **Locking (D4 design fix #8):** every target-doc mutation entry point guards on
  `if (importMode) return` **and** the controls are disabled on enter — never a
  global `pushUndo` suppression (commit itself pushes the one snapshot). When
  adding a new mutation handler to the v3 editor, **add an `importMode` guard.**
- Entering import mode must **not** `setDirty(true)` (cancelling mutates nothing);
  only a successful commit does. The `beforeunload` guard fires on `dirty ||
  importMode`.

### Tests + scope
- `tests/test-protocol-roundtrip-v3.js` suites **N1–N10** cover the whole
  substrate in Node (no browser). Run `pixi run test` after any `v3-import.js` or
  `protocol-yaml-v3.js` change.
- **Out of scope for D4 v1** (design §12): sequence/block-membership import,
  multi-doc YAML streams, pattern-path validation, a per-anchor "merge with
  existing" toggle. Imported conditions are *runnable* (bare ref appended), not
  behaviorally identical to how the sibling ran them.
- Authoritative docs: `docs/development/v3-d4-design.md` (rev 3),
  `docs/development/v3-d4-implementation-handoff.md`,
  `docs/development/v3-d4-design-reviews.md`.

## v3 Experiment Designer — Rig-Aware Plugins (#91) + #89 import fix

`experiment_designer_v3.html` (v0.21+) reads the **rig YAML** the user picks via
Settings → Rig → Browse… and uses its `plugins:` block to drive the plugin UI, and
D4 import binds **canonical** rig plugin names instead of prefixing them (closes #89).

### The rig→class mapping (in `js/plugin-registry.js`, pure, no YAML dep)
- `WELL_KNOWN_RIG_PLUGIN_NAMES = ['backlight', 'camera', 'temperature']` — the
  canonical rig plugin names. The DAQ thermometer's registry key is **`temperature`**
  (class `DAQThermometerPlugin`), matching the rig + experiment YAML — adding it in the
  designer produces `name: temperature` so the rig's config inherits (name-based match).
  Fixed 2026-06-11 (reported by Lisa F.): it used to be keyed `thermometer`, which
  exported as `name: thermometer` and silently broke config inheritance. The legacy
  `thermometer` rig key is still tolerated (`RIG_PLUGIN_KEY_MAP`/`TYPE_MAP` map it to
  the `temperature` built-in). v3 command lookup is by `matlab.class`, so import is
  name-agnostic regardless.
- `mapRigPluginToBuiltin(rigKey, rigType)` — **tolerant**: match the well-known
  KEY first (`RIG_PLUGIN_KEY_MAP`), then a normalized `type` (`RIG_PLUGIN_TYPE_MAP`,
  handles `"LED Controller"`, `"Bias"`/`"BIAS"`), else `null` ("unknown plugin type").
- `deriveRigPlugins(rigData)` → `{ plugins:[{key,enabled,type,builtinName,matlabClass,mapped}], unmapped }`.
  Never throws on null/partial input.
- `diffRigVsProtocol(derived, experiment.plugins)` → `{ unsupported, unused }`,
  **name-based** (a plugin's declared name must equal the rig key to inherit config).
- `createPluginEntry(builtinName, overrideName)` — the optional override lets a rig
  plugin be added under its canonical rig key (e.g. `temperature`) while reusing the
  built-in's class/defaults. `rigDefined` fields (ip/port) already have empty defaults,
  so rig-added plugins come out **config-less** by design.

### Rig YAML entry point
- `parseRigYAMLText(text)` in `js/protocol-yaml-v3.js` — thin `YAML.parse` wrapper;
  malformed/non-mapping input throws a clean `V3ParseError('RIG_PARSE_ERROR')`. The
  HTML imports this because it doesn't import the `yaml` package directly.

### HTML wiring
- Module state `loadedRig = { path, derived }`; `rigIsCurrent()` gates everything on
  `loadedRig.path === experiment.rig_path` (a manual path edit makes it stale → ignored).
- The Browse handler is `async` (reads `await f.text()`), then **must call
  `renderSettings()` itself** — `onRigEdit` doesn't re-render on success and re-picking
  the same path is a no-op there.
- Add-plugin dropdown option values are namespaced: `rig:<key>` (canonical add) vs
  `registry:<builtinName>`. `onAddPlugin(value)` parses the prefix.
- Mismatch warnings render **inline in Settings → Plugins** (only when `rigIsCurrent()`).

### #89 — canonical import binding (in `js/v3-import.js`)
- `_computePluginAction()` has a **canonical-name branch at the top**: if the source
  plugin name is in `WELL_KNOWN_RIG_PLUGIN_NAMES` or `staging.rigPluginNames`, never
  prefix — merge into an existing same-named target plugin, else add under the
  canonical name (`{ action:'add', canonical:true }`). The well-known names are an
  **always-on baseline**, so #89 is fixed even when no rig is loaded.
- `createStagingBuffer(src, file, { rigPluginNames })` threads extra loaded-rig names
  (the HTML passes them from `loadedRig` when `rigIsCurrent()`).
- A `canonical` entry is **non-renamable** — `setPluginPlannedName` and
  `setStagingPrefix` skip it; the import inspector renders "→ binds to rig plugin X".
- **When adding a new entry-point that prefixes plugin names, route through the
  canonical-name check** so #89 doesn't regress.

### Tests
- `tests/test-protocol-roundtrip-v3.js` suites **N12** (rig parse + tolerant map +
  `diffRigVsProtocol`, using `tests/fixtures/rigs/*`) and **N13** (#89 canonical
  import binding). Existing **N9** was updated to assert `camera` is added unprefixed.

## Planning Best Practices

### Project Size Assessment

Before starting work, assess whether the request is a **big project** or a **small task**:

**Small tasks** (no formal planning needed):
- Single file changes
- Bug fixes with clear scope
- Adding a single feature to existing code
- Documentation updates
- Running tests or validation

**Big projects** (use EnterPlanMode):
- Multi-file changes across different modules
- New features requiring architecture decisions
- Implementing multiple related features
- Refactoring that touches >3 files
- Work estimated to take >30 minutes of focused effort

### Parallel Agent Strategy

When a big project involves **multiple independent features**, evaluate whether they would benefit from parallelization:

**When to parallelize:**
- Features don't depend on each other's output
- Each feature can be tested independently
- Different expertise areas (e.g., frontend + backend + tests)

**How to coordinate parallel agents:**
1. Create a shared plan document outlining the work split
2. Launch agents simultaneously with clear scope boundaries
3. Use the TodoWrite tool to track progress across agents
4. Merge results and resolve any integration issues

**Example: Implementing 3 independent features**
```
Agent 1: Implement feature A (generator module)
Agent 2: Implement feature B (viewer module)
Agent 3: Write tests for both A and B
```

### Codebase Exploration

When starting a new task or entering plan mode, consider using **parallel Explore agents** to efficiently understand the codebase:

- **Use 1 agent** when the task is isolated to known files or making a small targeted change
- **Use 2-3 agents in parallel** when:
  - The scope is uncertain or spans multiple areas
  - You need to understand existing patterns before planning
  - Multiple subsystems are involved (e.g., parser + encoder + viewer)

**Example parallel exploration:**
```
Agent 1: Search for existing pattern generation implementations
Agent 2: Explore viewer integration patterns
Agent 3: Investigate testing/validation approaches
```

Launch all agents in a single message with multiple Task tool calls for maximum parallelism. This significantly reduces planning time for complex tasks.

## Close Session Protocol

When the user says **"close session"**, enter plan mode and prepare documentation updates:

1. **Summarize session work**
   - List files modified/created
   - Describe features added, bugs fixed, or refactors completed

2. **Review CLAUDE.md for updates**
   - New testing patterns or best practices discovered
   - Browser quirks or gotchas encountered
   - New utility functions that should be documented
   - Any corrections to existing documentation

3. **Review maDisplayTools docs/G4G6_ROADMAP.md for updates**
   - This is the unified roadmap for both MATLAB and web tools
   - Add a one-line entry to the changelog table in `G4G6_ROADMAP.md`
   - Append detailed session notes to `G4G6_ROADMAP_SESSIONS.md`
   - Mark completed tasks as done
   - Add any new issues discovered during the session
   - Note deferred items or future improvements identified

4. **Present plan for approval**
   - Show all proposed documentation changes
   - Wait for user approval before making edits

5. **After approval**
   - Make the documentation updates
   - Optionally offer to create a git commit summarizing the session
