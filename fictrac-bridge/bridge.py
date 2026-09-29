#!/usr/bin/env python3
"""bridge.py — FicTrac ⇆ browser closed-loop bridge for the G6 Arena Console.

Reads FicTrac records from a socket, maps each one to an arena *frame index*, and
pushes that index to browser clients over a WebSocket. `arena_console.html` applies
the index via SET_FRAME_POSITION (Mode 3). In the reverse direction the browser
sends JSON control + log messages back over the same socket; the bridge applies
config live and appends log events to a file — a browser can't write local files
freely or reconfigure a socket, but this local process can.

  FicTrac ──(UDP recv / TCP client)──▶ bridge ──(ws://host:port)──▶ arena_console.html
                                          │  ◀── config / log ──────┘
                                          └── append to log file

Transport roles match real FicTrac (so the same bridge works with fictrac_sim.py):
  --proto udp (default): FicTrac sends datagrams; the bridge binds and receives.
  --proto tcp:           FicTrac's TCP variant is a server; the bridge connects to it.

WebSocket message schema (also documented in README.md):
  bridge → browser:  {"type":"frame", "index":<int>, "seq":<int>, "t":<ms>,
                      "ms":<int>, "fc":<int>, "idx":<int>, "ft":<ms|null>,
                      "x":<rad>, "y":<rad>, "hd":<rad>}
                       (the `behavior_v1` fields drive the live oscilloscope; the
                        legacy index/seq/t keys are kept for back-compatibility)
                     {"type":"hello_ack", "bridge":<str>, "levels":[<str>...],
                      "level":<str>, "logging":<bool>}
                       (reply to hello — advertises the log levels this bridge can
                        write so the browser can tell a stale bridge from a current one)
                     {"type":"log_control_ack", "enabled":<bool>, "level":<str>,
                      "requested":<str|null>, "file":<str|null>}
                       (reply to log_control — `level` is the level ACTUALLY in force;
                        an unknown requested level is ignored, and this is how the
                        browser finds out)
                     {"type":"log_export_result", "name":<str>, "content":<str>}
                       (reply to log_export; {"error":<str>} when nothing was written)
  browser → bridge:  {"type":"hello", "client":"arena_console", "v":1}   (on connect)
                     {"type":"config", "fictrac_port":<int>, "coupling":<float>,
                                       "deg_per_frame":<float>, "offset":<float>, "frames":<int>,
                                       "epoch":true,
                                       "bias":{"type":"none"|"constant"|"sine"|"square",
                                               "amplitude":<deg/s>, "frequency":<Hz>}}
                       (any subset. "epoch":true, or a message CARRYING "bias", re-tares the
                        heading and re-zeros the bias phase clock, so every closed-loop epoch
                        starts at phase 0 with the display where the pattern loaded.
                        "gain" is accepted as a DEPRECATED alias of "deg_per_frame".)
                     {"type":"log_control", "enabled":<bool>,
                                            "level":"behavior_v2"|"behavior_v1"|"full"}
                       (open/close the log file; level picks the log format,
                        overriding --log-level — the runner asserts it per run)
                     {"type":"log",   "event":<str>, ...arbitrary, "ms":<int>}
                     {"type":"log_export"}   (close the active log, stream it back whole)

The FicTrac → frame-index policy lives in frame_index_from_heading(); edit that one
function to change closed-loop behaviour:

    idx = round((coupling · Δheading + offset + bias) / deg_per_frame) mod n_frames

`Δheading` is the fly's turn since the epoch's HEADING TARE, kept UNWRAPPED (per-frame
differences of FicTrac's wrapped col-17 heading, each wrapped to ±180° and accumulated —
telescopes across dropped frames). `coupling` is dimensionless: 1 = the display follows
the ball 1:1, 0.75/1.25 = less/more, negative = reversed, 0 = the display ignores the
fly (pure bias replay — a control condition). `deg_per_frame` is the PATTERN PITCH
(1.8 = 360°/200 px on a 10-column G6; a pattern property, NOT 360/frame_count — a
20-frame tiled grating still steps 1.8°/frame). The optional BIAS WAVEFORM (LAB-185) is
an added rotational velocity whose time-integral is summed into the mapping alongside
`offset` — OUTSIDE the coupling, so a negative coupling does not flip the bias; see
bias_angle_deg() and docs/development/closed-loop-bias.md.

Why unwrapped (bridge 3.3): the previous mapping divided a WRAPPED heading by `gain`
(deg/frame), so any coupling whose 360°/frame-pitch was not an integer multiple of
n_frames — gain 2.4 (0.75×), 1.44 (1.25×) — jumped the display by (k−1)·360° once per
ball revolution at FicTrac's zero. That is why "any gain but ±1.8 did odd things".

LOG LEVELS — three, all uniform NDJSON: a reader does one JSON.parse() per line and
dispatches on Array.isArray (positional array vs event object), then on arr[0]:
  - behavior_v2 (DEFAULT, docs/development/runlog-behavior-v2-plan.md Part 1): a one-time
    {"type":"frame_schema","level":"behavior_v2","cols":[...],
     "arena_cols":["t_off","dt","hex","status","rx_off"],"t0":<epoch ms>} header, then
    each FicTrac frame as the SAME positional array as behavior_v1 (below), and each
    browser `arena_command` echo (one per closed-loop 0x70 frame command, ~100 Hz — 76 %
    of a v1 file) as the compact array ["a", t_off, dt, hex, status, rx_off(, error)]
    with ms offsets from t0 (= the session line's ms). LOSSLESS: expand_arena_command()
    rebuilds the exact v1 object (see compact_arena_command for the invariants that are
    verified per line; an echo that does not fit is written verbatim, never dropped).
    Runner / session / run_metadata / config lines stay verbatim JSON objects.
  - behavior_v1: the v2 frame_schema minus arena_cols/t0, positional frame arrays
    [ms, fc, idx, ft, x, y, hd], and arena_command echoes as full JSON objects.
    Compact behavioral state the live scope + offline dashboard recompute all derived
    channels from (see js/kinematics.js). ft = FicTrac col-22 timestamp as relative
    ms — NOT col-24 dt, which cannot recover elapsed time across a frame dropped before
    logging (Frank, #143). col 22 is the camera hardware clock in ns on our rigs,
    normalized to ms here (FT_TS_NS_PER_MS); downstream dt is per-frame ft differences.
  - full (--log-level full / --log-frames): the whole 25-column record under a
    "fictrac" key (debug/archival); no schema line; arena echoes verbatim.
`bridge.py --convert IN OUT` re-encodes an existing file v1 ⇄ v2 (direction auto-
detected, `.gz` in/out handled) — the migration + reader-test path.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import math
import os
import signal
import sys
import time

try:
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed
except ImportError:  # --convert and the offline tests need none of the server
    serve = None

    class ConnectionClosed(Exception):  # type: ignore[no-redef]
        pass

import gzip

# Inbound WebSocket message cap. The library default is 1 MiB — raised so a
# multi-MB payload never kills the socket; sized to match the log_export
# replies we stream the other way (one experiment log as ONE message).
WS_MAX_SIZE = 16 * 1024 * 1024

# Bridge build tag. Bump when the wire/log schema changes so a rig can confirm at a
# glance which bridge it's running: `pixi run bridge -- --version` prints it, and it
# leads the startup banner. (An OLD bridge has no --version flag → argparse errors,
# which is itself the tell.) "behavior_v1" here means frames carry ms/fc/idx/ft/x/y/hd
# with `ft` normalized ns→ms — i.e. the live scope + dashboard will work.
BRIDGE_VERSION = "3.4 · behavior_v2 (compact arena echo, log_control ack, controller telemetry rows) + bias waveforms + heading tare + coupling (unwrapped heading) + start_frame + epoch-stamped frames"

# The `config` message the runner sends at each startClosedLoop. `gain` is the pre-3.3
# name of `deg_per_frame`; still accepted so an old Console / protocol keeps working.
CONFIG_KEYS = ("fictrac_port", "coupling", "deg_per_frame", "gain", "offset", "frames", "epoch", "bias")

# behavior_v1 — the logged frame schema (issue #140), UNCHANGED in behavior_v2.
# Positional-array rows in this column order; the live scope + offline dashboard
# recompute every derived channel (turning/forward/side/speed/dir) from this state.
BEHAVIOR_V1_COLS = ["ms", "fc", "idx", "ft", "x", "y", "hd"]

# Log levels the bridge can write, most-preferred first. Advertised in hello_ack
# so a browser can detect a stale bridge; the first entry is the fresh-process
# default (log_control overrides it per run).
LOG_LEVELS = ("behavior_v2", "behavior_v1", "full")
DEFAULT_LOG_LEVEL = LOG_LEVELS[0]

# behavior_v2 compact arena-command echo: ["a", t_off, dt, hex, status, rx_off] with
# an optional 7th element carrying a non-null `error` string. Offsets are ms from
# the schema line's t0. Declared in the v2 frame_schema line as `arena_cols`.
BEHAVIOR_V2_ARENA_COLS = ["t_off", "dt", "hex", "status", "rx_off"]
ARENA_TAG = "a"
ARENA_DIR = "browser→bridge"
# The exact v1 arena_command object (js/arena-session.js _logCommand + write_inbound
# stamps). Key ORDER is what the browser/bridge wrote; the SET is what must match
# for a line to be compacted — an extra key means a newer producer, so the line is
# kept verbatim (or raises under strict conversion) rather than losing the field.
ARENA_COMMAND_KEYS = ("type", "event", "t", "dt", "len", "head", "status", "echo", "ok", "error", "dir", "rx_ms")
_ARENA_COMMAND_KEYSET = frozenset(ARENA_COMMAND_KEYS)

# FicTrac col-22 is the camera's hardware-clock timestamp. Our rigs run identical
# cameras + software that emit it in NANOSECONDS (FicTrac's docs nominally call it
# ms, but this hardware clock is ns). behavior_v1's `ft` is defined as
# MILLISECONDS, so the pipeline divides col 22 by this constant. dt is taken from
# per-frame `ft` differences downstream, so a variable frame rate is handled for
# free — only the fixed unit is applied here. (If a future rig's camera differs,
# this one constant is the only knob.)
FT_TS_NS_PER_MS = 1_000_000.0

# Closed-loop bias waveforms (LAB-185). The vocabulary is shared with the web side:
# js/plugin-registry.js `startClosedLoop.params.bias_type` must offer exactly these.
BIAS_TYPES = ("none", "constant", "sine", "square")


def now_ms() -> int:
    return int(time.time() * 1000)


def behavior_v1_row(fields: list[float], index: int, rel_ms: int, ft0: float | None) -> dict:
    """Build one behavior_v1 record from a parsed FicTrac line. PURE (no clocks,
    no I/O) so it is unit-testable offline — this is where the col-22 ns→ms
    normalization that the live scope + offline dashboard depend on happens.

    fields  parsed FicTrac record (>=17 cols; col 22 = fields[21] if present)
    index   displayed frame index (from frame_index_from_fictrac)
    rel_ms  ms since run start (caller computes now_ms()-t0; the display axis)
    ft0     first-frame col-22 value in NATIVE units (ns), or None if unavailable

    `ft` is relative MILLISECONDS: subtract ft0 in native units first (keeps the
    ~2e13 magnitude from losing precision), THEN divide by FT_TS_NS_PER_MS.
    """
    has_ft = len(fields) > 21
    ft_rel = (
        round((fields[21] - ft0) / FT_TS_NS_PER_MS, 3) if (has_ft and ft0 is not None) else None
    )
    return {
        "ms": int(rel_ms),
        "fc": int(fields[0]),
        "idx": index,
        "ft": ft_rel,
        "x": round(fields[14], 5),
        "y": round(fields[15], 5),
        "hd": round(fields[16], 5),
    }

# ─────────────────────────────────────────────────────────────────────────────
# behavior_v2 line format — pure functions (no clocks, no I/O; offline-tested by
# tests/test-bridge-behavior.py and gated over the whole course corpus by
# scripts/runlog-v2-corpus.py). Both the live LogWriter and --convert use these.
# ─────────────────────────────────────────────────────────────────────────────
class RunlogFormatError(ValueError):
    """A line does not fit the format it claims (raised only under strict conversion;
    the live writer falls back to a verbatim object instead)."""


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _hex_bytes(head: str) -> list[str] | None:
    """Split a v1 `head` ("03 70 2e 00") into 2-digit lowercase hex bytes, or None
    when it is not exactly that shape (e.g. the ' …' truncation marker, uppercase)."""
    if not isinstance(head, str) or not head:
        return None
    parts = head.split(" ")
    for p in parts:
        if len(p) != 2 or p.lower() != p or any(c not in "0123456789abcdef" for c in p):
            return None
    return parts


def frame_schema_line(level: str, cols: list[str] | None, t0: int | None = None) -> dict:
    """The one-time schema header for a behavior_v1 / behavior_v2 log."""
    if level == "behavior_v2":
        return {
            "type": "frame_schema",
            "level": "behavior_v2",
            "cols": cols,
            "arena_cols": list(BEHAVIOR_V2_ARENA_COLS),
            "t0": t0,
        }
    return {"type": "frame_schema", "level": level, "cols": cols}


def arena_compact_reason(obj, t0: int) -> str | None:
    """Why `obj` can NOT be written as a compact "a" array (None = it can).

    These are the invariants expand_arena_command() relies on to rebuild the v1
    object exactly: fixed key set, dir, int t/rx_ms, numeric dt, spaced lowercase
    hex head with len == byte count, status int-or-null, echo == the command byte
    (head[1]) and ok == (status == 0) — or ALL THREE null when there was no reply
    (timeout / undecodable), error str-or-null."""
    if not isinstance(obj, dict):
        return "not an object"
    if obj.get("type") != "log" or obj.get("event") != "arena_command":
        return "not an arena_command"
    keys = set(obj)
    if keys != _ARENA_COMMAND_KEYSET:
        return f"unexpected key set (diff {sorted(keys ^ _ARENA_COMMAND_KEYSET)})"
    if obj["dir"] != ARENA_DIR:
        return f"dir {obj['dir']!r}"
    if not _is_int(obj["t"]) or not _is_int(obj["rx_ms"]) or not _is_int(t0):
        return "t/rx_ms/t0 not integers"
    if not _is_number(obj["dt"]):
        return "dt not a number"
    parts = _hex_bytes(obj["head"])
    if parts is None:
        return f"head {obj['head']!r} not spaced lowercase hex bytes"
    if obj["len"] != len(parts):
        return f"len {obj['len']!r} != {len(parts)} head bytes"
    status, echo, ok, error = obj["status"], obj["echo"], obj["ok"], obj["error"]
    if status is None:
        if echo is not None or ok is not None:
            return "status null but echo/ok not null"
    else:
        if not _is_int(status):
            return f"status {status!r} not int/null"
        if len(parts) < 2 or echo != int(parts[1], 16):
            return f"echo {echo!r} != command byte"
        if not isinstance(ok, bool) or ok != (status == 0):
            return f"ok {ok!r} != (status == 0)"
    if error is not None and not isinstance(error, str):
        return f"error {error!r} not str/null"
    return None


def compact_arena_command(obj: dict, t0: int, strict: bool = False):
    """v1 arena_command object → ["a", t_off, dt, hex, status, rx_off(, error)].

    Returns None when the object does not fit (the live writer then emits it
    verbatim); with strict=True raises RunlogFormatError instead."""
    reason = arena_compact_reason(obj, t0)
    if reason is not None:
        if strict:
            raise RunlogFormatError(f"arena_command not compactable: {reason}")
        return None
    arr = [
        ARENA_TAG,
        obj["t"] - t0,
        obj["dt"],
        obj["head"].replace(" ", ""),
        obj["status"],
        obj["rx_ms"] - t0,
    ]
    if obj["error"] is not None:
        arr.append(obj["error"])
    return arr


def is_arena_array(value) -> bool:
    """True for a behavior_v2 compact arena echo (vs a frame array, whose [0] is ms)."""
    return isinstance(value, list) and len(value) in (6, 7) and value[0] == ARENA_TAG


def expand_arena_command(arr: list, t0: int) -> dict:
    """["a", t_off, dt, hex, status, rx_off(, error)] → the exact v1 object, in the
    key order the browser + bridge wrote it. Raises RunlogFormatError if malformed."""
    if not is_arena_array(arr):
        raise RunlogFormatError(f"not a compact arena array: {arr!r}")
    _, t_off, dt, hexs, status, rx_off = arr[:6]
    error = arr[6] if len(arr) == 7 else None
    if not _is_int(t_off) or not _is_int(rx_off) or not _is_int(t0):
        raise RunlogFormatError("t_off/rx_off/t0 not integers")
    if not _is_number(dt):
        raise RunlogFormatError("dt not a number")
    if not isinstance(hexs, str) or len(hexs) % 2 or _hex_bytes(" ".join(hexs[i : i + 2] for i in range(0, len(hexs), 2)) or "") is None:
        raise RunlogFormatError(f"hex {hexs!r} malformed")
    if status is not None and not _is_int(status):
        raise RunlogFormatError(f"status {status!r} not int/null")
    if error is not None and not isinstance(error, str):
        raise RunlogFormatError(f"error {error!r} not str")
    parts = [hexs[i : i + 2] for i in range(0, len(hexs), 2)]
    if status is not None and len(parts) < 2:
        raise RunlogFormatError("status present but no command byte")
    return {
        "type": "log",
        "event": "arena_command",
        "t": t0 + t_off,
        "dt": dt,
        "len": len(parts),
        "head": " ".join(parts),
        "status": status,
        "echo": None if status is None else int(parts[1], 16),
        "ok": None if status is None else status == 0,
        "error": error,
        "dir": ARENA_DIR,
        "rx_ms": t0 + rx_off,
    }


def _is_schema(obj) -> bool:
    return isinstance(obj, dict) and obj.get("type") == "frame_schema"


def detect_format(objs) -> str:
    """'behavior_v2' | 'behavior_v1' | 'full' | 'legacy' for a parsed log (list of
    JSON values). The schema line decides; without one, "a" arrays mean v2,
    fictrac_frame objects carrying the 25-column `fictrac` array mean the `full`
    level, anything else is a pre-#140 log."""
    saw_full = False
    for o in objs:
        if _is_schema(o):
            return str(o.get("level"))
        if is_arena_array(o):
            return "behavior_v2"
        if isinstance(o, dict) and o.get("type") == "fictrac_frame" and "fictrac" in o:
            saw_full = True
    return "full" if saw_full else "legacy"


def convert_v1_to_v2(objs, strict: bool = True) -> list:
    """Re-encode a parsed v1 (or legacy/full) log as behavior_v2. Lossless: only the
    frame_schema line changes and arena_command objects become "a" arrays; every
    other line is passed through untouched. t0 = the first session line's `ms`.
    A file without a v1 schema line (pre-#140 / full level) gets a v2 schema line
    inserted after its first session line with "cols": null (no positional frame
    rows in this file) — convert_v2_to_v1 drops that line again."""
    schema_idx = next((i for i, o in enumerate(objs) if _is_schema(o)), None)
    cols = None
    if schema_idx is not None:
        sch = objs[schema_idx]
        if sch.get("level") == "behavior_v2":
            raise RunlogFormatError("already behavior_v2")
        if sch.get("level") != "behavior_v1" or set(sch) != {"type", "level", "cols"}:
            raise RunlogFormatError(f"unexpected v1 frame_schema {sch!r}")
        cols = sch["cols"]
    t0 = None
    for o in objs:
        if isinstance(o, dict) and o.get("type") == "session" and _is_int(o.get("ms")):
            t0 = o["ms"]
            break
    if t0 is None:
        first_a = next((o for o in objs if isinstance(o, dict) and o.get("event") == "arena_command"), None)
        t0 = first_a["t"] if first_a and _is_int(first_a.get("t")) else 0
    if schema_idx is not None:
        insert_at = schema_idx
    else:
        insert_at = 1 if objs and isinstance(objs[0], dict) and objs[0].get("type") == "session" else 0
    schema = frame_schema_line("behavior_v2", cols, t0)
    out = []
    for i, o in enumerate(objs):
        if i == schema_idx:
            out.append(schema)
            continue
        if schema_idx is None and i == insert_at:
            out.append(schema)
        if isinstance(o, dict) and o.get("event") == "arena_command" and o.get("type") == "log":
            arr = compact_arena_command(o, t0, strict=strict)
            out.append(arr if arr is not None else o)
        else:
            out.append(o)
    if schema_idx is None and insert_at >= len(objs):
        out.append(schema)
    return out


def convert_v2_to_v1(objs) -> list:
    """Inverse of convert_v1_to_v2: "a" arrays → v1 arena_command objects, the v2
    schema → the v1 schema (or dropped when cols is null). Everything else verbatim."""
    schema_idx = next((i for i, o in enumerate(objs) if _is_schema(o)), None)
    if schema_idx is None or objs[schema_idx].get("level") != "behavior_v2":
        raise RunlogFormatError("not a behavior_v2 log (no behavior_v2 frame_schema line)")
    sch = objs[schema_idx]
    if set(sch) != {"type", "level", "cols", "arena_cols", "t0"}:
        raise RunlogFormatError(f"unexpected v2 frame_schema keys {sorted(sch)}")
    if sch["arena_cols"] != BEHAVIOR_V2_ARENA_COLS:
        raise RunlogFormatError(f"unknown arena_cols {sch['arena_cols']!r}")
    t0 = sch["t0"]
    out = []
    for i, o in enumerate(objs):
        if i == schema_idx:
            if sch["cols"] is not None:
                out.append(frame_schema_line("behavior_v1", sch["cols"]))
            continue
        if is_arena_array(o):
            out.append(expand_arena_command(o, t0))
        else:
            out.append(o)
    return out


def canonical_json(obj) -> str:
    """Key-sorted compact JSON — the equality used by the round-trip tests."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_jsonl(path: str) -> list:
    """Parse a .jsonl or .jsonl.gz log into a list of JSON values (blank lines skipped)."""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def dumps_jsonl(objs) -> str:
    return "".join(json.dumps(o, separators=(",", ":")) + "\n" for o in objs)


def write_jsonl(path: str, objs) -> int:
    """Write compact NDJSON (gzip when the name ends in .gz, mtime 0 so the bytes are
    reproducible). Returns the number of bytes written."""
    data = dumps_jsonl(objs).encode("utf-8")
    if path.endswith(".gz"):
        with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            gz.write(data)
        return os.path.getsize(path)
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


def convert_file(src: str, dst: str, to: str | None = None) -> dict:
    """--convert: re-encode a run log v1 ⇄ v2. `to` = 'v1' | 'v2' | None (auto: the
    opposite of what `src` is). Returns a small report dict."""
    objs = read_jsonl(src)
    fmt = detect_format(objs)
    if to is None:
        to = "v1" if fmt == "behavior_v2" else "v2"
    if to == "v2":
        if fmt == "behavior_v2":
            raise RunlogFormatError(f"{src} is already behavior_v2")
        out = convert_v1_to_v2(objs, strict=True)
    elif to == "v1":
        out = convert_v2_to_v1(objs)
    else:
        raise ValueError(f"--to must be v1 or v2, not {to!r}")
    n = write_jsonl(dst, out)
    return {"src": src, "dst": dst, "from": fmt, "to": to, "lines": len(out), "bytes": n}


# ─────────────────────────────────────────────────────────────────────────────
# Processing policy — THE part you customise.
# ─────────────────────────────────────────────────────────────────────────────
def bias_angle_deg(kind: str, amp_dps: float, freq_hz: float, t_s: float) -> float:
    """Bias ANGLE (degrees) after t_s seconds of a closed-loop epoch. PURE (no clocks,
    no I/O) so it is unit-testable offline — see tests/test-bridge-behavior.py.

    The bias is authored as an added rotational VELOCITY v(t) in deg/s; what the
    mapping needs is its time-integral b(t) = ∫v, which is what this returns. `amp_dps`
    (A) is the PEAK velocity for every waveform, so the position excursion is derived
    and shrinks as frequency rises.

        kind        v(t)              b(t) = ∫v              position range
        none        0                 0                      —
        constant    A                 A·t                    unbounded drift
        sine        A·cos(ωt)         (A/ω)·sin(ωt)          ±A/(2πf)
        square      A·sign(cos ωt)    symmetric triangle     ±A/(4f)

    where ω = 2πf. Every waveform satisfies b(0) = 0, so closed-loop onset never
    produces a position jump, and the two periodic ones are ZERO-MEAN in position —
    the display is pushed equally left and right instead of drifting to one side.
    (`sign(cos ωt)` rather than `sign(sin ωt)` is what makes the triangle symmetric:
    b rises for the first quarter cycle, falls through the middle half, and rises back
    to 0 in the last quarter. `sign(sin ωt)` would give a one-sided 0 → +A/(2f) ramp.)

    Degenerate input is a defensive no-op (0.0), never a raise — this runs per FicTrac
    frame and must not kill the stream. freq_hz == 0 for sine/square is the divide-by-ω
    case; the WEB RUNNER is what rejects it up front (js/arena-runner-g6.js skips the
    trial), so a 0 here means someone bypassed that path. A NEGATIVE freq_hz needs no
    special case either — it is a NO-OP: both velocities are cosines, which are even in
    ω, so f and −f give an identical waveform. (For the sine's b(t) the two sign flips
    in A/ω and sin(ωt) cancel.) To reverse the disturbance direction, negate the
    AMPLITUDE, not the frequency; the runner warns when it sees a negative frequency.
    """
    if kind == "constant":
        return amp_dps * t_s
    if kind == "sine":
        w = 2.0 * math.pi * freq_hz
        if w == 0.0:
            return 0.0
        return (amp_dps / w) * math.sin(w * t_s)
    if kind == "square":
        if freq_hz == 0.0:
            return 0.0
        # Integral of A·sign(cos ωt): a symmetric triangle. Fold t into one period,
        # then piece it together from the quarter-cycle breakpoints (peak = A/(4f)).
        # abs() because a negative frequency is a no-op here (cos is even).
        period = 1.0 / abs(freq_hz)
        quarter = period / 4.0
        peak = amp_dps * quarter
        phase = t_s % period
        if phase <= quarter:  # rising 0 → +peak
            return amp_dps * phase
        if phase <= 3.0 * quarter:  # falling +peak → −peak
            return peak - amp_dps * (phase - quarter)
        return -peak + amp_dps * (phase - 3.0 * quarter)  # rising −peak → 0
    return 0.0  # "none" and anything unrecognised


def wrap180(deg: float) -> float:
    """Wrap degrees into [-180, 180)."""
    return ((deg + 180.0) % 360.0) - 180.0


def frame_index_from_heading(
    rel_heading_deg: float,
    n_frames: int,
    deg_per_frame: float,
    offset: float = 0.0,
    bias_deg: float = 0.0,
    coupling: float = 1.0,
) -> int:
    """Map the fly's UNWRAPPED turn since the epoch tare to a 0-based frame index.

        idx = round((coupling · rel_heading_deg + offset + bias_deg) / deg_per_frame) mod n_frames

    PURE (no clocks, no I/O) — see tests/test-bridge-behavior.py. The Pipeline owns the
    stateful parts: the tare, the unwrapping, and the bias phase clock.

    `rel_heading_deg` must be UNWRAPPED (cumulative, may exceed ±180°). A wrapped value
    works only when coupling·360°/deg_per_frame is an integer multiple of n_frames (the
    1:1 full-azimuth case); for any other coupling the wrap would jump the display by
    (coupling − 1)·360° once per ball revolution. `bias_deg` is outside the coupling on
    purpose: the disturbance is defined in DISPLAY degrees, so reversing the fly's
    coupling never reverses the bias, and coupling 0 gives a pure bias replay.
    `deg_per_frame` == 0 has no deg→index scale, so there is nothing to map (bias
    included) and the index stays 0.
    """
    if not deg_per_frame:
        return 0
    idx = round((coupling * rel_heading_deg + offset + bias_deg) / deg_per_frame)
    return idx % n_frames  # Python % is non-negative, so a negative coupling wraps cleanly


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket hub — coalescing broadcast (always the latest index, never a backlog).
# ─────────────────────────────────────────────────────────────────────────────
class Hub:
    def __init__(self, on_message) -> None:
        self._latest: dict | None = None
        self._version = 0
        self._cond = asyncio.Condition()
        self._clients = 0
        self._on_message = on_message  # async fn(raw) for inbound browser messages

    @property
    def clients(self) -> int:
        return self._clients

    async def publish(self, msg: dict) -> None:
        """Make `msg` the latest frame and wake all client senders."""
        async with self._cond:
            self._latest = msg
            self._version += 1
            self._cond.notify_all()

    async def serve_client(self, websocket) -> None:
        self._clients += 1
        peer = getattr(websocket, "remote_address", ("?", 0))
        print(f"[ws] client connected {peer} (total {self._clients})", file=sys.stderr)
        sender = asyncio.create_task(self._send_loop(websocket))
        try:
            await self._recv_loop(websocket)
        finally:
            sender.cancel()
            self._clients -= 1
            print(f"[ws] client disconnected {peer} (total {self._clients})", file=sys.stderr)

    async def _send_loop(self, websocket) -> None:
        """Per-client loop: send the latest frame whenever the version advances.

        If a client falls behind, it simply skips to the newest frame on its next
        wakeup — superseded indices are dropped rather than queued.
        """
        seen = 0
        try:
            while True:
                async with self._cond:
                    await self._cond.wait_for(lambda: self._version != seen)
                    seen = self._version
                    msg = self._latest
                if msg is not None:
                    await websocket.send(json.dumps(msg))
        except (ConnectionClosed, asyncio.CancelledError):
            pass

    async def _recv_loop(self, websocket) -> None:
        """Per-client loop: hand inbound browser messages to the dispatcher.

        The websocket rides along so request/response messages (log_export)
        can reply DIRECTLY to the asking client — the hub's broadcast path
        coalesces to the newest frame and would drop a one-shot reply."""
        try:
            async for raw in websocket:
                await self._on_message(raw, websocket)
        except ConnectionClosed:
            pass


# Minimum row lengths for the tagged array streams the browser may send via
# {type:"rows"} (schema: js/arena-telemetry.js STREAM_SCHEMA). Shorter rows are
# dropped so a malformed producer cannot poison the file for every reader.
ROW_MIN_LEN = {"cc": 7, "cf": 8, "cs": 7}


class LogWriter:
    """Appends one JSON line per event to a log file.

    The browser's "log fictrac" toggle starts a **fresh timestamped file on every
    activation** (start_new_log). A standalone --log PATH keeps a single file.
    On-demand files land in --log-dir (default: the process CWD).
    """

    def __init__(self, path: str | None, level: str | bool = DEFAULT_LOG_LEVEL, log_dir: str | None = None) -> None:
        self._explicit = path  # fixed --log path (standalone), else None
        self._dir = log_dir or ""
        self._fh = None
        self._name: str | None = None  # current-or-most-recent file (export target)
        self._t0: int | None = None  # behavior_v2 offset base = the open session line's ms
        self._verbatim_warned = 0
        # `level` accepts the legacy log_frames bool (True → 'full') for callers that
        # predate --log-level.
        self.level = "full" if level is True else (DEFAULT_LOG_LEVEL if level is False else level)
        if self.level not in LOG_LEVELS:
            raise ValueError(f"unknown log level {level!r} (one of {LOG_LEVELS})")
        if self._dir:
            os.makedirs(self._dir, exist_ok=True)
        if path:
            self._open(path, "bridge_start")

    @property
    def active(self) -> bool:
        return self._fh is not None

    @property
    def current_name(self) -> str | None:
        """Basename of the current-or-most-recent log file (for log_control_ack)."""
        return os.path.basename(self._name) if self._name else None

    @property
    def log_frames(self) -> bool:
        """Legacy alias: True when the level is `full` (25-column FicTrac records)."""
        return self.level == "full"

    def set_level(self, level: str) -> bool:
        """Select the log level for the NEXT log file (browser-driven, overriding the
        --log-level launch flag). Returns False — and leaves the level unchanged — for
        a level this bridge does not know; the dispatcher reports the level actually
        in force back to the browser in log_control_ack (a stale bridge used to
        ignore an unknown level silently)."""
        if level not in LOG_LEVELS:
            return False
        self.level = level
        return True

    def _open(self, name: str, event: str) -> None:
        self._fh = open(name, "a", buffering=1, encoding="utf-8")
        self._name = name
        ms = now_ms()
        self._t0 = ms
        self._emit({"type": "session", "event": event, "file": name, "ms": ms})
        # behavior_v1/v2 logs lead with a one-time schema line so the positional
        # arrays are self-describing (full mode stays keyed objects). v2 also
        # carries the compact arena-echo layout + t0 (= this session line's ms).
        if self.level == "behavior_v2":
            self._emit(frame_schema_line("behavior_v2", BEHAVIOR_V1_COLS, ms))
        elif self.level == "behavior_v1":
            self._emit(frame_schema_line("behavior_v1", BEHAVIOR_V1_COLS))
        print(f"[log] writing to {name} ({self.level})", file=sys.stderr)

    def start_new_log(self) -> None:
        """Begin a fresh timestamped log file — one per logging activation.

        With an explicit --log path, keep that single file (append + a marker)."""
        if self._explicit:
            if not self._fh:
                self._open(self._explicit, "logging_started")
            else:
                self._emit({"type": "session", "event": "logging_started", "ms": now_ms()})
            return
        self.close()
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + f"{now_ms() % 1000:03d}"
        self._open(os.path.join(self._dir, f"arena-log-{ts}.jsonl"), "logging_started")

    def export_current(self) -> tuple[str | None, str | None]:
        """Close the active log (if open) and return (basename, content) of the
        current-or-most-recent file — (None, None) when nothing was ever
        written or the file can't be read. Closing first guarantees the
        exported content is complete + flushed; a retry after close re-reads
        the same file."""
        if self._fh:
            self.close()
        if not self._name:
            return None, None
        try:
            with open(self._name, "r", encoding="utf-8") as fh:
                return os.path.basename(self._name), fh.read()
        except OSError as exc:
            print(f"[log] export failed for {self._name}: {exc}", file=sys.stderr)
            return None, None

    def write_event(self, obj: dict) -> None:
        """Append one bridge-authored event object. Unlike write_inbound() this does NOT
        stamp `rx_ms` — the caller supplies whatever timebase the event belongs in (e.g.
        bias_config carries `ms` in the same relative timebase as the behavior_v1 rows,
        which is what makes the bias reconstructable offline)."""
        self._emit(obj)

    def _emit(self, obj) -> None:
        # Compact separators are mandatory for the frame rows (issue #140 size
        # audit) and harmless for event objects — one line per JSON value.
        if self._fh:
            self._fh.write(json.dumps(obj, separators=(",", ":")) + "\n")

    def write_rows(self, rows) -> int:
        """Compact ARRAY rows from the browser, written verbatim one per line
        (controller telemetry streams "cc"/"cf"/"cs" from js/arena-telemetry.js;
        the tag in row[0] is the reader's dispatch key, like "a" for arena echoes).
        Rows are validated for shape only — a list whose first element is a short
        string tag — never rewritten. Returns the number written."""
        if not self._fh or not isinstance(rows, list):
            return 0
        n = 0
        for r in rows:
            if not (isinstance(r, list) and r and isinstance(r[0], str) and 1 <= len(r[0]) <= 4):
                continue
            if len(r) < ROW_MIN_LEN.get(r[0], 2):  # a bare ["cc"] would crash readers
                continue
            self._emit(r)
            n += 1
        return n

    def write_inbound(self, raw: str | bytes) -> None:
        if not self._fh:
            return
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            obj = {"type": "log", "event": "unparsed", "raw": raw}
        obj.setdefault("dir", ARENA_DIR)
        obj.setdefault("rx_ms", now_ms())
        if self.level == "behavior_v2" and obj.get("event") == "arena_command":
            # Compact echo (76 % of a v1 file). An echo that does not fit the fixed
            # shape is written verbatim — lossless either way, never dropped.
            arr = compact_arena_command(obj, self._t0)
            if arr is not None:
                self._emit(arr)
                return
            self._verbatim_warned += 1
            if self._verbatim_warned <= 3:
                print(
                    f"[log] arena_command kept verbatim: {arena_compact_reason(obj, self._t0)}",
                    file=sys.stderr,
                )
        self._emit(obj)

    def write_frame(self, beh: dict, fields: list[float]) -> None:
        # Store EVERY received FicTrac frame whenever logging is active — regardless
        # of whether the browser is applying frames. behavior_v1/v2 = the positional
        # array (identical in both); full = the 25-field record (debug/archival).
        if not self._fh:
            return
        if self.level == "full":
            rec = {"type": "fictrac_frame", "seq": beh["fc"], "index": beh["idx"], "t": beh["ms"]}
            rec["fictrac"] = fields
            self._emit(rec)
        else:
            self._emit([beh[c] for c in BEHAVIOR_V1_COLS])  # [ms, fc, idx, ft, x, y, hd]

    def close(self) -> None:
        if self._fh:
            self._emit({"type": "session", "event": "logging_stopped", "ms": now_ms()})
            self._fh.close()
            self._fh = None


# ─────────────────────────────────────────────────────────────────────────────
# FicTrac record parsing + dispatch.
# ─────────────────────────────────────────────────────────────────────────────
class Pipeline:
    """Parses FicTrac lines, computes a frame index, and publishes to the hub."""

    def __init__(
        self,
        hub: Hub,
        log: LogWriter,
        n_frames: int,
        deg_per_frame: float,
        offset: float,
        bias: dict | None = None,
        coupling: float = 1.0,
    ) -> None:
        self.hub = hub
        self.log = log
        self.n_frames = n_frames
        self.deg_per_frame = deg_per_frame
        self.coupling = coupling
        self.offset = offset
        self.parsed = 0
        self.skipped = 0
        # Heading state for the UNWRAPPED relative turn (bridge 3.3): `rel_deg` is the
        # fly's cumulative turn since the last tare; `_prev_hd_deg` the previous frame's
        # wrapped col-17 heading. Before any tare, rel_deg = the absolute unwrapped
        # heading (so the plain Console loop behaves as it always has, minus the jumps).
        self.rel_deg = 0.0
        self._prev_hd_deg: float | None = None
        self._last_fc: float | None = None
        # behavior_v1 relative clocks: `ms` counts bridge wall-clock ms since run
        # start; `ft` counts FicTrac's own timestamp (col 22) since the first frame.
        self.t0_ms = now_ms()
        self.ft0: float | None = None
        # Bias waveform (LAB-185) + its OWN phase clock, deliberately independent of
        # the behavior_v1 log-boundary clock: the phase must re-zero per closed-loop
        # epoch (each startClosedLoop), not per log file.
        self.bias = {"type": "none", "amplitude": 0.0, "frequency": 0.0}
        self.bias_t0_ms = now_ms()
        # HEADING TARE. FicTrac's integrated heading is absolute, so a closed-loop
        # epoch would otherwise open by jumping the display to round(heading/pitch).
        # hd0 is the heading treated as zero (logged for offline reconstruction);
        # _tare_pending latches it from the FIRST frame after the epoch begins (a config
        # message can't sample a heading that hasn't arrived yet, and the last-seen one
        # may be stale). `_tare_reason` is written into the heading_tare event.
        self.hd0 = 0.0
        self._tare_pending = False
        self._tare_reason = "epoch"
        # Epoch counter: +1 every time a tare FIRES. Stamped on every frame message so
        # the browser can tell a frame computed BEFORE the tare it just requested from
        # the first post-tare one — the race that flashed a stale index for one frame
        # at closed-loop start (rig03 bout 6, 2026-09-23). 0 = no tare yet.
        self.epoch_id = 0
        if bias:
            self.set_bias(bias, log_event=False, tare=False)

    # `gain` was the pre-3.3 name of deg_per_frame; kept so the dispatcher's alias, the
    # banner and older tests keep working.
    @property
    def gain(self) -> float:
        return self.deg_per_frame

    @gain.setter
    def gain(self, value: float) -> None:
        self.deg_per_frame = value

    def reset_base(self) -> None:
        """Re-zero the behavior_v1 relative clocks at a run boundary (log start)."""
        self.t0_ms = now_ms()
        self.ft0 = None

    def arm_tare(self, reason: str = "epoch") -> None:
        """Re-zero the relative heading on the NEXT FicTrac frame (a new closed-loop epoch,
        or a FicTrac restart detected from its frame counter)."""
        self._tare_pending = True
        self._tare_reason = reason

    def start_frame_to_offset(self, start_frame: int) -> float:
        """The `offset` (display degrees) that opens a tared epoch on `start_frame`.

        After the tare rel_heading is 0, so idx = round(offset / deg_per_frame) mod
        n_frames; offset = (start_frame mod n_frames) × deg_per_frame lands exactly on
        the requested 0-based frame, and the fly's turning then moves away from it with
        the usual coupling. Used by the config `start_frame` key (per-trial start
        position, e.g. a place-learning trial opening 90° outside the safe zone).
        """
        n = max(1, int(self.n_frames))
        return (int(start_frame) % n) * float(self.deg_per_frame)

    def set_bias(self, spec: dict | None, log_event: bool = True, tare: bool = True) -> dict:
        """Install a bias waveform, RE-ZERO its phase clock, and ARM THE HEADING TARE,
        so every closed-loop epoch starts at b(0) = 0 with the display where the
        pattern was loaded, and is reproducible trial to trial. Tolerant: an
        unrecognised type or unparseable number degrades to a no-op bias rather than
        raising (the web runner is what rejects bad specs up front, with a message).

        Also writes a `bias_config` log line carrying `ms` in the behavior_v1 relative
        timebase — that is what lets an offline analysis reconstruct b(t) exactly from
        the logged `ms` column.
        """
        spec = spec if isinstance(spec, dict) else {}
        kind = str(spec.get("type", "none")).strip().lower()
        if kind not in BIAS_TYPES:
            print(f"[cfg] unknown bias type {kind!r} → none", file=sys.stderr)
            kind = "none"
        try:
            amp = float(spec.get("amplitude", 0.0) or 0.0)
        except (TypeError, ValueError):
            amp = 0.0
        try:
            freq = float(spec.get("frequency", 0.0) or 0.0)
        except (TypeError, ValueError):
            freq = 0.0
        if not (math.isfinite(amp) and math.isfinite(freq)):
            amp, freq = 0.0, 0.0
        self.bias = {"type": kind, "amplitude": amp, "frequency": freq}
        self.bias_t0_ms = now_ms()
        # Arm the heading tare — but only for a real EPOCH, not for the CLI defaults
        # applied at construction. Startup must leave the mapping on absolute heading
        # so the plain Console closed loop behaves exactly as it always has; the tare
        # is scoped to closed-loop epochs, which is where the jump was a problem.
        if tare:
            self.arm_tare("epoch")
        if log_event:
            self.log.write_event(
                {
                    "type": "bias_config",
                    "dir": "bridge",
                    "ms": self.bias_t0_ms - self.t0_ms,
                    "bias": dict(self.bias),
                }
            )
        return self.bias

    def bias_now_deg(self, at_ms: int | None = None) -> float:
        """Bias angle, evaluated ANALYTICALLY at the elapsed epoch time — never
        incrementally integrated, so a dropped FicTrac frame costs nothing and the value
        is exactly reproducible offline. `at_ms` lets handle_line evaluate it at the SAME
        instant it stamps the row's `ms`, so offline reconstruction is exact."""
        if self.bias["type"] == "none":
            return 0.0
        t_s = ((now_ms() if at_ms is None else at_ms) - self.bias_t0_ms) / 1000.0
        return bias_angle_deg(self.bias["type"], self.bias["amplitude"], self.bias["frequency"], t_s)

    def advance_heading(self, hd_deg: float, fc: float | None, now: int) -> None:
        """Update the unwrapped relative heading with one FicTrac frame (col-17 heading in
        degrees, wrapped by FicTrac to 0..360). Pure bookkeeping; the frame's index is
        computed by the caller from `self.rel_deg`.

        - A pending tare (new epoch / FicTrac restart) zeroes rel_deg at THIS frame and
          logs `heading_tare` with `hd0_deg` + `reason`.
        - Otherwise rel_deg += wrap180(hd − previous hd): the per-frame step is wrapped,
          the sum is not — so a full ball revolution reads as 360°, not as a jump back to
          0, and a dropped frame only loses nothing as long as the fly turned < 180°
          across the gap. FicTrac's own col-8 delta is NOT used: it would lose the dropped
          frame's motion, and it is not present in `full`-level replays.
        - A FicTrac frame counter that goes BACKWARDS means FicTrac restarted (its heading
          re-zeroed): re-tare rather than record a huge fake turn.
        - The very first frame with no tare pending seeds rel_deg = hd (absolute), so a
          Console-only loop with no protocol behaves as before, minus the wrap jumps.
        """
        if fc is not None and self._last_fc is not None and fc < self._last_fc and not self._tare_pending:
            self.arm_tare("ft_reset")
        self._last_fc = fc
        if self._tare_pending:
            self._tare_pending = False
            self.hd0 = hd_deg
            self.rel_deg = 0.0
            self._prev_hd_deg = hd_deg
            self.epoch_id += 1
            self.log.write_event(
                {
                    "type": "heading_tare",
                    "dir": "bridge",
                    "ms": now - self.t0_ms,
                    "hd0_deg": round(hd_deg, 4),
                    "reason": self._tare_reason,
                    "epoch": self.epoch_id,
                }
            )
            return
        if self._prev_hd_deg is None:
            self._prev_hd_deg = hd_deg
            self.rel_deg = hd_deg
            return
        self.rel_deg += wrap180(hd_deg - self._prev_hd_deg)
        self._prev_hd_deg = hd_deg

    async def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        parts = line.split(",")
        # Real FicTrac's live UDP/TCP socket output prefixes every record with a
        # message-type tag — "FT" for a good frame, "FT_BADFR" (or similar) when
        # it couldn't track — that does NOT appear in offline .dat logs or in
        # fictrac_sim.py's synthetic output. Strip it before parsing floats; a
        # non-"FT" tag means a bad/skipped frame with no usable data.
        tag = parts[0].strip()
        if tag[:2].upper() == "FT":
            if tag != "FT":
                self.skipped += 1
                return
            parts = parts[1:]
        try:
            fields = [float(p) for p in parts]
        except ValueError:
            self.skipped += 1
            return
        if len(fields) < 17:  # need at least through the heading field
            self.skipped += 1
            return
        self.parsed += 1
        # ONE wall-clock sample per frame: the row's `ms`, the bias phase and the tare
        # event all use it, so an offline reader can reproduce idx exactly from the log.
        now = now_ms()
        # Tare (on the first frame of a new epoch, BEFORE mapping, so that frame already
        # lands at the pattern's start index) + unwrapped relative heading.
        self.advance_heading(math.degrees(fields[16]), fields[0], now)
        bias_deg = self.bias_now_deg(now)
        index = frame_index_from_heading(
            self.rel_deg, self.n_frames, self.deg_per_frame, self.offset, bias_deg, self.coupling
        )
        # behavior_v1 compact state (issue #140): the live scope + offline dashboard
        # recompute every derived channel from these. The ns→ms + column mapping
        # lives in behavior_v1_row() (pure, offline-tested); the Pipeline only owns
        # the stateful clocks (t0_ms wall base, ft0 first-frame col-22).
        if self.ft0 is None and len(fields) > 21:
            self.ft0 = fields[21]
        beh = behavior_v1_row(fields, index, now - self.t0_ms, self.ft0)
        # Legacy index/seq/t kept alongside the behavior_v1 fields for back-compat.
        msg = {"type": "frame", "index": index, "seq": beh["fc"], "t": now, "epoch": self.epoch_id}
        msg.update(beh)
        # Live bias angle, for the Studio's read-only readout only. Additive on the
        # WebSocket (unknown fields are ignored by older clients) and deliberately NOT
        # a behavior_v1 column — widening BEHAVIOR_V1_COLS would break every positional
        # reader (js/runlog-replay.js, the offline dashboard). Offline analysis
        # reconstructs b(t) from the bias_config event instead.
        if self.bias["type"] != "none":
            msg["bias"] = round(bias_deg, 3)
        await self.hub.publish(msg)
        self.log.write_frame(beh, fields)


# ─────────────────────────────────────────────────────────────────────────────
# Input transports.
# ─────────────────────────────────────────────────────────────────────────────
class _UdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._buf = b""

    def datagram_received(self, data: bytes, addr) -> None:
        # FicTrac sends one record per datagram, but be robust to coalesced or
        # split datagrams by buffering and splitting on newlines.
        self._buf += data
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            self._queue.put_nowait(line.decode("ascii", errors="replace"))
        # No trailing newline? Treat each datagram as a full record anyway.
        if self._buf and b"\n" not in data:
            self._queue.put_nowait(self._buf.decode("ascii", errors="replace"))
            self._buf = b""


async def read_udp(host: str, port: int, queue: asyncio.Queue) -> None:
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _UdpProtocol(queue), local_addr=(host, port)
    )
    print(f"[in] UDP listening on {host}:{port}", file=sys.stderr)
    try:
        await asyncio.Event().wait()  # run until cancelled
    finally:
        transport.close()


async def read_tcp(host: str, port: int, queue: asyncio.Queue) -> None:
    backoff = 0.5
    while True:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            print(f"[in] TCP connected to {host}:{port}", file=sys.stderr)
            backoff = 0.5
            try:
                while True:
                    raw = await reader.readline()
                    if not raw:
                        break  # server closed
                    queue.put_nowait(raw.decode("ascii", errors="replace"))
            finally:
                writer.close()
        except (ConnectionRefusedError, OSError) as exc:
            print(f"[in] TCP connect failed ({exc}); retrying in {backoff:g}s", file=sys.stderr)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 5.0)


class InputManager:
    """Owns the FicTrac reader task so the browser can re-bind it to a new port."""

    def __init__(self, proto: str, host: str, port: int, queue: asyncio.Queue) -> None:
        self.proto = proto
        self.host = host
        self.port = port
        self.queue = queue
        self._task: asyncio.Task | None = None

    def _reader(self):
        fn = read_udp if self.proto == "udp" else read_tcp
        return fn(self.host, self.port, self.queue)

    def start(self) -> None:
        self._task = asyncio.create_task(self._reader())

    async def rebind(self, port: int) -> None:
        if port == self.port:
            return
        print(f"[in] re-binding FicTrac input {self.port} → {port}", file=sys.stderr)
        self.port = port
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self.start()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


async def consume(queue: asyncio.Queue, pipeline: Pipeline) -> None:
    while True:
        line = await queue.get()
        await pipeline.handle_line(line)


def make_dispatcher(pipeline: Pipeline, log: LogWriter, inputs: InputManager):
    """Build the async handler for inbound browser messages."""

    async def reply(websocket, msg: dict) -> None:
        """Answer the ASKING client only (the hub's broadcast path coalesces to the
        newest frame and would drop a one-shot reply)."""
        if websocket is None:
            return
        try:
            await websocket.send(json.dumps(msg))
        except ConnectionClosed:
            pass

    async def dispatch(raw, websocket=None) -> None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            log.write_inbound(raw)
            return
        kind = obj.get("type") if isinstance(obj, dict) else None

        if kind == "hello":
            # Advertise what this bridge can write so the browser can detect a stale
            # bridge BEFORE a run (an old bridge never replies to hello at all).
            log.write_inbound(raw)
            await reply(
                websocket,
                {
                    "type": "hello_ack",
                    "bridge": BRIDGE_VERSION,
                    "levels": list(LOG_LEVELS),
                    "level": log.level,
                    "logging": log.active,
                },
            )
        elif kind == "config":
            applied = {}
            # deg_per_frame (the pattern pitch); `gain` is its pre-3.3 name. When a message
            # carries both, the new name wins.
            if obj.get("gain") is not None and obj.get("deg_per_frame") is None:
                pipeline.deg_per_frame = float(obj["gain"])
                applied["deg_per_frame"] = pipeline.deg_per_frame
                applied["gain_alias"] = True
            if obj.get("deg_per_frame") is not None:
                pipeline.deg_per_frame = float(obj["deg_per_frame"])
                applied["deg_per_frame"] = pipeline.deg_per_frame
            if obj.get("coupling") is not None:
                c = float(obj["coupling"])
                pipeline.coupling = c if math.isfinite(c) else 1.0
                applied["coupling"] = pipeline.coupling
            if obj.get("offset") is not None:
                pipeline.offset = float(obj["offset"])
                applied["offset"] = pipeline.offset
            if obj.get("frames"):
                pipeline.n_frames = max(1, int(obj["frames"]))
                applied["frames"] = pipeline.n_frames
            if obj.get("start_frame") is not None:
                # Per-trial START POSITION (protocol startClosedLoop params.start_frame):
                # the epoch tare zeroes rel_heading, so the epoch opens at
                # round(offset / deg_per_frame). Set offset = start_frame × pitch to open it
                # on that frame. Applied AFTER deg_per_frame/frames so it uses this
                # message's values; an explicit "offset" in the same message is overridden.
                pipeline.offset = pipeline.start_frame_to_offset(int(obj["start_frame"]))
                applied["start_frame"] = int(obj["start_frame"]) % max(1, pipeline.n_frames)
                applied["offset"] = pipeline.offset
            if obj.get("fictrac_port"):
                await inputs.rebind(int(obj["fictrac_port"]))
                applied["fictrac_port"] = inputs.port
            # Presence of the key — not its value — re-zeros the bias phase clock, so
            # `{"bias":{"type":"none"}}` is how the runner both stops the disturbance at
            # stopClosedLoop and guarantees the next epoch starts at phase 0.
            if "bias" in obj:
                applied["bias"] = pipeline.set_bias(obj["bias"])
            # Explicit epoch marker (bridge 3.3): re-tare without touching the bias. The
            # runner sends it with every startClosedLoop; `bias` presence still tares too.
            if obj.get("epoch"):
                pipeline.arm_tare("epoch")
                applied["epoch"] = True
            print(f"[cfg] applied {applied}", file=sys.stderr)
            log.write_inbound(raw)
        elif kind == "log_control":
            requested = obj.get("level")
            if obj.get("enabled"):
                if requested is not None and not log.set_level(requested):
                    # Browser asserts the level per run; an unknown one is NOT applied.
                    # The ack below carries the level actually in force so the Studio
                    # can warn ("bridge too old for X") instead of finding out later.
                    print(f"[log] unknown log level {requested!r} requested; keeping {log.level}", file=sys.stderr)
                pipeline.reset_base()  # zero behavior ms/ft at the run boundary
                log.start_new_log()  # fresh timestamped file per activation
                log.write_inbound(raw)
            else:
                log.write_inbound(raw)
                log.close()
            await reply(
                websocket,
                {
                    "type": "log_control_ack",
                    "enabled": log.active,
                    "level": log.level,
                    "requested": requested,
                    "file": log.current_name,
                },
            )
        elif kind == "log_export":
            # Close + stream the whole log back to the ASKING client only.
            name, content = log.export_current()
            if name is not None:
                reply_msg = {"type": "log_export_result", "name": name, "content": content}
            else:
                reply_msg = {"type": "log_export_result", "error": "no log file has been written"}
            await reply(websocket, reply_msg)
            print(
                f"[log] export → {name or 'nothing'}"
                + (f" ({len(content)} chars)" if content else ""),
                file=sys.stderr,
            )
        elif kind == "rows":
            # Compact array rows (controller telemetry cc/cf/cs) — verbatim lines.
            log.write_rows(obj.get("rows"))
        else:
            # {"type":"log", ...} and anything else → straight to the log file.
            log.write_inbound(raw)

    return dispatch


def _bias_banner(bias: dict) -> str:
    """One-glance bias summary for the startup banner / stderr."""
    if bias["type"] == "none":
        return "none"
    if bias["type"] == "constant":
        return f"constant {bias['amplitude']:g}deg/s"
    return f"{bias['type']} {bias['amplitude']:g}deg/s @{bias['frequency']:g}Hz"


async def run(args: argparse.Namespace) -> None:
    if serve is None:
        raise SystemExit("the `websockets` package is required to serve (pixi install); --convert works without it")
    log = LogWriter(args.log, args.log_level, args.log_dir)
    queue: asyncio.Queue[str] = asyncio.Queue()
    # pipeline ↔ hub is a cycle (hub's dispatcher reconfigures the pipeline; the
    # pipeline publishes to the hub), so build the pipeline first and wire the hub in.
    pipeline = Pipeline(
        None,
        log,
        args.frames,
        args.deg_per_frame,
        args.offset,
        {
            "type": args.bias_type,
            "amplitude": args.bias_amplitude,
            "frequency": args.bias_freq,
        },
        coupling=args.coupling,
    )
    inputs = InputManager(args.proto, args.in_host, args.in_port, queue)
    hub = Hub(make_dispatcher(pipeline, log, inputs))
    pipeline.hub = hub

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # e.g. Windows
            pass

    inputs.start()
    consumer = asyncio.create_task(consume(queue, pipeline))

    async with serve(hub.serve_client, args.ws_host, args.ws_port, max_size=WS_MAX_SIZE):
        print(
            f"[ws] serving ws://{args.ws_host}:{args.ws_port}  "
            f"(bridge {BRIDGE_VERSION}; proto={args.proto}, fictrac_port={args.in_port}, "
            f"frames={args.frames}, coupling={args.coupling:g}, deg_per_frame={args.deg_per_frame:g}, "
            f"bias={_bias_banner(pipeline.bias)}, log={args.log or 'on-demand'}, level={log.level})",
            file=sys.stderr,
        )
        await stop.wait()

    print(
        f"\n[bridge] shutting down (parsed={pipeline.parsed}, skipped={pipeline.skipped})",
        file=sys.stderr,
    )
    consumer.cancel()
    await inputs.stop()
    await asyncio.gather(consumer, return_exceptions=True)
    log.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # An OLD bridge lacks this flag, so `pixi run bridge -- --version` erroring with
    # "unrecognized arguments: --version" is itself proof the checkout is stale.
    p.add_argument("--version", action="version", version=f"fictrac-bridge {BRIDGE_VERSION}")
    p.add_argument("--proto", choices=("udp", "tcp"), default="udp", help="FicTrac transport (default: udp)")
    p.add_argument("--in-host", default="127.0.0.1", help="FicTrac source: UDP bind / TCP connect host (default: 127.0.0.1)")
    p.add_argument("--in-port", type=int, default=60000, help="FicTrac source port; re-bindable from the browser (default: 60000)")
    p.add_argument("--ws-host", default="127.0.0.1", help="WebSocket bind host (default: 127.0.0.1)")
    p.add_argument("--ws-port", type=int, default=8765, help="WebSocket port (default: 8765)")
    p.add_argument("--frames", type=int, default=200, help="frame count of the loaded pattern; the index modulus (default: 200)")
    p.add_argument("--coupling", type=float, default=1.0, help="dimensionless closed-loop coupling: 1 = the display follows the ball 1:1, 0.75/1.25 = less/more, negative = reversed, 0 = ignore the fly (bias-only replay). A protocol's startClosedLoop overrides this live (default: 1.0)")
    p.add_argument("--deg-per-frame", type=float, default=1.8, help="display degrees per frame index — the PATTERN pitch, e.g. 360/200 px = 1.8 on a 10-column G6 (default: 1.8)")
    p.add_argument("--gain", type=float, default=None, help="DEPRECATED alias of --deg-per-frame (pre-3.3 name)")
    p.add_argument("--offset", type=float, default=0.0, help="heading offset in degrees (default: 0.0)")
    p.add_argument("--bias-type", choices=BIAS_TYPES, default="none", help="closed-loop bias/disturbance waveform (default: none). A protocol's startClosedLoop overrides this live")
    p.add_argument("--bias-amplitude", type=float, default=0.0, help="bias PEAK velocity in deg/s (default: 0.0)")
    p.add_argument("--bias-freq", type=float, default=1.0, help="bias frequency in Hz for sine/square; ignored by constant (default: 1.0)")
    p.add_argument("--log", default=None, help="append browser log events (JSONL) to this file (else opened on demand)")
    p.add_argument("--log-dir", default=None, help="directory for on-demand arena-log-*.jsonl files (default: CWD; created if missing)")
    p.add_argument("--log-level", choices=LOG_LEVELS, default=None, help=f"launch default for the log format, overridden per run by the browser's log_control (default: {DEFAULT_LOG_LEVEL}). behavior_v2 = compact arena echoes; behavior_v1 = the pre-2026-09 format; full = the 25-column FicTrac record per frame")
    p.add_argument("--log-frames", action="store_true", help="alias for --log-level full (debug/archival)")
    p.add_argument("--convert", nargs=2, metavar=("IN", "OUT"), help="offline: re-encode a run log v1 ⇄ v2 (direction auto-detected; .jsonl or .jsonl.gz either side) and exit — no sockets")
    p.add_argument("--to", choices=("v1", "v2"), default=None, help="with --convert: force the target format instead of auto-detecting")
    args = p.parse_args(argv)

    if args.convert:
        src, dst = args.convert
        try:
            rep = convert_file(src, dst, args.to)
        except (RunlogFormatError, OSError, json.JSONDecodeError) as exc:
            print(f"[convert] FAILED: {exc}", file=sys.stderr)
            return 1
        print(
            f"[convert] {rep['src']} ({rep['from']}) → {rep['dst']} ({rep['to']}): "
            f"{rep['lines']} lines, {rep['bytes']} bytes",
            file=sys.stderr,
        )
        return 0

    if args.frames <= 0:
        p.error("--frames must be > 0")
    if args.gain is not None:
        print("[bridge] --gain is deprecated (pre-3.3 name of --deg-per-frame); using it as the pattern pitch", file=sys.stderr)
        args.deg_per_frame = args.gain
    if not math.isfinite(args.coupling):
        p.error("--coupling must be a finite number")
    # 0 Hz is the divide-by-ω case for the periodic waveforms — reject it here, where a
    # human can still read the message, rather than letting bias_angle_deg no-op silently.
    if args.bias_type in ("sine", "square") and args.bias_freq == 0:
        p.error(f"--bias-freq must be non-zero for --bias-type {args.bias_type}")
    if args.log_frames and args.log_level not in (None, "full"):
        p.error("--log-frames conflicts with --log-level")
    if args.log_level is None:
        args.log_level = "full" if args.log_frames else DEFAULT_LOG_LEVEL

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
