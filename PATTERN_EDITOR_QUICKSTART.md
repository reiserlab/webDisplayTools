# Pattern Editor Quick Start

**Based on Pattern Editor v0.9.21**

The Pattern Editor is a web-based tool for creating and editing arena display patterns. This guide covers all controls and common workflows.

**[Launch Pattern Editor](https://reiserlab.github.io/webDisplayTools/pattern_editor.html)**

> **Found a bug?** [Report it](https://github.com/reiserlab/webDisplayTools/issues/new?assignees=reiserm&labels=bug&title=%5BBug%5D+Pattern+Editor:+) | **Have an idea?** [Request a feature](https://github.com/reiserlab/webDisplayTools/issues/new?assignees=reiserm&labels=enhancement&title=%5BFeature%5D+Pattern+Editor:+)

---

## Interface Overview

![Pattern Editor Overview](docs/images/pe-overview.png)

The interface has two main areas:
- **Left Panel (Tools)** - Pattern generation and manipulation controls
- **Right Panel (Viewer)** - Pattern visualization and playback

---

## Tool Tabs (Left Panel)

### GENERATE Tab

Create patterns mathematically using spherical coordinate transformations.

#### Pattern Type

| Type | Description |
|------|-------------|
| **Square Grating** | Sharp on/off stripes with configurable duty cycle |
| **Sine Grating** | Smooth sinusoidal intensity variation |
| **Starfield** | Random dot field for optic flow experiments |
| **Edge** | Single edge that sweeps across duty cycle range |
| **Off/On** | Static all-off or all-on single frame |

#### Spherical Parameters

These controls define how the pattern wraps around the cylindrical arena:

| Control | Description |
|---------|-------------|
| **Motion Type** | `Rotation` (horizontal stripes), `Expansion` (concentric rings), `Translation` (linear motion) |
| **Pole Az/El** | Azimuth (-180 to +180) and Elevation (-90 to +90) of the pattern pole. Default: Az=0, El=-90 (standard rotation) |
| **Arena Model** | `Smooth` (continuous cylinder) or `Poly` (discrete panel facets) |
| **Anti-alias** | `None`, `Low (5)`, or `Std (15)` samples per pixel |

#### Parameters

| Control | Description |
|---------|-------------|
| **Spatial Frequency** | Wavelength in pixels or degrees (auto-converts) |
| **Duty (%)** | Grating on-fraction (1-99%, default 50%) |
| **Phase (%)** | Initial phase offset (0-100%) |
| **Step Size** | Pixels or degrees per frame for animation |
| **Frames** | Total frame count (shown in green as calculated value) |

#### Output

| Control | Description |
|---------|-------------|
| **Mode** | `GS16` (16 grayscale levels 0-15) or `GS2` (binary 0/1) |
| **High/Low** | Brightness values for on/off states (0-15) |

---

### ANIMATE Tab

Build multi-frame patterns from captured frames.

![Animate Tab - Frame Shifting](docs/images/pe-animate-shifting.png)

#### Frame Shifting Mode

Creates animation by shifting a single captured frame:

| Control | Description |
|---------|-------------|
| **Source Frame** | Double-click a frame in the clipboard to load it here |
| **Direction** | `H CW` (horizontal clockwise), `H CCW`, `V Up`, `V Down` |
| **Step (px)** | Pixels to shift per frame (1-20) |
| **Frames** | Total frames to generate |

#### Frame Animation Mode

![Animate Tab - Frame Animation](docs/images/pe-animate-sequence.png)

Build sequences from multiple clipboard frames:

| Control | Description |
|---------|-------------|
| **Sequence Builder** | Drag-and-drop area showing frames in order |
| **+ Add All Frames** | Adds all clipboard frames to sequence |
| **Clear Sequence** | Removes all frames from sequence |

---

### COMBINE Tab

Merge two patterns together using various blend modes.

![Combine Tab](docs/images/pe-combine.png)

| Control | Description |
|---------|-------------|
| **Pattern A/B** | Load patterns from viewer or .pat files |
| **Use Current as A/B** | Captures the currently displayed pattern |
| **Load A.../B...** | Opens file picker for .pat files |
| **Swap A/B** | Exchanges patterns A and B |

#### Combination Modes

| Mode | Description |
|------|-------------|
| **Sequential** | Concatenates A then B (A's frames followed by B's frames) |
| **Mask** | Shows B where A exceeds threshold (0-15) |
| **Blend** | Averages A and B pixel values (50/50) |
| **Horizontal Split** | Left portion from A, right from B |
| **Vertical Split** | Top portion from A, bottom from B |

For split modes, a slider controls the split position (0-100%).

---

### IMAGE Tab

Convert raster images to arena patterns.

![Image Tab](docs/images/pe-image.png)

| Control | Description |
|---------|-------------|
| **Load Image...** | Opens file picker for PNG/JPEG |
| **Preview** | Shows image with arena overlay; drag to pan |
| **Scale** | 10-500% zoom |
| **Rotation** | -180 to +180 degrees |
| **Fit** | Automatically fits arena to image bounds |
| **Mode** | `GS16` (0-255 mapped to 0-15) or `GS2` (threshold at 128) |
| **Invert** | Swaps light/dark values |

---

## Viewer Tabs (Right Panel)

### 2D Tab

Grid view showing pixel values with optional panel boundaries and numbers.

### Edit Tab

![Edit Mode](docs/images/pe-edit-mode.png)

Interactive pixel editing:

| Control | Description |
|---------|-------------|
| **Color Palette** | Click to select grayscale value (0-15) |
| **Flip H/V** | Mirror the pattern horizontally or vertically |
| **Invert** | Invert all pixel values |
| **Find/Replace** | Replace all pixels of one value with another |

Click on pixels in the viewer to paint with the selected color.

### 3D Tab

![3D View](docs/images/pe-3d-view.png)

Interactive Three.js visualization of the pattern on a cylindrical arena. Use mouse to orbit, zoom, and pan.

### Mercator / Mollweide

*Coming soon* - Map projections for spherical pattern visualization.

---

## Playback Controls

Located at the bottom of the viewer:

| Control | Description |
|---------|-------------|
| **⏮ ◀ ▶ ⏭** | First, previous, next, last frame |
| **Frame Counter** | Shows current frame / total frames |
| **Stretch** | Vertical display stretch factor (1-255) |
| **Play Button** | Start/stop animation playback |
| **FPS** | Playback speed (-30 to +30, negative = reverse) |

---

## Clipboard Bar

The clipboard stores captured frames and patterns for later use.

| Tab | Contents |
|-----|----------|
| **FRAMES** | Single frames for editing or animation building |
| **PATTERNS** | Complete multi-frame patterns for combining |

### Capture Buttons

| Button | Action |
|--------|--------|
| **↓ Frame** | Captures current frame to Frames clipboard |
| **↓ Pat** | Captures entire pattern to Patterns clipboard |

---

## File Operations

### Bottom-Left Buttons

| Button | Action |
|--------|--------|
| **Load** | Opens a .pat file |
| **Save** | Saves current pattern as .pat file |
| **New** | Creates a blank pattern |

### Status Bar

The bottom status bar shows:
- Pattern filename (click pencil to rename)
- Dimensions (width × height pixels)
- Frame count
- Grayscale mode (GS16/GS2)
- Unsaved indicator (red asterisk)

### Arena Selection

The arena dropdown (bottom-right) selects the target arena configuration:
- Grouped by generation (G3, G4, G4.1, G6)
- Lock button prevents accidental changes
- Changing arena clears the clipboard (with confirmation)

---

## Common Workflows

### 1. Generate a Rotating Grating

1. Select **GENERATE** tab
2. Set **Pattern Type** to "Square Grating"
3. Set **Motion Type** to "Rotation"
4. Adjust **Spatial Frequency** (e.g., 20 pixels)
5. Set **Duty** to 50%
6. Set **Step Size** to 1 pixel
7. Click the green **GENERATE** button
8. Use playback controls to preview animation
9. Click **Save** to export as .pat file

### 2. Edit Pixels Manually

1. Load or generate a pattern
2. Click the **Edit** viewer tab
3. Select a color from the palette (0-15)
4. Click pixels in the viewer to paint
5. Use **Flip H/V** or **Invert** for bulk transforms

### 3. Create Animation from Frames

1. Capture several frames to the clipboard:
   - Navigate to desired frame
   - Click **↓ Frame** to capture
   - Repeat for all frames
2. Switch to **ANIMATE** tab
3. Select **Frame Animation** mode
4. Click **+ Add All Frames** to build sequence
5. Click **GENERATE** to create pattern
6. **Save** the result

### 4. Combine Two Patterns

1. Generate or load first pattern
2. In **COMBINE** tab, click **Use Current as A**
3. Generate or load second pattern
4. Click **Use Current as B**
5. Select combination mode (Sequential, Mask, Blend, or Split)
6. Adjust mode-specific settings
7. Click **GENERATE** to create combined pattern

---

## Tips

- **Spatial frequency conversion**: The editor shows automatic pixel-to-degree conversion below the input
- **Frame count preview**: Shown in green next to Step Size based on your settings
- **Keyboard shortcuts**: Use arrow keys for frame navigation when viewer is focused
- **Arena lock**: Lock the arena dropdown to prevent accidental configuration changes
- **Clipboard persistence**: Clipboard contents are cleared when changing arena configuration

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| v0.9.21 | 2026-02-04 | Current version documented in this guide |

See the [Pattern Editor changelog](https://github.com/reiserlab/webDisplayTools/commits/main/pattern_editor.html) for detailed version history.

---

*Guide by Michael Reiser & Claude | [View on GitHub](https://github.com/reiserlab/webDisplayTools)*
