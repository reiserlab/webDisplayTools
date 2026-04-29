---
title: Web Tools
parent: Generation 6
has_children: true
nav_order: 11
---

# webDisplayTools - PanelDisplayTools

Web-based tools for configuring and editing display patterns for modular arena systems.

**Live Demo**: https://reiserlab.github.io/webDisplayTools/

## Quick Start

Open `index.html` in your web browser to access all tools, or visit the live demo above.

## Tools

### Pattern Editor ✅ Ready
Full-arena pattern design with spherical coordinate transformations:
- Generate gratings, starfields, edges with pole rotation
- Edit pixels directly in 2D or view in 3D
- Animate patterns via frame shifting or sequence building
- Combine patterns with blend/mask/split modes
- Export to .pat format for MATLAB

**[Launch Pattern Editor →](https://reiserlab.github.io/webDisplayTools/pattern_editor.html)** | **[Quick Start Guide](PATTERN_EDITOR_QUICKSTART.md)**

### Arena Layout ✅ Ready
Configure arena geometry from standard configs or create custom layouts:
- SVG-based 2D visualization
- 10 standard arena configurations (G3, G4, G4.1, G6)
- Click-to-toggle panels for partial arenas
- PDF and YAML export
- CI/CD validation against MATLAB

**[Launch Arena Layout →](https://reiserlab.github.io/webDisplayTools/arena_editor.html)**

### Arena 3D View ✅ Ready
Interactive 3D visualization of cylindrical arenas:
- Three.js rendering with orbit controls
- Test pattern preview (all-on, grating, sine)
- Angular resolution analysis
- Screenshot export

**[Launch Arena 3D View →](https://reiserlab.github.io/webDisplayTools/arena_3d_viewer.html)**

### Pattern Icon Generator ✅ Ready
Generate top-down cylindrical view icons from arena patterns:
- Single-frame and multi-frame motion blur rendering
- Configurable perspective (inner radius 0.1-0.75)
- Multiple background options (dark, white, transparent)
- Supports full and partial arena configurations
- PNG export for documentation and UI thumbnails

**[Launch Pattern Icon Generator →](https://reiserlab.github.io/webDisplayTools/icon_generator.html)**

### G6 Panel Patterns ✅ Ready
Create and preview 20×20 pixel patterns for individual G6 panels:
- Real-time preview with draw/erase modes
- Multiple modes: GS2, GS16, 4-Char, LED Map Reference
- Pattern export capabilities
- CI/CD validated against MATLAB

**[Launch G6 Panel Patterns →](https://reiserlab.github.io/webDisplayTools/g6_panel_editor.html)**

### Experiment Designer 🚧 Coming Soon
Design experiment protocols with stimulus sequences and trial parameters. YAML export for MATLAB execution.

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

For running tests or code formatting, first install dependencies:

```bash
npm install
```

Then you can use:

```bash
npm test              # Run validation tests
npm run format        # Format all JS files with Prettier
npm run format:check  # Check formatting without changes
```

## Repository Structure

```
webDisplayTools/
├── index.html                    # Main landing page
├── pattern_editor.html           # Pattern Editor (ready)
├── arena_editor.html             # Arena Layout Editor (ready)
├── arena_3d_viewer.html          # Arena 3D Viewer (ready)
├── icon_generator.html           # Pattern Icon Generator (ready)
├── g6_panel_editor.html          # G6 Panel Editor (ready)
├── experiment_designer.html      # Experiment Designer (placeholder)
├── PATTERN_EDITOR_QUICKSTART.md  # Pattern Editor guide
├── js/                           # Shared JavaScript modules
│   ├── arena-calculations.js     # Arena geometry calculations
│   ├── arena-configs.js          # Standard arena configurations
│   ├── arena-geometry.js         # Arena geometry helpers
│   ├── pat-parser.js             # .pat file parser
│   ├── pat-encoder.js            # .pat file encoder
│   ├── icon-generator.js         # Icon generation module
│   └── g6-encoding.js            # G6 panel encoding
├── docs/                         # Documentation assets
│   └── images/                   # Screenshots for guides
├── data/                         # Reference data
│   └── reference_data.json       # MATLAB validation data
├── tests/                        # Validation tests
└── .github/workflows/            # CI/CD workflows
```

## CI/CD Validation

Web tools are validated against MATLAB reference implementations:

1. MATLAB generates reference data (e.g., `generate_web_reference_data.m`)
2. Reference JSON is copied to `data/` directory
3. GitHub Actions runs validation tests on push/PR
4. Tests compare JavaScript calculations against MATLAB with tolerance of 0.0001

Run tests locally: `npm test`

## Supported Panel Generations

| Generation | Status | Notes |
|------------|--------|-------|
| **G6** | ✅ Actively tested | Current generation, 20×20 pixels, 0402 SMD LEDs |
| **G4.1** | ✅ Actively tested | Production systems, 16×16 pixels, 0603 SMD LEDs |
| **G4** | 📋 Comparison only | Legacy systems, included for reference |
| **G3** | 📋 Comparison only | Legacy systems, included for reference |

> **Note**: G3 and G4 configurations are included for comparison and backward compatibility, but are not actively tested or validated. For new installations, use G4.1 or G6 panels.

## About

Part of the Reiser Lab display tools ecosystem.

- **Main Repository**: [maDisplayTools](https://github.com/reiserlab/maDisplayTools) (MATLAB tools - private)
- **Web Tools**: [webDisplayTools](https://github.com/reiserlab/webDisplayTools) (This repository - public)

---

**Reiser Lab** | [GitHub](https://github.com/reiserlab)
