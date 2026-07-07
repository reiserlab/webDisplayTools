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
                    "x":<rad>, "y":<rad>, "hd":<rad>}
                     (the behavior_v1 fields — ms/fc/idx/ft/x/y/hd — drive the live
                      oscilloscope; index/seq/t stay for back-compatibility)
                   {"type":"log_export_result", "name":<str>, "content":<str>}
                     (reply to log_export; {"error":<str>} when nothing was written)
browser → bridge:  {"type":"hello", "client":"arena_console", "v":1}   (on connect)
                   {"type":"config", "fictrac_port":<int>, "gain":<float>,
                                     "offset":<float>, "frames":<int>}  (any subset)
                   {"type":"log_control", "enabled":<bool>}   (open the log file)
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
and dispatches on `Array.isArray` (frame array vs event object). While logging is
active the bridge records:

- a one-time schema line `{"type":"frame_schema","level":"behavior_v1",
  "cols":["ms","fc","idx","ft","x","y","hd"]}`, then **every** FicTrac record it
  receives (before WS coalescing) as the positional array `[ms, fc, idx, ft, x, y, hd]`
  — `ms` bridge-relative ms, `fc` FicTrac frame counter (col 1), `idx` displayed
  arena index, `ft` FicTrac timestamp (col 22) as relative ms (**not** col-24 dt,
  which can't recover elapsed time across a dropped frame), `x`/`y`/`hd` integrated
  position + heading (rad, 5-decimal). The live scope + offline dashboard recompute
  every derived channel (turning/forward/side/speed/dir) from this via
  `js/kinematics.js`. `--log-frames` switches to the full 25-column record
  (`{"type":"fictrac_frame", ..., "fictrac":[…25…]}`) for debug/archival.
- inbound browser `log` messages (e.g. `{"event":"arena_command", ...}` for every
  Web Serial command, or Arena Studio's `{"event":"run_metadata", ...}` header
  line at recorded-run start), each stamped with `dir` and `rx_ms`.

`log_export` (Arena Studio's course pipeline) **closes** the active log —
guaranteeing complete, flushed content — and streams the whole file back to the
asking client as ONE `log_export_result` message (re-export after close re-reads
the same file, so a failed commit can retry). Message size is capped at 16 MiB
(`WS_MAX_SIZE`, up from the library's 1 MiB default) so a multi-MB experiment
log transfers without chunking.

## Customising the closed-loop policy

Edit **one function** in `bridge.py`:

```python
def frame_index_from_fictrac(fields, n_frames, gain, offset) -> int:
    ...
```

The default maps the animal's integrated **heading** (FicTrac field 17 →
`fields[16]`, 0-based) to `index = round((heading° + offset) / gain) mod n_frames`.
`gain` is **degrees of heading per frame index** — `360/200 = 1.8` advances one
azimuthal position (one of 20 pixels × 10 surrounding columns) per index; a negative
gain reverses direction. `offset` is in degrees. Swap in integrated position
(`fields[14]`, `fields[15]`), speed (`fields[18]`), or any combination. `--frames N`
(the index modulus) should match the loaded pattern's frame count — the console
sends it automatically when you load a Mode-3 pattern.

## bridge.py options

| Option | Default | Meaning |
|---|---|---|
| `--proto {udp,tcp}` | `udp` | FicTrac transport. UDP: bind+receive. TCP: connect to FicTrac. |
| `--in-host` / `--in-port` | `127.0.0.1` / `60000` | FicTrac source address. |
| `--ws-host` / `--ws-port` | `127.0.0.1` / `8765` | WebSocket server address. |
| `--frames N` | `200` | Frame count of the loaded pattern (the index modulus); re-sent live by the console. |
| `--gain` | `1.8` | Degrees of heading per frame index (360/200); negative reverses. Re-settable live. |
| `--offset` | `0.0` | Heading offset in degrees. |
| `--log PATH` | on demand | Append log events (JSONL). If unset, opened when the browser enables logging. |
| `--log-frames` | off | Log the FULL 25-column FicTrac record per frame (debug/archival) instead of the default compact `behavior_v1` array `[ms,fc,idx,ft,x,y,hd]`. |

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

## fictrac_sim.py options

| Option | Default | Meaning |
|---|---|---|
| `file` (positional) | — | FicTrac log (CSV) to replay; omit to generate random data. |
| `--proto {udp,tcp}` | `udp` | UDP: send datagrams. TCP: act as server (FicTrac role). |
| `--host` / `--port` | `127.0.0.1` / `60000` | UDP destination / TCP bind address. |
| `--rate` | `50` | *Generated mode:* records per second. |
| `--seed` | — | *Generated mode:* RNG seed for byte-reproducible output. |
| `--count N` | `0` | *Generated mode:* emit N records then exit (0 = forever). |
| `--speed` | `1.0` | *Playback mode:* speed multiplier (`2` = twice real time). |

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
