# Florence Ch. 2, Figs 2.1 + 2.2 — extraction log, pattern spec, open questions (rev 2)

Companion to `florence_ch2_fig2-1_2-2_draft.yaml`. The reader-facing write-up with full file:line
citations is `florence_ch2_az_PL_protocol_summary.md` (read that first); this file keeps the
parameter table, the pattern spec, the per-question resolution log and the validation recipe.
Rev 1 (2026-09-17, thesis-only) was superseded the same day once the original control code and raw
trial files were located under Dropbox `aversive_memory_code/` — every value below now comes from
the code / data unless marked *thesis* or *inferred*.

Citation keys: `EXP` = `20180921_data/processed/20170213000002_combo_fly_2/20170213171850_11f03x6f_az_PL/run_az_PL_experiment.m`,
`TRIAL` = `run_az_PL_trial.m` in the same folder (the 2017-02 std copies; shift copies differ only at
`TRIAL` L174/L181, ctr copies only at `EXP` L25), `RAW` = `NORAW_cltrial_*.mat` in the Fig-2 folders,
`SFS` = `Matlab_work/TJ_review/fig2/single_fly_std.m`.

## 1. What the experiments are

**Fig 2.1 — platform + task.** Head-fixed, head-open fly on an air-supported ball (two optical
sensors, 50 Hz), inside a G3 LED arena whose pattern space is 96 × 32 px (3.75°/px, 12 × 4 panels;
physically ~180° × 120° per the thesis, inferred = 6 panel columns). A 660 nm fibre LED driven from
NI AO3 (1 V = on, −4.99 V = off) activates CsChrimson in Hot Cells ("virtual heat"). The MATLAB loop
integrates ball yaw into a cylinder heading `th` at gain 0.4, shows panorama frame `xpos = round(th/3.75)`,
and drives the LED from a 96-entry `light_vec[xpos]` every frame. Training trials leave one ~quadrant
around `th = 0` cool; test trials are uniformly hot. Position A / B differ only in which rotation of
the stripes-bars-diagonals panorama is shown (SD pattern 2 vs 5); the uncoupled control draws one of
four rotations at random every training trial. **Tethered walking, not flight** — FicTrac is the
direct analogue.

**Fig 2.2 — result.** Per-fly orientation traces for baseline / training 1, 5, 10, 15 / test and the
before-vs-after preference index for the three groups (std n = 7, shift n = 7, ctr n = 9).

## 2. Parameter table (values from the code / raw data)

| Parameter | Value | Where |
|---|---|---|
| Loop rate | 50 Hz | `EXP` L21; measured 20.0 ms frame period (`RAW` bdata.timestamp) |
| Pattern space / resolution | 96 azimuth positions × 32 rows, 3.75°/px (48 panels, `Panel_map` 4 × 12) | `az_pl/20190225_figure_3_revision/Pattern_002_smallbar_vert_on.mat` |
| Physical display | 180° × 120° (thesis) → inferred 6 of 12 panel columns | thesis Fig 2.1 legend, §2.3 |
| Rotation gain | `rot_gain = 0.4`: `th += (−Omega/ticks_per_deg)·0.4` (0.4 cylinder-deg per ball-deg, sign inverted) | `EXP` L19; `TRIAL` L200–201 |
| Ball calibration | 9 mm ball, 3.5 ticks/mm, `ticks_per_deg 0.2749`; `Omega = Σx1/2` per 20 ms | `EXP` L43–45; `TRIAL` L135 |
| `fwd_gain` | 1, unused (heading-only VR) | `EXP` L20 |
| Heading → frame | `xpos = round(th/360·96)`, clamped 1..96, `set_position([xpos 1])` each frame | `TRIAL` L203–209, L229 |
| LED on / off | AO3 = `light_power` 1 V (on) / −4.99 V (off); no driver model or calibration anywhere | `EXP` L32, L90; `TRIAL` L247 |
| Training heat map | `power_vec = 1; power_vec(36:61) = −4.99; conv(gausswin(15)/sum); (1:15)=1; (80:96)=1; circshift +48` | `EXP` L180–189 |
| Resulting `light_vec` | positions 91–96 & 1–6 = −4.99 (45° fully off); 7–20 & 77–90 ramp (52.5° each side, 0 V at ≈16.5/80.5, −2 V at ≈13.5/83.5); 21–76 = 1 V (210° full heat); centre `th` ≈ +1.9° | `RAW` `c_trial.light_vec` (identical for every training trial checked) |
| Test heat map | 1 V everywhere | `EXP` L174–176 |
| LED lookup | `cpower = light_vec(xpos)` every frame; no hysteresis / filter / lag (3001/3001 frames match) | `TRIAL` L218; `RAW` check |
| Trial timing | 5 s dark (panels off, `th = 0`, LED **ON** 1 V) + 60 s closed loop = `trial_time 65` | `EXP` L36–38; `TRIAL` L140–146; `RAW` (4.98 + 60.00 s) |
| Start orientation | `th` 90 or 270 (`xpos` 24 / 72), `randperm(2)` per trial, applied at the first VR frame; also for test trials | `EXP` L33–34, L215–218; `TRIAL` L194–195; `RAW` e.g. `[270 270 90 90 270 90 270 270 90 90 270 270 90 270 270 270 270]` |
| Session | 17 trials: 1 = test (baseline), 2–16 = training, 17 = test | `EXP` L170, L174, L225–235 |
| ITI | LED off + `all_off`, `pause(3)`, then `pause(30)` (behavior, `is_imaging 0`) or key press (`is_imaging 1` = all 23 Fig-2 flies); after trial 1 an "is < .25?" prompt | `EXP` L250–278; `RAW` settings |
| Pattern IDs | 1 at init/fixation; 2 std + all tests; 5 shift; `rand_pat ∈ {2,3,4,5}` ctr training | `EXP` L82; `TRIAL` L151, L172–192 |
| Uncoupled draw | `randperm(4)+1`, first element, per training trial; observed 10/11/9/15 for 2/3/4/5 over 45 draws | `TRIAL` L186–188; `RAW` |
| Fixation phase | `fix_time 0` (disabled) in 2016-12 → 2017; 5 s in 2016-04/05 | `EXP` L37; 2016 `RAW` settings |
| Online metric | `PI = ((#th>315 + #th<45) − #(135<th<225)) / (sum)` from 6 s to end | `EXP` L254–258 |
| Flies | std 7, shift 7, ctr 9 (Fig 2b); genotype `11f03x6f` (11F03>GCaMP6f, HC>CsChrimson), age 4 d, `notes '660'` | `process_all_experiment_pi.m`; `RAW` settings |
| Cameras / DAQ | 2 Point Grey previews (alignment only); NI Dev1 AO0–3 + Port1/Line0:2; AO2 = ±5 V frame clock | `EXP` L46–66, L87–90; `TRIAL` L237–247 |

## 3. Pattern to generate — `G6_2x10_florence_sbd_v1`

No suitable pattern exists in the course library (the P3 T-figure panoramas are two-cue quadrant
patterns). Build ONE 200-frame G6 2×10 panorama (GS16 to match the course bundle; the content is
binary so GS2 would also work, ≈ 0.2 MB vs 0.8 MB). No `pattern_ID` until it is on the SD (next free
course slot = 46).

**Source bitmap** (`SFS` L50–56, a 32 × 96 logical image, 1 = lit; reconstruction of the missing
`makePatternStructSBD.m` — inferred to equal the real pattern 2):

```matlab
bars    = fliplr(repmat([zeros(32,8) ones(32,8)], [1 2]));        % vertical bars, 8 px on/off, full height
stripes = [ones(8,32); zeros(8,32); ones(8,32); zeros(8,32)];      % horizontal stripes, 8 rows on/off
diag    = stripes; for ii = 2:32, diag(:,ii) = circshift(diag(:,ii), [ii-1 0]); end   % 45 deg diagonals
sbd     = circshift([stripes bars diag], [0 -16]);                 % 32 x 96, sectors of 32 columns (120 deg)
```

**Re-index to `th`** (so that column index increases with the closed-loop heading; from `SFS` L63,
L152, L180: displayed row `r ↔ sbd column 81−r`, `th = 0 ↔ r = 32`): `sbd_th(:, k) = sbd(:, mod(48 − k, 96) + 1)`
for `k = 0…95` (column `k` covers `th = 3.75·k … 3.75·(k+1)`). Result: `th` 0–120° = vertical bars,
120–240° = horizontal stripes, 240–360° = diagonals; the bars/diagonal seam is at `th = 0`
(Position A cool-zone centre), the bars/horizontal seam at 120°, horizontal/diagonal at 240°.

**Resample 96 × 32 → 200 × 40** by nearest neighbour (`imresize(sbd_th, [40 200], 'nearest')`,
i.e. G6 column `c` takes source column `floor(c·96/200)`, G6 row `r` takes source row `floor(r·32/40)`):
3.75° → 1.8° azimuth (each source column becomes 2 or 3 G6 columns; 8-px bars → 16–17 px = 30°), and
120° → 72° of elevation (each source row → 1.25 G6 rows; the 8-row = 30° stripes become 10 rows = 18°,
i.e. the vertical structure is scaled to the G6 display height rather than kept at its angular size —
alternative: keep 30° bands = 16.7 rows and show only ~2.4 bands). Diagonals remain diagonals (slope
1.25 rows per 2.08 columns ≈ 31° in G6 pixel space instead of 45° — state which you prefer; keeping
45° in G6 pixels means regenerating `diag` at G6 resolution with period 20 rows / 20 columns).

**Frames:** frame `f` = `sbd_g6` rolled by `f` columns so that frame index = `th/1.8`, using the same
roll direction as the course P3 generator (`build_p3_shifted_patterns.mjs`: frame `i` of the shifted
copy = source frame `(i+50) mod 200`) — the sign that makes "fly turns right ⇒ panorama moves left on
the arena" must be checked together with the gain sign (Q5).

**Optional variant** `G6_2x10_florence_sbd_front180_v1`: same, with the 100 columns behind the fly
forced dark (emulates the 180° window; which half of the original cylinder was visible is unknown, Q4).

## 4. Question log (rev-1 questions → resolution)

1. **Cylinder layout** — *settled (inferred from the analysis reconstruction, `SFS` L50–62)*: three 120°
   sectors, horizontal stripes | vertical bars | diagonals, rolled by −16 columns; seams at `th` 0
   (bars/diag = Position A centre), 120° (bars/horizontal), 240° (horizontal/diag). *Still open*: the
   actual `makePatternStructSBD.m` / SD pattern files are not in Dropbox — needed to confirm the
   roll, the frame direction and the rotation of patterns 3/4/5.
2. **Stripe parameters** — *settled*: 8-px (30°) vertical bars with 8-px gaps; 8-row (30°) horizontal
   stripes with 8-row gaps; 45° diagonals of period 16 px; lit-on-dark (inferred). Height = full 32 rows.
3. **Start ±90°** — *settled*: random side per trial (`randperm(2)`, `EXP` L215–218), for test trials
   too; `th` is set to the start value at the first VR frame (`TRIAL` L194) after 5 s of dark. *Still
   open (implementation)*: today's bridge maps absolute heading → frame, so `frame_index` is not
   enforced; proposed change = at `startClosedLoop` set the bridge `offset` so that heading_now maps to
   the trialParams `frame_index` (`arena-runner-g6.js` `fictracApply` + `bridge.py` config). Decide
   whether to build this before running.
4. **Full 360° vs frontal 180°** — *open*: the original fly saw 180° × 120° of a 96-position cylinder;
   which half depended on the installed panel columns (`Panel_map` 4 × 12, installed subset unknown).
   Run the natural full panorama, or the `front180` masked pattern?
5. **Gain magnitude and sign** — *magnitude settled*: 0.4 cylinder-deg per ball-deg → fictrac gain
   1.8/0.4 = 4.5 heading-deg per frame. *Sign open*: `th` uses `−Omega` (`TRIAL` L200) but the panel
   frame direction is unknown; use the course convention (−4.5) and confirm world-stable rotation on
   the bench (sim: `pixi run sim`).
6. **LED level** — *open*: `light_power` = 1 V into an unspecified driver (if a Thorlabs LEDD1B, 20 % of
   its current limit); no irradiance anywhere. Placeholder `led_percent 5`; titrate on the CSHL BuckPuck
   (Ch. 1 free-walking avoidance saturated at 12 µW/mm² for 625 nm).
7. **ITI / between trials** — *settled*: LED off + panels off, 3 s, then 30 s on behavior rigs (`EXP`
   L276) or an operator key press for imaging flies (all Fig-2 flies). Draft uses 33 s. The trial then
   starts with 5 s dark + LED on. *Minor open*: the imaging flies' real ITIs (recoverable from file
   timestamps if needed).
8. **Hysteresis / boundary** — *settled*: none; per-frame lookup, but the heat edge is a Gaussian ramp
   over ~52° (positions 7–20 / 77–90). Our `led_activation` is binary → `hysteresis 0` and a hard edge
   at the 90° quadrant (`[[25,174]]`); alternatives `[[34,166]]` (the 120° "V ≤ 0" zone) or
   `[[13,187]]` (the 45° fully-off zone). Reproducing the ramp would need a graded `led_activation`
   (level per band) — a runner feature, if wanted.
9. **Uncoupled granularity** — *settled*: quantised to the four rotations {2,3,4,5}, uniform, re-drawn
   every training trial; test trials use pattern 2 (`TRIAL` L179–191). Draft: 4 offsets × 2 starts,
   15-entry shuffled list (4/4/4/3).
10. **Baseline/test start** — *settled*: random 90/270 as for training; draft binds baseline to 270
    (frame 150) and the final test to 90 (frame 50).
11. **File organisation** — *open (preference)*: one YAML with swap-in blocks (as written; leaves
    `unused-condition` warnings) vs three course-style files.
12. **Pattern SD slot** — *open*: assign `pattern_ID` 46 when the pattern is built and the course SD
    bundle regenerated (`build_course_sd_bundle.mjs`).

New since rev 1:

13. **Position B rotation** — the analysis draws "shift" as `circshift(sbd_r,[24 0])` = 90° (`SFS`
    L112–114) and the ctr set is four patterns, so patterns 2–5 are most likely the 0/90/180/270°
    rotations (pattern 3 = 180° from the OL-map "N/S" naming). Which of ±90° is pattern 5 is unknown;
    the draft moves the B cool zone to `th` +90° (into the bars sector, toward the bars/horizontal
    seam the thesis names). Confirm with the pattern file.
14. **Dark-epoch LED** — the original kept the LED at 1 V during the 5 s dark (`TRIAL` L144); the G6
    runner forces the LED off for the instant between `trialParams` and the first applied frame of a
    training trial (activator baseline). Acceptable? (Test trials are unaffected: `ledDrive` is re-sent.)
15. **"is < .25?" gate** — an operator prompt after the baseline trial (`EXP` L268–270); baseline
    `PI_2quad_60` in the 23 Fig-2 flies spans −0.94…+1.0, so it was advisory. Not encoded.

## 5. Validation

```
~/.pixi/bin/pixi run node --import ./tests/vendor-yaml.register.mjs \
    .claude/skills/protocol-yaml/bin/validate-protocol.mjs protocols/drafts/florence_ch2_fig2-1_2-2_draft.yaml
```

Expected: exit 0, no blocking errors; `unused-condition` warnings for the Position-B and uncoupled
conditions while the Position-A block is selected (and vice versa for the swap-in variants). Runner
`flattenStructure` (nominal order): 2 tests + 15 training trials + 16 `iti` + shutdown = 34 steps,
1633 s = 27 min 13 s.
