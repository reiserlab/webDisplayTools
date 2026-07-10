# CSHL 2026 Course Data Dashboard

Static, browser-based JSONL viewer and protocol-aware analysis dashboard for the
CSHL 2026 course.

## What it does

- Opens one or more local JSONL files.
- Loads a same-origin JSONL URL.
- Browses a locally served course-repository checkout.
- Signs in to the private GitHub course repository with the same fine-grained
  personal-access-token flow and storage keys used by Arena Studio.
- Indexes run metadata without downloading complete runlogs, then loads full
  files only when selected.
- Opens a persisted rig-folder picker before indexing GitHub runlogs; the first
  selection defaults to the Arena Studio bench when one is configured.
- Shows rig and experimenter first in the run-selection dropdown.
- Switches between single-fly and grouped-fly analysis.
- Defaults grouped analysis to exact protocol family + genotype + sex, with
  explicit `ALL` options for pooling genotypes or sexes within one protocol.
- Keeps every runlog independently selectable so reruns and metadata mistakes
  are visible rather than silently excluded.
- Averages trials within each fly/run before averaging across flies.
- Exports each interactive plot as SVG, PNG, or CSV.
- Exports the focused run's derived frame table as CSV.
- Lets users set shared turning and forward plot ranges in the dashboard or fit
  padded shared ranges to the selected data; manual values persist locally.

The dark oscilloscope uses the Arena Studio channel order and colors. Analysis
plots use a white background and Plotly hover, zoom, pan, and reset controls.
Time-series matrices default to dashboard-controlled manual ranges (turning
+/-300 deg/s and forward 0-25 mm/s). Users can edit and persist those values or
choose Fit selected to compute one padded, rounded range spanning every
displayed trace in the selected dataset.

## Analysis pages

### p0 optogenetic intensity

- Grating turning, forward, and relative-heading time series
- Bar turning, forward, and relative-heading time series
- LED dose response
- CW and CCW remain signed and separate
- Trials align to LED or sham onset

### p1 optomotor and looming

- Optomotor matrices for turning, forward, and relative heading
- Rows are spatial period; columns are temporal frequency
- Static 0 Hz controls are included
- Loom matrices for turning, forward, and relative heading
- Rows are stimulus class; columns are loom speed
- Loom positions remain separate
- Signed optomotor tuning summary
- Folded optomotor summary with turning computed as `mean(CW, -CCW)` and
  forward velocity computed as `mean(CW, CCW)` within each fly
- Matched optomotor summary with turning above forward velocity, spatial period
  columns, and CCW/left turning sign-flipped into the CW/right frame

### p2 object choice

- Baseline/opto sweep matrices ordered from slow to fast
- Fixation time series and arena-frame diagnostics
- Full-360 reference-aligned occupancy plots with a 1% chance line
- Cardinal polar occupancy plots
- Harmonic object-choice preference summaries
- The first 2 s of each choice trial are excluded from occupancy/preference
  scoring

Unknown protocols receive generic condition-aligned turning, forward, and
relative-heading pages instead of failing import.

## Public page, private data

The dashboard itself can be public while its URL is distributed through private
course documentation. Private runlogs remain in
`reiserlab/cshl-2026-course`.

The sign-in flow uses:

- `studio_gh_pat` in `sessionStorage`, optionally `localStorage`
- `studio_gh_repo` in `localStorage`
- `Authorization: Bearer <token>` headers to `api.github.com`

The token is never placed in a URL, request body, runlog, CSV export, or console
message. The course token should be a fine-grained PAT restricted to the course
repository with Contents read/write access, matching Arena Studio.

The dashboard currently performs read operations only. Write permission is
retained on the shared course token so the same sign-in remains compatible with
Arena Studio and later metadata-correction workflows.

## Why the dashboard analysis is JavaScript

Plotly's Python interface ultimately renders interactive figures through
Plotly.js. Running Python directly on GitHub Pages would require Pyodide or
PyScript plus a JavaScript authentication/UI layer, adding a large startup
download while still leaving two integration surfaces.

This version therefore keeps one browser analysis implementation in JavaScript.
The FicTrac math is not reimplemented: `vendor/kinematics.js` is an exact copy of
`webDisplayTools/js/kinematics.js`, the shared Arena Studio source of truth.

## Run locally

From `/Users/reiserm/Documents/CSHL course prep`:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8766/dashboard/data-browser/
```

To browse the separate live checkout without GitHub authentication, serve the
common parent directory:

```bash
python3 -m http.server 8767 --bind 127.0.0.1 --directory /Users/reiserm/Documents
```

Then open:

```text
http://127.0.0.1:8767/CSHL%20course%20prep/dashboard/data-browser/?localRepo=/GitHub/cshl-2026-course/runlogs/
```

Direct links can load a same-origin runlog with `?data=...`. The `?repo=owner/name`
parameter pre-fills the private GitHub repository; a legacy `?repo=/local/path/`
value still pre-fills the local-server path.

## Source layout

- `app.js`: UI, repository loading, selection state, scope, and downloads
- `analysis-core.js`: JSONL parsing, trial/epoch normalization, kinematics, and metrics
- `plot-specs.js`: protocol adapters and Plotly figure/CSV specifications
- `github-repo.js`: PAT storage and private GitHub Contents API reads
- `vendor/kinematics.js`: unchanged shared Arena Studio FicTrac math

## Validation

Run:

```bash
node dashboard/data-browser/tests/test-analysis.js
node dashboard/data-browser/tests/test-github-client.js
```

The analysis test parses live p0, p1, and p2 fixtures, validates stimulus
alignment and p2 occupancy normalization, builds every protocol page, and checks
two-fly aggregation. The GitHub test verifies that the token appears only in the
Authorization header.
