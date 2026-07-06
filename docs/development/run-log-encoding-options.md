# Run-log encoding options (course pipeline)

**Status:** proposal for review. **Tracking:** [#140](https://github.com/reiserlab/webDisplayTools/issues/140).

## TL;DR

The bench run-log (FicTrac-bridge JSONL, auto-committed per run to
`runlogs/<bench-id>/` in the course repo) exists to correlate **what the fly did**
with **what the arena displayed** — FicTrac itself already records everything
about the fly's behaviour independently, so this log's job is the *bridge*
between the two, not a replacement for FicTrac's own file.

Two logging levels, both as **NDJSON**: every line is a valid JSON value —
frame rows are compact **JSON arrays** (positional, per a declared
`frame_schema`, relative-ms timestamps), interleaved with JSON object event
rows. A reader dispatches on the parsed type (`Array` → frame, `Object` →
event) — no custom line-format sniffing needed.

- **Minimal** — `[ms, fc, index]`: bridge timestamp, FicTrac frame counter,
  arena displayed frame. Enough to rejoin with FicTrac's own recording later
  via `fc`. **~1.8 MB for a 15-minute run** at 100 Hz.
- **Verbose** — minimal + `dt, x, y, hd, dir`: FicTrac's own inter-frame
  interval plus integrated position/heading, so turning + forward locomotion can
  be read straight out of the bridge log without a join. **~5.3 MB for a
  15-minute run** at 100 Hz.

No gzip — committed logs stay plain text on GitHub.

## Context

- **One committed log = one run.** The bridge rotates a fresh file at each run
  start, so each file is scoped start-to-finish.
- **GitHub ceiling ≈ 35 MiB/file** (Contents API; measured). Both levels above
  are comfortably under it even at several times the assumed run length.
- **Camera runs at ~100 Hz nominal, but frame-to-frame spacing is not constant.**
  You cannot recover per-frame velocity by assuming a fixed framerate. FicTrac
  hands you the real timing directly, so no assumption is needed:
  - **col 24 = "ms since previous frame"** — the actual inter-frame interval
    `dt`, per frame. This is the `dt` verbose logs (as `dt`), not a differenced
    absolute clock — which also sidesteps the col-22 clock-domain ambiguity
    (col 22 is "video position *or* epoch ms" depending on config).
  - **col 19 = "movement speed" (rad/frame)** — FicTrac's own per-frame speed,
    already normalised per frame (× ball radius → mm/frame; ÷ `dt` → mm/s).
  - **col 25 = "frame-capture time (ms since midnight)"** — an unambiguous
    absolute per-frame stamp, if one is ever wanted (wraps at midnight).
- **Frame rows are ~99% of the bytes**; session/runner events are a handful.
- All sizes below are **measured** (Python `json.dumps`, the bridge's serializer)
  over a modelled 15-minute run — 100 Hz × 900 s = 90,000 frames, an integrated
  random-walk path. Double the camera rate → double the file.

## Fields

### Both levels: identity + arena correlation

| key     | source        | FicTrac col | meaning                                                                        |
| ------- | ------------- | ----------- | ------------------------------------------------------------------------------- |
| `ms`    | bridge clock  | —           | timestamp, stored as **relative ms since run start** (epoch start logged once in `run_metadata`); aligns frames to the bridge-stamped arena/runner events |
| `fc`    | FicTrac       | 1           | FicTrac's frame counter — the join key back to FicTrac's own independent recording |
| `index` | arena         | —           | the frame index the controller **displayed** at that instant — needed to correlate behaviour with what the fly saw |

`fc` alone is sufficient to detect dropped frames (it increments by 1 per
camera frame); FicTrac's separate sequence counter (column 23) is not logged
here.

### Verbose adds: timing + behaviour

| key   | FicTrac col | meaning                              | unit |
| ----- | ----------- | ------------------------------------- | ---- |
| `dt`  | 24          | ms since the previous frame — FicTrac's own inter-frame interval (no framerate assumption, no clock-domain ambiguity) | ms |
| `x`   | 15          | integrated x position, lab coords    | rad (scale by ball radius) |
| `y`   | 16          | integrated y position, lab coords    | rad (scale by ball radius) |
| `hd`  | 17          | integrated heading (facing direction) | rad |
| `dir` | 18          | instantaneous movement direction     | rad |

`x`/`y` (integrated position) replace the raw per-frame delta-rotation vector
(columns 6–8): the integrated path is more directly useful for reconstructing
the 2-D walking trace, and forward/turning velocities can be recovered from
successive `x`/`y`/`hd` samples divided by the actual `dt` — see below.
`hd` and `dir` are recorded together because they answer two different
questions: `hd` is which way the fly is **facing**, `dir` is which way it's
**actually moving** — the two diverge during sideways slip, which is exactly
the behaviour this log needs to be able to see. (FicTrac's own per-frame speed,
col 19, is available too if a magnitude-only channel is preferred over deriving
it from `x`/`y`.)

**Deriving velocities (verbose only):** for consecutive rows `i-1, i`:

```
dt_s      = dt[i] / 1000                              # col 24, already the actual interval
dx, dy    = x[i]-x[i-1], y[i]-y[i-1]                  # rad
speed_mm  = hypot(dx, dy) * ball_radius_mm / dt_s
turn_dps  = deltaAngle(hd[i], hd[i-1]) * 57.3 / dt_s  # unwrap across ±π
```

Never substitute a nominal 100 Hz for `dt_s` — that's the assumption this
scheme exists to avoid. `dt` (col 24) is the interval itself, so no differencing
of an absolute clock is required.

## Byte audit — where every byte goes

Per-field average bytes in a **verbose** frame row, measured over the modelled
90,000-frame run (compact separators, no spaces):

| field        | avg B | share | note                                   |
| ------------ | ----: | ----: | -------------------------------------- |
| `y`          |  8.52 | 14.6% | integrated position — grows over the run |
| `x`          |  8.23 | 14.1% | integrated position — grows over the run |
| `fc`         |  7.00 | 12.0% | absolute join key (~7 digits)          |
| `hd`         |  6.39 | 10.9% | bounded ±π, 4 dp                       |
| `dir`        |  6.39 | 10.9% | bounded ±π, 4 dp                       |
| `ms`         |  5.88 | 10.1% | relative ms, grows to 6 digits         |
| `dt`         |  3.52 |  6.0% | ms since previous frame (~10) — tiny   |
| `index`      |  2.45 |  4.2% | 0–199                                  |
| _(structure)_ | 10.00 | 17.1% | 2 brackets + 7 commas + newline        |
| **total**    | **58.4** |    | **→ 5.25 MB / 15-min**                 |

Row totals (measured):

| level                            | B/frame | 15-min file |
| -------------------------------- | ------: | ----------: |
| **minimal** `[ms,fc,index]`      |    20.3 |    1.83 MB  |
| **verbose** (8 fields)           |    58.4 |    5.25 MB  |
| verbose as keyed objects `{…}`   |   100.4 |    9.03 MB  |
| full 25 cols (archival, opt-in)  |    ~350 |   ~31.5 MB  |

**Levers, ranked by payoff:**

1. **Timing = col 24, not a raw absolute clock.** As a single field: col 24
   (`dt` ≈ 10) = **3.5 B**, col 25 = 10 B, col 22 raw epoch = **15 B**. Using
   col 24 saves **~11.5 B/frame ≈ 1.0 MB/run** *and* is the correct answer to
   the timing question (below).
2. **Compact separators are mandatory.** The bridge must serialize frame rows
   with `separators=(",", ":")` — Python's `json.dumps` **default adds a space
   after every comma** (+7 B/frame ≈ 0.6 MB/run for nothing).
3. **Positional arrays, not keyed objects.** The array row (58 B) vs. the same
   fields as a keyed object (100 B) saves **~42 B/frame ≈ 3.8 MB/run** by not
   repeating key names every line — this is why the scheme is arrays + a
   one-time `frame_schema`.
4. **Relative `ms`** — ms-since-run-start (epoch logged once in `run_metadata`)
   instead of the 13-digit absolute epoch; the single biggest per-field saving.
5. _(minor, not recommended)_ `fc` relative-to-run would save ~2 B/frame but
   complicates the join key — keep `fc` absolute.

Note that `x`/`y` are the largest *data* fields precisely because integrated
position grows over a long walk; their size is also the most run-dependent (an
active, forward-walking fly accumulates bigger numbers). If size ever bites,
logging per-frame *deltas* instead is the escape hatch — at the cost of
reintroducing the differencing/drift question the integrated fields avoid.

## Recommended scheme

**Uniform NDJSON** — every line is one JSON value: session/runner events are
JSON **objects**, frame rows are JSON **arrays** (positional, per the
one-time `frame_schema` line declaring which level is in use and column
order). A reader does one `JSON.parse()` per line and dispatches on the
parsed type — `Array.isArray(v)` → frame row indexed against
`frame_schema.cols`, else → event object. No line-format sniffing, no
non-JSON lines anywhere in the file.

Minimal:

```jsonl
{"type":"logging_started","file":"arena-log-20260704-134533-129.jsonl","ms":1783187133129}
{"type":"run_metadata","run_id":"nkts77qj","experimenter":"michael","genotype":"Canton-S","rig_id":"bench01","protocol_filename":"g6_2x10_smoke.yaml","t0_ms":1783187133129,"ball_radius_mm":4.5,"fps":100}
{"type":"frame_schema","level":"minimal","cols":["ms","fc","index"]}
[0,1054712,64]
[10,1054713,64]
[20,1054714,65]
{"type":"runner","phase":"sequence-complete","rx_ms":1783187183251}
{"type":"logging_stopped","ms":1783187183252}
```

Verbose (`dt` = col 24, small ms-since-previous-frame values):

```jsonl
{"type":"logging_started","file":"arena-log-20260704-134533-129.jsonl","ms":1783187133129}
{"type":"run_metadata","run_id":"nkts77qj","experimenter":"michael","genotype":"Canton-S","rig_id":"bench01","protocol_filename":"g6_2x10_smoke.yaml","t0_ms":1783187133129,"ball_radius_mm":4.5,"fps":100}
{"type":"frame_schema","level":"verbose","cols":["ms","fc","index","dt","x","y","hd","dir"]}
[0,1054712,64,9.9,12.3456,-4.5678,1.2345,1.1987]
[10,1054713,64,10.2,12.3501,-4.5701,1.2358,1.1990]
[20,1054714,65,9.7,12.3549,-4.5719,1.2371,1.1994]
{"type":"runner","phase":"sequence-complete","rx_ms":1783187183251}
{"type":"logging_stopped","ms":1783187183252}
```

- **Self-describing** — `frame_schema` gives the level and column order;
  `run_metadata` carries the epoch start, ball radius, and nominal fps needed
  to convert to real units.
- **Streamable** — the bridge writes each frame row as it arrives (no
  buffering), with `separators=(",", ":")`.
- **Tool-compatible** — the whole file is valid NDJSON; any generic NDJSON/JSON-Lines
  reader can consume it line-by-line without a bespoke parser.

## Decisions (from review)

1. **Per-frame timing — RESOLVED: use col 24 (`dt`), not col 22.** FicTrac's
   col 24 ("ms since previous frame") is the actual inter-frame interval
   directly — no framerate assumption, no differencing, and it avoids col 22's
   "video position *or* epoch ms" ambiguity. Col 19 (FicTrac's own speed) and
   col 25 (frame-capture time) are available if wanted. **One remaining bench
   check:** confirm the course's FicTrac build actually populates cols 24/25
   (some configs leave them 0); if not, fall back to differencing col 22 stored
   as-is. (Can't be checked on the simulator — it emits a perfectly regular
   col 24.)
2. **Rounding — RESOLVED: yes, with fixed decimal places for the integrated
   fields.** `dt` is small (col 24 ≈ 10 ms) so 0.1 ms is ample; `hd`/`dir` are
   bounded ±π so 4–5 sig figs is fine. For `x`/`y`, use **fixed decimal places
   (e.g. 4 dp), not significant figures** — integrated position grows large over
   a run, and sig-fig rounding would swallow the tiny frame-to-frame delta that
   the velocity derivation depends on.
3. **Archival — RESOLVED: yes, keep a `full` (all-25-column) opt-in mode**
   (today's `--log-frames`), default off. Caveat: at 100 Hz a 15-min full log is
   ~31.5 MB, right against the ~35 MB GitHub ceiling — a long full run should be
   chunked or skip the auto-commit.

## References

- Tracking issue: [reiserlab/webDisplayTools#140](https://github.com/reiserlab/webDisplayTools/issues/140)
- Shipped pipeline: PR #139 (Arena Studio v0.5 course data pipeline)
- FicTrac column reference: `rjdmoore/fictrac` → `doc/data_header.txt`
- This repo's column map: `fictrac-bridge/fictrac_sim.py` (header comment) +
  `frame_index_from_fictrac()` in `fictrac-bridge/bridge.py`
