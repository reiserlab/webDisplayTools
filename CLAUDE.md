# Claude Code Guidelines for webDisplayTools

## Versioning

Use simple two-digit versions for all web tools (e.g., `v1`, `v2`, `v6`). No semantic versioning (1.0.0) needed.

Format in footer: `Tool Name vX | YYYY-MM-DD HH:MM ET`

Example: `Arena Editor v2 | 2026-01-16 14:30 ET`

**IMPORTANT**: Always include timestamp in Eastern Time (ET) to distinguish multiple updates per day. Update the timestamp whenever the page is modified.

**To get current time**: Run `date "+%Y-%m-%d %H:%M ET"` in Bash to get the actual current time. Never guess or make up timestamps.

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
**Status:** Broken for partial arenas as of 2026-02-02

The icon generator has issues with partial arenas (arenas where not all columns are installed):
- Full arenas (e.g., G6_2x10 with all 10 columns) render correctly
- Partial arenas (e.g., G6_2x12 with 8 of 12 columns) produce scrambled patterns
- Folder detection (inferring arena from folder name) doesn't work for partial arenas
- Manual arena selection dropdown does appear as fallback

**Known issues:**
1. Pattern data is scrambled when rendered for partial arenas
2. Arena detection regex may not handle partial arena folder naming conventions
3. The mapping between pattern pixel coordinates and physical arena positions needs review

**To investigate:**
1. Compare MATLAB's icon generation algorithm
2. Verify column_installed handling for partial arenas
3. Check if column ordering (CW/CCW) affects the mapping
4. Debug folder name detection for partial arena patterns

### Spherical Pattern Generation - Pole Position Bug
**Status:** Known issue as of 2026-02-02

Pattern generation with non-default pole positions produces incorrect results:

**Problem:**
- For a rotation pattern with north pole [0,0], horizontal bands are expected
- After rotation transform, phi (azimuthal angle) should be constant along each horizontal row
- Current implementation: phi varies along rows AND columns after rotation

**Root Cause:**
The rotation transformation in `arena-geometry.js` doesn't achieve the desired coordinate mapping. After pitch rotation by -π/2:
- Original Z (height) transforms into Y, but...
- `cart2sphere` computes `phi = atan2(x, y)`, which still depends on both x and the transformed z
- For horizontal bands, we need phi to depend ONLY on original height (z)

**To fix:**
1. Review MATLAB's `make_grating_edge.m` implementation closely
2. Verify the coordinate convention (which axis is "up", which is "forward")
3. May need different rotation order or additional transformation
4. Consider if `cart2sphere` convention differs from MATLAB's `cart2sph`

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
