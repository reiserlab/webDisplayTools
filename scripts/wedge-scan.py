#!/usr/bin/env python3
"""wedge-scan.py — scan G6 arena run logs for the Mode-3 "controller wedge".

Firmware issue reiserlab/LED-Display_G6_Firmware_Arena#50: during sustained
Mode-3 closed-loop streaming (host sends SET_FRAME_POSITION 0x70 at 100–286 Hz)
the controller occasionally becomes ~100–500 ms per command (normally 2–3 ms)
and stays that way. On the host side this shows up as 0x70 rows with
``status: null`` and ``error: "response timeout after 500 ms (cmd 0x70)"``,
then a TRIAL_PARAMS (0x08) failure (a ``runner`` event, phase ``error``), then
the operator aborts. This script streams many logs (unattended-soak scale) and
produces the per-run table from that issue.

INPUT FORMATS (auto-detected per file; ``.gz`` transparently):
  * bridge NDJSON ``behavior_v2`` — ``{"type":"frame_schema",...,"t0":<epoch ms>}``
    header, FicTrac frames as ``[ms, fc, idx, ft, x, y, hd]`` arrays, arena echoes
    as compact ``["a", t_off, dt, hex, status, rx_off(, error)]`` arrays. The
    format authority is ``fictrac-bridge/bridge.py`` (``expand_arena_command``);
    the tiny subset decoded here is re-implemented so this tool imports nothing
    from the bridge (no websockets, no path games).
  * bridge NDJSON ``behavior_v1`` — arena echoes as full
    ``{"type":"log","event":"arena_command","t":..,"dt":..,"head":"03 70 bf 00",
    "status":0,...,"error":null}`` objects.
  * bridge NDJSON ``full`` — verbatim arena echoes, FicTrac under ``"fictrac"``.
  * Arena Studio ``.runlog.json`` envelope ``{schema, intent, meta, events, summary}``
    — runner events only, NO per-command rows: run metadata + outcome + any
    ``error`` events mentioning a timeout are reported, per-command stats are
    ``n/a (no arena_command rows)`` and the outcome is ``no-arena-rows``.

ONSET DEFINITION (the one number that matters):
  the first 0x70 row with ``status: null`` (timeout) that is followed, within the
  next WINDOW (default 10) arena rows, by >= MIN_FOLLOWERS (default 2) more
  timeouts of ANY opcode — i.e. a sustained failure. A timeout that does not
  meet that bar is an *isolated* timeout (counted in ``isolated_timeouts``,
  outcome ``isolated`` when there is no wedge).

WHAT ``dt`` IS:
  ``dt`` is the HOST-observed round trip: from the browser handing the request
  to Web Serial until the framed reply was parsed, INCLUDING host queue time and
  USB/CDC scheduling. It is not a controller-side RTT. A 500-ish dt with
  ``status: null`` is the host's 500 ms timeout, not a measured reply.

OUTCOME column:  clean | wedge | fault-declared | isolated | incomplete | no-arena-rows
  (fault-declared = the runner/Studio declared a controller fault — e.g. rejects —
   without the timeout signature; `declared_fault` carries the reason)
  ``incomplete`` = no terminal runner/session event (killed bridge, truncated
  file) OR any unparseable line (``bad_lines`` > 0) — a damaged file is never
  reported as ``clean`` silently.

Memory is bounded: files are streamed line by line; RTT percentiles use an
integer-ms histogram; the "last 30 s" trend uses a rolling deque.

Usage:
  python scripts/wedge-scan.py runlogs/rig03-sr/*.jsonl
  python scripts/wedge-scan.py --json runlogs/            # directories recurse
  python scripts/wedge-scan.py --verbose some.jsonl.gz     # +/-5 rows at onset
Exit code 0 always, except 2 when a named file could not be opened.
"""

from __future__ import annotations

import argparse
import collections
import gzip
import io
import json
import os
import re
import sys

# ── constants ────────────────────────────────────────────────────────────────
DEFAULT_WINDOW = 10  # arena rows after a candidate timeout to look for followers
DEFAULT_MIN_FOLLOWERS = 2  # more timeouts (any opcode) needed to confirm onset
TREND_WINDOW_MS = 30_000  # "last 30 s before onset" trend window
SLOW_DT_MS = 50  # soft-degradation threshold for an OK 0x70 reply
# Controller telemetry rows (fw feat/telemetry-ring via js/arena-telemetry.js).
CTL_TAGS = ("cc", "cf", "cs")
CTL_STATE_KINDS = {
    1: "boot",
    2: "state_change",
    3: "error_glyph",
    4: "sd_slow",
    5: "ring_overrun",
    6: "telemetry",
    7: "sd_open",
    8: "wdog_context",  # code = EXC_RETURN low byte; arg bits 0-8 = stacked IPSR, bits 9-15 = prior isr_last
    9: "prev_isr_count",  # code = ISR id; arg = previous boot's entry count >> 12
}
ISR_NAMES = ["none", "refresh_timer", "spi_dma", "watchdog", "usb", "sdhc", "lpspi", "pit"]

HIST_CAP_MS = 5_000  # dt histogram: buckets 0..HIST_CAP_MS-1 + one overflow bucket
CONTEXT_ROWS = 5  # --verbose: rows before/after the onset row
RUNLOG_JSON_MAX_BYTES = 64 * 1024 * 1024  # whole-file json.load cap for envelopes
NA = "n/a (no arena_command rows)"

OPCODE_NAMES = {
    0x00: "ALL_OFF",
    0x01: "SYSTEM_RESET",
    0x08: "TRIAL_PARAMS",
    0x16: "SET_REFRESH_RATE",
    0x17: "GET_REFRESH_RATE",
    0x1B: "SET_PANEL_DISPLAY_MODE",
    0x1C: "GET_PANEL_DISPLAY_MODE",
    0x30: "STOP_DISPLAY",
    0x32: "STREAM_FRAME",
    0x33: "GET_FRAMES_SENT",
    0x34: "RESET_FRAMES_SENT",
    0x70: "SET_FRAME_POSITION",
    0x80: "GET_FILE_COUNT",
    0x82: "GET_PATTERN_FILENAME",
    0x83: "SET_PATTERN_FILENAME",
    0x84: "GET_PATTERN_FILE",
    0x85: "SET_PATTERN_FILE",
    0x86: "DELETE_PATTERN_FILE",
    0x88: "GET_PATTERN_INFO",
    0x8A: "GET_SD_ARCHIVE",
    0x8F: "PURGE_MEMORY",
    0xA0: "SET_AO_VOLTAGE",
    0xA1: "GET_AO_VOLTAGE",
    0xA3: "SET_AO_MODE",
    0xA4: "GET_ANALOG_IN",
    0xAA: "SET_DIGITAL_OUT",
    0xAB: "GET_DIGITAL_OUT",
    0xAC: "SET_DIO_ROLE",
    0xAD: "GET_DIO_ROLE",
    0xC0: "SET_ETHERNET_IP",
    0xC1: "GET_ETHERNET_IP",
    0xC2: "GET_CONTROLLER_INFO",
    0xC3: "SET_DIAG_OUTPUT",
    0xC4: "GET_DIAG_OUTPUT",
    0xC5: "SET_SPI_CLOCK",
    0xC6: "GET_SPI_CLOCK",
    0xC8: "G6_PROGRAM_PANEL",
    0xC9: "G6_VERIFY_PANEL",
    0xCA: "GET_HEALTH",
    0xE0: "SET_FIRMWARE_FILE",
    0xE3: "GET_FIRMWARE_INFO",
    0xFF: "ALL_ON",
}

TERMINAL_RUNNER_PHASES = ("sequence-complete", "aborted")
_HEX2 = re.compile(r"^[0-9a-fA-F]{2}$")
_CMD_IN_REASON = re.compile(r"cmd\s+0x([0-9a-fA-F]{1,2})")


def opcode_name(op: int | None) -> str:
    """Human label for an opcode byte, e.g. ``SET_FRAME_POSITION (0x70)``."""
    if op is None:
        return "?"
    name = OPCODE_NAMES.get(op)
    return f"{name} (0x{op:02X})" if name else f"0x{op:02X}"


# ── one decoded arena row ────────────────────────────────────────────────────
class ArenaRow:
    """A normalized arena command echo (from a v1 object or a v2 array)."""

    __slots__ = ("line", "t", "dt", "hex", "opcode", "status", "error")

    def __init__(self, line, t, dt, hexs, status, error):
        self.line = line  # 1-based physical line number
        self.t = t  # epoch ms of the request (None if unknown)
        self.dt = dt  # host-observed round trip, ms
        self.hex = hexs  # request bytes, no spaces, lowercase
        self.status = status  # int or None (None = no reply)
        self.error = error  # str or None
        self.opcode = int(hexs[2:4], 16) if len(hexs) >= 4 else None

    @property
    def timeout(self) -> bool:
        return self.status is None

    @property
    def index(self) -> int | None:
        """u16 LE payload of a 0x70 request (frame index); None otherwise."""
        if self.opcode != 0x70 or len(self.hex) < 8:
            return None
        return int(self.hex[4:6], 16) | (int(self.hex[6:8], 16) << 8)

    def brief(self) -> str:
        st = "TIMEOUT" if self.timeout else f"status {self.status}"
        idx = self.index
        idx_s = f" idx {idx}" if idx is not None else ""
        err = f" — {self.error}" if self.error else ""
        return f"L{self.line} {opcode_name(self.opcode)}{idx_s} dt={self.dt} ms {st}{err}"


def _normalize_hex(head) -> str | None:
    """``"03 70 bf 00"`` / ``"03700000"`` → ``"0370bf00"``; None if not hex bytes.

    A v1 ``head`` may carry a truncation marker for long commands; only the
    leading whole hex bytes are kept so the opcode is still recoverable."""
    if not isinstance(head, str):
        return None
    parts = head.split(" ") if " " in head else [head[i : i + 2] for i in range(0, len(head), 2)]
    out = []
    for p in parts:
        if not _HEX2.match(p):
            break
        out.append(p.lower())
    return "".join(out) if out else None


def decode_arena(value, line: int, t0: int | None) -> ArenaRow | None:
    """Return an ArenaRow for a v2 ``["a", ...]`` array or a v1/full
    ``arena_command`` object; None for anything else (frames, events)."""
    if isinstance(value, list):
        if len(value) in (6, 7) and value[0] == "a":
            _, t_off, dt, hexs, status, _rx = value[:6]
            error = value[6] if len(value) == 7 else None
            h = _normalize_hex(hexs)
            if h is None:
                return None
            t = (t0 + t_off) if (t0 is not None and isinstance(t_off, (int, float))) else None
            return ArenaRow(line, t, dt, h, status, error)
        return None
    if isinstance(value, dict) and value.get("event") == "arena_command":
        h = _normalize_hex(value.get("head"))
        if h is None:
            return None
        t = value.get("t")
        return ArenaRow(line, t if isinstance(t, (int, float)) else None, value.get("dt"), h, value.get("status"), value.get("error"))
    return None


# ── bounded statistics helpers ───────────────────────────────────────────────
class DtHistogram:
    """Integer-ms histogram with an overflow bucket; exact median/p99 for
    integer dts, within 1 ms for fractional ones."""

    def __init__(self, cap: int = HIST_CAP_MS):
        self.cap = cap
        self.buckets = collections.Counter()
        self.n = 0
        self.max = None

    def add(self, dt) -> None:
        if not isinstance(dt, (int, float)):
            return
        b = int(round(dt))
        b = self.cap if b >= self.cap else max(b, 0)
        self.buckets[b] += 1
        self.n += 1
        self.max = dt if self.max is None else max(self.max, dt)

    def percentile(self, q: float):
        if not self.n:
            return None
        target = max(1, int(round(q * self.n)))
        seen = 0
        for b in sorted(self.buckets):
            seen += self.buckets[b]
            if seen >= target:
                return f">={self.cap}" if b == self.cap else b
        return None


def _median(values) -> float | None:
    vals = sorted(v for v in values if isinstance(v, (int, float)))
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2


class TrendWindow:
    """Rolling deque of (t_ms, dt) for OK 0x70 rows in the last TREND_WINDOW_MS."""

    def __init__(self, span_ms: int = TREND_WINDOW_MS):
        self.span = span_ms
        self.q = collections.deque()
        self.n_seen = 0  # fallback counter when rows carry no timestamp

    def add(self, t, dt) -> None:
        key = t if isinstance(t, (int, float)) else self.n_seen
        self.n_seen += 1
        self.q.append((key, dt))
        cutoff = key - self.span
        while self.q and self.q[0][0] < cutoff:
            self.q.popleft()

    def median(self):
        return _median(dt for _, dt in self.q)


# ── file iteration ───────────────────────────────────────────────────────────
def open_text(path: str):
    """Open a plain or gzip'd log as a UTF-8 text stream (line-buffered)."""
    if path.endswith(".gz"):
        return io.TextIOWrapper(gzip.open(path, "rb"), encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def iter_files(paths, recurse=True):
    """Expand directories into log files (sorted); yield paths in order."""
    exts = (".jsonl", ".jsonl.gz", ".ndjson", ".ndjson.gz", ".runlog.json", ".json.gz")
    for p in paths:
        if os.path.isdir(p) and recurse:
            for root, _dirs, files in os.walk(p):
                for f in sorted(files):
                    if f.endswith(exts) and f != "index.json":
                        yield os.path.join(root, f)
        else:
            yield p


def meta_from_filename(path: str) -> dict:
    """``<proto>__<user>__<ts>__<runid>.jsonl`` + parent dir → run metadata."""
    base = os.path.basename(path)
    stem = base.split(".")[0]
    out = {"bench": os.path.basename(os.path.dirname(os.path.abspath(path)))}
    parts = stem.split("__")
    if len(parts) == 4:
        out.update(protocol=parts[0], run_id=parts[3])
    return out


# ── the per-file analyzer ────────────────────────────────────────────────────
class RunScan:
    """Streaming state for one log file. Feed lines with ``feed()``; read
    ``result()`` when done. Everything here is bounded-memory."""

    def __init__(self, path: str, window: int, min_followers: int):
        self.path = path
        self.window = window
        self.min_followers = min_followers
        self.format = None  # behavior_v2 | behavior_v1 | full | runlog.json | unknown
        self.t0 = None  # epoch ms reference (schema t0 / session ms / first arena t)
        self.last_t = None
        self.lines = 0
        self.bad_lines = 0
        self.first_bad_line = None
        self.arena_rows = 0
        self.cmd70_total = 0
        self.cmd70_ok = 0
        self.nonzero_status = 0
        self.nonzero_by_op = collections.Counter()  # opcode → non-zero-status replies
        self.resets = 0
        self.timeouts_total = 0
        self.isolated_timeouts = 0
        self.slow_before = 0  # OK 0x70 with dt > SLOW_DT_MS before onset
        self.ctl_records = 0
        self.ctl_by_tag = collections.Counter()
        self.ctl_sd_hist = collections.Counter()
        self.ctl_sd_max = 0
        self.ctl_states = collections.Counter()
        self.ctl_cmd_rejects = 0
        self.ctl_tail = collections.deque(maxlen=40)
        self.ctl_tail_pre_onset = []
        self.ctl_pre_boot = []  # [(lineno of the boot record, [(lineno, row), ...])]
        self.hist = DtHistogram()  # OK 0x70 dt before onset
        self.trend = TrendWindow()
        self.onset = None  # confirmed ArenaRow
        self.onset_cmd70_count = 0
        self.onset_trend_median = None
        self.timeouts_after = 0
        self.first_non70_fail = None
        self.runner_errors = []  # (line, text) — bounded to a few
        self.terminal = None  # 'sequence-complete' | 'aborted' | 'logging_stopped'
        self.declared_fault = None  # runner summary.fault (the live detector's verdict)
        self.ctl_malformed = 0  # tagged rows too short to decode (dropped, counted)
        self.meta = meta_from_filename(path)
        self.frames = 0
        self.recent = collections.deque(maxlen=CONTEXT_ROWS)  # last rows (context)
        self.candidates = []  # pending onset candidates
        self.context_after = []  # rows after onset for --verbose
        self.context_before = []

    # ── ingestion ────────────────────────────────────────────────────────
    def feed(self, line: str, lineno: int) -> None:
        self.lines = lineno
        s = line.strip()
        if not s:
            return
        try:
            value = json.loads(s)
        except ValueError:
            self.bad_lines += 1
            if self.first_bad_line is None:
                self.first_bad_line = lineno
            return
        row = decode_arena(value, lineno, self.t0)
        if row is not None:
            if self.format is None:  # legacy log without a frame_schema line
                self.format = "behavior_v2 (no schema)" if isinstance(value, list) else "behavior_v1 (no schema)"
            self._arena(row)
            return
        if isinstance(value, list):
            if value and isinstance(value[0], str) and value[0] in CTL_TAGS:
                self._ctl(value, lineno)
                return
            self._frame(value)
            return
        if isinstance(value, dict):
            self._event(value, lineno)

    def _ctl(self, arr, lineno: int) -> None:
        """Controller telemetry row (js/arena-telemetry.js): ["cc"|"cf"|"cs", rx, t_us, seq, ...]."""
        tag = arr[0]
        if len(arr) < 4:
            self.ctl_malformed += 1  # a bare ["cc"] must not kill the scan
            return
        self.ctl_records += 1
        self.ctl_by_tag[tag] += 1
        if isinstance(arr[1], (int, float)):
            self._touch(arr[1])
        if tag == "cf" and len(arr) >= 8 and isinstance(arr[6], (int, float)):
            sd = int(arr[6])
            self.ctl_sd_hist[min(sd // 100, 999)] += 1
            if sd > self.ctl_sd_max:
                self.ctl_sd_max = sd
        elif tag == "cs" and len(arr) >= 7:
            kind = CTL_STATE_KINDS.get(arr[4], f"kind_{arr[4]}")
            if arr[4] == 1 and len(arr) >= 7:
                # boot: code = SRC_SRSR & 0xFF (bit7 = wdog3 watchdog reset), arg bit1 = previous
                # boot died inside the watchdog pre-reset ISR (fw fb11681)
                if isinstance(arr[5], int) and arr[5] & 0x80:
                    kind = "boot(watchdog-reset)"
                elif isinstance(arr[6], int) and arr[6] & 0x02:
                    kind = "boot(wdog-isr)"
            elif arr[4] == 8 and len(arr) >= 7 and isinstance(arr[6], int):
                # watchdog context: which execution context the watchdog IRQ preempted
                ipsr = arr[6] & 0x1FF
                prior = arr[6] >> 9
                prior_name = ISR_NAMES[prior] if prior < len(ISR_NAMES) else f"isr_{prior}"
                ctx = "thread" if ipsr == 0 else ("pit-handler" if ipsr == 138 else f"handler_{ipsr}")
                kind = f"wdog_context({ctx}, before={prior_name})"
            elif arr[4] == 9 and len(arr) >= 7 and isinstance(arr[5], int):
                nm = ISR_NAMES[arr[5]] if arr[5] < len(ISR_NAMES) else f"isr_{arr[5]}"
                kind = f"prev_isr_count({nm})"
            self.ctl_states[kind] += 1
        elif tag == "cc" and len(arr) >= 7 and arr[5] not in (0, None):
            self.ctl_cmd_rejects += 1
        # Crash-dump tails. (a) host-order: the last records seen before the onset
        # was confirmed; (b) controller-order: at every `boot` STATE record, snapshot
        # the records that preceded it — that is the previous boot's final history,
        # which reaches the host only AFTER the reboot (post-mortem drain), i.e.
        # after the onset in file order.
        if tag == "cs" and len(arr) >= 7 and arr[4] == 1 and self.ctl_tail:
            self.ctl_pre_boot.append((lineno, list(self.ctl_tail)))
        self.ctl_tail.append((lineno, arr))
        if self.onset is None:
            self.ctl_tail_pre_onset = list(self.ctl_tail)

    def _frame(self, arr) -> None:
        self.frames += 1
        if arr and isinstance(arr[0], (int, float)) and self.t0 is not None:
            self._touch(self.t0 + arr[0])

    def _touch(self, t) -> None:
        if isinstance(t, (int, float)):
            self.last_t = t if self.last_t is None else max(self.last_t, t)

    def _event(self, obj: dict, lineno: int) -> None:
        typ = obj.get("type")
        ev = obj.get("event")
        if typ == "frame_schema":
            self.format = obj.get("level") or "behavior_v1"
            if isinstance(obj.get("t0"), (int, float)):
                self.t0 = obj["t0"]
            return
        if typ == "session":
            if isinstance(obj.get("ms"), (int, float)):
                if self.t0 is None:
                    self.t0 = obj["ms"]
                self._touch(obj["ms"])
            if ev == "logging_stopped":
                self.terminal = self.terminal or "logging_stopped"
            return
        if isinstance(obj.get("rx_ms"), (int, float)):
            self._touch(obj["rx_ms"])
        if ev == "run_metadata":
            for k_src, k_dst in (("run_id", "run_id"), ("protocol_filename", "protocol"), ("rig_id", "bench"), ("tool_version", "tool"), ("firmware", "firmware")):
                if obj.get(k_src):
                    self.meta[k_dst] = obj[k_src]
            return
        if ev == "fictrac_frame" or "fictrac" in obj:
            self.frames += 1
            return
        if ev == "runner":
            self._runner(obj, lineno)
        # reset detection on structured fields only (never free-text notes);
        # RESET_FRAMES_SENT / resetFramesSent is a counter clear, not a reboot.
        for k in ("event", "phase", "op", "command", "cmd"):
            v = obj.get(k)
            if isinstance(v, str) and "reset" in v.lower() and "frames" not in v.lower():
                self.resets += 1
                break

    def _runner(self, obj: dict, lineno: int) -> None:
        phase = obj.get("phase")
        if phase in TERMINAL_RUNNER_PHASES:
            self.terminal = phase
            summ = obj.get("summary")
            if isinstance(summ, dict) and summ.get("fault"):
                self.declared_fault = str(summ["fault"])
        elif phase == "fault":
            self.declared_fault = self.declared_fault or str(obj.get("reason") or "fault")
        elif phase == "error":
            text = obj.get("reason") or obj.get("error") or "error"
            if len(self.runner_errors) < 5:
                self.runner_errors.append((lineno, str(text)))
            if self.onset is not None and self.first_non70_fail is None:
                m = _CMD_IN_REASON.search(str(text))
                if m:
                    self.first_non70_fail = f"{opcode_name(int(m.group(1), 16))} via runner:error"
                else:
                    self.first_non70_fail = f"runner:error {text}"[:80]

    def _arena(self, row: ArenaRow) -> None:
        if self.t0 is None and row.t is not None:
            self.t0 = row.t  # v1 file without a session line
        self._touch(row.t)
        self.arena_rows += 1
        if row.opcode == 0x01:
            self.resets += 1
        if row.status is not None and row.status != 0:
            self.nonzero_status += 1
            self.nonzero_by_op[row.opcode] += 1
        is70 = row.opcode == 0x70
        if is70:
            self.cmd70_total += 1
            if row.status == 0:
                self.cmd70_ok += 1
        if row.timeout:
            self.timeouts_total += 1

        if self.onset is None:
            self._before_onset(row)
        else:
            self._after_onset(row)
        self.recent.append(row)

    def _before_onset(self, row: ArenaRow) -> None:
        # advance pending candidates first (this row is a follower of each)
        confirmed = None
        keep = []
        for c in self.candidates:
            c["since"].append(row)
            if row.timeout:
                c["followers"] += 1
            if c["followers"] >= self.min_followers:
                confirmed = c if confirmed is None else confirmed
            elif len(c["since"]) < self.window:
                keep.append(c)  # else: expired unconfirmed → an isolated timeout
        if confirmed is not None:
            self._confirm(confirmed)
            return
        self.candidates = keep

        if row.timeout:
            if row.opcode == 0x70:
                self.candidates.append(
                    {
                        "row": row,
                        "since": [],  # arena rows after the candidate (<= window)
                        "followers": 0,
                        "cmd70_before": self.cmd70_ok,
                        "trend": self.trend.median(),
                        "context_before": list(self.recent),
                    }
                )
            return
        if row.opcode == 0x70 and row.status == 0:
            self.hist.add(row.dt)
            self.trend.add(row.t, row.dt)
            if isinstance(row.dt, (int, float)) and row.dt > SLOW_DT_MS:
                self.slow_before += 1

    def _confirm(self, c: dict) -> None:
        self.onset = c["row"]
        self.onset_cmd70_count = c["cmd70_before"]
        self.onset_trend_median = c["trend"]
        self.context_before = c["context_before"]
        self.candidates = []
        for r in c["since"]:  # rows between onset and confirmation are "after"
            self._after_onset(r)

    def _after_onset(self, row: ArenaRow) -> None:
        if len(self.context_after) < CONTEXT_ROWS:
            self.context_after.append(row)
        if row.timeout:
            self.timeouts_after += 1
        failed = row.timeout or (row.status not in (None, 0))
        if failed and row.opcode != 0x70 and self.first_non70_fail is None:
            self.first_non70_fail = opcode_name(row.opcode)

    # ── result ───────────────────────────────────────────────────────────
    def outcome(self) -> str:
        if self.arena_rows == 0:
            return "no-arena-rows" if self.lines and self.bad_lines == 0 else "incomplete"
        if self.onset is not None:
            return "wedge"
        if self.declared_fault:
            # The live detector tripped (e.g. ≥3 REJECTS in 10 applies) but no
            # timeout signature is in the rows: the run is not clean, and the
            # inferred and declared verdicts must both be visible.
            return "fault-declared"
        if self.isolated_timeouts:
            return "isolated"
        if self.bad_lines or self.terminal is None:
            return "incomplete"
        return "clean"

    def result(self) -> dict:
        # every timeout not part of the confirmed wedge (onset row + after) was
        # isolated, i.e. the controller recovered
        self.isolated_timeouts = self.timeouts_total - self.timeouts_after - (1 if self.onset is not None else 0)
        self.candidates = []
        has_rows = self.arena_rows > 0
        dur = None
        if self.t0 is not None and self.last_t is not None:
            dur = round((self.last_t - self.t0) / 1000, 1)
        on = self.onset
        overall = self.hist.percentile(0.5)
        flags = []
        if self.bad_lines:
            flags.append(f"bad_lines={self.bad_lines}@L{self.first_bad_line}")
        if has_rows and self.terminal is None:
            flags.append("no-terminal-event")
        if self.resets:
            flags.append(f"resets={self.resets}")
        trend = None
        if has_rows:
            base = self.onset_trend_median if on is not None else self.trend.median()
            trend = f"last30s {base} vs overall {overall}"
        return {
            "file": os.path.basename(self.path),
            "format": self.format or ("unknown" if has_rows else "no-schema"),
            "run_id": self.meta.get("run_id", "?"),
            "protocol": self.meta.get("protocol", "?"),
            "firmware": self.meta.get("firmware") or "—",
            "bench": self.meta.get("bench", "?"),
            "tool": self.meta.get("tool"),
            "duration_s": dur,
            "lines": self.lines,
            "bad_lines": self.bad_lines,
            "frames": self.frames,
            "cmd70_ok": self.cmd70_ok if has_rows else NA,
            "cmd70_total": self.cmd70_total if has_rows else NA,
            "rtt_median_ms": overall if has_rows else NA,
            "rtt_p99_ms": self.hist.percentile(0.99) if has_rows else NA,
            "rtt_max_ms": self.hist.max if has_rows else NA,
            "nonzero_status": self.nonzero_status if has_rows else NA,
            "nonzero_by_op": ({opcode_name(op): n for op, n in self.nonzero_by_op.most_common()} if has_rows else NA),
            "isolated_timeouts": self.isolated_timeouts if has_rows else NA,
            "onset_elapsed_s": (round((on.t - self.t0) / 1000, 1) if (on is not None and on.t is not None and self.t0 is not None) else None),
            "onset_line": on.line if on is not None else None,
            "onset_index": on.index if on is not None else None,
            "onset_cmd70_count": self.onset_cmd70_count if on is not None else None,
            "timeouts_after": self.timeouts_after if on is not None else None,
            "first_non70_fail": self.first_non70_fail,
            "slow_before": (f"dt>{SLOW_DT_MS}ms before onset: {self.slow_before}" if has_rows else NA),
            "ctl_records": (f"{self.ctl_records} ({', '.join(f'{k}:{v}' for k, v in sorted(self.ctl_by_tag.items()))})" if self.ctl_records else "—"),
            "ctl_sd_max_us": self.ctl_sd_max if self.ctl_records else "—",
            "ctl_states": (", ".join(f"{k}:{v}" for k, v in sorted(self.ctl_states.items())) or "—") if self.ctl_records else "—",
            "ctl_cmd_rejects": self.ctl_cmd_rejects if self.ctl_records else "—",
            "trend": trend if has_rows else NA,
            "resets": self.resets,
            "terminal": self.terminal,
            "declared_fault": self.declared_fault,
            "ctl_malformed": self.ctl_malformed,
            "runner_errors": [f"L{ln}: {tx}" for ln, tx in self.runner_errors],
            "outcome": self.outcome(),
            "flags": flags,
            "_ctl_tail": (
                [f"{n}: {json.dumps(a, separators=(',', ':'))}" for n, a in self.ctl_tail_pre_onset]
                if (self.onset is not None and self.ctl_tail_pre_onset)
                else []
            ),
            "_ctl_pre_boot": [
                (bl, [f"{n}: {json.dumps(a, separators=(',', ':'))}" for n, a in rows])
                for bl, rows in self.ctl_pre_boot
            ],
            "_context": (
                [r.brief() for r in self.context_before] + [f">>> {on.brief()}  <<< ONSET"] + [r.brief() for r in self.context_after]
                if on is not None
                else []
            ),
        }


# ── Studio .runlog.json envelope ─────────────────────────────────────────────
def scan_runlog_json(path: str, doc: dict) -> dict:
    """Report a Studio run-log envelope (runner events only, no command rows)."""
    meta = doc.get("meta") or {}
    summary = doc.get("summary") or {}
    events = doc.get("events") or []
    fm = meta_from_filename(path)
    errors = []
    resets = 0
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            continue
        text = " ".join(str(ev.get(k)) for k in ("reason", "error", "message") if ev.get(k))
        if ev.get("phase") == "error" or "timeout" in text.lower():
            if len(errors) < 5:
                errors.append(f"ev{i} t+{ev.get('t_offset_s')}s: {text or ev.get('phase')}")
        for k in ("phase", "op", "command"):
            v = ev.get(k)
            if isinstance(v, str) and "reset" in v.lower():
                resets += 1
                break
    timeout_errors = [e for e in errors if "timeout" in e.lower()]
    flags = ["runlog.json: no per-command rows"]
    if summary.get("outcome"):
        flags.append(f"studio outcome {summary['outcome']}")
    if timeout_errors:
        flags.append(f"{len(timeout_errors)} timeout error event(s)")
    return {
        "file": os.path.basename(path),
        "format": "runlog.json",
        "run_id": meta.get("run_id") or fm.get("run_id", "?"),
        "protocol": meta.get("protocol_filename") or fm.get("protocol", "?"),
        "bench": meta.get("rig_id") or meta.get("rig") or fm.get("bench", "?"),
        "firmware": meta.get("firmware") or fm.get("firmware") or "—",
        "tool": meta.get("tool_version"),
        "duration_s": summary.get("duration_s"),
        "lines": len(events),
        "bad_lines": 0,
        "frames": 0,
        "cmd70_ok": NA,
        "cmd70_total": NA,
        "rtt_median_ms": NA,
        "rtt_p99_ms": NA,
        "rtt_max_ms": NA,
        "nonzero_status": NA,
        "nonzero_by_op": NA,
        "isolated_timeouts": NA,
        "onset_elapsed_s": None,
        "onset_line": None,
        "onset_index": None,
        "onset_cmd70_count": None,
        "timeouts_after": None,
        "first_non70_fail": (timeout_errors[0] if timeout_errors else None),
        "slow_before": NA,
        "ctl_records": "—",
        "ctl_sd_max_us": "—",
        "ctl_states": "—",
        "ctl_cmd_rejects": "—",
        "trend": NA,
        "resets": resets,
        "terminal": summary.get("outcome"),
        "runner_errors": errors,
        "outcome": "no-arena-rows",
        "flags": flags,
        "_context": [],
        "_ctl_tail": [],
        "_ctl_pre_boot": [],
    }


def _looks_like_envelope(path: str, first_line: str) -> bool:
    head = first_line.lstrip()
    return path.endswith(".runlog.json") or head == "{" or head.startswith('{"schema"')


def scan_file(path: str, window: int, min_followers: int) -> dict:
    """Analyze one file (any supported format). Raises OSError if unopenable."""
    with open_text(path) as fh:
        first = fh.readline()
        if first and _looks_like_envelope(path, first):
            size = os.path.getsize(path)
            if size <= RUNLOG_JSON_MAX_BYTES:
                rest = fh.read()
                try:
                    doc = json.loads(first + rest)
                except ValueError:
                    doc = None
                if isinstance(doc, dict) and "events" in doc and ("schema" in doc or "meta" in doc):
                    return scan_runlog_json(path, doc)
                # not an envelope after all: fall through as NDJSON
                scan = RunScan(path, window, min_followers)
                for n, line in enumerate(io.StringIO(first + rest), 1):
                    scan.feed(line, n)
                return scan.result()
        scan = RunScan(path, window, min_followers)
        if first:
            scan.feed(first, 1)
            for n, line in enumerate(fh, 2):
                scan.feed(line, n)
    return scan.result()


# ── output ───────────────────────────────────────────────────────────────────
TABLE_COLUMNS = [
    ("file", "file"),
    ("run_id", "run"),
    ("protocol", "protocol"),
    ("bench", "bench"),
    ("firmware", "fw"),
    ("format", "fmt"),
    ("duration_s", "dur s"),
    ("cmd70_ok", "0x70 OK"),
    ("cmd70_total", "0x70 total"),
    ("rtt_median_ms", "RTT med"),
    ("rtt_p99_ms", "RTT p99"),
    ("nonzero_status", "status!=0"),
    ("isolated_timeouts", "isolated"),
    ("onset_elapsed_s", "onset s"),
    ("onset_line", "onset line"),
    ("onset_index", "onset idx"),
    ("onset_cmd70_count", "0x70 before"),
    ("timeouts_after", "timeouts after"),
    ("first_non70_fail", "first non-0x70 fail"),
    ("slow_before", "soft degrade"),
    ("ctl_records", "ctl recs"),
    ("ctl_sd_max_us", "sd max us"),
    ("ctl_states", "ctl states"),
    ("ctl_cmd_rejects", "ctl rejects"),
    ("trend", "trend (dt med)"),
    ("resets", "resets"),
    ("bad_lines", "bad lines"),
    ("outcome", "outcome"),
    ("flags", "flags"),
]


def _cell(v) -> str:
    if v is None:
        return "—"
    if isinstance(v, list):
        return "; ".join(str(x) for x in v) if v else "—"
    return str(v).replace("|", "\\|")


def render_markdown(results, verbose=False) -> str:
    keys = [k for k, _ in TABLE_COLUMNS]
    heads = [h for _, h in TABLE_COLUMNS]
    out = ["| " + " | ".join(heads) + " |", "|" + "|".join("---" for _ in heads) + "|"]
    for r in results:
        cells = []
        for k in keys:
            v = r.get(k)
            if k == "nonzero_status" and isinstance(v, int) and v:
                v = f"{v} (" + ", ".join(f"{op}:{n}" for op, n in r["nonzero_by_op"].items()) + ")"
            cells.append(_cell(v))
        out.append("| " + " | ".join(cells) + " |")
    for r in results:
        if r.get("runner_errors"):
            out.append("")
            out.append(f"**{r['file']}** runner errors:")
            out.extend(f"- {e}" for e in r["runner_errors"])
    if verbose:
        for r in results:
            if r.get("_context"):
                out.append("")
                out.append(f"**{r['file']}** onset context (±{CONTEXT_ROWS} arena rows):")
                out.append("```")
                out.extend(r["_context"])
                out.append("```")
            if r.get("_ctl_tail"):
                out.append("")
                out.append(f"**{r['file']}** controller-side records before the wedge (last {len(r['_ctl_tail'])}; ring crash dump):")
                out.append("```")
                out.extend(r["_ctl_tail"])
                out.append("```")
            for bl, rows in r.get("_ctl_pre_boot", []):
                out.append("")
                out.append(f"**{r['file']}** controller records preceding the boot recorded at line {bl} (previous boot's final {len(rows)}; post-reboot drain):")
                out.append("```")
                out.extend(rows)
                out.append("```")
    out.append("")
    out.append(f"_dt = host-observed round trip incl. queue time (not controller RTT). Onset = first 0x70 timeout followed by >= {DEFAULT_MIN_FOLLOWERS} more timeouts within {DEFAULT_WINDOW} arena rows; timeouts_after excludes the onset row._")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="wedge-scan.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("paths", nargs="+", help="log files (.jsonl, .jsonl.gz, .runlog.json) or directories (recursed)")
    ap.add_argument("--json", action="store_true", help="machine-readable JSON array instead of the markdown table")
    ap.add_argument("--verbose", "-v", action="store_true", help=f"print the onset context (±{CONTEXT_ROWS} arena rows) per wedged file")
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW, help=f"arena rows after a 0x70 timeout in which followers must appear (default {DEFAULT_WINDOW})")
    ap.add_argument("--min-followers", type=int, default=DEFAULT_MIN_FOLLOWERS, help=f"additional timeouts (any opcode) that confirm an onset (default {DEFAULT_MIN_FOLLOWERS})")
    args = ap.parse_args(argv)

    results = []
    rc = 0
    for path in iter_files(args.paths):
        try:
            results.append(scan_file(path, args.window, args.min_followers))
        except OSError as e:
            print(f"wedge-scan: cannot open {path}: {e}", file=sys.stderr)
            rc = 2
    if args.json:
        clean = [{k: v for k, v in r.items() if k not in ("_context", "_ctl_tail", "_ctl_pre_boot") or args.verbose} for r in results]
        print(json.dumps(clean, indent=1))
    else:
        print(render_markdown(results, verbose=args.verbose))
    return rc


if __name__ == "__main__":
    sys.exit(main())
