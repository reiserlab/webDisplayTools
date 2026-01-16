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
- Version 6 (last updated 2025-01-12)

**[Launch G6 Panel Editor →](https://reiserlab.github.io/webDisplayTools/g6_panel_editor.html)**

### Arena Layout Editor 🚧 Coming Soon
Configure arena geometry, panel layout, and display parameters. Export configuration files for MATLAB.

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
├── g6_panel_editor.html      # G6 Panel Pattern Editor
├── experiment_designer.html  # Experiment Designer (placeholder)
├── arena_editor.html         # Arena layout configurator (placeholder)
├── g41_pattern_editor.html   # G4.1 pattern editor (placeholder)
└── g6_pattern_editor.html    # G6 pattern editor (placeholder)
```

## About

Part of the Reiser Lab display tools ecosystem.

- **Main Repository**: [maDisplayTools](https://github.com/reiserlab/maDisplayTools) (MATLAB tools - private)
- **Web Tools**: [webDisplayTools](https://github.com/reiserlab/webDisplayTools) (This repository - public)

---

**Reiser Lab** | [GitHub](https://github.com/reiserlab)
