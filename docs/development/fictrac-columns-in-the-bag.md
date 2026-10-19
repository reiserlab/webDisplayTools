# FicTrac columns in the MCAP bag — audit and recommended record (LAB-303)

**Status:** DECIDED (Michael, 2026-10-18): 10 columns, one record per frame, `float64`, one MCAP
message per frame (no batching; "simpler is better", 2× the JSONL accepted). Nothing in the recorder
changes with this PR; the implementation is its own PR (§4).
**Question:** the ROS 2 bridge (`ros2-poc/`, PR #254) records every FicTrac frame twice — the
25-column record as the adapter received it (`/fictrac/frame`, with the verbatim line) and the
closed-loop evaluation (`/arena/frame`). Since the bags will be pushed to the GitHub data repo like
the `.jsonl.gz` is today (Michael, 2026-10-18), bag size matters: which FicTrac columns does the bag
have to keep so it stays near the size of today's `.jsonl.gz`?
**Answer in one line:** keep 10 of the 25 columns (the 5 the behavior row has, plus the error score,
the three lab-frame delta-rotation components and the sequence counter), store them in the ONE
per-frame `/arena/frame` record and stop recording the raw FicTrac topics by default. Measured on the
two bench bags with a chunk-only index and zstd 19, one message per frame: **2.24× and 2.48×** the
`.jsonl.gz` (today's bags: 10.2× and 30.4×; all 25 columns: 4.5× and 5.5×). For a 30 minute run at
50 Hz that is ≈ 5 MB against ≈ 2.3 MB today. Two levers were measured and deliberately not pulled:
batching the records 1 s per message (1.94× / 2.14×) and an `int32` fixed-point encoding at the
JSONL's own 5-decimal precision (≈ 1.5×); both stay available if the data repo's growth ever needs
them.

Constraints honored: `BEHAVIOR_V1_COLS` is never widened; MCAP is the record and the `.jsonl.gz` a
derived, transitional, FicTrac-only format (retired by 2026-12-31); the converter's derived file must
stay byte-identical to the live writer's (`converted == live`, the harness's fidelity gate).

Related: `telemetry-logging-reference.md` (run-log format authority), `runlog-behavior-v2-plan.md`,
`closed-loop-bias.md` (heading tare), plan file §3 (rev5, "decision pending — measured before forking
the archive path").

---

## 1. The 25 FicTrac columns: meaning, readers, derivability

Column definitions from FicTrac's own documentation,
[`doc/data_header.txt`](https://github.com/rjdmoore/fictrac/blob/master/doc/data_header.txt)
(rjdmoore/fictrac, last changed in commit `7894ebb`, 2019-12-06), cross-checked against the code that
produces the line,
[`src/Trackball.cpp`](https://github.com/rjdmoore/fictrac/blob/master/src/Trackball.cpp)
(`Trackball::updateTrackball` for the integrals, `Trackball::logData` for the column order,
`ss.precision(14)` for the text precision). What the code says, because every "derivable" verdict
below rests on it:

```
velx      = dr_lab[1];  vely = -dr_lab[0]          // sphere rolling, radians/frame, heading ignored
step_mag  = hypot(velx, vely)                      // col 19
step_dir  = atan2(vely, velx)                      // col 18
intx     += velx;  inty += vely                    // cols 20-21 ("two optic mice")
heading  -= dr_lab[2]   (wrapped to [0, 2π))       // col 17
posx/posy += step_mag along (velx, vely) rotated   // cols 15-16, integrated in 4 sub-steps
             by the heading, mid-step heading       //   across the frame's heading change
```

Readers audited (every one that touches a FicTrac quantity today): `fictrac-bridge/bridge.py`
(`behavior_v1_row`, `Pipeline.handle_line`, `advance_heading`), `js/kinematics.js` (live scope +
dashboard derivations), `js/runlog-replay.js` (`COL_X/Y/HD/TS` for `full`-level logs),
`js/studio-replay.js` (`ballDelta`/`ballStep`, the 3D ball) and `js/fly-gait.js` (walks from
`ballDelta`), `dashboard/data-browser/analysis-core.js` + `plot-specs.js` (`centralDiff` →
forward / speed / turning / heading, `fc` gaps), `scripts/closed-loop-report.py` (`ms, fc, idx, hd`;
`f[0]`, `f[16]` on `full` logs), `scripts/runlog-check.py` (counts rows), `scripts/bench-check.py`
(`ms, idx`), `scripts/telemetry-report.py` / `wedge-scan.py` (skip FicTrac rows),
`fictrac-bridge/fictrac_sim.py` (writes all 25; col 22 in ns), and in `ros2-poc/`:
`nodes/bridge_node.py` (`arena_frame_msg`), `nodes/mcap_convert.py` (`frame_line`,
`fictrac_fields`: the 25 columns are read ONLY for `--level full`), `interfaces/…/FicTracFrame.msg`,
`interfaces/…/ArenaFrame.msg`. The MATLAB tools do not read these logs.

| Col | FicTrac name | Units (per the doc / code) | Read today by | Derivable from the kept set? | Verdict |
|---|---|---|---|---|---|
| 1 | frame counter | integer, video frame index from 1 | every reader (`fc`): drop detection, join key, `ft_reset` inference | no | **keep** |
| 2–4 | delta rotation vector, camera frame | rad, axis-angle (x right, y down, z forward) | nobody | yes: cols 6–8 rotated by the fixed camera→lab transform in the FicTrac config | drop |
| 5 | delta rotation error score | dimensionless (optimizer residual; frames above `opt_max_err` are dropped by FicTrac) | nobody (the simulator writes 0) | no | **keep** (the only tracking-quality signal) |
| 6–8 | delta rotation vector, lab frame | rad/frame, axis-angle in lab coordinates | nobody directly; every integral below is computed from them | col 8 exactly (= −Δcol 17, wrapped); cols 6–7 only approximately from Δcols 15–16 and col 17, because `posx/posy` are integrated in 4 sub-steps across the frame's heading change and because after a dropped frame the sum of two rotation vectors is not their composition | **keep** (the primary measurement; 24 B/frame) |
| 9–11 | absolute rotation vector, camera frame | rad | nobody | yes: composition of cols 2–4 | drop |
| 12–14 | absolute rotation vector, lab frame | rad | nobody | yes: composition of cols 6–8 (note: col 17 is a separate scalar integral of −col 8, not col 14) | drop |
| 15–16 | integrated x / y position, lab | rad (× ball radius = distance) | every reader (`x`, `y`): velocity by differencing, forward/side projection, ball replay | in principle from 6–8 + 17 by re-running FicTrac's sub-step integration; not worth the fragility | **keep** |
| 17 | integrated animal heading | rad, wrapped [0, 2π) | every reader (`hd`): turning, closed-loop tare + mapping, ball yaw | Σ −col 8 (needs the start value) | **keep** |
| 18 | animal movement direction | rad, relative to the animal | nobody (`kinematics.js` computes `move_dir` from Δx, Δy) | yes, exactly: `atan2(−col 6, col 7)` | drop |
| 19 | animal movement speed | rad/frame | nobody (`kinematics.js` computes `speed` from Δx, Δy; verified on the bench bag to 1.6e-6) | yes, exactly: `hypot(col 6, col 7)` | drop |
| 20–21 | integrated forward / side motion | rad ("two optic mice") | nobody (`kinematics.js` projects Δx, Δy onto the heading instead) | yes, exactly: running sums of col 7 and −col 6 | drop |
| 22 | timestamp | the doc says ms (video position or since epoch); on our rigs a ns camera clock, divided by 1e6 in the bridge (`FT_TS_NS_PER_MS`) | every reader (`ft`): THE derivative time base; gap detection | no | **keep** (store the native value too, see §2) |
| 23 | sequence counter | integer; equals col 1 until FicTrac's tracking is reset, then restarts at 1 | nobody (the bridge infers a reset from col 1 going backwards → `heading_tare reason:"ft_reset"`) | no | **keep** (makes a reset explicit; compresses to nothing) |
| 24 | delta timestamp | ms since the previous frame | nobody (`kinematics.js` deliberately uses col 22 differences, which survive a dropped row; Frank, #143) | yes, exactly: col 22 − previous col 22 (verified 0.0 on the bench bag) | drop |
| 25 | alt. timestamp | ms since midnight | nobody | yes: same clock as col 22 (verified) | drop |

Two facts worth keeping in mind. First, the `.jsonl.gz` row `[ms, fc, idx, ft, x, y, hd]` keeps
cols 1, 22, 15, 16, 17 rounded to 5 decimals (`ft` to 3), which is a large part of why it is small
(≈ 25 B per frame after gzip). Second, a real FicTrac prints every value with 14 significant digits, so
the verbatim `raw` string the typed `FicTracFrame` carries is ≈ 400 B per frame on a rig (the bench
bags were simulator-fed at 6 decimals, ≈ 300 B); the record as written today is the 25 `float64`
fields AND that string.

## 2. Recommended recorded set and record shape

**Columns kept (10):** 1, 5, 6, 7, 8, 15, 16, 17, 22, 23.

| Column | Why it is in |
|---|---|
| 1 `fc` | join key for everything; gap / drop detection; the behavior row's `fc` |
| 5 `err` | the only per-frame tracking-quality value; not derivable; lets analysis flag or weight frames (today nothing does, because nothing has it) |
| 6–8 `dr_lab` | the measurement everything else is integrated from; the 3D replay's ball integration (`ballDelta`: yaw = Δhd, pitch = forward, roll = side) is an approximation of exactly these three numbers; not exactly recoverable (sub-step integration, dropped frames) |
| 15–16 `x`, `y` | the behavior row; every velocity in the lab's analysis is a difference of these |
| 17 `hd` | the behavior row; the closed-loop tare and mapping; turning |
| 22 `ft` | the behavior row; the derivative time base; the FicTrac clock in the three-clock model |
| 23 `ft_seq` | a tracking reset becomes a recorded fact instead of an inference |

**Columns dropped (15) and why that is safe:** 2–4, 9–11, 12–14 (rotations in the camera frame and
both absolute rotation vectors) are rotations of, or compositions of, cols 6–8 — nobody reads them, and
the camera→lab transform is in the rig's FicTrac config if anyone ever needs the camera frame. 18, 19,
20, 21 are exact functions of cols 6–7 (direction, speed, the two running sums); the lab already
re-derives direction, speed, forward and side from Δx/Δy in `js/kinematics.js` and the dashboard
(`centralDiff`), and will be able to do so exactly from the kept 6–7. 24 is col 22 differenced
(kinematics avoids it on purpose: it cannot recover elapsed time across a dropped row). 25 is col 22 on
a different origin. None of these appear in the behavior row, in `kinematics.js`, in the replay, in the
dashboard, in any script, or in the converter other than as the undifferentiated 25 of `--level full`.

**Record shape: ONE record per FicTrac frame on `/arena/frame`.** Today the bag holds two per-frame
records, and the FicTrac one (`fields[25]` + the verbatim line) is 68–77 % of the bytes while
`/arena/frame` already repeats cols 1, 15, 16, 17, 22 beside the evaluation (`idx`, `ms`, `t_ms`,
`epoch`, `bias_deg`, `seq`). The recommendation is to extend `ArenaFrame` with the five extra values
and stop recording `/fictrac/frame` and `/fictrac/raw` by default:

```
# ArenaFrame.msg — additions (the existing fields stay; names final at implementation)
float64 err          # FicTrac col 5, delta-rotation error score
float64 dr_lab_x     # FicTrac cols 6-8, delta rotation vector in lab coordinates, rad/frame
float64 dr_lab_y
float64 dr_lab_z
int64   ft_seq       # FicTrac col 23, sequence counter (restarts at 1 on a tracking reset)
int64   ft_ns        # FicTrac col 22 as received (native unit; ns on our rigs). `ft` stays the relative ms
uint8   flags        # bit 0: untracked frame (an "FT_BADFR" line — no columns; fc/seq only when FicTrac sent them)
```

Why merged rather than a trimmed separate FicTrac topic: it is what the JSONL already is (one merged
row per frame, which is why the sizing study's 0.75–1.16× held only for that layout); the two-topic
variant with the same 10 columns measures 3.2× / 3.8× against 1.9× / 2.1× merged, and even after
deduplicating `x/y/hd/ft` out of `ArenaFrame` it stays at 2.5× / 2.8× (table in §3). The values in the
merged record are the floats the adapter parsed from the very bytes the closed-loop math consumed, so
nothing the record of truth needs is lost; what is lost is the verbatim line, and that is precisely
Michael's decision. The live topics are unchanged: the adapter keeps publishing `/fictrac/frame` (typed,
25 columns + raw) and `/fictrac/raw` for `ros2 topic echo`, Foxglove and the byte-for-byte bridge 3.4
math; recording them stays available as an opt-in (`--record-fictrac-raw`) for debugging a tracker.

**Encoding: `float64` (decided).** It is the ROS-idiomatic choice, lossless against FicTrac's
14-digit text, and the live topic and the bag keep ONE message type, so Foxglove plots the bag as it
plots the live topic. The alternative was measured and declined for now: the `.jsonl.gz` is small
partly because 5-decimal text has far less entropy than a `float64` mantissa, and an `int32`
fixed-point encoding at that precision buys ≈ 25 % (third-from-last row of the table). Its costs are
what decided against it: `x`/`y` grow without bound (an `int32` at 1e-5 rad overflows after ≈ 97 m
of walked path on a 9 mm ball, so they would need `int64`), every field needs a scale chosen for good
(the deltas at 1e-6 or finer, the error score's real-rig range is unknown), Foxglove cannot rescale a
message path so the recorded type would have to differ from the live one, and the node and the
converter would have to round identically. All of that for ≈ 1.5 MB per half-hour run. It stays the
knob to pull if the data repo's growth becomes a problem; it changes nothing in the readers but a
scale factor in the converter.

**Batching: one message per frame (decided).** The plan's tuning batched the per-frame record 1 s per
MCAP message, worth 13–16 % (rows in §3). Declined for simplicity: per record there is no
nested-array message type, no unbatching in the converter, a crash loses one frame instead of up to a
second, and the bag plots natively in Foxglove. The converter can learn a batched layout later and
both layouts can coexist in old and new bags.

**What a bad frame becomes.** FicTrac sends a tagged `FT_BADFR` line for a frame it could not track;
`Pipeline.handle_line` counts it (`skipped`) and emits no row, so no `/arena/frame` record exists
today and the frame is visible only as an `fc` gap. With the FicTrac topics no longer recorded, the
node should write one flagged record (`flags` bit 0, `fc`/`ft_seq` when present, numeric fields NaN)
so the bag says "untracked" rather than "missing". The JSONL is unaffected (no row, as today).

## 3. Measured bag sizes

Two real bench runs (Mac, 2026-10-14, simulator-driven FicTrac at 50 Hz, G6 controller, BIAS node;
`ros2-poc/runlogs/arena-log-20261014-194449-517` = 181 s, typed topics; `…-204300-169` = 164 s,
String fallback), each with its `.jsonl` as exported; `.jsonl.gz` = gzip −9 of that file, which is
what the Studio commits. Every MCAP variant is written by the pure-Python `mcap` writer the way
`ros2-poc/sizing/compare.py` does it: chunk index only (no per-message index), zstd level 19,
"batched" = one message per topic per wall-clock second holding that second's records. Column sets
are packed as little-endian structs (≈ typed CDR: `int64` for cols 1/23, `int64` ns for col 22,
`float64` otherwise); `/arena/frame` is re-packed from its decoded fields in BOTH bags so the typed
and the String run compare like for like; every other topic (`/arena/browser` echoes, `/bias/*`,
events, session) is kept byte for byte. Script: `bag_matrix.py` in this session's notes folder
(to be ported to `ros2-poc/sizing/columns.py`, §4).

| Variant (chunk-only index, zstd 19) | bag 1 (9 055 frames) | × jsonl.gz | bag 2 (8 199 frames) | × jsonl.gz |
|---|---:|---:|---:|---:|
| `.jsonl.gz` (reference) | 228 764 B | 1.00 | 162 356 B | 1.00 |
| as recorded today (rosbag2 defaults, 2 topics per frame, 25 cols + raw line) | 2 328 063 B | 10.2 | 4 932 680 B | 30.4 |
| two topics per frame, all 25 cols `float64`, both batched | 1 033 103 B | 4.52 | 887 532 B | 5.47 |
| two topics per frame, behavior 5 cols only, batched | 658 474 B | 2.88 | 541 897 B | 3.34 |
| two topics per frame, recommended 10 cols, batched | 737 263 B | 3.22 | 609 194 B | 3.75 |
| two topics, recommended 10, `ArenaFrame` without `x/y/hd/ft` (join by `fc`), batched | 561 371 B | 2.45 | 456 183 B | 2.81 |
| **one record per frame (ArenaFrame + cols 5, 6–8, 23), `float64`, one message per frame — ADOPTED** | **511 489 B** | **2.24** | **402 172 B** | **2.48** |
| one record per frame, `float64`, batched 1 s (declined, available later) | 443 004 B | 1.94 | 347 430 B | 2.14 |
| one record per frame, `int32` fixed-point × 1e-5, batched | 340 319 B | 1.49 | 249 554 B | 1.54 |
| floor: no FicTrac extras at all (today's `ArenaFrame` alone, batched) | 360 902 B | 1.58 | 262 895 B | 1.62 |

Reading the table:

- The adopted record is **2.24× / 2.48×** today's `.jsonl.gz` (56 and 49 B per frame after
  compression against 25 and 20 B); the five extra columns cost ≈ 0.4–0.5× over the floor (the error
  score and sequence counter are nearly free, the three deltas are the bulk). In practice: a 30 minute
  run at 50 Hz (90 000 frames) is ≈ 5 MB instead of ≈ 2.3 MB; the BIAS video of the same run is
  gigabytes. Against the plan's framing (≈ 125 MB/day on a busy ball rig at 3×, i.e. ≈ 42 MB/day of
  `.jsonl.gz` today) this is ≈ 100 MB/day, so GitHub's comfortable ≈ 1 GB repository size is reached
  in about 10 busy rig-days instead of 24 — the data repo needs the rotation plan either way.
- Even with NO FicTrac extras the bag is ≈ 1.6× the JSONL: a per-frame `float64` record with its
  bookkeeping (`t_ms`, `ms`, `seq`, `epoch`, `bias_deg`, `has_ft`, the derived `turning_dps` /
  `forward_mms`) compresses to ≈ 32–40 B/frame against the JSONL's ≈ 20–25 B text row. Columns are
  one lever; encoding is the other (fixed-point: 1.5×). Dropping the two derived channels from the
  recorded record saves ≈ 1 % and is not worth a second message type.
- In the merged layout (measured on the batched variant) `/arena/frame` is 65–74 % of the bag; the arena-command echoes
  (`/arena/browser`) are most of the rest in bag 1 (14 %), nothing in bag 2 (that run sent one
  browser line). The JSONL spends 88–96 % of its bytes on the frame rows too, so the ratio is
  dominated by frame-row encoding, as it should be.
- The plan's rev5 note quotes ≈ 3.0× for all 25 columns and ≈ 1.8× at behavior resolution with the
  same tuning; this script measures 4.5× / 5.5× and 2.9× / 3.3× for the closest two-topic variants.
  The earlier numbers were produced with a different packing (not recoverable from the note); the
  figures here come from one script applied identically to every row, so compare rows within this
  table rather than against the note.

Caveats: the bench bags are simulator-fed (6-decimal text, `err` always 0, many structurally zero
columns), so real tracker data will compress somewhat worse in every row of the table, including the
reference `.jsonl.gz` — the ratios should hold better than the absolute bytes. Bag 2 was recorded on
the String path, so its `ArenaFrame` is re-packed here (its JSON form would be larger). The rosbag2
MCAP plugin's `compressionLevel: Slowest` is expected to be zstd 19 in the mcap C++ writer; verify on
the pinned `ros-jazzy-rosbag2-storage-mcap` when implementing, or apply the tuning in the
`reindex()` rewrite, which is pure Python and already where a cleanly closed run gets its final layout.

## 4. Code change list (not implemented here)

All under `ros2-poc/` on PR #254's branch, its own PR after the pilot starts (plan §3 said the
archive publisher is its own PR; this is the recorder half of the same decision).

1. **`interfaces/arena_interfaces/msg/ArenaFrame.msg`** — add `err`, `dr_lab_x/y/z`, `ft_seq`,
   `ft_ns`, `flags` (above). One type for the live topic and the bag, one message per frame, as today.
   The String fallback carries the same fields in its JSON object.
2. **`nodes/bridge_node.py`** — `arena_frame_msg()` takes the parsed FicTrac fields (the typed path
   has `m.fields`; the String path parses the line once with `fictrac_udp_adapter.parse_fictrac_line`)
   and fills the new fields; the hub message to the Studio and the JSONL row are untouched.
   `RecordingLogWriter.topics()` drops `/fictrac/frame` and `/fictrac/raw` from the recorded set
   unless `--record-fictrac-raw`; `_fictrac` / `_fictrac_typed` stop calling `record_device` for them
   (subscriptions unchanged). `record_frame` is unchanged (one record per frame). An `FT_BADFR` line
   records a flagged frame (`Pipeline.skipped` stays the counter) and `connector_status` reports
   `bad_frames`.
3. **`nodes/_rows.py`** — one `arena_frame_to_row(fields_dict) -> [ms, fc, idx, ft, x, y, hd]`
   shared by the node's live writer and the converter (today the mapping lives twice: in
   `arena_frame_msg` and in `mcap_convert.frame_line`'s typed branch).
4. **`nodes/mcap_convert.py`** — `frame_line` reads the new fields through `_rows.py` (the JSONL row
   is unchanged, so `converted == live` still holds); `--level full` is retired with a clear error for
   bags that have no `/fictrac/*` topic (it needs the 25 columns, which no longer exist; the only
   `full` readers, `runlog-replay.js` and `closed-loop-report.py`, read cols 1, 15–17, 22 of it and keep
   working on old files), and keeps working for the 2026-10-14 bags that do carry them.
5. **`nodes/recorder.py` / `nodes/mcap_index.py`** — the tuning: `IndexType.ALL & ~MESSAGE` and
   zstd 19 in `reindex()` (the pure-Python writer, same level swap as `sizing/compare.py`), applied
   from `Recorder.close()` for the `crashsafe` profile as today. If the `default` rosbag2 profile is
   kept as an option, pass `compression: Zstd`, `compressionLevel: Slowest`, `noMessageIndex: true`
   through `storage_config_uri`. `max_bag_bytes` stays off by default (plan §3).
6. **`sizing/columns.py`** — port `bag_matrix.py` (this session's notes folder) so the table above
   is reproducible from `pixi run size-columns -- runlogs/<run>.bag`; keep `compare.py` for the JSONL
   side.
7. **Tests, `tests/test_ros2_poc.py`** — (a) the merged record's new fields equal the columns of the
   FicTrac line that produced it (fc join against the live `/fictrac/frame` topic during the
   harness run); (b) the existing `converted == live` gate on the new record; (c) a bad-frame line
   yields a flagged record and no JSONL row; (d) the 2026-10-14 bags (two-topic layout) still convert;
   (e) a size regression: a synthetic 60 s × 50 Hz run's reindexed bag ≤ 3× its `.jsonl.gz`; (f)
   replace the "full level carries the 25 FicTrac columns" check by "full level refused without
   `/fictrac/*`".
   `tests/check_runlog_readers.js` is unchanged — the JSONL shape never changes. Docs: this file's
   §2 becomes the `ArenaFrame` field reference; `telemetry-logging-reference.md` gets a one-paragraph
   pointer (the JSONL section is unchanged).

Outside `ros2-poc/` nothing changes: `fictrac-bridge/bridge.py`, `js/kinematics.js`, the replay, the
dashboard and every script read the JSONL, whose rows are the same five columns as before.

## 5. Proposed Linear comment on LAB-303 (text only; not applied)

> **FicTrac columns in the bag — decision doc** (`docs/development/fictrac-columns-in-the-bag.md`,
> PR link). Audit of the 25 FicTrac columns against every reader (bridge, kinematics, replay,
> dashboard, scripts, converter): the behavior row's 5 are the only ones anything reads. Recommended
> record (DECIDED 2026-10-18): ONE `/arena/frame` record per frame = today's ArenaFrame + error
> score, the 3 lab-frame delta-rotation components and the sequence counter (10 of 25 columns),
> `float64`, one message per frame; `/fictrac/*` no longer recorded by default. Measured on the two
> 2026-10-14 bench bags (chunk-only index, zstd 19): **2.24× / 2.48× the jsonl.gz** — ≈ 5 MB per
> 30 min run at 50 Hz against ≈ 2.3 MB today (as recorded now 10×/30×; all 25 columns 4.5×/5.5×).
> Declined for simplicity, measured and available later: 1 s batching (1.9×/2.1×) and int32
> fixed-point (≈ 1.5×). The 2× growth is accepted; the data repo needs the rotation plan either way.
> Implementation = its own PR on #254's branch after the pilot starts (change list in the doc §4).
