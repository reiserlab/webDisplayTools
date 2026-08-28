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
                     {"type":"log_export_result", "name":<str>, "content":<str>}
                       (reply to log_export; {"error":<str>} when nothing was written)
  browser → bridge:  {"type":"hello", "client":"arena_console", "v":1}   (on connect)
                     {"type":"config", "fictrac_port":<int>, "gain":<float>,
                                       "offset":<float>, "frames":<int>,
                                       "bias":{"type":"none"|"constant"|"sine"|"square",
                                               "amplitude":<deg/s>, "frequency":<Hz>}}
                       (any subset; a message CARRYING "bias" re-zeros the bias phase
                        clock AND re-tares the heading, so every closed-loop epoch
                        starts at phase 0 with the display where the pattern loaded)
                     {"type":"log_control", "enabled":<bool>, "level":"behavior_v1"|"full"}
                       (open/close the log file; level picks the frame-row format,
                        overriding --log-frames — the runner asserts behavior_v1)
                     {"type":"log",   "event":<str>, ...arbitrary, "ms":<int>}
                     {"type":"log_export"}   (close the active log, stream it back whole)

The FicTrac → frame-index policy lives in frame_index_from_fictrac(); edit that one
function to change closed-loop behaviour. The optional BIAS WAVEFORM (LAB-185) is an
added rotational velocity whose time-integral is summed into the mapping alongside
`offset`, so the display keeps moving even when the fly is still — see
bias_angle_deg() and docs/development/closed-loop-bias.md. Each epoch also TARES the
heading (hd0), so it opens with the display where `frame_index` put it rather than
jumping to an arbitrary index derived from FicTrac's absolute heading.

FRAME LOGGING has two levels (issue #140), both uniform NDJSON — a reader does one
JSON.parse() per line and dispatches on Array.isArray (frame array vs event object):
  - behavior_v1 (DEFAULT): a one-time {"type":"frame_schema","level":"behavior_v1",
    "cols":["ms","fc","idx","ft","x","y","hd"]} header, then each frame as the
    positional array [ms, fc, idx, ft, x, y, hd]. Compact behavioral state the live
    scope + offline dashboard recompute all derived channels from (see js/kinematics.js).
    ft = FicTrac col-22 timestamp as relative ms — NOT col-24 dt, which cannot
    recover elapsed time across a frame dropped before logging (Frank, #143).
    col 22 is the camera hardware clock in ns on our rigs, normalized to ms here
    (FT_TS_NS_PER_MS); downstream dt is per-frame ft differences (variable-rate safe).
  - full (--log-frames): the whole 25-column record under a "fictrac" key (debug/archival).
Session/runner events stay JSON objects on their own lines. `minimal` and gzip are deferred.
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

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

# Inbound WebSocket message cap. The library default is 1 MiB — raised so a
# multi-MB payload never kills the socket; sized to match the log_export
# replies we stream the other way (one experiment log as ONE message).
WS_MAX_SIZE = 16 * 1024 * 1024

# Bridge build tag. Bump when the wire/log schema changes so a rig can confirm at a
# glance which bridge it's running: `pixi run bridge -- --version` prints it, and it
# leads the startup banner. (An OLD bridge has no --version flag → argparse errors,
# which is itself the tell.) "behavior_v1" here means frames carry ms/fc/idx/ft/x/y/hd
# with `ft` normalized ns→ms — i.e. the live scope + dashboard will work.
BRIDGE_VERSION = "2.2 · behavior_v1 (ns→ms ft, x/y/hd frames) + bias waveforms + heading tare"

# behavior_v1 — the default logged frame schema (issue #140). Positional-array
# rows in this column order; the live scope + offline dashboard recompute every
# derived channel (turning/forward/side/speed/dir) from this compact state.
BEHAVIOR_V1_COLS = ["ms", "fc", "idx", "ft", "x", "y", "hd"]

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


def frame_index_from_fictrac(
    fields: list[float],
    n_frames: int,
    gain: float,
    offset: float,
    bias_deg: float = 0.0,
    hd0_deg: float = 0.0,
) -> int:
    """Map one FicTrac record to a 0-based arena frame index in [0, n_frames).

    Default policy: drive the frame from the animal's integrated heading (FicTrac
    field 17 → 0-based index 16, radians). `gain` is **degrees of heading per frame
    index** — e.g. a pattern with 200 azimuthal positions over 360° gives
    360/200 = 1.8; a negative gain reverses the coupling direction. `offset` shifts
    the zero (degrees). Replace the body to use position (fields 15-16), speed
    (field 19), or any combination.

    `bias_deg` is the disturbance angle from bias_angle_deg(), summed in the same
    heading-equivalent degrees space as `offset`. So a positive bias amplitude moves
    the display the same direction as increasing fly heading, and a NEGATIVE `gain`
    reverses the bias direction along with the fly coupling.

    `hd0_deg` is the HEADING TARE: the heading treated as zero. FicTrac's integrated
    heading is absolute (and wraps 0..360), so without a tare the first frame of a
    closed-loop epoch lands at round(heading/gain) — an essentially arbitrary index.
    On the bench that showed up as the pattern being loaded centred in front of the
    fly and then JUMPING somewhere else, possibly out of view, on the very first
    FicTrac frame. Subtracting the heading at epoch onset makes the epoch start at
    index 0 (i.e. wherever `frame_index` put it, for the usual frame_index 0) and
    move relative to that. `offset` still applies on top, so it can deliberately
    place the start elsewhere.
    """
    if not gain:
        return 0  # no deg→index scale, so there is nothing to map (bias included)
    # Wrap the tared difference into (-180, 180] so it reads as a true RELATIVE turn:
    # FicTrac's col-17 heading already wraps 0..360, so a fly that turned +20 deg past
    # a tare of 350 would otherwise present as -340. The two are equivalent modulo
    # 360/gain frames, which only coincides with n_frames when the pattern spans the
    # full azimuth — wrapping keeps the nearest-angle reading correct for short,
    # tiled patterns too. Only the heading is wrapped; `bias_deg` must stay unbounded
    # so a constant disturbance keeps rotating.
    heading_deg = ((math.degrees(fields[16]) - hd0_deg + 180.0) % 360.0) - 180.0
    idx = round((heading_deg + offset + bias_deg) / gain)
    return idx % n_frames  # Python % is non-negative, so negative gain wraps cleanly


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


class LogWriter:
    """Appends one JSON line per event to a log file.

    The browser's "log fictrac" toggle starts a **fresh timestamped file on every
    activation** (start_new_log). A standalone --log PATH keeps a single file.
    On-demand files land in --log-dir (default: the process CWD).
    """

    def __init__(self, path: str | None, log_frames: bool, log_dir: str | None = None) -> None:
        self._explicit = path  # fixed --log path (standalone), else None
        self._dir = log_dir or ""
        self._fh = None
        self._name: str | None = None  # current-or-most-recent file (export target)
        self.log_frames = log_frames
        if self._dir:
            os.makedirs(self._dir, exist_ok=True)
        if path:
            self._open(path, "bridge_start")

    @property
    def active(self) -> bool:
        return self._fh is not None

    def set_level(self, level: str) -> None:
        """Select the frame-logging level for the NEXT log file (browser-driven,
        overriding the --log-frames launch flag): 'full' = 25-column record,
        anything else = the compact behavior_v1 array."""
        self.log_frames = level == "full"

    def _open(self, name: str, event: str) -> None:
        self._fh = open(name, "a", buffering=1, encoding="utf-8")
        self._name = name
        self._emit({"type": "session", "event": event, "file": name, "ms": now_ms()})
        # behavior_v1 logs lead with a one-time schema line so the positional
        # frame arrays are self-describing (full mode stays keyed objects).
        if not self.log_frames:
            self._emit({"type": "frame_schema", "level": "behavior_v1", "cols": BEHAVIOR_V1_COLS})
        print(f"[log] writing to {name}", file=sys.stderr)

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

    def write_inbound(self, raw: str | bytes) -> None:
        if not self._fh:
            return
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            obj = {"type": "log", "event": "unparsed", "raw": raw}
        obj.setdefault("dir", "browser→bridge")
        obj.setdefault("rx_ms", now_ms())
        self._emit(obj)

    def write_frame(self, beh: dict, fields: list[float]) -> None:
        # Store EVERY received FicTrac frame whenever logging is active — regardless
        # of whether the browser is applying frames. Default = behavior_v1 positional
        # array; --log-frames = the full 25-field record (debug/archival).
        if not self._fh:
            return
        if self.log_frames:
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
        gain: float,
        offset: float,
        bias: dict | None = None,
    ) -> None:
        self.hub = hub
        self.log = log
        self.n_frames = n_frames
        self.gain = gain
        self.offset = offset
        self.parsed = 0
        self.skipped = 0
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
        # epoch would otherwise open by jumping the display to round(heading/gain).
        # hd0 is the heading treated as zero; _tare_pending latches it from the FIRST
        # frame after the epoch begins (a config message can't sample a heading that
        # hasn't arrived yet, and the last-seen one may be stale).
        self.hd0 = 0.0
        self._tare_pending = False
        if bias:
            self.set_bias(bias, log_event=False, tare=False)

    def reset_base(self) -> None:
        """Re-zero the behavior_v1 relative clocks at a run boundary (log start)."""
        self.t0_ms = now_ms()
        self.ft0 = None

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
            self._tare_pending = True
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

    def bias_now_deg(self) -> float:
        """Current bias angle, evaluated ANALYTICALLY at the elapsed epoch time — never
        incrementally integrated, so a dropped FicTrac frame costs nothing and the value
        is exactly reproducible offline."""
        if self.bias["type"] == "none":
            return 0.0
        t_s = (now_ms() - self.bias_t0_ms) / 1000.0
        return bias_angle_deg(self.bias["type"], self.bias["amplitude"], self.bias["frequency"], t_s)

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
        # Latch the heading tare on the first frame of a new epoch, BEFORE mapping, so
        # that very first frame already lands at the pattern's start index instead of
        # jumping. Logged (with the same relative ms as the frame rows) because offline
        # reconstruction of the mapping needs it.
        if self._tare_pending:
            self._tare_pending = False
            self.hd0 = math.degrees(fields[16])
            self.log.write_event(
                {
                    "type": "heading_tare",
                    "dir": "bridge",
                    "ms": now_ms() - self.t0_ms,
                    "hd0_deg": round(self.hd0, 4),
                }
            )
        bias_deg = self.bias_now_deg()
        index = frame_index_from_fictrac(
            fields, self.n_frames, self.gain, self.offset, bias_deg, self.hd0
        )
        # behavior_v1 compact state (issue #140): the live scope + offline dashboard
        # recompute every derived channel from these. The ns→ms + column mapping
        # lives in behavior_v1_row() (pure, offline-tested); the Pipeline only owns
        # the stateful clocks (t0_ms wall base, ft0 first-frame col-22).
        if self.ft0 is None and len(fields) > 21:
            self.ft0 = fields[21]
        beh = behavior_v1_row(fields, index, now_ms() - self.t0_ms, self.ft0)
        # Legacy index/seq/t kept alongside the behavior_v1 fields for back-compat.
        msg = {"type": "frame", "index": index, "seq": beh["fc"], "t": now_ms()}
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

    async def dispatch(raw, websocket=None) -> None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            log.write_inbound(raw)
            return
        kind = obj.get("type")

        if kind == "config":
            applied = {}
            if obj.get("gain") is not None:
                pipeline.gain = float(obj["gain"])
                applied["gain"] = pipeline.gain
            if obj.get("offset") is not None:
                pipeline.offset = float(obj["offset"])
                applied["offset"] = pipeline.offset
            if obj.get("frames"):
                pipeline.n_frames = max(1, int(obj["frames"]))
                applied["frames"] = pipeline.n_frames
            if obj.get("fictrac_port"):
                await inputs.rebind(int(obj["fictrac_port"]))
                applied["fictrac_port"] = inputs.port
            # Presence of the key — not its value — re-zeros the bias phase clock, so
            # `{"bias":{"type":"none"}}` is how the runner both stops the disturbance at
            # stopClosedLoop and guarantees the next epoch starts at phase 0.
            if "bias" in obj:
                applied["bias"] = pipeline.set_bias(obj["bias"])
            print(f"[cfg] applied {applied}", file=sys.stderr)
            log.write_inbound(raw)
        elif kind == "log_control":
            if obj.get("enabled"):
                if obj.get("level") in ("behavior_v1", "full"):
                    log.set_level(obj["level"])  # browser asserts the level per run
                pipeline.reset_base()  # zero behavior_v1 ms/ft at the run boundary
                log.start_new_log()  # fresh timestamped file per activation
                log.write_inbound(raw)
            else:
                log.write_inbound(raw)
                log.close()
        elif kind == "log_export":
            # Close + stream the whole log back to the ASKING client only.
            name, content = log.export_current()
            if name is not None:
                reply = {"type": "log_export_result", "name": name, "content": content}
            else:
                reply = {"type": "log_export_result", "error": "no log file has been written"}
            if websocket is not None:
                try:
                    await websocket.send(json.dumps(reply))
                except ConnectionClosed:
                    pass
            print(
                f"[log] export → {name or 'nothing'}"
                + (f" ({len(content)} chars)" if content else ""),
                file=sys.stderr,
            )
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
    log = LogWriter(args.log, args.log_frames, args.log_dir)
    queue: asyncio.Queue[str] = asyncio.Queue()
    # pipeline ↔ hub is a cycle (hub's dispatcher reconfigures the pipeline; the
    # pipeline publishes to the hub), so build the pipeline first and wire the hub in.
    pipeline = Pipeline(
        None,
        log,
        args.frames,
        args.gain,
        args.offset,
        {
            "type": args.bias_type,
            "amplitude": args.bias_amplitude,
            "frequency": args.bias_freq,
        },
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
            f"frames={args.frames}, gain={args.gain:g}, bias={_bias_banner(pipeline.bias)}, "
            f"log={args.log or 'on-demand'})",
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
    p.add_argument("--gain", type=float, default=1.8, help="degrees of heading per frame index, e.g. 360/200=1.8 (default: 1.8)")
    p.add_argument("--offset", type=float, default=0.0, help="heading offset in degrees (default: 0.0)")
    p.add_argument("--bias-type", choices=BIAS_TYPES, default="none", help="closed-loop bias/disturbance waveform (default: none). A protocol's startClosedLoop overrides this live")
    p.add_argument("--bias-amplitude", type=float, default=0.0, help="bias PEAK velocity in deg/s (default: 0.0)")
    p.add_argument("--bias-freq", type=float, default=1.0, help="bias frequency in Hz for sine/square; ignored by constant (default: 1.0)")
    p.add_argument("--log", default=None, help="append browser log events (JSONL) to this file (else opened on demand)")
    p.add_argument("--log-dir", default=None, help="directory for on-demand arena-log-*.jsonl files (default: CWD; created if missing)")
    p.add_argument("--log-frames", action="store_true", help="log the FULL 25-column FicTrac record per frame (debug/archival); default logs the compact behavior_v1 array [ms,fc,idx,ft,x,y,hd]")
    args = p.parse_args(argv)

    if args.frames <= 0:
        p.error("--frames must be > 0")
    # 0 Hz is the divide-by-ω case for the periodic waveforms — reject it here, where a
    # human can still read the message, rather than letting bias_angle_deg no-op silently.
    if args.bias_type in ("sine", "square") and args.bias_freq == 0:
        p.error(f"--bias-freq must be non-zero for --bias-type {args.bias_type}")

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
