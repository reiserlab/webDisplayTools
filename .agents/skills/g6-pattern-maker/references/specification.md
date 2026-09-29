# G6 declarative pattern specification

## Coordinate and arena model

- G6 panels are 20x20 pixels.
- `pixel_width = panel_columns * 20`; `pixel_height = panel_rows * 20`.
- Full-grid 2x10, 3x10, and 4x10 are supported. The 48-bit G6 panel mask limits dense arenas to at most 48 panels.
- Logical row 0 is bottom; logical column 0 is left.
- `x_deg: 0` is the calibrated front at `arena.front_column_px`. Positive azimuth moves toward increasing columns.
- `y_deg: 0` is the vertical center. Positive elevation moves toward increasing rows.
- Angular conversion is `pixel_width / 360` pixels per degree in both axes. With 10 columns this is 1 pixel per 1.8 degrees, regardless of arena height.
- Pixel fields (`x_px`, `y_px`, `width_px`, and similar) override degree fields and are intended for calibration or legacy matching. `x_px` is an absolute column; `y_px` is relative to vertical center.

## Top-level schema

One file can contain one pattern or a batch:

```json
{
  "defaults": {
    "arena": {
      "generation": "G6",
      "panel_rows": 2,
      "panel_columns": 10,
      "front_column_px": 49.5,
      "arena_id": 1,
      "observer_id": 0
    },
    "encoding": {"gs_levels": 16, "duty_cycle": 128},
    "canvas": {"background": 5}
  },
  "patterns": [
    {
      "name": "dark_bar_10deg",
      "frame_count": 200,
      "motion": {"type": "horizontal_translation", "pixels_per_frame": 1},
      "layers": [
        {"type": "rect", "x_deg": 0, "y_deg": 0, "width_deg": 10, "height_px": 42, "value": 0}
      ],
      "assertions": {"allowed_values": [0, 5]}
    }
  ]
}
```

For one pattern, omit `defaults` and `patterns` and place the pattern fields at the top level.

## Common pattern fields

- `name`: filesystem-safe logical name; required.
- `arena`: G6 geometry/calibration object.
- `encoding.gs_levels`: `2` or `16`.
- `encoding.duty_cycle`: integer 0-255, or `duty_cycle_by_frame` array.
- `canvas.background`: valid grayscale value.
- `rasterization.pixel_center_offset`: normally `0.5`; use `0` only to reproduce legacy generators that sampled at integer pixel centers.
- `frame_count`: positive integer, maximum 65535.
- `motion.type`: `static` or `horizontal_translation`.
- `motion.pixels_per_frame`: signed number; positive shifts the scene toward increasing columns.
- `motion.start_offset_px`: optional initial phase.
- `layers`: drawn in order; later layers overwrite earlier layers where covered.
- `notes`: string or string array recording scientific assumptions and provenance.
- `assertions`: optional checks described below.

## Layer primitives

All shapes accept `value`. Positions may use degree or pixel forms.

- `rect`: `x_deg|x_px`, `y_deg|y_px`, `width_deg|width_px`, `height_deg|height_px`.
- `oblique`: same center fields plus `length_deg|length_px`, `thickness_deg|thickness_px`, and `orientation: "forward"|"backward"`.
- `disc`: center plus `diameter_deg|diameter_px`.
- `annulus`: center plus `outer_diameter_deg|outer_diameter_px` and `thickness_deg|thickness_px`.
- `square_grating`: `period_deg|period_px`, `duty_fraction` (default 0.5), `phase_deg|phase_px`, `phase_reference: "column_zero"|"front"` (default `column_zero`), `on_value`, and `off_value`. It fills the arena.
- `checker_grid`: `x_deg|x_px`, `y_deg|y_px`, `rows`, `columns`, `cell_size_deg|cell_size_px`, optional `gap_deg|gap_px`, `values`, and integer `seed`. Coordinates are the grid center by default. To specify the lower-left pixel start, set `anchor: "lower_left"` and give absolute `x_px` and `y_px`. When `balanced` is true, the compiler creates equal contiguous blocks in `values` order and applies its seeded Fisher-Yates shuffle; the cell count must be divisible by `values.length`.
- `barberpole`: rectangle fields plus `stripe_period_px`, `slope`, `value_a`, and `value_b`.
- `horizontal_profile`: `x_deg|x_px`, `width_deg|width_px`, `profile: "edge"|"peak"`, `background`, `dark`, and `bright`.
- `loom_disc`, `loom_annulus`, `loom_dots`: center plus `initial_diameter_deg`, `final_diameter_deg`, `motion_frames`, `hold_frames`, and optional `annulus_thickness_deg` or `seed_salt`. The diameter follows a linear trajectory in cotangent of half-angle, matching constant-size/velocity looming conventions.

Any layer may use `copies`, an array of additional position overrides. The base layer is always drawn once, followed by every listed copy.

## Assertions

- `allowed_values`: every decoded pixel must be in this list.
- `repeat_after_frames`: every comparable frame must equal the frame this many positions later. It must be smaller than `frame_count`; do not use it to describe the implicit wrap from the last frame back to frame zero.
- `min_non_background_fraction` and `max_non_background_fraction`.
- `expected_frame_count`.

`min_non_background_fraction` and `max_non_background_fraction` count every pixel whose value differs from `canvas.background`, across each full frame. For example, 120 squares of 7x7 pixels in a 40x200 arena occupy `5880/8000 = 0.735`, not merely the fraction of dark squares.

Core checks always enforce dense G6 geometry, legal values, frame lengths/count, duty range, strict CRC parse, metadata agreement, and pixel-perfect encode/decode round-trip.

## Exact transforms

Use `phase-shift` for a phase partner. A shift of `N` creates output frame `i` from source frame `(i + N) mod frame_count`. For a 200-frame full-azimuth movie, 50 frames is exactly 90 degrees.

## Reproducibility bundle

Generation writes:

- `name.pat`: controller binary.
- `name.spec.json`: normalized source specification.
- `name.provenance.json`: tool version, dependency path, SHA-256 hashes, parsed metadata, and validation results.

The `.spec.json` is the scientific source of truth; the `.pat` is a compiled artifact; a deployment `pattern_ID` belongs to a later SD-card catalog.
