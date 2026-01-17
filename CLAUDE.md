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
- G5: 40mm width, 20x20 pixels (rotated rectangle LEDs)
- G6: 45.4mm width, 20x20 pixels (rotated rectangle LEDs)

Arena radius formula: `cRadius = panelWidth / (tan(alpha/2)) / 2` where `alpha = 2*PI/numPanels`

### LED Specifications
- G4.1, G5, G6 use 0604 LED package: 0.6mm × 0.4mm = 1.5:1 aspect ratio
- LEDs are rectangles rotated 45° on the panel (not diamonds)
- G3, G4 use circular LED visualization

## Arena 3D Viewer (`arena_3d_viewer.html`)

### Key Implementation Details
- Uses Three.js r128 with OrbitControls
- Renderer requires `preserveDrawingBuffer: true` for screenshot functionality
- LED meshes stored in `ledMeshes[]` array for efficient animation (color-only updates)
- Pattern rotation uses `state.phaseOffset` to shift pattern, not world rotation
- Controls disabled during auto-rotate for performance

### State Object
```javascript
state = {
    panelType: 'G6',      // G3, G4, G4.1, G5, G6
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
- `gen`: Panel generation (G3, G4, G4.1, G5, G6) - defaults to G6
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
The "Load Pattern (Coming Soon)" button is a placeholder for future functionality to load custom patterns from files or the pattern editor.
