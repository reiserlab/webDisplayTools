# Florence Ch. 2 (Figs 2.1 / 2.2) — the `az_PL` protocol, reconstructed from the original code

Reader-facing summary for the G6 port. Companion files: `florence_ch2_fig2-1_2-2_draft.yaml` (the
v3 protocol) and `florence_ch2_fig2-1_2-2_notes.md` (question-by-question log, pattern spec).
Compiled 2026-09-17. Anything not read directly from a file is marked **inferred**.

Path abbreviations used in citations:

- `AMC/` = `/Users/reiserm/Library/CloudStorage/Dropbox-HHMI/Michael Reiser/aversive_memory_code/`
- `EXP` = `AMC/20180921_data/processed/20170213000002_combo_fly_2/20170213171850_11f03x6f_az_PL/run_az_PL_experiment.m`
  (the std copy; line numbers below refer to it)
- `TRIAL` = same folder, `run_az_PL_trial.m`
- `TJR/` = `/Users/reiserm/Library/CloudStorage/Dropbox-HHMI/Michael Reiser/Matlab_work/TJ_review/fig2/`

## 1. Sources

| Source | What it gave | Notes |
|---|---|---|
| Thesis `20180108_thesis+revisions.docx` (Columbia 2018), Ch. 2 §2.1, §2.3 Methods "Behavior Assay", Fig 2.1/2.2 legends; §4.3 for the 11.25°×18.75° bar | prose description only (1 + 15 + 1 one-minute trials, quadrant cool zone, ±90° start, Position A/B seams, uncoupled = random shift) | word-identical to the 2017 draft `TJ_draft.docx` on every protocol fact |
| `TJR/process_all_experiment_pi.m` L11–37 | the Fig 2 fly lists: **std** (Position A) 7 flies, **shift** (Position B) 7, **ctr** (uncoupled) 9 — see table below | analysis only |
| `TJR/single_fly_std.m` L50–62 (`sbd = [stripes bars diag]`, `circshift(sbd,[0 -16])`), L86–118 (heat-map reconstruction, `circshift(sbd_r,[24 0])` for "shift"), L180 (`mod(th+180-60,360)`), L152 (`circshift(map,[-16 0])`) | the only surviving description of the SBD pattern layout and of the shift amount | analysis reconstruction, **not** the generator |
| `TJR/combined_silencing_figure.m` L19–73 | the five Shibire/GCaMP silencing groups and their data folders (Fig 2.3) | |
| `AMC/20180921_data/processed/<fly>/<ts>_*_az_PL/run_az_PL_experiment.m`, `run_az_PL_trial.m`, `run_az_PL_OL_trial.m` | **the control code, copied into every data folder at the end of each session** (`EXP` L462–464) | the 2017-02 Fig-2 copies: `run_az_PL_trial.m` has exactly two variants (md5: 16 std/ctr copies identical, 7 shift copies identical, differing only in `set_pattern_id` 2 → 5 at L174/L181); `run_az_PL_experiment.m` copies differ only in `geno`/`is_control`/comment blocks. vs the 2016-12-05 Shibire copy: only `geno`, `is_imaging` and the added `hot_end` flag (diff) — **no version gap** for the parameters |
| `AMC/.../NORAW_cltrial_NN_env_{test,train}_rep_NNN.mat` (`expr.settings`, `expr.c_trial.light_vec/player/rand_pat`, `expr.c_trial.bdata.{th,xpos,laser_power,timestamp}`) | the values actually used per trial; verified for one std, one shift, one ctr fly (all 17 trials each) and partially for others | read with the MATLAB MCP |
| `AMC/az_pl/20190225_figure_3_revision/Pattern_002_smallbar_vert_on.mat` | the G3 arena geometry of the rig's pattern files (`x_num 96, y_num 32, num_panels 48, Panel_map 4×12`) | the SBD pattern file itself is **not** in Dropbox |
| `makePatternStructSBD.m` (called at `TRIAL` L13), `make_OL_map_posvec.m`, `init_memory.m`, `init_tcp.m` (az_PL version) | **missing** — not anywhere under Dropbox (`mdfind` + `find`) | lived in `C:\MatlabRoot\az_pl\experiment\` on the rig PC |

Fig 2 flies (`process_all_experiment_pi.m` L11–37), all `20180921_data/processed/…`:

| Group | Folders (`<combo>/<ts>_*_az_PL`) |
|---|---|
| std = Position A (7) | 20170206000001_combo_fly_1, 20170202000001_combo_fly_1, 20170201000001_combo_fly_1, 20170213000003_combo_fly_3, 20170213000002_combo_fly_2, 20170223000002_combo_fly_2, 20170223000003_combo_fly_3 |
| shift = Position B (7) | 20170216000003_combo_fly_3_shifted, 20170216000001_combo_fly_1_shifted, 20170211000002_combo_fly_2, 20170211000001_combo_fly_1, 20170210000001_combo_fly_1, 20170226000001_combo_fly_1_shift, 20170226000002_combo_fly_2_shift |
| ctr = uncoupled (9) | 20170212000003_combo_fly_3_ctr, 20170212000002_combo_fly_2_ctr, 20170212000001_combo_fly_1_ctr, 20170220000001_combo_fly_1_ctr, 20170220000002_combo_fly_2_ctr, 20170220000003_combo_fly_3_ctr, 20170219000001_combo_fly_1_ctr, 20170224000001_combo_fly_1_ctr, 20170022400002_combo_fly_2_ctr |

Every one of these 23 folders carries its own `run_az_PL_*.m` copies (checked by `find`), so the
2017 scripts, not the 2016-12-05 copy, are the reference. All 23 have `is_imaging = 1` and
`geno` `11f03x6f`(`_shifted`/`_shift`/`_ctr`) in `expr.settings` (raw files).

## 2. Rig and coupling

| Item | Value | Where |
|---|---|---|
| Pattern space | 96 azimuth positions × 32 rows, 3.75°/px, 48 panels in a 4 × 12 `Panel_map` (12 panel columns × 8 px = 96 px = 360°) | `Pattern_002_smallbar_vert_on.mat`: `xpix 96, ypix 32, x_num 96, y_num 32, num_panels 48, Panel_map [4 12]` |
| Physical display | 180° × 120° (thesis Fig 2.1 legend; §2.3) → **inferred** 6 of the 12 panel columns × 4 rows installed; the virtual cylinder is the full 96 positions, the fly sees half of it | thesis; inference |
| Loop rate | 50 Hz (`hz = 50`); serial callback every `48000/hz` bytes = 12 bytes × 80 samples | `EXP` L21; `TRIAL` L24; measured frame period 0.0200 s (bdata.timestamp) |
| Ball tracker | two optical sensors on COM9 at 1.25 Mbaud, 4 kS/s, 12-byte packets; `Vfwd = Σx0·0.7071`, `Vss = Σy0·0.7071`, `Omega = Σx1/2` per 20 ms | `TRIAL` L16–29, L128–135 |
| Ball / calibration | `ball_diameter 9` mm, `ticks_per_mm 3.5`, `ticks_per_deg = 9π·3.5/360 = 0.2749` | `EXP` L43–45 |
| Rotation coupling | `th(n) = mod(th(n-1) + (−Omega/ticks_per_deg)·rot_gain, 360)`, `rot_gain = 0.4`, i.e. the cylinder turns **0.4° per 1° of (nominal) ball yaw**, sign-inverted | `TRIAL` L200–201; `EXP` L19 |
| Position → frame | `xpos = round(th/360·96)`, clamped 0→1 and 97→96; `Panel_tcp_com('set_position',[xpos 1])` every frame | `TRIAL` L203–209, L229; `Panel_tcp_com.m` L329 (0x70 + x,y) |
| `fwd_gain` | 1 — declared but unused in `run_az_PL_trial.m` (no translation; `xpos` is heading only) | `EXP` L20 |
| Panel controller | `init_tcp; set_pattern_id 1; stop; all_off` at session start; `set_pattern_id 2/5/rand_pat` at the first VR frame of each trial | `EXP` L81–84; `TRIAL` L151, L174–188 |
| DAQ | NI `Dev1`: AO0–AO3 + `Port1/Line0:2` digital. Per-frame scan `[5 5 clk_out cpower 0 1 1]` → **AO0 = 5 V, AO1 = 5 V (trial gates), AO2 = ±5 V frame clock (`clk_out` alternates per frame), AO3 = LED (`cpower`)**, DIO 0/1/2. Session idle `[0 0 0 −4.99 0 0 0]`; between trials `[−4.99 0 0 −4.99 1 0 0]`; trial start `[5 5 0 −4.99 1 1 1]` | `EXP` L87–90, L99, L252; `TRIAL` L41, L65, L237–247 |
| LED "off" convention | `−4.99 V` on AO3; "on" = `light_power = 1` V. No LED-driver model or irradiance calibration anywhere in code, data or thesis (Thorlabs M660F1 fibre LED per thesis §2.3) | `EXP` L32, L90; thesis |
| Cameras | two Point Grey `videoinput` devices (`vi_m`, `vi_l`), previewed for alignment, one snapshot each saved in `settings.m_view/l_view`; `camera.do_capture = 0` | `EXP` L46–66 |
| Imaging | `is_imaging = 1` → operator-paced trials (key press) instead of timed pauses | `EXP` L27, L272–277 |

## 3. Visual pattern

- **Pattern IDs.** SD pattern **1** is loaded at init and used only in the (disabled) fixation
  phase (`EXP` L82; `TRIAL` L151). During closed loop: **pattern 2** for std and for all test
  trials; **pattern 5** for the shift group (both train and test); **`rand_pat ∈ {2,3,4,5}`** for
  ctr training trials (`TRIAL` L172–192; shift copy L174/L181). The OL-mapping stimulus table
  labels `pat_id 2` "SBD", `pat_id 7` "SBD_…_flipLR", `pat_id 6` "smallbar_vert_on", and uses
  `pat 3` as the "envOL_N" counterpart of `pat 2` "envOL_S" (`generate_targeted_multisensory_stimulus_struct.m`
  L43/L77; `run_OL_viz_map_v1_experiment.m` stim_struct) → **inferred: patterns 2–5 are the same
  SBD panorama at four rotations (3 = 180°)**. The generator `makePatternStructSBD.m` is missing.
- **Layout (from `TJR/single_fly_std.m` L50–62, reconstruction — inferred to equal the real pattern):**
  a 32-row × 96-column bitmap `sbd = [stripes bars diag]`, three **32-column (120°) sectors**, then
  `circshift(sbd,[0 −16])` (60°):
  - `stripes` = **horizontal stripes**: rows 1–8 on, 9–16 off, 17–24 on, 25–32 off (8 rows = 30° per
    band, 2 bands, full 32-row height) — L51
  - `bars` = **vertical bars**: `fliplr(repmat([zeros(32,8) ones(32,8)],[1 2]))` → 8-px (30°) bars,
    8-px gaps, 2 bars per sector, full height — L50
  - `diag` = the horizontal-stripe bitmap with column *ii* circularly shifted down by *ii−1*
    rows → **45° diagonals**, period 16 px (60°) along azimuth and 16 rows in elevation — L52–56
  - polarity: `1` = lit, `0` = dark in the reconstruction colormap (L124–127) → **inferred lit
    stripes on a dark arena** (the thesis icons are drawn black-on-white).
- **Where the seams sit.** With `th` the closed-loop heading variable, the figure code maps
  `th → y = mod(th+120,360)/360·96` (L180) and shows the strip `flipud(sbd')` rolled by −16 rows
  (L63, L152). Solving: displayed row `r ↔ sbd column 81−r`, and `th = 0 ↔ r = 32 ↔ column 49`,
  which is the **first column of the diagonal sector, i.e. the vertical-bars / diagonal seam**.
  Increasing `th` walks toward lower columns: **`th` 0→120° = vertical bars, 120→240° = horizontal
  stripes, 240→360° = diagonals** (inferred from the analysis figure; direction of `th` vs panel
  frames not independently verifiable without the pattern file).
- **Frame / position bookkeeping.** `xpos` 1…96 = `th`/3.75 rounded; `start_theta [90 270]` ↔
  `start_xpos [24 72]` (`EXP` L33–34, applied at `TRIAL` L194–195). The training `power_vec` is
  built with the cool zone at positions 36:61 (centre 48.5) and then `circshift(…,[1 48])`
  (`EXP` L181–189) → centre position 96.5 ≡ **`th` ≈ 0° (+1.9°)**, so the start positions are
  exactly ±90° from the cool-zone centre and the online PI window 315–45° (`EXP` L255–256) is the
  cool quadrant. The analysis figure instead builds an un-shifted map with the zone at 38:58
  (`single_fly_std.m` L92, a plotting approximation with `gausswin(10)`) and shifts the fly trace
  by +120° and the image by −16 rows (−60°), which lands the same `th = 0` on row 32.

## 4. Heat (opto) landscape

- **Training trials (2–16):** `power_vec = 1·ones(1,96); power_vec(36:61) = −4.99;` smoothed by a
  normalised `gausswin(15)` (`conv … 'same'`), then edges reset `power_vec(1:15) = 1`,
  `power_vec(80:96) = 1`, then `circshift([1 48])` (`EXP` L180–189). Resulting `light_vec`
  (identical in every training trial of every fly checked; raw `c_trial.light_vec`):
  positions **91–96 & 1–6 = −4.99 V (fully off, 12 positions = 45°)**; 7–20 and 77–90 = Gaussian
  ramp (14 positions = 52.5° each side; crosses 0 V between 16/17 and 80/81, −2 V at ≈13.5/83.5);
  **21–76 = 1 V (full heat, 56 positions = 210°)**. So: fully-cool 45°, "LED voltage ≤ 0 V" zone
  120° (positions 81–16), nominal quadrant per the thesis/online PI 90°. What the driver did
  between −4.99 V and 0 V is unknown (no driver model in the code) — if it clips at 0 V the
  physical cool zone was ≈120° wide with a ~15° ramp on each side.
- **Test trials (1, 17):** `power_vec = 1·ones(1,96)` — uniform heat (`EXP` L174–176).
- **Lookup:** `cpower = light_vec(xpos(count))` every frame, sent in the same `outputSingleScan`
  as the frame clock (`TRIAL` L218, L247). **No hysteresis, no filtering, no latency**: in the raw
  data `laser_power == light_vec(xpos)` on 3001/3001 VR frames (a one-frame lag would have given
  25 mismatches).
- **Dark epoch (first `dark_frames = 250` = 5 s):** panels `all_off`, `th = 0`, `xpos = 1`, and
  **LED = `light_power` = 1 V (heat ON)** (`TRIAL` L140–146; raw `laser_power` = 1 on all dark frames).
- **Fixation epoch:** `fix_time = 0` in 2016-12 → 2017 (`EXP` L37) → never runs; when it did (2016-04/05,
  `fix_time 5`) it showed pattern 1 in closed loop with the LED at `light_power` (`TRIAL` L148–167).
- **ITI:** LED to −4.99 V at trial end (`TRIAL` L65), panels `all_off` (`EXP` L250); stays off until the
  next trial's first frame.
- `is_dynamic_off` (blank the panels whenever the fly is in heat) exists but is 0 everywhere
  (`TRIAL` L220–227; note it tests an undefined `c_power` and would error if enabled).

## 5. Trial and session structure (2017 Fig-2 version)

| Trial | Type (`c_trial.name`) | Pre-epoch | Closed loop | LED map | Start | Pattern | After the trial |
|---|---|---|---|---|---|---|---|
| 1 | `env_test_rep_001`, `is_test 1` | 5 s dark, LED 1 V | 60 s | uniform 1 V | th 90 or 270, `randperm(2)` (`EXP` L215–218) | 2 (5 shift; 2 ctr) | LED off, `all_off`, `pause(3)`, **"is < .25?" + key press** (`EXP` L268–270) |
| 2–16 | `env_train_rep_NNN`, `is_test 0` | 5 s dark, LED 1 V | 60 s | cool zone at th≈0 (§4) | random ±90° each trial | 2 (5 shift; **`rand_pat`** ctr) | LED off, `all_off`, `pause(3)`, then **key press** (`is_imaging 1`) or `pause(30)` (`EXP` L272–277) |
| 17 | `env_test_rep_017`, `is_test 1` | 5 s dark, LED 1 V | 60 s | uniform 1 V | random | 2 (5 shift; 2 ctr) | same; `hot_end` prompt before it if set (`EXP` L240–244) |

`trial_time = 60 + dark_time + fix_time = 65` s (`EXP` L38); the callback loop runs until
`toc ≥ trial_time` (`TRIAL` L46–51) — measured 3250 frames = 65.0 s, dark 4.98 s + VR 60.00 s.
`reward_time = Inf` (`EXP` L39) disables early termination on "safe frames".
Session: 17 × 65 s = 18.4 min of trials; + 16 × (3 s + 30 s) = 8.8 min on a behavior rig → ≈ 27 min;
imaging flies (all of Fig 2) were operator-paced, so their ITIs are not recorded in the settings
(the `timestamp`s in successive files would give them). `num_trials 10`/`num_mock 4` (`EXP` L23–24) are
vestigial in this version (loop is hard-coded `for aa = 1:17`, L170).

## 6. Online metric

`th_exp = th((dark_time+fix_time+1)·50 : count)` (from 6 s to the end), `p1 = #(th>315)`,
`p2 = #(th<45)`, `p4 = #(135<th<225)`, **`PI = ((p1+p2) − p4)/(p1+p2+p4)`** — target quadrant
(±45° around 0) vs the opposite quadrant, plotted live per trial (`EXP` L254–267). The analysis
files carry `PI_2quad_30`, `PI_2quad_60`, `PI_allQuad_30/60`, `tQ_time`, `outside_tQ_time`,
`time_to_cool`, `cool_time` (`bdata` fields) and `summary_data.PI_2quad_60(1:2)` (baseline, test) +
`train_quadPI(1:15)` (`process_all_experiment_pi.m` L54–60). The computing script is not in Dropbox;
**inferred**: `_60` = the whole 60 s VR epoch, `_30` = the first 30 s, `2quad` = target vs opposite as
above, `allQuad` = target vs the other three. Baseline `PI_2quad_60` for the 23 Fig-2 flies ranges
−0.94…+1.0 (five flies ≥ 0.25), so the "is < .25?" prompt was advisory, not an exclusion rule.

## 7. Position A vs Position B ("shift")

Concretely the **only** difference is the SD pattern shown in closed loop: `set_pattern_id 2` (std)
vs `set_pattern_id 5` (shift), in both training and test trials (`TRIAL` L174/L181 in the shift
copies; `EXP` identical except `geno = '11f03x6f_shifted'`). The heat map, start positions, and
everything else are unchanged. Pattern 5 is a rotated copy of pattern 2: the analysis reconstruction
draws the shift environment as `circshift(sbd_r,[24 0])` = **24 positions = 90°** (`single_fly_std.m`
L112–114; inferred to reflect the real pattern; the 180°/270° rotations are `[48 0]`). The thesis
says B was trained "to the seam between horizontal and vertical stripes": in the 3 × 120° layout a 90°
rotation from the bars/diagonal seam puts the cool-zone centre 30° short of the bars/horizontal seam,
with the zone (±45–60°) still containing that seam — consistent, but the exact rotation and its
direction need the pattern file or `makePatternStructSBD.m`.

## 8. Uncoupled control (ctr)

`is_control = 1` (`EXP` L25). At the first VR frame of every **training** trial:
`rand_vec = randperm(4)+1; rand_pat = rand_vec(1); set_pattern_id(rand_pat)` (`TRIAL` L179–191) →
**the pattern (not the heat map) is re-drawn per trial, uniformly from the four rotations
{2,3,4,5}**, independently each trial (raw `rand_pat` over three flies × 15 trials: 10/11/9/15
draws of 2/3/4/5; e.g. `[3 5 5 3 4 3 5 5 2 3 2 3 3 2 5]`). Test trials use pattern 2 (`TRIAL`
L179–182), i.e. the std alignment. Heat map, dark epoch, ±90° random start (relative to the fixed
heat map, hence relative to a random pattern phase) and ITIs are identical to std. One in four
training trials is therefore the Position-A pairing by chance.

## 9. Other controls and variants in the data tree

| Variant | Where / how identified | What it is |
|---|---|---|
| **Shibire silencing (Fig 2.3)** | `combined_silencing_figure.m` L19–73; folders `2016-12-01…14/*_11f03xShits_{cold,hot}_az_PL`, `2016-12-14…16/*_11f03xgcamp_hot_az_PL`, `2016-12-18/28, 2017-01-02/*_11f03xShi(Ts)_hot_end_az_PL`, `2016-12-29/30/*_11f03xGcamp_hot_end_az_PL` | same 17-trial protocol, `is_imaging 0` (30 s ITIs), un-dissected flies. Groups: `shi_cold` (permissive 20 °C throughout, n=10), `shi_hot` (restrictive 28 °C throughout, n=10), `gcamp_hot` (GCaMP genotype at 28 °C, n=10), `shi_hot_end` / `gcamp_hot_end` (`hot_end = 1`: heated only before trial 17 — "heat up!!!! then hit space", `EXP` L240–244; tests retrieval; n=10/9) |
| **hot_end flag** | `EXP` L29, L240–244 | added between 2016-12-05 and 2016-12-18 (diff); pauses before the final test so the bath can be warmed |
| **Open-loop mapping sessions** (`OL_map_naive` / `OL_map_trained`) | 2017 `processed/<fly>/<ts>_*_OL_map_{naive,trained}/`, scripts `run_OL_viz_map_v1_experiment.m`, `run_OL_target_multisensory_trial.m`, `generate_targeted_multisensory_stimulus_struct.m` | the Ch. 4 pre/post characterization: `smallbar_vert_on_30_dps` (pat 6, RF mapping), `SBD_cold` / `SBD_hot` (pat 2 swept 360° at 30°/s, LED −4.99 vs 1 V), `SBD_cold_pause` / `SBD_hot_pause` (104 s), `SBD_hot_pause_flipLR` (pat 7); 300 s trials, `light_power −4.99` default, randomised `exp_order` |
| **In-script OL mapping (`do_map`, `OL_A`/`OL_B`)** | `EXP` L28, L100–166, L392–457; files `OL_A_1.mat`/`OL_B_1.mat` in 2016-05 folders | the same idea run inside the learning session (22 s dark, 70 s, LED off, `make_OL_map_posvec`), pre and post; `do_map = 0` in every 2017 copy |
| **No-retinal control** | `2016-12-02/06/*_11f03-no_ret_OL_map_naive` (5 sessions) | OL mapping (`viz_SBD_cold/hot`) in flies without all-trans-retinal → light-only control for the CsChrimson "heat" (**inferred** from the name) |
| **Early 2016-04/05 az_PL** (`HC-Gal4x2b/x3a/x5a_az_PL`, 52 sessions) | raw `expr.settings`: `num_trials 9, num_mock 1, fix_time 5, trial_time 70, is_imaging 1`; 11 trials, tests at 1 and 11; 2016-05-18 copy of `run_az_PL_experiment.m`: `1+10+4 = 15` trials, tests at 1, 7, 13–15 (L180–185), `pause(10)` ITI, `fix_time 5`, in-script OL_A/OL_B | the pilot with a 5 s **fixation phase** (pattern 1 in closed loop, heat on) before VR, fewer training trials, extra interleaved tests. The 2016-04-25 folder's `run_optothermal.m`/`run_thermo_opto_trial.m` copies are a *different* experiment (`dir_resp`, `rot_gain .02`, a 3-state dark → stripe-fixation-until-still → VR machine with a time-indexed `light_vec`) — a copy-over, so those early sessions' code is only partly recoverable |
| **`dir_resp`** | `2016-05-16, 06-02/*HC-Gal4xUAS-Chr, UAS-Gcamp6m_dir_resp`, `run_optothermal.m` | optomotor / expansion patterns at gains ±34/45/113 with LED powers −4/−1.5/3.5 V — visual-response characterisation, not learning |
| **100-trial variant (commented out)** | `EXP` L282–386 | `for aa = 13:100`: a test every 6th trial (`mod(aa−12,6)==0`), `pause(10)` ITI, PI window trimmed by 15×45 samples — never active in the saved copies |
| **`is_dynamic_off`** | `EXP` L26; `TRIAL` L220–227 | would blank the panels whenever the fly is in heat (cue only in the cool zone); 0 everywhere, and buggy (`c_power` undefined) |
| **`reward_time`** | `EXP` L39; `TRIAL` L47 | early trial termination after `reward_frames` safe frames; `Inf` everywhere |
| `num_mock` | `EXP` L24 | "mock" = the extra test trials of the 2016 design (4 in the 15-trial May-2016 layout, 1 in April); vestigial in 2017 |

Distinct experiment-name suffixes across `20180921_data/az_pl/behavior/*/` and `processed/*/*`:
`HC-Gal4x2b_az_PL` (35), `HC-Gal4x5a_az_PL` (15), `HC-Gal4x3a_az_PL` (2), `HC-Gal4xUAS-Chr, UAS-Gcamp6m_dir_resp` (4),
`11f03xShits_cold_az_PL` (10), `11f03xShits_hot_az_PL` (10), `11f03xgcamp_hot_az_PL` (10), `11f03xShi_hot_end_az_PL` (12),
`11f03xShiTs_hot_end_az_PL` (6), `11f03xGcamp_hot_end_az_PL` (10), `11f03-no_ret_OL_map_naive` (5),
`11f03x6f_az_PL` (9), `11f03x6f{-,_}shift(ed)_az_PL` (8), `11f03x6f{-,_}ctr_az_PL` (7), and the paired
`11f03x6f*_OL_map_{naive,trained}` sessions (2 per imaging fly).

## 10. Mapping to the G6 rig (`florence_ch2_fig2-1_2-2_draft.yaml`)

| Original | G6 draft | Arithmetic / note |
|---|---|---|
| 96 positions, 3.75°/px, 96 × 32 px, 180° window | 200 frames, 1.8°/frame, 200 × 40 px, full 360° visible | frame `f ↔ th = 1.8 f`; pattern = the 96 × 32 `sbd` bitmap re-indexed so column increases with `th` and nearest-neighbour resampled to 200 × 40 (notes §3). The 360° view vs the original 180° window is a behavioural difference (open question) |
| `rot_gain 0.4` (cylinder-deg per ball-deg) | fictrac `gain: -1.8` (heading-deg per frame, 1:1 world-stable; decision 2026-09-17: TJ's 0.4 not replicated) | bridge: `idx = round((heading+offset)/gain)`; want `1.8·idx = 0.4·heading` ⇒ `gain = 1.8/0.4 = 4.5`. Sign follows the course P3 protocols (`-1.8` there = 1:1); confirm world-stable direction on the bench. Both systems integrate heading, so 0.4 is a pure scale (one cylinder turn per 900° of ball yaw) |
| cool zone centred th≈0: fully off 45°, `V≤0` 120°, nominal quadrant 90° | `led_activation.on_ranges: [[25,174]]` (LED ON = heat outside frames 175–24) | 90° quadrant = the thesis/online-PI definition; alternatives `[[34,166]]` (120°) or `[[13,187]]` (45°). The Gaussian ramp is not expressible — binary edge, `hysteresis 0` (the original had none) |
| start th 90 / 270, `randperm(2)` per trial | `frame_index` 50 / 150, 15-entry shuffled list (`randomize: true`) | a balanced permutation, not independent flips; **not enforced by today's bridge** (absolute heading → frame; needs a rebase-at-`startClosedLoop` change, notes Q3) |
| Position B = pattern 5 (90° rotation) | cool zone moved +90° → `[[0,24],[75,199]]`, starts 0 / 100 | same pattern; moving the LED band is equivalent to rotating the pattern; direction inferred from the thesis's V/H-seam statement |
| ctr: `rand_pat ∈ {2,3,4,5}` per training trial, test = pattern 2 | 4 offsets (0/90/180/270°) × 2 starts = 8 conditions, 15-entry shuffled list; tests = A geometry | shuffled list (4/4/4/3) ≈ uniform draws |
| 5 s dark, LED 1 V, panels off | `allOff` + `ledDrive led_percent` + `wait 5` before each trialParams | the runner's activator forces the LED off for the instant between trialParams and the first applied frame |
| 60 s closed loop | `trialParams` mode 3 + `startClosedLoop` / `wait 60` / `stopClosedLoop` | |
| test trials: uniform 1 V | `ledDrive led_percent` after trialParams, `ledDrive 0` after stop | |
| LED 1 V into an unknown driver | `led_percent 5` (**placeholder**, course `led5` value) | 1 V of a 0–5 V modulation input would be 20 % of the driver's current limit if it was an LEDD1B (inferred) — needs a titration |
| ITI 3 s + 30 s (behavior) / key press (imaging) | `iti` condition: `allOff` + `ledDrive 0` + `wait 33`, as block `intertrial` and between phases | |
| 17 × 65 s + 16 ITIs | 1633 s = 27 min 13 s | |
| "is < .25?" gate, `hot_end`, `do_map` | not encoded | operator steps / other experiments |

Remaining open questions (details in the notes file): the LED driver / irradiance (Q6); the exact
rotation and direction of pattern 5 and the frame direction of the SBD frames (Q1/Q7, need
`makePatternStructSBD.m` or the SD pattern files); which 180° of the cylinder the original fly saw and
whether to mask the G6 rear (Q4); the gain sign on this rig (Q5); implementing the start-position rebase
in the runner/bridge (Q3); whether to reproduce the Gaussian heat edge (Q8, would need a graded
`led_activation`); ITI length for the imaging-paced flies (Q7).
