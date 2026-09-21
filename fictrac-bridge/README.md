# FicTrac → Arena Console closed-loop bridge

A small local bridge that reads [FicTrac](https://github.com/rjdmoore/fictrac)
socket output, maps each record to an arena **frame index**, and pushes that index
to `arena_console.html` over a WebSocket. The browser displays that frame via the
arena's host-stepped display mode (Mode 3 / `SET_FRAME_POSITION`). In the reverse
direction the browser sends JSON log events back, which the bridge appends to a file.

```
 FicTrac ──(UDP recv / TCP client)──▶ bridge.py ──(ws://localhost:8765)──▶ arena_console.html
                                          │   ◀──── {"type":"log", …} ────┘
                                          └──────────▶ --log file (JSONL)
```

For development without a camera or a real FicTrac install, `fictrac_sim.py`
generates random-walk data in FicTrac's exact wire format.

## Why a bridge at all?

A browser can't read raw UDP/TCP and can't freely write local files. The bridge is
the local process that owns the FicTrac socket and the log file; the browser only
ever speaks WebSocket. (For a *tight* low-latency loop you could instead point a
bridge straight at the arena controller's TCP server on `:62222` and bypass the
browser — see "Latency" below. This tool keeps the browser in the loop on purpose.)

## Setup

Dependencies are managed with [pixi](https://pixi.sh) (same as `Arena-Firmware/`).
The only third-party package is `websockets`; everything else is the Python stdlib.
The pixi workspace lives at the **`webDisplayTools/` root** (`pixi.toml` / `pixi.lock`),
so run pixi from there:

```bash
cd "Generation 6/webDisplayTools"
pixi install          # creates the env from pixi.toml / pixi.lock
```

## Quick start (simulated FicTrac, no hardware)

Two pixi tasks are defined: `bridge` and `sim`. Arguments after `--` are forwarded
to the script (the same idiom the Arena-Firmware pixi tasks use).

**UDP (FicTrac's default live socket output):**

```bash
# terminal 1 — the bridge (binds UDP :60000, serves WebSocket :8765)
pixi run bridge -- --proto udp --frames 60 --log run.jsonl

# terminal 2 — the simulator (sends UDP datagrams to the bridge)
pixi run sim -- --proto udp --rate 50 --seed 1
```

**TCP (FicTrac's TCP server variant):** here FicTrac is the *server* and the bridge
connects to it, so start the simulator first.

```bash
pixi run sim    -- --proto tcp --rate 50          # listens, accepts one client
pixi run bridge -- --proto tcp --frames 60        # connects to the sim
```

Then open `arena_console.html`, connect to the arena (Web Serial), load a pattern
**in Mode 3**, open the **Closed-loop bridge** panel, connect to `ws://localhost:8765`,
and tick **activate fictrac**.

## Console panel controls

Once the bridge WebSocket is connected, the panel exposes:

- **activate fictrac … at port N** — apply each incoming frame index to the arena
  (Mode 3). The adjacent **at port** field is the UDP/TCP port the bridge listens on
  for FicTrac; changing it pushes a `config` message and the bridge re-binds its
  FicTrac input live.
- **log fictrac** — log the session to the bridge: **every received FicTrac frame**
  (frame number + timestamp, recorded even when *activate fictrac* is off) and every
  command sent to the arena. **Each time it's switched on it starts a new
  timestamped `arena-log-<date>.jsonl`** in the bridge's working directory (a fixed
  `--log` path keeps one file instead).
- **gain** + presets — degrees of heading per frame index (see below). Presets
  `1.8` and `−1.8` are `360/200` for a 200-position azimuthal pattern, forward and
  reversed. Edit `CL_GAIN_PRESETS` in `arena_console.html` to add more.

These are pushed to the bridge over the WebSocket, so a running bridge reconfigures
without a restart. The browser also sends the loaded pattern's frame count as the
index modulus when a Mode-3 pattern is loaded.

## Driving it from a real FicTrac

In your FicTrac config, set the socket destination to the bridge and run the bridge
with the matching `--proto`:

```
sock_host : 127.0.0.1
sock_port : 60000
```

FicTrac's default build emits **UDP** datagrams (`--proto udp`). The alternate
`SocketRecorder_*.src` build is a **TCP server** (`--proto tcp`). Either way each
record is the 25-field, comma-separated, newline-terminated line documented in
FicTrac's `doc/data_header.txt` — **prefixed with a message-type tag** (`FT, ` for
a good frame, `FT_BADFR, ` for one it couldn't track) that only appears on the
live socket output, not in offline `.dat` logs. `bridge.py` strips the `FT` tag
and skips `FT_BADFR` frames; `fictrac_sim.py`'s synthetic/generated output has no
tag (it mirrors the `.dat` format), so it won't catch a regression here — test
against a real FicTrac capture (or a recording with the tag prepended) if you
touch this parsing path.

## WebSocket message schema

```
bridge → browser:  {"type":"frame", "index":<int>, "seq":<int>, "t":<ms>,
                    "ms":<int>, "fc":<int>, "idx":<int>, "ft":<ms|null>,
                    "x":<rad>, "y":<rad>, "hd":<rad>, "bias":<deg>}
                     (the behavior_v1 fields — ms/fc/idx/ft/x/y/hd — drive the live
                      oscilloscope; index/seq/t stay for back-compatibility)
                     `bias` is present ONLY while a bias waveform is active: the angle
                     the disturbance is currently adding, for display. Additive — older
                     clients ignore it. NOT a behavior_v1 column (see below).
                     NOTE: `ft` is relative MILLISECONDS. FicTrac col-22 is the camera
                     hardware clock — NANOSECONDS on our rigs — normalized here via
                     FT_TS_NS_PER_MS. `ms` is the bridge wall-clock (display axis); `ft`
                     is the velocity time base (per-frame differences, drop-safe).
                   {"type":"hello_ack", "bridge":<str>, "levels":[<str>…], "level":<str>,
                    "logging":<bool>}
                     (reply to hello — the log levels this bridge can write, so the
                      browser can tell a stale bridge before a run; an old bridge
                      never replies to hello)
                   {"type":"log_control_ack", "enabled":<bool>, "level":<str>,
                    "requested":<str|null>, "file":<str|null>}
                     (reply to log_control — `level` is the level ACTUALLY in force;
                      an unknown requested level is ignored and this is how you know)
                   {"type":"log_export_result", "name":<str>, "content":<str>}
                     (reply to log_export; {"error":<str>} when nothing was written)
browser → bridge:  {"type":"hello", "client":"arena_console", "v":1}   (on connect)
                   {"type":"config", "fictrac_port":<int>, "gain":<float>,
                                     "offset":<float>, "frames":<int>,
                                     "bias":{"type":"none"|"constant"|"sine"|"square",
                                             "amplitude":<deg/s>, "frequency":<Hz>}}
                                                              (any subset; a message
                                                               CARRYING "bias" re-zeros
                                                               the bias phase clock AND
                                                               re-tares the heading)
                   {"type":"log_control", "enabled":<bool>,
                                          "level":"behavior_v2"|"behavior_v1"|"full"}
                                                              (open the log file; level
                                                               picks the log format)
                   {"type":"log", "event":<str>, ...arbitrary fields, "ms":<int>}
                   {"type":"log_export"}   (close the active log, stream it back whole)
```

The bridge always broadcasts the **latest** frame to each client and drops
superseded indices rather than queuing them, so a slow consumer never builds a
backlog. A `config` message applies `gain`/`offset`/`frames` immediately and
re-binds the FicTrac input when `fictrac_port` changes. `log_control{enabled:true}`
**starts a new timestamped log file** and re-zeroes the behavior_v1 `ms`/`ft`
clocks (false closes it; `--log-dir` picks where on-demand files land, default CWD).
The log is **uniform NDJSON** — one JSON value per line; a reader parses each line
and dispatches on `Array.isArray` (positional array vs event object), then on
`arr[0]` (`"a"` = arena echo, a number = frame). While logging is active the bridge
records:

- a one-time schema line — `{"type":"frame_schema","level":"behavior_v2",
  "cols":["ms","fc","idx","ft","x","y","hd"],"arena_cols":["t_off","dt","hex",
  "status","rx_off"],"t0":<epoch ms>}` (default) or the `behavior_v1` form without
  `arena_cols`/`t0` — then **every** FicTrac record it
  receives (before WS coalescing) as the positional array `[ms, fc, idx, ft, x, y, hd]`
  — `ms` bridge-relative ms, `fc` FicTrac frame counter (col 1), `idx` displayed
  arena index, `ft` FicTrac timestamp (col 22) as relative ms (**not** col-24 dt,
  which can't recover elapsed time across a dropped frame), `x`/`y`/`hd` integrated
  position + heading (rad, 5-decimal). The live scope + offline dashboard recompute
  every derived channel (turning/forward/side/speed/dir) from this via
  `js/kinematics.js`. The frame array is identical in `behavior_v1` and `behavior_v2`.
  The **browser picks the level** per run via `log_control`'s `level` (Arena
  Studio's runner asserts the level chosen in File ▾ → Run logging, overriding
  `--log-level`); the bridge answers with `log_control_ack` naming the level it
  will actually write. `full` logs the whole 25-column record
  (`{"type":"fictrac_frame", ..., "fictrac":[…25…]}`) for debug/archival, with no
  schema line.
- inbound browser `log` messages (e.g. Arena Studio's `{"event":"run_metadata", ...}`
  header line at recorded-run start), each stamped with `dir` and `rx_ms`, as
  verbatim JSON objects.
- the browser's `{"event":"arena_command", ...}` echo of every Web Serial command
  (one per closed-loop 0x70 frame command, ~100 Hz — 76 % of a `behavior_v1` file's
  bytes). Under **`behavior_v2`** each becomes the compact array
  `["a", t_off, dt, hex, status, rx_off]` (+ a 7th `error` string when non-null):
  `t_off`/`rx_off` are ms offsets from the schema line's `t0`, `hex` is the `head`
  bytes without spaces, `status` is the reply status or `null` on timeout. The
  constant/derivable v1 fields (`type`, `event`, `dir`, `len`, `echo` = the command
  byte, `ok` = `status === 0`; all three of `status`/`echo`/`ok` are `null` when no
  reply decoded) are restored on expansion — **lossless**, verified per line: an
  echo that does not fit the fixed shape is written verbatim instead. Measured on
  the course corpus (164 logs, 1.28 GB): v2 is 0.51× the v1 bytes overall and 0.38×
  on closed-loop P3 runs; v2.gz is 0.17× overall.
  `behavior_v1` writes the echo as the full object (the pre-2026-09 format).

**Converting existing files** (migration + testing readers on real data before a rig
produces v2), no sockets needed:

```bash
pixi run bridge -- --convert runlogs/rig1/run.jsonl run.v2.jsonl.gz   # v1 → v2 (+gzip)
pixi run bridge -- --convert run.v2.jsonl.gz run.v1.jsonl             # and back
```

Direction is auto-detected from the `frame_schema` line (`--to v1|v2` forces it);
`.gz` on either side is handled. The conversion is strict — an `arena_command` with
an unexpected key set aborts instead of dropping a field. `tests/test-bridge-behavior.py`
holds the round-trip unit tests; `scripts/runlog-v2-corpus.py` runs the same round
trip over every log in a course-repo clone and prints the size table.

`log_export` (Arena Studio's course pipeline) **closes** the active log —
guaranteeing complete, flushed content — and streams the whole file back to the
asking client as ONE `log_export_result` message (re-export after close re-reads
the same file, so a failed commit can retry). Message size is capped at 16 MiB
(`WS_MAX_SIZE`, up from the library's 1 MiB default) so a multi-MB experiment
log transfers without chunking.

## Customising the closed-loop policy

Edit **one function** in `bridge.py`:

```python
def frame_index_from_fictrac(fields, n_frames, gain, offset, bias_deg=0.0) -> int:
    ...
```

The default maps the animal's integrated **heading** (FicTrac field 17 →
`fields[16]`, 0-based) to
`index = round((heading° + offset + bias°) / gain) mod n_frames`.
`gain` is **degrees of heading per frame index** — `360/200 = 1.8` advances one
azimuthal position (one of 20 pixels × 10 surrounding columns) per index; a negative
gain reverses direction. `offset` is in degrees. Swap in integrated position
(`fields[14]`, `fields[15]`), speed (`fields[18]`), or any combination. `--frames N`
(the index modulus) should match the loaded pattern's frame count — the console
sends it automatically when you load a Mode-3 pattern.

## Bias / disturbance waveforms

`bias_deg` above comes from a second pure function, `bias_angle_deg(kind, amp_dps,
freq_hz, t_s)`. A **bias** is a smooth disturbance added to the loop so the display
keeps moving even when the fly holds still — the stimulus for disturbance-rejection
experiments. It is authored as a rotational **velocity** (deg/s peak); the bridge
integrates it analytically:

| `type` | `v(t)` | `b(t) = ∫v` | position range |
| --- | --- | --- | --- |
| `constant` | `A` | `A·t` | unbounded drift |
| `sine` | `A·cos(ωt)` | `(A/ω)·sin(ωt)` | `±A/(2πf)` |
| `square` | `A·sign(cos ωt)` | symmetric triangle | `±A/(4f)` |

Every waveform starts at `b(0) = 0` (no jump at onset), and the periodic two are
**zero-mean in position** — the display is pushed equally both ways. Since `A` is a
velocity, the position excursion shrinks as frequency rises. Reverse the direction by
negating the **amplitude**; negating the frequency is a no-op (both velocities are
cosines, even in ω).

Set it live from the browser with a `config` message carrying `bias`. Presence of the
key re-zeros the phase clock, so each closed-loop epoch starts at phase 0 — the web
runner does exactly this on every `startClosedLoop`, and pushes
`bias: {"type":"none"}` on `stopClosedLoop` to stop the integration. Each push also
writes a `bias_config` line into the log whose `ms` is in the **same relative timebase
as the behavior_v1 rows**, which is what makes `b(t)` exactly reconstructable offline
(the per-frame `bias` on the WebSocket is display-only; `BEHAVIOR_V1_COLS` is
deliberately not widened).

### Heading tare

FicTrac's integrated heading is absolute, so without a tare a closed-loop epoch opens
by snapping the display to `round(heading/gain)` — on real fly logs a median 55-156
frame jump (up to 340 deg of azimuth), i.e. the stimulus leaving the fly's view on the
first frame. Every epoch therefore re-zeros the heading: `hd0` is latched from the first
frame after the epoch opens, so the epoch starts where `frame_index` put it and moves
relative to that. The tared difference is wrapped into `(-180, 180]` so it reads as a
true relative turn (only the heading — the bias stays unbounded so `constant` keeps
rotating). Each latch writes a `heading_tare` log event carrying `hd0_deg`, which
offline analysis NEEDS: without it a recomputed index is off by `round(hd0/gain)`.

The tare is armed by epochs only, not at startup, so the plain Console closed loop
still maps absolute heading exactly as before.

Full reference, including the validation policy and the authoring YAML:
`docs/development/closed-loop-bias.md`.

## bridge.py options

| Option | Default | Meaning |
|---|---|---|
| `--proto {udp,tcp}` | `udp` | FicTrac transport. UDP: bind+receive. TCP: connect to FicTrac. |
| `--in-host` / `--in-port` | `127.0.0.1` / `60000` | FicTrac source address. |
| `--ws-host` / `--ws-port` | `127.0.0.1` / `8765` | WebSocket server address. |
| `--frames N` | `200` | Frame count of the loaded pattern (the index modulus); re-sent live by the console. |
| `--gain` | `1.8` | Degrees of heading per frame index (360/200); negative reverses. Re-settable live. |
| `--offset` | `0.0` | Heading offset in degrees. |
| `--bias-type` | `none` | Bias/disturbance waveform: `none`, `constant`, `sine`, `square`. A protocol's `startClosedLoop` overrides this live. |
| `--bias-amplitude` | `0.0` | Bias PEAK velocity in deg/s; negative reverses. |
| `--bias-freq` | `1.0` | Bias frequency in Hz for `sine`/`square`; ignored by `constant`. Must be non-zero for the periodic waveforms. |
| `--log PATH` | on demand | Append log events (JSONL). If unset, opened when the browser enables logging. |
| `--log-level {behavior_v2,behavior_v1,full}` | `behavior_v2` | Launch default for the log format; the browser's `log_control` overrides it per run (acknowledged in `log_control_ack`). |
| `--log-frames` | off | Alias for `--log-level full` (the 25-column FicTrac record per frame, debug/archival). |
| `--convert IN OUT [--to v1\|v2]` | — | Offline: re-encode a run log v1 ⇄ v2 (`.jsonl` or `.jsonl.gz` either side) and exit. |

## Replaying a recorded FicTrac log

Pass a CSV path to replay a recording instead of generating random data:

```bash
pixi run sim -- recording.csv                 # UDP, original real-time speed
pixi run sim -- recording.csv --speed 2       # 2× faster
pixi run sim -- recording.csv --proto tcp      # TCP server (bridge connects)
```

Each row is re-sent **verbatim**, paced by the inter-row difference of the
`timestamp` column (**col 22, milliseconds**), so the file plays at its original
speed; the first row goes immediately and non-increasing timestamps clamp to no
delay. It plays once, then exits. Lines without ≥22 fields or a numeric col 22
(e.g. a header) are skipped. Any comma-separated FicTrac `.dat`/CSV with ≥22
columns works.

## Replaying a REAL fly from one of our run logs

Every committed run log (`runlogs/<rig>/*.jsonl.gz`) carries the fly's FicTrac trace as
`[ms, fc, idx, ft, x, y, hd]` rows. `--replay` re-emits that heading/position as FicTrac
records at the original pacing — real saccade, bout and pause statistics with no model:

```bash
pixi run sim -- --replay path/to/run.jsonl.gz            # once, real time
pixi run sim -- --replay path/to/run.jsonl.gz --loop     # forever; heading stays continuous
pixi run sim -- --replay path/to/run.jsonl.gz --speed 3
```

The fly is **not reactive** (it cannot see what the arena shows), so this tests the
mapping — tare, wrap, modulus, coupling, link load — with realistic kinematics, not the
fly's response. `ms` restarts at 0 on every log activation; a backwards step is treated
as no delay, and gaps are capped at 1 s.

## A model fly in the loop (no camera, no ball, real arena)

`--model fly` closes the loop without FicTrac: the sim subscribes to the bridge's
WebSocket, reads the frame index the arena is showing (the bridge broadcasts every
`frame` to all clients), converts it to the feature's azimuth in the fly's view, and
turns like a fly would:

```bash
pixi run bridge                                          # 3.2+ (bias + tare)
pixi run sim -- --model fly --kp 2                       # fixates the feature
pixi run sim -- --model fly --kv 1 --kp 0                # pure optomotor follower
pixi run sim -- --model fly --kp 2 --pause-s 2 --seed 1  # walks in bouts, reproducible
```

```
ω_target = −kp·az − kv·d(az)/dt     az = wrap180(frame_dir · idx · deg_per_frame + feature_az0)
τ dω/dt  = ω_target − ω              + Ornstein–Uhlenbeck noise + Poisson saccades + walking bouts
```

Signs, once: FicTrac heading is **CCW-positive** (turning LEFT increases it); feature
azimuth is **right-positive**; `--frame-dir +1` (default) says an index increase moves
the feature RIGHT — the on-arena direction confirmed for a positive bias at gain +1.8.
Turning toward the feature is therefore `−kp·az`. With a correctly signed rig a `--kp`
fly parks the feature in front and, when a bias is installed, counter-turns it
(`closed-loop-report.py` prints that as `rejection ≈ 1`, with the steady-state lag a
proportional controller must have: 45° at kp 2 against 90 °/s). A `--kv` fly is
stabilizing too — following the retinal slip *is* counter-rotating the display
(rejection ≈ 0.5 at kv 1). The two failure signatures are unmistakable: a mis-signed
rig (or `--frame-dir`) parks a `--kp` fly's feature at **±180°** (anti-fixation), and
drives a `--kv` fly into a **runaway spin** (rejection ≪ 0). Measured in the virtual
loop (bridge + sim, no arena): kp 2 → frontal 92 %, rejection +0.99; kv 1 → +0.52;
kp 2 mis-signed → frontal 4–21 %, feature at 130–164°; kv 1 mis-signed → −61.
A frame older than `--stale-s` (no run in progress) counts as "display unseen": the fly
free-runs on noise and saccades so the ball keeps moving between trials.

Afterwards: `pixi run python scripts/closed-loop-report.py run.jsonl.gz --svg out.svg`
— per closed-loop epoch, the fly's turning, where the feature sat, the reconstructed
bias, the rejection index and the idx-consistency check.

## fictrac_sim.py options

| Option | Default | Meaning |
|---|---|---|
| `file` (positional) | — | FicTrac log (CSV) to replay; omit to generate random data. |
| `--proto {udp,tcp}` | `udp` | UDP: send datagrams. TCP: act as server (FicTrac role). |
| `--host` / `--port` | `127.0.0.1` / `60000` | UDP destination / TCP bind address. |
| `--rate` | `50` | *Generated / model mode:* records per second. |
| `--seed` | — | *Generated / model mode:* RNG seed for byte-reproducible output. |
| `--count N` | `0` | *Generated / model mode:* emit N records then exit (0 = forever). |
| `--speed` | `1.0` | *Playback / replay mode:* speed multiplier (`2` = twice real time). |
| `--noise`, `--turn-sigma`, `--jump-every`, `--jump-deg` | `1.0`, `0.05`, `0`, `90` | *Generated mode:* random-walk scale and the fw #50 soak knobs. |
| `--replay RUNLOG` / `--loop` | — | *Replay mode:* a bridge run log (`.jsonl[.gz]`) to re-emit; loop forever. |
| `--model fly` | — | *Model mode:* the closed-loop model fly (below). |
| `--bridge` | `ws://127.0.0.1:8765` | *Model:* bridge WebSocket to watch frames on. |
| `--kp` / `--kv` | `0` / `0` | *Model:* fixation gain (°/s per °) / optomotor gain (fly ω ÷ world ω). |
| `--tau` | `0.1` | *Model:* turning-response time constant (s). |
| `--noise-dps` / `--noise-tau` | `30` / `0.3` | *Model:* OU turning noise sigma (°/s) and time constant (s). |
| `--saccade-rate` / `--saccade-deg` / `--saccade-ms` | `0.5` / `45` / `80` | *Model:* Poisson saccades per s, mean amplitude, duration. |
| `--bout-s` / `--pause-s` | `4` / `0` | *Model:* mean walking bout / pause (0 = never pauses). |
| `--speed-rad-s` | `0.6` | *Model:* forward speed while walking (ball rad/s → cols 15/16/19/20). |
| `--heading0` | `0` | *Model:* initial heading (°). |
| `--deg-per-frame` / `--frame-dir` / `--feature-az0` | `1.8` / `+1` / `0` | *Model:* how a frame index becomes a feature azimuth (see signs above). |
| `--stale-s` | `1.0` | *Model:* a published frame older than this counts as "display unseen". |

## Notes & limitations

- **Mode 3 prerequisite.** The console only applies indices when a pattern is
  loaded and the arena is in Mode 3 (host-stepped). The panel shows a hint
  otherwise. The firmware rejects `SET_FRAME_POSITION` if no pattern is open or the
  index is ≥ the pattern's frame count.
- **Latency.** The path UDP → bridge → WebSocket → browser → Web Serial → Teensy
  adds JS-event-loop and USB-CDC overhead (tens of ms, with jitter). Fine for
  moderate rates with coalescing. For a tight loop, drive the controller's TCP
  server (`:62222`) directly and skip the browser.
- **Secure context.** `ws://localhost` / `ws://127.0.0.1` works from `file://` and
  `http://localhost`. If the console is ever served over `https`, only a localhost
  `ws://` is allowed; a remote `ws://` would be blocked as mixed content.
- **One driver.** Only one browser tab should hold the serial port and apply frames,
  even though the bridge can broadcast to several WebSocket clients.
