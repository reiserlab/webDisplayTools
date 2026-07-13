---
name: g6-pattern-maker
description: Create, transform, preview, inspect, compare, and validate reproducible Generation 6 LED-arena pattern files (.pat) from scientific stimulus descriptions or declarative JSON specifications. Use for G6 full-grid arena patterns, including 2x10, 3x10, and 4x10 geometries; moving bars and gratings; looming discs, annuli, and dot controls; compound objects and textures; exact phase-shifted partners; pattern provenance; or regression checks against existing patterns.
---

# G6 Pattern Maker

Create scientific patterns as versioned JSON specifications, then use the bundled deterministic compiler. Do not hand-assemble `.pat` bytes or silently bake in a 2x10 arena.

## Workflow

1. Translate the request into explicit scientific choices: geometry, luminance, duty cycle, coordinates, frame count, motion, seed, and invariants.
2. Read [references/specification.md](references/specification.md) before authoring or changing a spec.
3. If any choice would materially change the experiment and cannot be inferred, ask the user. Otherwise record the assumption in `notes`.
4. Write a JSON source specification. Prefer degrees for scientific dimensions and pixels only for hardware calibration or exact legacy reproduction.
5. Generate with:

   ```bash
   node scripts/g6_pattern_tool.js generate spec.json output-directory
   ```

6. Inspect the generated file and provenance report:

   ```bash
   node scripts/g6_pattern_tool.js inspect output-directory/name.pat
   ```

7. Make previews from the emitted `.pat`, never from a separate drawing path:

   ```bash
   node scripts/g6_pattern_tool.js preview output-directory/name.pat output-directory/name.gif
   ```

8. For a partner that must be an exact phase transform, transform the decoded source rather than redrawing it:

   ```bash
   node scripts/g6_pattern_tool.js phase-shift source.pat shifted.pat 50
   ```

9. Compare decoded pixels, not only filenames, GIF appearance, or binary hashes:

   ```bash
   node scripts/g6_pattern_tool.js compare candidate.pat reference.pat
   ```

10. Audit an existing pattern library before building a regression set:

   ```bash
   node scripts/g6_pattern_tool.js audit-library path/to/patterns manifest.json
   ```

   This strictly parses every `.pat`, records metadata and SHA-256, and reports duplicates.

11. Score a flat candidate directory against a flat frozen reference directory:

   ```bash
   node scripts/g6_pattern_tool.js score-library candidates references report.json
   ```

   Files are matched by logical name after removing a leading numeric SD-card prefix. Review
   exact-byte equality, decoded equality, pixel agreement, and missing/extra names separately.

## Guardrails

- Support G6 dense full-grid arenas only. Require `panel_rows * panel_columns <= 48`. Reject partial/masked arenas.
- Treat row 0 as the bottom and column 0 as the left in logical frame arrays.
- Keep `front_column_px` explicit whenever azimuth zero means the calibrated front of a physical arena.
- Use `gs_levels: 16` with values 0-15 or `gs_levels: 2` with values 0-1.
- Call the last per-panel byte `duty_cycle`; `stretchValues` is only its legacy encoder name.
- Preserve the JSON spec and generated provenance beside every important `.pat` file.
- Require strict parse/CRC validation and decoded round-trip equality after generation.
- Validate 3x10 and 4x10 outputs in software, but label their physical orientation unverified until asymmetric hardware tests pass.
- Keep logical pattern names independent of deployment `pattern_ID`. Assign SD-card IDs only during bundle construction.

## Existing-pattern work

When reproducing a legacy pattern, do not read its generator or target `.pat` until after the candidate is frozen if the task is intended as a blind evaluation. Record underspecified conventions. Classify differences as scientific, phase/orientation, rasterization, encoding, or legacy-target issues before changing the skill.
