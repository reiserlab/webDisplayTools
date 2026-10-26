#!/usr/bin/env python3
"""stimulus_core.py — what the G6 arena should be showing, what it did show, and whether it keeps up.

Pure (no rclpy): the live `stimulus_node.py` and the offline `foxglove_json.py --stimulus` feed it
the same `/arena/browser` records, so a live dashboard and a replayed bag agree.

Inputs (every Studio → bridge message, as the bridge records it; formats:
docs/development/telemetry-logging-reference.md):
  * runner status events  {"type":"log","event":"runner","phase":…}
      run_metadata          a new run: protocol_filename (→ pattern names), telemetry level
      step-start            condition name; resets the per-step trialParams counter
      trial-running         params {mode, patternId, frameRate, initPos, duty}, durationSec —
                            the host's view of a trial start (stamped with the record's rx_ms)
      command op=allOff     the arena goes dark
      sequence-start / -complete / error
  * {"type":"log","event":"trial_quality"|"display_gap"}   the Studio's own verdicts
  * {"type":"rows","rows":[…]} controller telemetry (ring firmware, drained ~10 Hz):
      ["cc", rx, t_us, seq, cmd, status, "reqhex"]     cmd 8 = trialParams (req = mode u8 ·
                                                        patternId u16 · frameRate i16 · initPos u16),
                                                        cmd 0 = allOff
      ["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us(, req_age_us, superseded, flags)]
      ["cs", rx, t_us, seq, kind, code, arg]           kind 3 = error glyph, 4 = slow SD read

The controller rows are the ground truth. Each displayed frame (`cf`) carries the controller's
own microsecond clock, and so does the trialParams command that started the trial (`cc` cmd 8).
So the expected index, the lag and the display rate are all computed on THAT clock, not affected
by the ~100 ms batching of the drain:

    expected(t) = (init + sign(fps) · floor(|fps| · (t − t_trialParams))) mod n_frames
    lag         = observed − expected, wrapped into ±n/2 (0 = on schedule)
    rate        = cf rows in the last controller second

For the LIVE picture (the expected display at host time "now"), the controller clock is mapped to
host epoch ms with offset = min over the last 30 s of (rx_ms − t_us/1000): `rx` is when the
browser drained the row, never before it happened, so the minimum is the drain's latency floor
(a few ms: every batch's newest row was recorded just before the read), and the live picture runs
that much behind the arena.
Without telemetry (a firmware without the ring, or before the first rows) the host trial start
(the trial-running record's rx_ms) is the anchor and observed/lag/rate are unknown — never "OK"
without evidence.

Pattern names: the wire carries only the SD slot (`patternId`), so a trial's pattern NAME comes
from the protocol: the run's `protocol_filename` is looked up under the protocol dirs, and the
k-th trial-running of a step takes the k-th trialParams `pattern:` of that condition. Learned
slot → name pairs serve Console trials and protocols that cannot be found.
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections import deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tools"))
from patfile import read_pat  # noqa: E402

OK, WARN, ERROR, STALE = 0, 1, 2, 3  # diagnostic_msgs/DiagnosticStatus levels
LEVEL_NAMES = {OK: "OK", WARN: "WARN", ERROR: "ERROR", STALE: "STALE"}

CMD_ALL_OFF = 0x00
CMD_TRIAL_PARAMS = 0x08
CMD_SET_FRAME_POSITION = 0x70
# A non-ok reply to one of THESE is an arena error; other commands (SD listing, health, info
# queries) are refused routinely while a pattern plays (status 10 = display active) and are only
# counted.
DISPLAY_CMDS = (CMD_ALL_OFF, CMD_TRIAL_PARAMS, CMD_SET_FRAME_POSITION)
CS_ERROR_GLYPH = 3
CS_SD_SLOW = 4

U32 = 1 << 32


def wrap_diff(d: int, n: int) -> int:
    """d mod n, as the nearest value in [−n/2, n/2)."""
    return (d + n // 2) % n - n // 2 if n > 1 else 0


def parse_trial_params_req(req_hex: str):
    """The first 8 request bytes of a 0x08 command → (mode, pattern_id, fps, init) or None."""
    try:
        b = bytes.fromhex(req_hex)
    except (ValueError, TypeError):
        return None
    if len(b) < 7:
        return None
    mode = b[0]
    pid = b[1] | (b[2] << 8)
    fps = int.from_bytes(b[3:5], "little", signed=True)
    init = b[5] | (b[6] << 8)
    return mode, pid, fps, init


class PatternLibrary:
    """`.pat` files by name (the file stem), searched recursively under `dirs`, first dir wins."""

    def __init__(self, dirs) -> None:
        self.dirs = [Path(d) for d in dirs if d]
        self._index: dict[str, Path] | None = None
        self._indexed_at = 0.0
        self._cache: dict[str, dict | None] = {}

    def _scan(self) -> None:
        idx: dict[str, Path] = {}
        for d in self.dirs:
            if d.is_dir():
                for p in sorted(d.rglob("*.pat")):
                    idx.setdefault(p.stem, p)
        self._index = idx
        self._indexed_at = time.monotonic()

    def path(self, name: str | None) -> Path | None:
        if not name:
            return None
        stem = Path(str(name)).name
        stem = stem[:-4] if stem.lower().endswith(".pat") else stem
        if self._index is None or (stem not in self._index and time.monotonic() - self._indexed_at > 10.0):
            self._scan()
        return self._index.get(stem)

    def get(self, name: str | None) -> dict | None:
        if not name:
            return None
        if name in self._cache and self._cache[name] is not None:
            return self._cache[name]
        p = self.path(name)
        pat = None
        if p is not None:
            try:
                pat = read_pat(p)
            except (OSError, ValueError):
                pat = None
        self._cache[name] = pat
        return pat


class ProtocolIndex:
    """condition name → [trialParams pattern names, in command order], from a v3 protocol YAML."""

    def __init__(self, dirs) -> None:
        self.dirs = [Path(d) for d in dirs if d]
        self._cache: dict[str, dict] = {}

    def find(self, filename: str | None) -> Path | None:
        if not filename:
            return None
        base = Path(str(filename)).name
        for d in self.dirs:
            if (d / base).is_file():
                return d / base
            if d.is_dir():
                for p in d.rglob(base):
                    return p
        return None

    def conditions(self, filename: str | None) -> dict:
        if not filename:
            return {}
        if filename in self._cache:
            return self._cache[filename]
        out: dict[str, list[str]] = {}
        p = self.find(filename)
        if p is not None:
            try:
                import yaml

                doc = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
                for c in doc.get("conditions") or []:
                    if not isinstance(c, dict) or not c.get("name"):
                        continue
                    names = [str(cmd.get("pattern")) for cmd in (c.get("commands") or [])
                             if isinstance(cmd, dict) and cmd.get("command_name") == "trialParams" and cmd.get("pattern")]
                    out[str(c["name"])] = names
            except Exception:  # a protocol we cannot read only costs us the names
                out = {}
        self._cache[filename] = out
        return out


class StimulusTracker:
    def __init__(self, patterns: PatternLibrary | None = None, protocols: ProtocolIndex | None = None,
                 stale_s: float = 2.0, rate_tol: float = 0.05, lag_tol: int = 2) -> None:
        self.patterns = patterns or PatternLibrary([])
        self.protocols = protocols or ProtocolIndex([])
        self.stale_s, self.rate_tol, self.lag_tol = stale_s, rate_tol, lag_tol
        self.pid_names: dict[int, str] = {}
        self.frame_log: list | None = None  # set to [] to collect (t_us, idx, pid, lag) per cf row (replay)
        self.reset_run()
        self.seen_any = False

    # ── state ──────────────────────────────────────────────────────────────────
    def reset_run(self) -> None:
        self.run: dict = {}
        self.run_open = False
        self.telemetry_level = None
        self.condition = None
        self.step_tp = 0
        self.proto: dict = {}
        self.state = "idle"  # idle | dark | trial
        self.trial: dict | None = None   # host view (runner)
        self.ctrl: dict | None = None    # controller view (cc cmd 8): {mode, pid, fps, init, t0}
        self.ctrl_dark_t = None
        self.obs = None                  # last cf: {idx, pid, t}
        self.cf_times: deque = deque()
        self.lag = None
        self.rate_hz = None
        self.rows = 0
        self.last_rows_ms = None
        self._t_last_raw = None
        self._t_base = 0
        self._offsets: deque = deque()   # (rx_ms, rx_ms*1000 − t_us)
        self.max_idx: dict[int, int] = {}
        self.refused_other = 0
        self.last_cf_ms = None
        self.errors: list[tuple[float, str]] = []
        self.warnings: list[tuple[float, str]] = []
        self.flagged = 0
        self.trials_judged = 0
        self.last_quality = None
        self.changed = True

    # ── feeding ────────────────────────────────────────────────────────────────
    def feed_record(self, rec: dict) -> None:
        """A bridge `/arena/browser` record: {rx_ms, raw, …} (raw = the browser message text)."""
        raw = rec.get("raw")
        try:
            msg = json.loads(raw) if isinstance(raw, str) else rec.get("msg")
        except json.JSONDecodeError:
            return
        if isinstance(msg, dict):
            self.feed(msg, rec.get("rx_ms"))

    def feed(self, msg: dict, rx_ms) -> None:
        self.seen_any = True
        rx_ms = float(rx_ms) if isinstance(rx_ms, (int, float)) else time.time() * 1000.0
        kind = msg.get("type")
        if kind == "rows":
            self._rows(msg.get("rows") or [], rx_ms)
            return
        if kind != "log":
            return
        ev = msg.get("event")
        if ev == "run_metadata":
            pid_names = self.pid_names
            self.reset_run()
            self.pid_names = pid_names
            self.run = {k: msg.get(k) for k in ("run_id", "protocol_filename", "rig", "arena_config", "telemetry", "firmware")}
            self.telemetry_level = msg.get("telemetry")
            self.proto = self.protocols.conditions(msg.get("protocol_filename"))
            self.run_open = True
            self.state = "dark"
            self.changed = True
        elif ev == "runner":
            self._runner(msg, rx_ms)
        elif ev == "trial_quality":
            trials = msg.get("trials") or []
            self.trials_judged = len(trials)
            self.flagged = sum(1 for t in trials if t.get("status") == "flagged")
            self.last_quality = trials[-1].get("status") if trials else None
            if self.flagged:
                self.warnings.append((rx_ms, f"{self.flagged} of {len(trials)} trials flagged by trial_quality"))
        elif ev == "display_gap":
            self.warnings.append((rx_ms, f"display gap ({msg.get('kind') or 'see the run log'}) in trial {msg.get('trial')}"))

    def _runner(self, m: dict, rx_ms: float) -> None:
        phase = m.get("phase")
        cond = m.get("condition") or m.get("conditionName")
        if phase == "sequence-start":
            self.run_open = True
            if self.state == "idle":
                self.state = "dark"
        elif phase in ("sequence-complete", "sequence-aborted", "aborted", "stopped"):
            self.run_open = False
            summ = m.get("summary") or {}
            if summ.get("fault") or summ.get("errors"):
                self.errors.append((rx_ms, f"sequence ended: errors {summ.get('errors')}, fault {summ.get('fault')}"))
        elif phase == "step-start":
            self.condition = cond
            self.step_tp = 0
        elif phase == "trial-running":
            p = m.get("params") or {}
            k = self.step_tp
            self.step_tp += 1
            names = self.proto.get(cond or self.condition) or []
            pid = p.get("patternId")
            name = names[k] if k < len(names) else (names[-1] if names else None)
            if name is None and isinstance(pid, int):
                name = self.pid_names.get(pid)
            if name is not None and isinstance(pid, int):
                self.pid_names[pid] = name
            duty = p.get("duty")
            self.trial = {
                "condition": cond or self.condition, "pattern": name, "pattern_id": pid,
                "mode": p.get("mode"), "fps": p.get("frameRate") or 0, "init": p.get("initPos") or 0,
                "duty": 255 if not duty else int(duty), "duration_s": m.get("durationSec"), "t_host_ms": rx_ms,
            }
            self.state = "trial"
            self.lag = None
            self.changed = True
            if m.get("ok") is False or (m.get("status") not in (None, 0)):
                self.errors.append((rx_ms, f"trialParams status {m.get('status')} ({cond})"))
        elif phase == "command":
            if m.get("op") == "allOff":
                self.state = "dark"
                self.trial = None
                self.changed = True
            v = m.get("value")
            if isinstance(v, dict) and v.get("ok") is False and m.get("op") != "connectorCommand":
                self.errors.append((rx_ms, f"{m.get('op')} failed ({cond})"))
        elif phase == "error":
            self.errors.append((rx_ms, str(m.get("message") or "runner error")))

    def _unwrap(self, t_us: int) -> int | None:
        if not isinstance(t_us, (int, float)):
            return None
        t = int(t_us)
        last = self._t_last_raw
        if last is not None:
            d = t - last
            if d < -(U32 // 2):
                self._t_base += U32
            elif -(U32 // 2) <= d < -2_000_000:  # backwards by > 2 s: the controller rebooted
                self._t_base = 0
                self._offsets.clear()
                self.cf_times.clear()
                self.ctrl = None
        self._t_last_raw = t
        return self._t_base + t

    def _rows(self, rows: list, rx_ms: float) -> None:
        self.last_rows_ms = rx_ms
        batch_min = None
        for r in rows:
            if not isinstance(r, list) or len(r) < 7 or not isinstance(r[0], str):
                continue
            tag = r[0]
            t = self._unwrap(r[2])
            if t is None:
                continue
            self.rows += 1
            row_rx = r[1] if isinstance(r[1], (int, float)) else rx_ms
            off = row_rx * 1000.0 - t
            batch_min = off if batch_min is None else min(batch_min, off)
            if tag == "cc":
                cmd, status = r[4], r[5]
                if cmd == CMD_TRIAL_PARAMS and status == 0:
                    tp = parse_trial_params_req(r[6])
                    if tp:
                        mode, pid, fps, init = tp
                        self.ctrl = {"mode": mode, "pid": pid, "fps": fps, "init": init, "t0": t}
                        self.ctrl_dark_t = None
                        self.lag = None
                elif cmd == CMD_ALL_OFF and status == 0:
                    self.ctrl = None
                    self.ctrl_dark_t = t
                elif status not in (0, None):
                    if cmd in DISPLAY_CMDS:
                        self.errors.append((rx_ms, f"controller refused cmd 0x{int(cmd):02X} (status {status})"))
                    else:
                        self.refused_other += 1
            elif tag == "cf":
                idx, pid = r[4], r[5]
                self.obs = {"idx": idx, "pid": pid, "t": t}
                self.last_cf_ms = rx_ms
                if isinstance(pid, int) and isinstance(idx, int):
                    self.max_idx[pid] = max(self.max_idx.get(pid, 0), idx)
                self.cf_times.append(t)
                while self.cf_times and self.cf_times[0] <= t - 1_000_000:
                    self.cf_times.popleft()
                self._judge_frame(idx, pid, t)
                if self.frame_log is not None:
                    self.frame_log.append((t, idx, pid, self.lag))
            elif tag == "cs":
                kind = r[4]
                if kind == CS_ERROR_GLYPH:
                    self.errors.append((rx_ms, f"controller error glyph (code {r[5]}, arg {r[6]})"))
                elif kind == CS_SD_SLOW:
                    us = r[6] * 100 if isinstance(r[6], int) else None
                    self.warnings.append((rx_ms, f"slow SD read: {us / 1000:.1f} ms" if us is not None else "slow SD read"))
        if batch_min is not None:
            self._offsets.append((rx_ms, batch_min))
            while self._offsets and self._offsets[0][0] < rx_ms - 30_000:
                self._offsets.popleft()
        if self.cf_times:
            self.rate_hz = (len(self.cf_times) - 1) / max(1e-6, (self.cf_times[-1] - self.cf_times[0]) / 1e6) if len(self.cf_times) > 1 else 0.0

    # ── controller-clock judgments ─────────────────────────────────────────────
    def n_frames(self, pid=None, name=None) -> int | None:
        pat = self.patterns.get(name) if name else None
        if pat:
            return int(pat["num_frames"])
        if pid is not None and pid in self.max_idx:
            return self.max_idx[pid] + 1
        return None

    def _ctrl_expected(self, t: int) -> int | None:
        c = self.ctrl
        if not c or c["mode"] != 2 or t < c["t0"]:
            return None
        name = self.pid_names.get(c["pid"])
        n = self.n_frames(c["pid"], name)
        steps = math.floor(abs(c["fps"]) * (t - c["t0"]) / 1e6 + 1e-9)
        e = c["init"] + (steps if c["fps"] >= 0 else -steps)
        return e % n if n else e

    def _judge_frame(self, idx, pid, t: int) -> None:
        c = self.ctrl
        if not c or pid != c["pid"] or c["mode"] != 2:
            return
        exp = self._ctrl_expected(t)
        n = self.n_frames(pid, self.pid_names.get(pid))
        if exp is None or not n or not isinstance(idx, int):
            return
        self.lag = wrap_diff(idx - exp, n)

    def clock_offset_us(self) -> float | None:
        return min(o for _, o in self._offsets) if self._offsets else None

    # ── outputs ────────────────────────────────────────────────────────────────
    def stimulus(self) -> dict:
        t = self.trial
        out = {"state": self.state, "run_id": self.run.get("run_id"), "protocol": self.run.get("protocol_filename"),
               "condition": self.condition}
        if self.state == "trial" and t:
            n = self.n_frames(t["pattern_id"], t["pattern"])
            out.update({k: t[k] for k in ("pattern", "pattern_id", "mode", "fps", "init", "duty", "duration_s", "t_host_ms")})
            out["condition"] = t["condition"]
            out["n_frames"] = n
            out["pattern_found"] = self.patterns.path(t["pattern"]) is not None
        return out

    def expected_index(self, now_ms: float) -> int | None:
        """The frame the arena should show at host epoch ms `now_ms` (None when dark/unknown)."""
        t = self.trial
        if self.state != "trial" or not t:
            return None
        n = self.n_frames(t["pattern_id"], t["pattern"])
        if t["mode"] != 2:
            return self.obs["idx"] if self.obs and self.obs.get("pid") == t["pattern_id"] else (t["init"] % n if n else t["init"])
        off = self.clock_offset_us()
        c = self.ctrl
        if c and off is not None and c["pid"] == t["pattern_id"] and c["fps"] == t["fps"]:
            e = self._ctrl_expected(int(now_ms * 1000.0 - off))
            if e is not None:
                return e
        dt = max(0.0, (now_ms - t["t_host_ms"]) / 1000.0)
        steps = math.floor(abs(t["fps"]) * dt + 1e-9)
        e = t["init"] + (steps if t["fps"] >= 0 else -steps)
        return e % n if n else e

    def observed_index(self):
        return self.obs["idx"] if self.obs else None

    def has_telemetry(self) -> bool:
        return self.rows > 0

    def health(self, now_ms: float | None = None) -> dict:
        now_ms = time.time() * 1000.0 if now_ms is None else now_ms
        age_s = None if self.last_rows_ms is None else max(0.0, (now_ms - self.last_rows_ms) / 1000.0)
        frame_age_s = None
        if self.last_cf_ms is not None or self.trial:
            since = max(self.last_cf_ms or 0.0, (self.trial or {}).get("t_host_ms") or 0.0)
            frame_age_s = max(0.0, (now_ms - since) / 1000.0)
        recent = lambda lst, s=10.0: [txt for (t, txt) in lst if now_ms - t < s * 1000.0]
        t = self.trial
        rotating = self.state == "trial" and t and t.get("mode") == 2 and (t.get("fps") or 0) != 0
        expected_rate = abs(t["fps"]) if rotating else 0.0
        c = self.ctrl
        since_start_s = None
        if c and self.obs and c["pid"] == (t or {}).get("pattern_id"):
            since_start_s = (self.obs["t"] - c["t0"]) / 1e6
        values = {
            "state": self.state, "condition": (t or {}).get("condition") or self.condition or "",
            "pattern": (t or {}).get("pattern") or "", "fps": (t or {}).get("fps", 0), "duty": (t or {}).get("duty", ""),
            "expected_rate_hz": expected_rate, "display_rate_hz": self.rate_hz, "lag_frames": self.lag,
            "observed_idx": self.observed_index(), "telemetry_rows": self.rows,
            "telemetry_age_s": None if age_s is None else round(age_s, 2),
            "other_cmds_refused": self.refused_other, "trials_flagged": self.flagged, "trials_judged": self.trials_judged,
            "clock_offset_ms": None if self.clock_offset_us() is None else round(self.clock_offset_us() / 1000.0, 1),
        }
        errs, warns = recent(self.errors), recent(self.warnings)
        if not self.seen_any:
            level, msg = WARN, "no Studio messages yet"
        elif errs:
            level, msg = ERROR, errs[-1]
        elif rotating and self.rows and frame_age_s is not None and frame_age_s > self.stale_s:
            # only while a pattern plays: in the dark the ring has nothing to send
            level, msg = STALE, f"no displayed-frame telemetry for {frame_age_s:.0f} s"
        elif self.run_open and not self.rows:
            level, msg = WARN, ("no controller telemetry yet" if str(self.telemetry_level or "").startswith("ring")
                                else "no controller telemetry on this run (expected display only)")
        elif rotating and since_start_s is not None and since_start_s > 1.2 and self.rate_hz is not None \
                and abs(self.rate_hz - expected_rate) > max(1.0, self.rate_tol * expected_rate):
            level, msg = WARN, f"display rate {self.rate_hz:.1f} Hz, expected {expected_rate:.0f} Hz"
        elif rotating and self.lag is not None and abs(self.lag) > self.lag_tol:
            level, msg = WARN, f"display {self.lag:+d} frames off schedule"
        elif warns:
            level, msg = WARN, warns[-1]
        elif self.state == "trial" and t:
            msg = f"{t.get('pattern') or 'pattern ' + str(t.get('pattern_id'))} @ {t.get('fps')} fps"
            if self.rate_hz is not None and rotating:
                msg += f" · shown {self.rate_hz:.0f} Hz"
            if self.lag is not None:
                msg += f" · lag {self.lag:+d}"
            level = OK
        else:
            level, msg = OK, self.state
        return {"level": level, "level_name": LEVEL_NAMES[level], "message": msg, "values": values}
