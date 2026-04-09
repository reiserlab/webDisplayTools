# Claude Code Guidelines for webDisplayTools

## Scope of This File

**CLAUDE.md** is for **how to work with the code** — architecture, patterns, gotchas, testing procedures, and coding conventions. It should NOT contain roadmap items, feature wishlists, or project planning.

Roadmap and planning content belongs in:
- **`docs/ROADMAP.md`** — roadmap, milestones, changelog, and open items

**Review needed (future session):** Audit existing CLAUDE.md sections for roadmap content that has leaked in (e.g., "Future Improvements" lists, "Testing Required (Next Session)" checklists). Move planning items to the roadmap file and keep CLAUDE.md focused on technical reference.

## Versioning

Use simple two-digit versions for all web tools (e.g., `v1`, `v2`, `v6`). No semantic versioning (1.0.0) needed.

Format in footer: `Tool Name vX | YYYY-MM-DD HH:MM ET`

Example: `Arena Editor v2 | 2026-01-16 14:30 ET`

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
- Dependencies via CDN only (Three.js, etc.)
- Web outputs must match MATLAB outputs exactly

### Code Formatting

This project uses **Prettier** for consistent JavaScript formatting. Configuration is in `.prettierrc`.

**Setup:**
```bash
npm install           # Install Prettier (first time only)
```

**Style rules:**
- Single quotes (`'string'`)
- No trailing commas
- 4-space indentation
- 100 character print width
- Semicolons required

**Commands:**
```bash
npm run format        # Format all JS files
npm run format:check  # Check formatting (for CI)
npx prettier --write path/to/file.js  # Format single file
```

**Before committing:** Run `npm run format` on any modified JavaScript files to ensure consistent style.

### Shared Modules

Some JavaScript modules are shared between multiple tools and must support different loading patterns:

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

### Architecture (v0.8 — 2026-04-08)
- 3-zone layout: settings panel (280px left), editor with tab bar (flex right), filmstrip with lane view (bottom)
- Single `<script type="module">` importing from `js/arena-configs.js`, `js/protocol-yaml.js`, `js/plugin-registry.js`
- Data model: `experiment` object with `experiment_info`, `arena_info`, `rig_path`, `plugins[]`, `experiment_structure`, phases with `commands[]`, and `conditions[]` with `commands[]`

### Shared Modules
- **`js/protocol-yaml.js`** — YAML parser (`simpleYAMLParse` with inline comment stripping), v1/v2 generators, string helpers. Dual-export (window.ProtocolYAML + ES6 module). Used by HTML, both test files.
  - `yamlStr(str)` — double-quotes strings for YAML
  - `yamlPath(str)` — single-quotes paths (no escape sequences, safe for Windows backslashes)
- **`js/plugin-registry.js`** — Built-in plugin definitions (LEDControllerPlugin: 7 commands, BiasPlugin: 6 commands), controller command definitions (6 commands), lookup functions for dropdown population. Dual-export.
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

**Shared command helpers** (used by Commands tab, Table view, and phase editor):
- `buildAddCommandOptions()` — returns HTML `<option>`/`<optgroup>` string for add-command dropdowns
- `createCommandFromSelectValue(value)` — parses `"controller:trialParams"` / `"wait:wait"` / `"plugin:backlight:setRedLEDPower"` into a command object
- `createPluginCommand(pluginName, commandName)` — builds plugin command with default params from registry schema

### YAML Export (v2)
- Generates protocol v2 via `generateV2Protocol()` from `js/protocol-yaml.js`
- `rig:` field replaces inline `arena_info`
- **Paths use single quotes** via `yamlPath()` (pattern_library, rig, script_path) — prevents Windows backslash escape issues
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

### Key Implementation Notes
- **Must use `<script type="module">`** to import shared modules
- Mode 2 (Constant Rate): `gain` fixed at 0, `frame_rate` editable
- Mode 4 (Closed-Loop): `frame_rate` fixed at 0, `gain` editable
- `handleTrackClick` calls `switchEditorTab('commands')` then `renderEditor()` — always shows Commands tab on block click
- `computeLaneData()`: trialParams fires controller autonomously (doesn't advance clock), wait advances clock, plugin commands are instantaneous
- **Phase initialization must deep-clone**: `{ include: false, commands: JSON.parse(JSON.stringify(DEFAULT_PHASE.commands)) }` — shallow spread shares the commands array reference
- Plugin config uses `setPluginConfig()` helper that deletes empty values and removes config object when empty

### Related Files
- `experiment_designer.html` — Main tool (v0.8)
- `experiment_designer_quickstart.html` — Step-by-step guide (v0.8)
- `js/protocol-yaml.js` — Shared YAML parser/generator (added `yamlPath`)
- `js/plugin-registry.js` — Plugin definitions + command schemas (updated defaults)
- `tests/test-protocol-roundtrip.js` — 130 CI checks (9 suites, v1+v2)
- `tests/generate-roundtrip-protocol.js` — YAML + manifest generator for MATLAB
- `tests/fixtures/v2_*.yaml` — V2 YAML test fixtures from maDisplayTools
- `docs/experiment-designer-v06-testing.md` — Manual testing checklist
- `docs/protocol-roundtrip-testing.md` — Roundtrip testing architecture
- GitHub Issues: [#33](https://github.com/reiserlab/webDisplayTools/issues/33), [#53](https://github.com/reiserlab/webDisplayTools/issues/53) (hover tooltips), [#54](https://github.com/reiserlab/webDisplayTools/issues/54) (undo/redo)

### Testing & Validation (v0.8)

**Automated:** `node tests/test-protocol-roundtrip.js` — 130 checks across 9 suites (v1+v2 parse/generate roundtrips). Run after any change to `protocol-yaml.js` or the data model.

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
