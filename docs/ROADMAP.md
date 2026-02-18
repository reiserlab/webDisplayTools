# webDisplayTools Roadmap

## Pattern Editor

### v1.0 Milestone (Pending Hardware Validation)
Once all features are tested and confirmed on lab hardware:
- Bump version to **Pattern Editor v1.0**
- Remove the orange "in progress" development banner
- Update index page card if needed

### Current: v0.9.31 (2026-02-18)
All major features implemented:
- Grid/Edit mode with pixel-level editing
- 3D viewer with full view controls (10 presets, FOV, zoom, screenshot, stats)
- Mercator projection viewer tab with pan/zoom, gridlines, panel boundaries
- Mollweide projection viewer tab with eye FOV overlay
- Pattern generation (square/sine gratings, spherical patterns)
- Tabbed clipboard (frames and patterns)
- Frame animation mode with vertical filmstrip sequence builder
- Pattern combiner (A op B) with animated thumbnail previews on hover
- .pat file load/save (G4, G4.1, G6 with Header V1 and V2)

### Known Issues
- ~~#28: All 5 items addressed and closed (Feb 11)~~

### Future Enhancements
- **True fisheye shader** (#9) — barrel distortion for fly eye simulation
- ~~**Mercator projection** viewer tab~~ (done v0.9.31)
- ~~**Mollweide projection** viewer tab~~ (done v0.9.31)
- **Image tab** — import images as patterns

---

## Standalone 3D Viewer (`arena_3d_viewer.html`)

### Open Items
- Frank's feedback (#5): include MATLAB design_arena.m script, clarify G4 LED shape
- True fisheye shader (#9) — shared with Pattern Editor

---

## Infrastructure

### Open PRs
- **PR #31** — maDisplayTools fallback download (needs rebase)
- **PR #32** — Prettier formatter run (ready to merge after coordination)

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-18 | PE v0.9.31 | Mercator and Mollweide projection viewer tabs; white labels/axes; full-sphere default FOV; eye FOV overlay on Mollweide (#44) |
| 2026-02-13 | PE v0.9.29 | Relocated LOAD/NEW buttons to viewer toolbar; 3-tier button visual hierarchy (primary/secondary/status); LOAD button widened for discoverability |
| 2026-02-11 | PE v0.9.26 | Expanded hover animation to full row in combiner and clipboard; vertical filmstrip for sequence builder; animated combiner thumbnails; closed #28 and #29 |
| 2026-02-11 | PE v0.9.24 | 3D viewer controls: 10 view presets, FOV slider, zoom, screenshot, arena stats (#29) |
| 2026-02-10 | PE v0.9.23 | Roundtrip pattern generator for MATLAB validation |
| 2026-02-09 | PE v0.9.22 | Preview mode, V2-aware arena dropdown sync |
| 2026-02-08 | PE v0.9.21 | Header V2 support for G4/G4.1 and G6 pattern files |
