# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Planned
- Arena Layout Editor implementation
- G4.1 Pattern Editor implementation
- G6 Pattern Editor (multi-panel) implementation
- Experiment Designer implementation

## [1.0.0] - 2025-01-16

### Added
- Initial public release of webDisplayTools
- Landing page (`index.html`) with modern dark theme interface
- G6 Panel Pattern Editor (`g6_panel_editor.html`) - fully functional
  - 20×20 pixel pattern editing
  - Multiple modes: GS2, GS16, 4-Char, LED Map Reference
  - Real-time preview and pattern export
  - Version 6 (migrated from previous standalone version)
- Coming soon placeholder pages for all planned tools:
  - Arena Layout Editor (`arena_editor.html`)
  - G4.1 Pattern Editor (`g41_pattern_editor.html`)
  - G6 Pattern Editor (`g6_pattern_editor.html`)
  - Experiment Designer (`experiment_designer.html`)
- Comprehensive README.md with usage instructions
- `.claude.md` for AI assistant context

### Design System
- Dark theme with green accents (#00e676)
- JetBrains Mono and IBM Plex Mono fonts
- Consistent styling across all pages
- Responsive card-based layout
- Hover effects and smooth transitions

### Technical Decisions
- **Repository Separation**: Split from private `maDisplayTools` to enable public GitHub Pages hosting
- **Flat Structure**: All HTML files in root directory for simplicity
- **Single-Page Apps**: Each tool is self-contained in one HTML file
- **Client-Side Only**: No server required, works offline after initial load
- **Vanilla JavaScript**: No build process or frameworks
- **GitHub Pages**: Automatic deployment from main branch

### Infrastructure
- GitHub Pages enabled at https://reiserlab.github.io/webDisplayTools/
- Public repository at https://github.com/reiserlab/webDisplayTools
- Reiser Lab branding and links added to all pages

---

## Notes on Versioning

This project follows [Semantic Versioning](https://semver.org/):
- MAJOR version for incompatible API changes
- MINOR version for backwards-compatible functionality additions
- PATCH version for backwards-compatible bug fixes

For web tools that export files, version compatibility with MATLAB tools in the maDisplayTools repository is critical.
