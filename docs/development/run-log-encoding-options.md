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
  via `fc`. **~1.68 MB for a 15-minute run** at 100 Hz.
- **Verbose** — minimal + `ts, x, y, hd, dir`: FicTrac's own per-frame timestamp
  plus integrated position/heading, so turning + forward locomotion can be read
  straight out of the bridge log without a join. **~5.4 MB for a 15-minute run**
  at 100 Hz.

No gzip — committed logs stay plain text on GitHub.

## Context

- **One committed log = one run.** The bridge rotates a fresh file at each run
  start, so each file is scoped start-to-finish.
- **GitHub ceiling ≈ 35 MiB/file** (Contents API; measured). Both levels above
  are comfortably under it even at several times the assumed run length.
- **Camera runs at ~100 Hz nominal, but frame-to-frame spacing is not constant.**
  You cannot recover per-frame speed by assuming a fixed framerate and dividing
  by frame count — the actual inter-frame interval has to come from FicTrac's
  own per-frame timestamp (column 22). This is why `ts` is a required verbose
  field, not an optional QC add-on.
- **Frame rows are ~99% of the bytes**; session/runner events are a handful.
- All sizes below are estimates at 100 Hz over a 15-minute run (90,000 frames).
  Double the camera rate → double the file.

## Fields

### Both levels: identity + arena correlation

| key     | source        | FicTrac col | meaning                                                                        |
| ------- | ------------- | ----------- | ------------------------------------------------------------------------------- |
| `ms`    | bridge clock  | —           | timestamp, stored as **relative ms since run start** (epoch start logged once in `run_metadata`) |
| `fc`    | FicTrac       | 1           | FicTrac's frame counter — the join key back to FicTrac's own independent recording |
| `index` | arena         | —           | the frame index the controller **displayed** at that instant — needed to correlate behaviour with what the fly saw |

`fc` alone is sufficient to detect dropped frames (it increments by 1 per
camera frame); FicTrac's separate sequence counter (column 23) is not logged
here.

### Verbose adds: timing + behaviour

| key   | FicTrac col | meaning                              | unit |
| ----- | ----------- | ------------------------------------- | ---- |
| `ts`  | 22          | FicTrac's own per-frame timestamp — the actual inter-frame interval, not an assumed one | ms |
| `x`   | 15          | integrated x position, lab coords    | rad (scale by ball radius) |
| `y`   | 16          | integrated y position, lab coords    | rad (scale by ball radius) |
| `hd`  | 17          | integrated heading (facing direction) | rad |
| `dir` | 18          | instantaneous movement direction     | rad |

`x`/`y` (integrated position) replace the raw per-frame delta-rotation vector
(columns 6–8): the integrated path is more directly useful for reconstructing
the 2-D walking trace, and forward/turning velocities can be recovered from
successive `x`/`y`/`hd` samples divided by the actual `ts` delta — see below.
`hd` and `dir` are recorded together because they answer two different
questions: `hd` is which way the fly is **facing**, `dir` is which way it's
**actually moving** — the two diverge during sideways slip, which is exactly
the behaviour this log needs to be able to see.

**Deriving velocities (verbose only):** for consecutive rows `i-1, i`:

```
dt_s      = (ts[i] - ts[i-1]) / 1000                  # actual inter-frame interval
dx, dy    = x[i]-x[i-1], y[i]-y[i-1]                  # rad
speed_mm  = hypot(dx, dy) * ball_radius_mm / dt_s
turn_dps  = deltaAngle(hd[i], hd[i-1]) * 57.3 / dt_s  # unwrap across ±π
```

Never substitute a nominal 100 Hz for `dt_s` — that's the assumption this
scheme exists to avoid.

## Encoding options — sizes for a 15-min run (90,000 frames @ 100 Hz nominal)

| Scheme                                        | fields                          | ~B/frame | 15-min file | readable   |
| ---------------------------------------------- | -------------------------------- | -------- | ----------- | ---------- |
| Today's default (verbose JSON, no behaviour)   | `seq`/`index`/`t` per frame       | ~66      | ~5.9 MB     | yes        |
| Full 25 cols — verbose JSON (archival/QC only) | everything                        | ~350     | ~31.5 MB    | yes, but near the 35 MB ceiling |
| **Minimal — JSON array + relative ms**         | `[ms, fc, index]`                  | **~19**  | **~1.68 MB** | yes+schema |
| **Verbose — JSON array + relative ms**         | `[ms, fc, index, ts, x, y, hd, dir]` | **~60** | **~5.4 MB** | yes+schema |

**Three levers do most of the work** (independent of which level you pick):

- **Relative time** — store `ms` as ms-since-run-start (the epoch start is
  logged once in `run_metadata`) instead of the 13-digit absolute epoch. This
  is the single biggest per-field saving.
- **Float rounding** — FicTrac's position/heading fields don't need more than
  4–5 significant figures for behavioural resolution.
- **Positional arrays over keyed objects** — a `[...]` row per the declared
  `frame_schema` costs only 2 bytes (the brackets) over bare CSV, vs. repeating
  every field's key name on every row (the "today's default" and "full 25
  cols" rows above).

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

Verbose:

```jsonl
{"type":"logging_started","file":"arena-log-20260704-134533-129.jsonl","ms":1783187133129}
{"type":"run_metadata","run_id":"nkts77qj","experimenter":"michael","genotype":"Canton-S","rig_id":"bench01","protocol_filename":"g6_2x10_smoke.yaml","t0_ms":1783187133129,"ball_radius_mm":4.5,"fps":100}
{"type":"frame_schema","level":"verbose","cols":["ms","fc","index","ts","x","y","hd","dir"]}
[0,1054712,64,1783187133129.4,12.3456,-4.5678,1.2345,1.1987]
[10,1054713,64,1783187133139.1,12.3501,-4.5701,1.2358,1.1990]
[20,1054714,65,1783187133149.6,12.3549,-4.5719,1.2371,1.1994]
{"type":"runner","phase":"sequence-complete","rx_ms":1783187183251}
{"type":"logging_stopped","ms":1783187183252}
```

- **Self-describing** — `frame_schema` gives the level and column order;
  `run_metadata` carries the epoch start, ball radius, and nominal fps needed
  to convert to real units.
- **Streamable** — the bridge writes each frame row as it arrives (no
  buffering).
- **Tool-compatible** — the whole file is valid NDJSON; any generic NDJSON/JSON-Lines
  reader can consume it line-by-line without a bespoke parser.

## Open questions

1. **`ts` clock domain** — FicTrac's column-22 comment says "video position or
   epoch ms" depending on install/config. Need a bench check: if it's epoch ms
   on the same clock as the bridge, `ts` can be relativized against the same
   `t0_ms` as `ms` (shrinking it the same way); if it's a video-file position,
   it must be stored as-is and only differences (`ts[i]-ts[i-1]`) are
   meaningful.
2. **`ts`/`x`/`y` rounding** — FicTrac emits these as 6-decimal floats. OK to
   round `ts` to ~0.1 ms and `x`/`y`/`hd`/`dir` to ~4–5 significant figures for
   the committed log?
3. **Archival** — keep a `full` (all-25-column) option available on request
   for reprocessing/QC, alongside `minimal`/`verbose`, given it sits close to
   the GitHub file-size ceiling at 100 Hz?

## References

- Tracking issue: [reiserlab/webDisplayTools#140](https://github.com/reiserlab/webDisplayTools/issues/140)
- Shipped pipeline: PR #139 (Arena Studio v0.5 course data pipeline)
- FicTrac column reference: `rjdmoore/fictrac` → `doc/data_header.txt`
- This repo's column map: `fictrac-bridge/fictrac_sim.py` (header comment) +
  `frame_index_from_fictrac()` in `fictrac-bridge/bridge.py`
