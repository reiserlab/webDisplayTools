# Claude Code Guidelines for webDisplayTools

## Versioning

Use simple two-digit versions for all web tools (e.g., `v1`, `v2`, `v6`). No semantic versioning (1.0.0) needed.

Format in footer: `Tool Name vX | YYYY-MM-DD`

Example: `Arena Editor v2 | 2026-01-16`

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

## Architecture

- All web tools are standalone single-page HTML files
- No build process required
- Vanilla JavaScript preferred
- Dependencies via CDN only (Three.js, etc.)
- Web outputs must match MATLAB outputs exactly

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
- `js/pat-parser.js` - Pattern file parser module
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

## Pattern Editor Migration Plan

The Pattern Editor is being developed in phases. The full migration plan is saved at:

**Plan file:** `~/.claude/plans/linear-fluttering-lerdorf.md`

This plan covers:
- Two-pane layout (tools left, viewer right)
- Tool tabs: Generate, Frame to Pattern, Combine
- Viewer tabs: Grid/Edit, 3D, Mercator, Mollweide
- Frame clipboard for capturing and sequencing frames
- 7 implementation phases over ~6-7 weeks

**Current status:** Streams A-H complete. All major features implemented: Grid/Edit mode, 3D viewer, pattern generation, frame clipboard, sequence builder, pattern combiner. Pending: MATLAB reference validation, manual testing, polish.

**GitHub Issue:** [#6 - additional web tools for making patterns](https://github.com/reiserlab/webDisplayTools/issues/6)

## Planning Best Practices

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
