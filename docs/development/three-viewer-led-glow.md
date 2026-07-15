# Shared ThreeViewer LED glow

**Status:** implemented and benchmarked in the shared ThreeViewer.

## Visual goal

Make an illuminated panel LED read as a small physical emitter instead of a
perfect, hard-edged pixel. The package is 14% larger than its measured display
size and receives a restrained green halo. The effect should remain legible at
normal arena-view distances without turning neighboring LEDs into a continuous
glowing sheet.

This is deliberately **not** bloom, atmospheric scattering, a point light per
LED, surface illumination, or a photometric model of the hardware. It does not
soften transitions over time or change pattern brightness values. Those choices
would either change experiment semantics or make large arenas unnecessarily
expensive to render.

## Scope and consumers

The implementation lives in
`js/pattern-editor/viewers/three-viewer.js`. That module is shared by:

- the Pattern Designer 3D view (`pattern_editor.html`); and
- Arena Studio replay (`js/arena-replay-viewer.js`).

Both consumers therefore receive the same emitter shape, brightness mapping,
and performance behavior. `arena_3d_viewer.html` has a separate, older renderer
and is **not** changed automatically; treat it as a future migration target and
follow the reuse checklist below.

### CSHL preview-only physical gap

The full G6_2x10 CSHL rig is physically missing rear panels 8 and 18. G6 numbers
panels row-major and one-based, so these are the lower and upper panels of
zero-based column 7. The shared ThreeViewer omits that entire column from the
Pattern Designer and replay render even though the rig registry still describes
the full arena.

This is presentation-only. The arena config remains 10 columns / 20 panels, PAT
data remains 200 x 40 / 8,000 addresses, and LEDs after the gap retain their
original global column indices. Configured statistics therefore still report
8,000 addressable LEDs, while `getRenderStats().ledCount` and the glow buffer
contain 7,200 physical preview emitters. The hard-coded omission is restricted
to a full G6 2x10 arena; partial G6_2x8of10 and all other shapes are unchanged.

### CSHL replay camera alignment

Course calibration places column 3 directly in front of the fly and column 8
directly behind it. In the shared G6_2x10 geometry those directions are `-X`
and `+X`, respectively. The replay popup therefore maps **Rear** to the
`from-east` external preset so the camera looks inward through the column-8
gap. **Fly Eye** starts from `fly-west`, then raises the camera and target to
1 mm above the top of the 9 mm ball so the view faces column 3 without putting
the camera inside the ball.

The replay **Width** control is a horizontal viewing angle with compact options
from 60 to 150 degrees. Three.js stores vertical FOV, so the replay converts
the selected horizontal width using the live camera aspect ratio and reapplies
it after window resizing. This keeps 120, 135, and 150 degree fly views
meaningful even when the popup is resized.

## Rendering architecture

The existing LED meshes remain the crisp physical cores. Their geometry is
scaled by `LED_CORE_SCALE = 1.14`, which is enough to improve visibility without
changing panel pitch or LED placement.

All halos are one `THREE.Points` object:

1. A single `BufferGeometry` holds one point at each LED position. Positions
   are calculated after column transforms and converted back into arena-local
   coordinates, with a small outward surface offset.
2. One 64 x 64 `CanvasTexture` supplies a white radial alpha falloff. It is
   tinted per LED through one dynamic vertex-color buffer.
3. One additive, depth-tested `PointsMaterial` draws the entire lit arena. The
   point cloud is hidden when every LED is off, so a dark frame costs no extra
   draw call.
4. Frame updates modify the core material colors and the point cloud's color
   buffer. They do not allocate sprites, lights, materials, or textures.

This makes the cost approximately one transparent draw call for a lit arena,
not one draw call per LED. That distinction matters for G6_2x10, which has an
8,000-address grid and 7,200 rendered CSHL emitters, and for larger arenas.

### Tunable constants

| Constant | Current value | Purpose |
|---|---:|---|
| `LED_CORE_SCALE` | `1.14` | Slightly enlarges the solid LED package |
| `LED_HALO_DIAMETER_SCALE` | `2.0` | Halo diameter relative to the package's largest dimension |
| `LED_HALO_OPACITY` | `0.34` | Keeps the additive glow visible but restrained |
| `LED_HALO_TEXTURE_SIZE` | `64` | Radial texture resolution; shared by every LED |
| `LED_HALO_SURFACE_OFFSET` | `0.004` | Moves the halo just forward of the package to avoid z-fighting |

Tune the scale and opacity together and in small increments. Increasing halo
diameter without lowering opacity quickly makes dense patterns look like solid
green panels. Do not replace the shared point cloud with per-LED sprites or
lights merely to make the effect stronger.

## Brightness semantics

Glow brightness follows the exact value already used for the LED core:

- **Off:** value 0 produces a black core and zero vertex color. If all values
  are zero, the point cloud is not rendered.
- **GS2:** value 0 is fully off and value 1 is fully on. There is no threshold,
  interpolation, or fade between frames.
- **GS16:** values 0 through 15 map linearly to 0 through 1. The halo retains the
  same relative green-phosphor mix as the core (`0.6 R, 1.0 G, 0.2 B`), so dim
  levels remain dim instead of being promoted to a binary glow.
- **No pattern loaded:** the viewer's existing full-brightness preview behavior
  is preserved.

The glow therefore changes presentation only. It does not change pattern data,
frame selection, grayscale mode, timing, or replay synchronization.

## Lifecycle and cleanup

The point geometry, material, and canvas texture are created once per arena
build. `_buildArena()` disposes the previous layer before rebuilding panel
geometry, and `destroy()` disposes it before releasing the renderer. Any future
implementation must preserve all three disposal steps: texture, material, and
geometry. Failing to dispose the texture is easy to miss during one load but
leaks GPU resources across repeated arena changes.

`setLedGlowEnabled(false)` is a comparison and benchmark switch, not a separate
user preference. Core LEDs remain visible when it is disabled.

## Local benchmark

Use `tests/benchmark-three-viewer-led-glow.html` through an HTTP server, never as
a `file://` URL. The default `?mode=compare` runs hard/glow/glow/hard (ABBA) in
one viewer, reducing page-load and GPU warm-up bias. The fixture uses a fixed
960 x 720 canvas, a 50% lit GS16 checkerboard, four warm-up renders per batch,
and 12 timed samples per path. Each sample calls `gl.finish()` so the recorded
duration includes submitted GPU work.

Example URLs:

```text
http://127.0.0.1:8000/tests/benchmark-three-viewer-led-glow.html?mode=compare
http://127.0.0.1:8000/tests/benchmark-three-viewer-led-glow.html?mode=compare&arena=G6_3x16_full
http://127.0.0.1:8000/tests/benchmark-three-viewer-led-glow.html?mode=glow&workload=off
http://127.0.0.1:8000/tests/benchmark-three-viewer-led-glow.html?mode=hard&workload=gap
```

The measurements below are local observations, not CI gates. Browser scheduling
and GPU state can add noise, especially to p95, so use identical viewport,
device-pixel ratio, arena, pattern, and browser conditions for both modes.

**Reference machine:** Apple M5 Max, Chrome 150, 960 x 720 canvas, DPR 2.
Measurements were taken on 2026-07-13.

### Standard CSHL G6_2x10 preview (8,000 addresses / 7,200 emitters)

ABBA values below are the mean of the two batch medians or p95 values for each
mode from the current panels 8/18 rear physical-gap preview.

| Timed path | Hard | Glow | Change | Acceptance limit |
|---|---:|---:|---:|---:|
| Render median | 50.8 ms | 50.8 ms | +0.1% | 58.4 ms |
| Render p95 | 53.5 ms | 54.3 ms | +1.6% | 66.8 ms |
| Update + render median | 50.2 ms | 50.3 ms | +0.2% | 57.7 ms |
| Update + render p95 | 54.0 ms | 54.3 ms | +0.6% | 67.5 ms |

The acceptance formula is median <= max(1.15x hard, hard + 2 ms) and p95 <=
max(1.25x hard, hard + 4 ms). Every measured path passed.

| Renderer counter, lit checkerboard | Hard | Glow | Change |
|---|---:|---:|---:|
| Draw calls | 14,446 | 14,447 | +1 |
| Points | 0 | 7,200 | +7,200 in one batch |
| Triangles | 14,508 | 14,508 | 0 |
| Geometries | 14,447 | 14,447 | 0 (layer already allocated) |
| Textures | 1 | 1 | 0 (texture already allocated) |

With an all-off workload, the point cloud hid itself as designed: 14,446 draw
calls and 0 submitted points, identical to hard mode.

The `workload=gap` mapping check lights only logical rear column 8 in frame 0 and
only adjacent column 9 in frame 1. The current result is 0 rendered lit meshes
and no glow for frame 0, then exactly 800 lit meshes and visible glow for frame
1. This proves the physical gap does not collapse or reindex later PAT columns.

### Worst-case G6_3x16_full (19,200 LEDs)

| Timed path | Updated hard | Glow | Change |
|---|---:|---:|---:|
| Render median | 79.6 ms | 82.1 ms | +3.1% |
| Render p95 | 100.7 ms | 107.0 ms | +6.3% |
| Update + render median | 83.6 ms | 83.9 ms | +0.3% |
| Update + render p95 | 90.5 ms | 87.5 ms | -3.3% |

The worst-case lit frame also added exactly one draw call (38,513 to 38,514),
submitted 19,200 points in that one batch, and added no triangles. This is well
inside the performance budget; the viewer's existing individual LED and outline
objects remain the dominant rendering cost.

A result fails review if it creates per-LED scene objects for the halo, changes
triangle count, adds more than one lit-frame draw call, adds a dark-frame draw
call, or exceeds either timing limit on a repeatable same-session comparison.

## Visual QA

Check both top-down and oblique views with GS2 and GS16 patterns:

- lit packages are slightly easier to see, with a soft edge rather than a large
  aura;
- off pixels remain truly dark, including next to bright pixels;
- GS16 levels remain visibly ordered and do not collapse to on/off;
- neighboring halos do not merge into a solid panel at the default camera;
- depth testing prevents front LEDs from shining through panel backs;
- frame stepping and replay update core and halo together; and
- switching arena configuration repeatedly keeps the glow allocation bounded
  to one point geometry and one canvas texture.

## Reuse checklist for another 3D viewer

1. Reuse one point cloud and one radial texture for the whole arena. Do not add a
   sprite, mesh, or light per LED.
2. Keep the physical core and halo separate: scale the core by 1.14 and size the
   halo from the package's largest dimension at 2.0x.
3. Build halo positions only after panel/column transforms are current. Offset
   each point slightly along its transformed surface normal.
4. Store brightness-scaled phosphor color in a dynamic vertex-color attribute;
   do not threshold GS16 values.
5. Hide the point cloud when all pixels are zero.
6. Dispose the point geometry, material, and texture on rebuild and destroy.
7. Run the fixed hard/glow benchmark and the visual QA above before enabling the
   effect by default.
