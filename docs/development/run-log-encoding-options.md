# Run-log encoding options (course pipeline)

**Status:** proposal for review. **Tracking:** [#140](https://github.com/reiserlab/webDisplayTools/issues/140).

## TL;DR

The bench run-log (FicTrac-bridge JSONL, auto-committed per run to
`runlogs/<bench-id>/` in the course repo) should carry **turning behaviour +
forward locomotion** without bloating. Recommendation: log **4 curated FicTrac
fields** (per-frame side / forward / yaw + integrated heading) as **compact CSV
frame rows** (relative-ms timestamps, 4–5 significant-figure floats) interleaved
with JSON event rows. That's **~1.8 MB for a 15-minute run** — ~90 % smaller than
dumping all 25 columns as JSON, and even smaller than today's (behaviour-less)
default — while staying human-readable and self-describing.

## Context

- **One committed log = one run.** The bridge rotates a fresh file at each run
  start, so each file is scoped start-to-finish (bench-verified 2026-07-04).
- **GitHub ceiling ≈ 35 MiB/file** (Contents API; measured). Anything under a few
  MB is comfortable.
- **Frame rate ≈ 50 Hz** on the current bench (measured: 2506 frames / 50.1 s).
  A 15-min run ≈ **45,000 frames**. **Frame rows are ~99 % of the bytes**;
  session/runner events are a handful.
- All sizes below are estimates at 50 Hz. **Double the camera rate → double the
  file.**

## The behavioural fields to keep

Goal: turning + forward locomotion. FicTrac's **delta rotation vector in lab
coordinates (cols 6–8)** gives per-frame velocities on exactly these axes;
**integrated heading (col 17)** gives absolute orientation.

| key    | FicTrac col (1-based) | `fields[]` idx | meaning                      | unit      |
| ------ | --------------------- | -------------- | ---------------------------- | --------- |
| `side` | 6                     | 5              | sideways / slip velocity     | rad/frame |
| `fwd`  | 7                     | 6              | **forward** velocity         | rad/frame |
| `yaw`  | 8                     | 7              | **turning** velocity         | rad/frame |
| `hd`   | 17                    | 16             | integrated heading (facing)  | rad       |

**Scaling for analysis:** forward mm/s = `fwd × ball_radius × fps`; turning °/s =
`yaw × fps × 57.3`. The axis mapping (x = side, y = forward, z = yaw) is FicTrac's
standard lab-frame convention — worth a 10-second bench check (walk the ball
straight → `fwd` dominates; spin in place → `yaw` dominates) to confirm signs
before the course.

### Every frame row also carries identity + timing

The 4 fields above are the *behaviour*. Each frame row keeps them **in addition
to** the frame's identity + timing — **not instead of**:

| key     | source        | meaning                                                                                                            |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ms`    | bridge clock  | timestamp, stored as **relative ms since run start** (the absolute epoch start is logged once in `run_metadata`)   |
| `index` | arena         | the frame index the controller **displayed** at that instant — needed to correlate behaviour with what the fly saw |
| `seq`   | FicTrac       | FicTrac's own frame counter — lets you detect **dropped frames**; the one field you may drop (~8 B) if you don't need that QC |

So a full frame row is **`ms, seq, index, side, fwd, yaw, hd`** (7 values). The
size estimates below already include `index` + timestamp; `seq` adds ~8 B/frame
(~0.35 MB over a 15-min run) if kept.

Optional add-ons: cols 15–16 (integrated x/y position) for the 2-D walking path;
the full 25 columns for archival/QC.

## Encoding options — sizes for a 15-min run (45,000 frames @ 50 Hz)

| #     | Scheme                                             | data kept              | ~B/frame | 15-min file | vs #0 | readable    |
| ----- | -------------------------------------------------- | ---------------------- | -------- | ----------- | ----- | ----------- |
| 0     | Full 25 cols — verbose JSON (`--log-frames` today) | everything             | ~350     | **~16 MB**  | —     | yes         |
| 1     | Full 25 cols — CSV rows + JSON events              | everything             | ~260     | ~12 MB      | −26 % | yes         |
| 2     | Curated 4 — verbose JSON                           | turn + fwd + slip + hd | ~125     | ~5.6 MB     | −64 % | yes         |
| 3     | Curated 4 — short-key JSON (drop `"type"`)         | same                   | ~85      | ~3.8 MB     | −76 % | ~           |
| 4     | Curated 4 — CSV rows + JSON events (abs ms)        | same                   | ~53      | ~2.4 MB     | −85 % | yes+schema  |
| **5★**| **Curated 4 — CSV + relative-ms + rounded floats** | same                   | **~40**  | **~1.8 MB** | −89 % | yes+schema  |
| 6     | #5 + gzip (`.jsonl.gz`)                            | same                   | ~11      | ~0.5 MB     | −97 % | no (opaque) |
| —     | _today's default (no behaviour data)_              | seq / index / t        | ~66      | ~3.0 MB     | —     | yes         |

**Two levers do most of the work** (independent of the row format):

- **Relative time** — store ms-since-run-start (the epoch start is logged once in
  `run_metadata`) instead of the 13-digit absolute epoch. Saves ~7–8 B/frame —
  the single biggest field.
- **Float rounding** — FicTrac deltas are tiny; 4–5 significant figures is ample
  behavioural resolution.

**gzip** layers on top of _any_ row format (≈ 3–4× on CSV, ≈ 7× on verbose JSON)
as an escape hatch for an unusually long run — at the cost of GitHub inline
preview.

## Recommended scheme (#5)

Interleave: **JSON** for the few session/runner event rows, **bare CSV** for the
frame rows, with a one-time schema line. Parser rule: a line starting with `{` is
a JSON event; otherwise it's a CSV frame per the declared schema.

```jsonl
{"type":"logging_started","file":"arena-log-20260704-134533-129.jsonl","ms":1783187133129}
{"type":"run_metadata","run_id":"nkts77qj","experimenter":"michael","genotype":"Canton-S","rig_id":"bench01","protocol_filename":"g6_2x10_smoke.yaml","t0_ms":1783187133129,"ball_radius_mm":4.5,"fps":50}
{"type":"frame_schema","cols":["ms","seq","index","side","fwd","yaw","hd"]}
0,1054712,64,-0.0123,0.0345,0.0082,1.2345
20,1054713,64,-0.0110,0.0361,0.0075,1.2352
40,1054714,65,-0.0098,0.0357,0.0069,1.2359
{"type":"runner","phase":"sequence-complete","rx_ms":1783187183251}
{"type":"logging_stopped","ms":1783187183252}
```

- **Self-describing** — `frame_schema` gives column order; `run_metadata` carries
  the epoch start, ball radius, and fps needed to convert to real units.
- **Streamable** — the bridge writes each frame row as it arrives (no buffering).
- **~2.2 MB / 15-min run** with `seq` kept (~1.8 MB — table row #5 — if `seq` is
  dropped), far under the 35 MB ceiling even at 2× the frame rate or 3× the
  duration.

## Open questions

1. **Fields** — are `side / fwd / yaw / hd` the right minimal set, or do you also
   want raw delta-rotation-cam (cols 2–4) or absolute orientation (cols 12–14)
   for QC?
2. **Frame rate** — confirm the course cameras run ~50 Hz (drives every size).
   At 100 Hz, #5 is ~3.6 MB/15-min (still fine); full JSON (#0) would be ~32 MB,
   right at the ceiling.
3. **Archival** — keep a `full` (all-25) option alongside `curated` in case
   reprocessing later needs a dropped column?
4. **gzip** — acceptable to opt into `.jsonl.gz` for long runs, or must every
   committed log stay plain text on GitHub?
5. **Precision** — OK to round floats to ~5 sig figs? (`seq`, `index`, and the
   timestamp are all **kept** per frame alongside the 4 behavioural fields; `seq`
   is the only droppable one, ~8 B/frame, if dropped-frame QC isn't needed.)

## References

- Tracking issue: [reiserlab/webDisplayTools#140](https://github.com/reiserlab/webDisplayTools/issues/140)
- Shipped pipeline: PR #139 (Arena Studio v0.5 course data pipeline)
- FicTrac column reference: `rjdmoore/fictrac` → `doc/data_header.txt`
- This repo's column map: `fictrac-bridge/fictrac_sim.py` (header comment) +
  `frame_index_from_fictrac()` in `fictrac-bridge/bridge.py`
