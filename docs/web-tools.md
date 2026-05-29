---
title: Web Tools
parent: Generation 6
has_children: true
nav_order: 11
---

# Web Tools

Browser-based tools for configuring, designing, and previewing display patterns for modular LED arena systems. All tools run as standalone HTML pages — no installation required.

**Live Demo**: <https://reiserlab.github.io/webDisplayTools/>

## Tools

### Pattern Editor

Full-arena pattern design with spherical coordinate transformations.

- Generate gratings, starfields, and edges with pole rotation
- Edit pixels directly in 2D or preview in 3D
- Animate patterns via frame shifting or sequence building
- Combine patterns with blend/mask/split modes
- Export to `.pat` format for MATLAB

[Launch Pattern Editor](https://reiserlab.github.io/webDisplayTools/pattern_editor.html) · [Quick Start Guide](../PATTERN_EDITOR_QUICKSTART.md)

### Arena Layout Editor

Configure arena geometry from standard configurations or create custom layouts.

- SVG-based 2D visualization
- 10 standard arena configurations (G3, G4, G4.1, G6)
- Click-to-toggle panels for partial arenas
- PDF and YAML export

[Launch Arena Layout Editor](https://reiserlab.github.io/webDisplayTools/arena_editor.html)

### Arena 3D Viewer

Interactive 3D visualization of cylindrical arenas.

- Three.js rendering with orbit controls
- Test pattern preview (all-on, grating, sine wave)
- Angular resolution analysis
- Screenshot export

[Launch Arena 3D Viewer](https://reiserlab.github.io/webDisplayTools/arena_3d_viewer.html)

### Pattern Icon Generator

Generate top-down cylindrical view icons from arena patterns.

- Single-frame and multi-frame motion-blur rendering
- Configurable perspective (inner radius 0.1–0.75)
- Multiple background options (dark, white, transparent)
- Supports full and partial arena configurations
- PNG export for documentation and UI thumbnails

[Launch Pattern Icon Generator](https://reiserlab.github.io/webDisplayTools/icon_generator.html)

### G6 Panel Patterns

Create and preview 20×20 pixel patterns for individual G6 panels.

- Real-time preview with draw/erase modes
- Multiple modes: GS2, GS16, 4-Char, LED Map Reference
- Pattern export capabilities

[Launch G6 Panel Patterns](https://reiserlab.github.io/webDisplayTools/g6_panel_editor.html)

### Experiment Designer

Design experiment protocols with stimulus sequences and trial parameters. YAML export for MATLAB execution.

[Launch Experiment Designer](https://reiserlab.github.io/webDisplayTools/experiment_designer.html) · [Quick Start Guide](experiment-designer-quickstart.md)

## Source

Source code and issue tracker: [reiserlab/webDisplayTools](https://github.com/reiserlab/webDisplayTools)
