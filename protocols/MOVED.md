# Protocols and rig records that left this repo (2026-10-29, LAB-227)

Experiment material now lives in private repos so that a rig's protocol tweaks never need a
webDisplayTools release. The rule: a protocol stays here only if a tool, test, QC profile or doc
fixture depends on it. Copies were made from commit `59a377b` (Release 2026-10-28); each destination
has a `PROVENANCE.md`. Open a moved protocol in the Studio, signed in, with
`arena_studio.html?repo=<repo>&p=<path>`.

| Was here | Now (repo → path) |
|---|---|
| `protocols/bias_camera_closed_loop_poc.yaml` | `reiserlab/arena-experiments` → `protocols/ww18/bias_camera_closed_loop_poc.yaml` |
| `protocols/bias_camera_closed_loop_poc_ww18.yaml` | `reiserlab/arena-experiments` → `protocols/ww18/bias_camera_closed_loop_poc_ww18.yaml` |
| `protocols/bias_camera_closed_loop_poc_ww18_soak10.yaml` | `reiserlab/arena-experiments` → `protocols/ww18/bias_camera_closed_loop_poc_ww18_soak10.yaml` |
| `protocols/fictrac_bias_test.yaml` | `reiserlab/arena-experiments` → `protocols/shared/fictrac_bias_test.yaml` |
| `protocols/fictrac_direction_test.yaml` | `reiserlab/arena-experiments` → `protocols/shared/fictrac_direction_test.yaml` |
| `protocols/fictrac_coupling_bias_fly_test.yaml` | `reiserlab/arena-experiments` → `protocols/shared/fictrac_coupling_bias_fly_test.yaml` |
| `protocols/led_activation_quadrant_test.yaml` + `_patterns/` | `reiserlab/arena-experiments` → `protocols/shared/led_activation_quadrant_test.yaml` + `_patterns/` |
| `protocols/mode3_drill_1trial.yaml` | `reiserlab/arena-experiments` → `protocols/shared/mode3_drill_1trial.yaml` |
| `protocols/g6_2p_color_led_sweep.yaml` + `_patterns/` | `reiserlab/scanimage-2026-bergamo` → `protocols/g6_2p_color_led_sweep.yaml` + `_patterns/` |
| `protocols/g6_2x10_2p_diagnostics.yaml` + `_patterns/` | `reiserlab/scanimage-2026-bergamo` → `protocols/g6_2x10_2p_diagnostics.yaml` + `_patterns/` |
| `protocols/g6_2x10_2p_duty_sweep.yaml` | `reiserlab/scanimage-2026-bergamo` → `protocols/g6_2x10_2p_duty_sweep.yaml` |
| `rig/windows-results-ww18-2026-10-15.md` | `reiserlab/arena-experiments` → `rigs/ww18/` |
| `rig/okey-cokey-pc-*.md`, `rig/HANDOVER-okey-cokey-2026-10-21.md`, `rig/docs/okey-cokey-foxglove-dashboard-plan.md`, `rig/config/bias/okey-cokey-bfs-u3-51s5m.json`, `rig/tools/okey-cokey-start.ps1`, `rig/tools/bias-ufmf.ps1` | `reiserlab/arena-experiments` → `rigs/ww14/` (same names; `config/` and `tools/` subfolders) |

A copy of `g6_2p_color_led_sweep.yaml` stays as the test fixture `tests/fixtures/v3_g6_2p_color_led_sweep.yaml`.
The pattern generators `scripts/make-color-optomotor-patterns.js --gs16` and
`scripts/make-2p-diagnostic-patterns.js` now take `--out <dir>` pointing into the 2P repo.

Pages under `docs/development/` that cite the old paths are historical records and were not edited.
