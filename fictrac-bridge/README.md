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
and enable **Apply frames**.

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
FicTrac's `doc/data_header.txt`.

## WebSocket message schema

```
bridge → browser:  {"type":"frame", "index":<int>, "seq":<int>, "t":<ms>}
browser → bridge:  {"type":"hello", "client":"arena_console", "v":1}   (on connect)
                   {"type":"log",   "event":<str>, ...arbitrary fields, "ms":<int>}
```

The bridge always broadcasts the **latest** frame to each client and drops
superseded indices rather than queuing them, so a slow consumer never builds a
backlog. Inbound `log` messages are appended to `--log` as JSON lines, each stamped
with `dir` and `rx_ms`.

## Customising the closed-loop policy

Edit **one function** in `bridge.py`:

```python
def frame_index_from_fictrac(fields, n_frames, gain, offset) -> int:
    ...
```

The default maps the animal's integrated **heading** (FicTrac field 17 →
`fields[16]`, 0-based) across the whole pattern, scaled by `--gain` and rotated by
`--offset` (radians). Swap in integrated position (`fields[14]`, `fields[15]`),
speed (`fields[18]`), or any combination. `--frames N` must match the frame count
of the pattern loaded on the arena.

## bridge.py options

| Option | Default | Meaning |
|---|---|---|
| `--proto {udp,tcp}` | `udp` | FicTrac transport. UDP: bind+receive. TCP: connect to FicTrac. |
| `--in-host` / `--in-port` | `127.0.0.1` / `60000` | FicTrac source address. |
| `--ws-host` / `--ws-port` | `127.0.0.1` / `8765` | WebSocket server address. |
| `--frames N` | `60` | Frame count of the loaded pattern (maps the index range). |
| `--gain` / `--offset` | `1.0` / `0.0` | Heading→pattern coupling knobs. |
| `--log PATH` | off | Append browser log events (JSONL). |
| `--log-frames` | off | Also log every outbound frame + source fields. |

## fictrac_sim.py options

| Option | Default | Meaning |
|---|---|---|
| `--proto {udp,tcp}` | `udp` | UDP: send datagrams. TCP: act as server (FicTrac role). |
| `--host` / `--port` | `127.0.0.1` / `60000` | UDP destination / TCP bind address. |
| `--rate` | `50` | Records per second. |
| `--seed` | — | RNG seed for byte-reproducible output. |
| `--count N` | `0` | Emit N records then exit (0 = forever). |

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
