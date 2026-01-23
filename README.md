# webDisplayTools - PanelDisplayTools

Web-based tools for configuring and editing display patterns for modular arena systems.

**Live Demo**: https://reiserlab.github.io/webDisplayTools/

## Quick Start

Open `index.html` in your web browser to access all tools, or visit the live demo above.

## Tools

### G6 Panel Pattern Editor ✅ Ready
Create and edit 20×20 pixel patterns for G6 panels with:
- Real-time preview
- Draw and erase modes
- Multiple modes: GS2, GS16, 4-Char, LED Map Reference
- Pattern export capabilities
- Modern dark theme UI
- Version 6 (last updated 2026-01-12)

**[Launch G6 Panel Editor →](https://reiserlab.github.io/webDisplayTools/g6_panel_editor.html)**

### Arena Layout Editor ✅ Ready
Configure arena geometry and panel layout for G3-G6 display systems with:
- SVG-based visualization with labeled dimensions
- Support for all panel generations (G3, G4, G4.1, G6, Custom)
- Click-to-toggle panels for partial arena designs
- Angle offset control for arena rotation
- Export PDF for documentation
- Export JSON with geometry and pin coordinates
- CI/CD validation against MATLAB reference
- v2 (2026-01-16)

**[Launch Arena Layout Editor →](https://reiserlab.github.io/webDisplayTools/arena_editor.html)**

### Arena 3D Viewer ✅ Ready
Interactive 3D visualization of arena configurations with:
- Three.js-based 3D rendering with orbit controls
- Accurate LED visualization (rotated rectangles for G4.1/G6, circles for G3/G4)
- Pattern visualization: All On, Grating (square wave), Sine wave
- Animated pattern rotation with efficient color-only updates
- Standard view presets (top-down, cardinal directions, fly view from center)
- Zoom controls and screenshot export with descriptive filenames
- Linked from Arena Layout Editor with configuration pass-through
- v3 (2026-01-17)

**[Launch Arena 3D Viewer →](https://reiserlab.github.io/webDisplayTools/arena_3d_viewer.html)**

### G4.1 Pattern Editor 🚧 Coming Soon
Design patterns for G4.1 display systems with support for multiple panel configurations.

### G6 Pattern Editor 🚧 Coming Soon
Advanced pattern editor for G6 display systems with multi-panel support and animation tools.

### Experiment Designer 🚧 Coming Soon
Design and configure experiments with visual stimuli sequences and parameter management.

## Design System

All tools use a consistent dark theme design:
- **Background**: `#0f1419`
- **Surface**: `#1a1f26`
- **Border**: `#2d3640`
- **Text**: `#e6edf3`
- **Accent**: `#00e676` (green)
- **Fonts**: JetBrains Mono (headings), IBM Plex Mono (body)

## Development Notes

- All web tools are standalone single-page HTML files (no build process required)
- Vanilla JavaScript is preferred for simplicity
- Web outputs must match MATLAB outputs exactly
- Keep dependencies minimal or use CDN links
- Consistent dark theme across all tools
- Mobile-responsive design

## Local Development

All tools can be tested locally by opening the HTML files directly in a web browser. No server setup is required for basic functionality.

## Repository Structure

```
webDisplayTools/
├── index.html                # Main landing page
├── g6_panel_editor.html      # G6 Panel Pattern Editor (ready)
├── arena_editor.html         # Arena Layout Editor (ready)
├── arena_3d_viewer.html      # Arena 3D Viewer (ready)
├── g41_pattern_editor.html   # G4.1 pattern editor (placeholder)
├── g6_pattern_editor.html    # G6 pattern editor (placeholder)
├── experiment_designer.html  # Experiment Designer (placeholder)
├── js/                       # Shared JavaScript modules
│   └── arena-calculations.js # Arena geometry calculations
├── data/                     # Reference data
│   └── reference_data.json   # MATLAB-generated validation data
├── tests/                    # Validation tests
│   └── validate-arena-calculations.js
└── .github/workflows/        # CI/CD workflows
    └── validate-calculations.yml
```

## CI/CD Validation

Web tools are validated against MATLAB reference implementations:

1. MATLAB generates reference data (e.g., `generate_web_reference_data.m`)
2. Reference JSON is copied to `data/` directory
3. GitHub Actions runs validation tests on push/PR
4. Tests compare JavaScript calculations against MATLAB with tolerance of 0.0001

Run tests locally: `npm test`

## About

Part of the Reiser Lab display tools ecosystem.

- **Main Repository**: [maDisplayTools](https://github.com/reiserlab/maDisplayTools) (MATLAB tools - private)
- **Web Tools**: [webDisplayTools](https://github.com/reiserlab/webDisplayTools) (This repository - public)

---

**Reiser Lab** | [GitHub](https://github.com/reiserlab)
