# Pattern Designer — multi-color G6 panels (V1)

Linear: LAB-223 (epic) → LAB-228 (this V1) · LAB-229 (pattern-file color tag, deferred).
Hardware: `LED-Display_G6_Hardware_Panel` (`docs/Four-color and Red+IR panel decisions.md`),
mapping spec `Modular-LED-Display/docs/development/g6_02-led-mapping.md` (color-banks section).

## What a color panel is

The standard G6 20×20 board has four independently current-limited LED banks, `T0`–`T3`. A
color panel is that board with each bank populated with a different LED. The panel firmware
(`layout.cpp`, `NUM_COLOR = 4`) lays the banks out as a repeating 2×2 mosaic. In **host
coordinates** — the ones every `.pat` frame, the grid editor and the viewers use; row 0 = bottom,
col 0 = left:

```
bank(row, col) = 2·(row % 2) + (col % 2)
    T0 even row / even col     T1 even / odd     T2 odd / even     T3 odd / odd
```

| Layout key (`js/panel-color.js`) | T0 | T1 | T2 | T3 | Boards |
|---|---|---|---|---|---|
| `g6-green` (default, mono) | green | green | green | green | every panel before 2026-08 |
| `four-color` | violet 405 | blue 470 | green 525 | yellow-orange 590 | four-color v0.4 (15 pilot panels) |
| `red-ir-v0.4r2` | red 630 | IR 850 | IR 850 | red 630 | red + IR checkerboard (HW PR #1) |
| `red-ir-v0.4r1` | red | IR | red | IR | red + IR pilot boards (vertical stripes) |

Bank→color is a BOM-only property of the board variant; the firmware and the frame format do
not know or care. Consequences that everything in the Designer relies on:

- **No `.pat` format change, no new generation, no new arena config.** A color pattern is an
  ordinary GS2/GS16 frame; the color of a pixel is fixed by its position. Color is a *panel*
  property, orthogonal to `generation` and to the arena config — so none of the `=== 'G6'`
  checks, `PANEL_SPECS`, or the generated `js/arena-configs.js` are touched.
- **A pure single color lights only 100 of the 400 LEDs per panel** (a 10×10 lattice at 2-px
  pitch). The renderers show exactly that; a 1-px bar in a pure color blinks as it moves, as it
  would on the hardware.
- **The `.pat` carries no color tag** (header is full). The Designer appends `_4c` / `_rir` to
  generated filenames; the proper tag (MANIFEST + repo metadata) is LAB-229.

## The one bench-decided constant: `ROW_PARITY_FLIP`

`js/pat-encoder.js` packs panel rows as `19 − row`. 19 is odd, so host-row parity and wire-row
parity are opposite. Spec and firmware say host row 0 = bottom = `T0`/`T1` (flip 0), but the
first bench check with a real color panel is what settles it. Recipe: light only bank-0 host
pixels (e.g. Generate → `four-color` → ON color "violet" → any pattern) and show it from the
Studio Console. Violet (or red on red+IR v0.4r2) → correct. The other row parity lights → set
`ROW_PARITY_FLIP = 1` in `js/panel-color.js` and update the one test vector in
`tests/test-panel-color.js`. Nothing else changes.

## How the Designer uses it (`js/panel-color.js` is the only place color logic lives)

- **Panel LEDs selector** (status bar, next to Arena; `?panel=<key>` in the URL, omitted for the
  default). Not part of the arena lock. Changing it **re-renders only**: frames are never
  rewritten and the pattern is not dirtied ("values are per-LED; color is where the LED sits").
- **Rendering:** every pixel color goes through `PanelColor.pixelCss(key, row, col, b)` (2D grid,
  flat thumbnails, Mercator/Mollweide, icon thumbnails via `options.panelLayout`) or
  `PanelColor.pixelHex(...)` (3D viewer, `setPanelColor(key)`). The mono layout reproduces the
  legacy green-phosphor ramps **byte for byte** — `pixelCss` rounds like the 2D code did,
  `pixelHex` floors like the ThreeViewer did — so the default is pixel-identical to before.
  In the 3D viewer color belongs to the **physical LED** (panel row `py`, panel column with the
  CCW mirror, *without* the phase offset): the pattern slides under the fixed mosaic exactly as
  the hardware does. IR is drawn in a dim false color and the hint says so.
- **ON color** (Generate → Output, shown only for color layouts): chips *All* / one per channel /
  *Custom* (a 0–15 level per channel in GS16, on/off in GS2). Generators stay monochrome; one
  call at the end of `handleGenerate` masks every frame:
  `v ← min(maxVal, round(v · w[bank(row, col)]))` (`PanelColor.applyOnColor`). Weights are
  independent (they need not sum to 100 %); `lowLevel` is masked too. Image-converter and
  combiner outputs are **not** masked in V1.
- **Edit brushes** (color layouts only): *LED* = today's single-LED brush, value only; *2×2 cell*
  sets the four LEDs of the cell under the cursor to `value · w[bank]` (`PanelColor.paintCell`,
  replace semantics). Palette swatches show value, not color (a swatch has no position).
- The ES-module viewers read `globalThis.PanelColor` with a fallback, so `arena_replay_viewer.html`
  (which shares `three-viewer.js`) is unchanged.

## Deferred (see LAB-223 "Deferred")

Background/OFF color (a second weight vector), layers (Combine tool), per-color calibration
LUT (LAB-213), authoring at the reduced 10×10 grid, Studio Console thumbnails (`js/pat-preview.js`
needs the same Panel LEDs setting in the Studio), the pattern-file color tag (LAB-229).
