#!/usr/bin/env python3
"""mcap_convert.py — an arena bridge MCAP bag → the behavior_v2 (or behavior_v1 / full) run log.

    pixi run convert -- runlogs/arena-log-20261014-183007-969.bag            # → <bag stem>.jsonl beside it
    pixi run convert -- BAG --level behavior_v1 --out run.v1.jsonl
    pixi run convert -- BAG --order time       # the multi-process ordering (see below)
    pixi run convert -- BAG --recover          # a crash-truncated bag: salvage what is complete

LAB-303 Plan B: the bag the bridge node records (nodes/recorder.py) is the record of truth and
the NDJSON every reader accepts is DERIVED from it — at log_export time by the bridge node, or
offline by this script. Pure Python: the `mcap` package for the container and a small CDR
decoder for the message types we use, so a lab PC can convert a bag without a ROS process
(and without rosbag2's index: `--recover` scans a torn file record by record).

What the bag holds and how it becomes lines (nodes/bridge_node.py writes these):

  /arena/session   {"seq","event","file","ms","level",…}   → the session + frame_schema lines
  /arena/browser   {"seq","rx_ms","raw","line":bool}        → every browser message, verbatim.
                   `line` = the live writer wrote it as a line (hello/config/log/log_control…);
                   `rows` messages expand to their rows; `connector_command` → its connector
                   event; `log_export` → nothing (as today).
  /arena/frame     the closed-loop evaluation (String JSON or rig_interfaces/ArenaFrame),
                   with the node's OWN sample time `t`/`ms` AND, since 2026-10-18, the kept FicTrac
                   columns beyond the behavior row (err, dr_lab_x/y/z, ft_seq, ft_ns — docs/development/
                   fictrac-columns-in-the-bag.md); a flagged untracked frame (flags bit 0) → no line
                                                                      → [ms, fc, idx, ft, x, y, hd]
  /arena/event     {"seq", …a bridge-authored event…}: bias_config, heading_tare,
                   connector_status, source_lost/resumed, warn       → verbatim
  /kinefly/raw     the adapter envelope (DERIVED stream)             → ["kf", ms, seq, t_src, L, R, head, abd]
  /bias/reply, /bias/status  the BIAS node's JSON (DERIVED)          → {"type":"connector","src":"bias",…}
  /scanimage/reply, /scanimage/status  the ScanImage node's JSON (DERIVED) → {"type":"connector","src":"scanimage",…}
  /fictrac/raw | /fictrac/frame  the adapter's FicTrac records (only when the bridge node ran with
                   --record-fictrac-raw; bags before 2026-10-18 always have them) → used only for level `full`

Clock and order rules (comparison.md §4, B1/B2):
  * ONE ms base: t0 = the session-open record's `ms`, set when the run's log opened. Frame
    rows, heading_tare and bias_config carry the closed-loop node's own sample instant in that
    base (the node computed idx, bias phase and tare from one `now`); nothing is re-stamped
    from the recorder's receive time.
  * `--order seq` (default): lines whose producer ran in the bridge process carry the writer's
    emission sequence number and are written in exactly that order — the live writer's order.
    DERIVED streams (Kinefly, BIAS) have no such number: their `ms` is the recorder's receive
    time relative to t0 and they are inserted by that time among the sequenced lines.
  * `--order time`: everything sorted by its own `ms` (ties: session < event < frame < browser,
    then seq). This is what a graph with the closed-loop math in a SEPARATE process would have
    to do; the harness measures how far it lands from the live writer's order.
Levels are a converter option (the bag holds everything): behavior_v2 compacts arena echoes
to ["a",…] and carries t0 in the schema line; behavior_v1 keeps the echo objects; full keeps
the 25-column FicTrac records (joined from /fictrac/* by frame counter) and writes no schema — it
is refused for a bag recorded without the raw FicTrac topics (the default since 2026-10-18).
"""

from __future__ import annotations

import argparse
import bisect
import importlib.util
import json
import math
import os
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _rows import KF_TAG, arena_frame_to_row, kf_row  # noqa: E402  (shared with bridge_node.py)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRIDGE_PY = REPO / "fictrac-bridge" / "bridge.py"

TOPIC_SESSION = "/arena/session"
TOPIC_BROWSER = "/arena/browser"
TOPIC_FRAME = "/arena/frame"
TOPIC_EVENT = "/arena/event"
TOPIC_FICTRAC_RAW = "/fictrac/raw"
TOPIC_FICTRAC_FRAME = "/fictrac/frame"
TOPIC_KINEFLY = "/kinefly/raw"
TOPIC_BIAS_CMD = "/bias/cmd"
TOPIC_BIAS_REPLY = "/bias/reply"
TOPIC_BIAS_STATUS = "/bias/status"
TOPIC_SCANIMAGE_REPLY = "/scanimage/reply"
TOPIC_SCANIMAGE_STATUS = "/scanimage/status"
# Connector device topics → (connector id, event kind): their JSON becomes a DERIVED
# {"type":"connector","src":<id>,"kind":…} line (mirror of bridge_node.CONNECTOR_TOPICS).
CONNECTOR_TOPIC_SRC = {
    TOPIC_BIAS_REPLY: ("bias", "reply"), TOPIC_BIAS_STATUS: ("bias", "status"),
    TOPIC_SCANIMAGE_REPLY: ("scanimage", "reply"), TOPIC_SCANIMAGE_STATUS: ("scanimage", "status"),
}


def load_bridge_module(path: Path = BRIDGE_PY):
    """fictrac-bridge/bridge.py's PURE functions (compact_arena_command, frame_schema_line, …),
    imported by path, so the derived file uses exactly the live writer's encoders."""
    spec = importlib.util.spec_from_file_location("fictrac_bridge_pure", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = load_bridge_module()


# ─────────────────────────────────────────────────────────────────────────────
# CDR decoding (XCDR1, little-endian; alignment origin = right after the 4-byte header)
# ─────────────────────────────────────────────────────────────────────────────
_PRIM = {
    "bool": ("?", 1), "byte": ("B", 1), "char": ("b", 1), "int8": ("b", 1), "uint8": ("B", 1),
    "int16": ("<h", 2), "uint16": ("<H", 2), "int32": ("<i", 4), "uint32": ("<I", 4),
    "int64": ("<q", 8), "uint64": ("<Q", 8), "float32": ("<f", 4), "float64": ("<d", 8),
}


class Cdr:
    def __init__(self, data: bytes) -> None:
        if len(data) < 4:
            raise ValueError("CDR payload shorter than its header")
        self.d = data
        self.p = 4  # the encapsulation header is not part of the aligned stream
        self.le = data[1] == 1

    def _align(self, n: int) -> None:
        rel = self.p - 4
        pad = (-rel) % n
        self.p += pad

    def prim(self, t: str):
        fmt, size = _PRIM[t]
        self._align(size)
        if not self.le and len(fmt) == 2:
            fmt = ">" + fmt[1]
        v = struct.unpack_from(fmt, self.d, self.p)[0]
        self.p += size
        return v

    def string(self) -> str:
        n = self.prim("uint32")
        raw = self.d[self.p : self.p + n]
        self.p += n
        return raw.rstrip(b"\x00").decode("utf-8", errors="replace")

    def seq_prim(self, t: str) -> list:
        n = self.prim("uint32")
        return [self.prim(t) for _ in range(n)]


def parse_msgdef(text: str) -> list[tuple[str, str]]:
    """ros2msg schema text → [(type, name)] for the TOP message (the first block; nested
    definitions after a '====' separator are not needed by our types)."""
    fields = []
    for line in text.splitlines():
        if line.startswith("===="):
            break
        s = line.split("#", 1)[0].strip()
        if not s or "=" in s:
            continue
        typ, name = s.split()[:2]
        fields.append((typ, name))
    return fields


def decode_cdr(schema_name: str | None, schema_text: str | None, data: bytes):
    """→ dict of fields (or {'data': str} for std_msgs/String). Only the shapes our .msg files
    use: primitives, string, primitive sequences."""
    if schema_name in (None, "std_msgs/msg/String"):
        c = Cdr(data)
        return {"data": c.string()}
    if not schema_text:
        raise ValueError(f"no schema text for {schema_name}; cannot decode without ROS")
    c = Cdr(data)
    out = {}
    for typ, name in parse_msgdef(schema_text):
        if typ.endswith("[]"):
            base = typ[:-2]
            out[name] = c.seq_prim(base) if base in _PRIM else [c.string() for _ in range(c.prim("uint32"))]
        elif typ == "string":
            out[name] = c.string()
        elif typ in _PRIM:
            out[name] = c.prim(typ)
        else:
            raise ValueError(f"{schema_name}: field {name} of type {typ} is not supported by this decoder")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Reading a bag (a rosbag2 directory or a single .mcap file), optionally torn
# ─────────────────────────────────────────────────────────────────────────────
def bag_files(path: str | os.PathLike) -> list[Path]:
    p = Path(path)
    if p.is_dir():
        return sorted(f for f in p.glob("*.mcap") if not f.name.endswith((".unindexed.mcap", ".indexed.tmp")))
    return [p]


def read_records(path, recover: bool = False):
    """Yield dicts {topic, schema, log_ns, pub_ns, msg, i} in FILE order; `summary` info in
    the generator's return value via StopIteration (use read_all)."""
    from mcap.reader import NonSeekingReader, make_reader

    info = {"files": [], "torn": False, "error": None, "records": 0}
    for f in bag_files(path):
        info["files"].append(str(f))
        with open(f, "rb") as fh:
            reader = NonSeekingReader(fh, validate_crcs=False) if recover else make_reader(fh, validate_crcs=False)
            try:
                # FILE order in both modes: log_time_order=True would read the whole file before
                # yielding anything, so a torn file would yield nothing at all.
                for schema, channel, message in reader.iter_messages(log_time_order=False):
                    info["records"] += 1
                    yield {
                        "topic": channel.topic,
                        "schema": schema.name if schema else None,
                        "schema_text": schema.data.decode("utf-8", errors="replace") if schema and schema.data else None,
                        "log_ns": message.log_time,
                        "pub_ns": message.publish_time,
                        "data": message.data,
                    }
            except Exception as exc:  # a torn tail (crash), or a bag without a summary
                info["torn"] = True
                info["error"] = f"{type(exc).__name__}: {exc}"
                if not recover:
                    raise
    return info


def read_all(path, recover: bool = False) -> tuple[list[dict], dict]:
    recs = []
    gen = read_records(path, recover)
    try:
        while True:
            recs.append(next(gen))
    except StopIteration as stop:
        info = stop.value or {}
    for r in recs:
        try:
            r["msg"] = decode_cdr(r["schema"], r.get("schema_text"), r["data"])
        except Exception as exc:
            r["msg"] = None
            r["decode_error"] = f"{type(exc).__name__}: {exc}"
        r.pop("data", None)
    return recs, info


def _json_of(rec: dict):
    """A String-JSON record's object (None when not JSON)."""
    m = rec.get("msg")
    if not m or "data" not in m:
        return m  # a typed message: already a dict of fields
    try:
        return json.loads(m["data"])
    except (json.JSONDecodeError, TypeError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# bag → lines
# ─────────────────────────────────────────────────────────────────────────────
RANK = {"session": 0, "event": 1, "frame": 2, "browser": 3, "derived": 4}


def frame_line(fr: dict, level: str, fields_by_fc: dict | None):
    """A /arena/frame record (hub message JSON or ArenaFrame fields) → the logged frame, or None
    for a flagged untracked frame (the live writer wrote no row). The column mapping is
    _rows.arena_frame_to_row, shared with the node."""
    row = arena_frame_to_row(fr)
    if row is None:
        return None
    if level == "full":
        ms, fc, idx = row[0], row[1], row[2]
        fields = (fields_by_fc or {}).get(int(fc))
        rec = {"type": "fictrac_frame", "seq": fc, "index": idx, "t": ms}
        rec["fictrac"] = fields if fields is not None else []
        return rec
    return row


def fictrac_fields(rec: dict) -> tuple[int, list[float]] | None:
    """A /fictrac/raw envelope or /fictrac/frame message → (fc, fields) as the pipeline parses."""
    m = rec.get("msg") or {}
    if "fields" in m and "raw" in m:  # typed FicTracFrame
        fields = list(m["fields"])
    else:
        env = _json_of(rec)
        raw = env.get("raw") if isinstance(env, dict) else None
        if not isinstance(raw, str):
            return None
        parts = raw.strip().split(",")
        tag = parts[0].strip()
        if tag[:2].upper() == "FT":
            if tag != "FT":
                return None
            parts = parts[1:]
        try:
            fields = [float(p) for p in parts]
        except ValueError:
            return None
    if len(fields) < 17:
        return None
    return int(fields[0]), fields


def convert(records: list[dict], level: str | None = None, order: str = "seq", connectors=None) -> tuple[list, dict]:
    """→ (lines as JSON values, report). `level` None = the level the run was opened with."""
    stats = {"frames": 0, "browser_lines": 0, "rows": 0, "events": 0, "kf": 0, "bias": 0, "scanimage": 0,
             "connector_cmds": 0, "skipped": 0, "unordered_inserts": 0}
    opens = [r for r in records if r["topic"] == TOPIC_SESSION]
    session_open = None
    for r in opens:
        o = _json_of(r)
        if isinstance(o, dict) and o.get("event") in ("logging_started", "bridge_start") and "file" in o:
            session_open = o
            break
    if session_open is None:
        raise ValueError("no session-open record on /arena/session (not a bridge-node bag, or the open record was lost)")
    t0 = int(session_open["ms"])
    level = level or session_open.get("level") or "behavior_v2"
    if level not in B.LOG_LEVELS:
        raise ValueError(f"unknown level {level!r} (one of {B.LOG_LEVELS})")
    conn_set = set(connectors if connectors is not None else (session_open.get("connectors") or ["bias"]))

    seq_lines: list[tuple[int, int, int, object]] = []  # (seq, own_ms, rank, obj)
    derived: list[tuple[int, int, int, object]] = []  # (own_ms, rank, log_ns, obj)
    pending: dict[str, dict] = {}  # connector_command id → {"plugin","connector"}
    fields_by_fc: dict[int, list[float]] = {}

    def add(seq: int, own_ms: int, rank: str, obj) -> None:
        seq_lines.append((int(seq), int(own_ms), RANK[rank], obj))

    if level == "full":
        for r in records:
            if r["topic"] in (TOPIC_FICTRAC_RAW, TOPIC_FICTRAC_FRAME):
                ff = fictrac_fields(r)
                if ff:
                    fields_by_fc[ff[0]] = ff[1]
        if not fields_by_fc:
            # The 25 columns exist only in the adapter's topics, which the bridge node records only
            # with --record-fictrac-raw (off since 2026-10-18); the merged /arena/frame record keeps
            # 10 of them. The readers of `full` (runlog-replay.js, closed-loop-report.py) use cols
            # 1/15-17/22, which behavior_v2 carries — derive that instead.
            raise ValueError("level 'full' needs the raw FicTrac topics (/fictrac/frame or /fictrac/raw), which this bag "
                             "does not hold: the bridge node records them only with --record-fictrac-raw. Use --level behavior_v2.")

    for r in records:
        t = r["topic"]
        if t == TOPIC_SESSION:
            o = _json_of(r)
            if not isinstance(o, dict):
                stats["skipped"] += 1
                continue
            ev = o.get("event")
            if ev in ("logging_started", "bridge_start") and "file" in o:
                add(o["seq"], 0, "session", {"type": "session", "event": ev, "file": o["file"], "ms": int(o["ms"])})
                if level == "behavior_v2":
                    add(o["seq"], 0, "session", B.frame_schema_line("behavior_v2", B.BEHAVIOR_V1_COLS, int(o["ms"])))
                elif level == "behavior_v1":
                    add(o["seq"], 0, "session", B.frame_schema_line("behavior_v1", B.BEHAVIOR_V1_COLS))
            elif ev == "logging_started":  # explicit --log path: a marker in an already-open file
                add(o["seq"], int(o["ms"]) - t0, "session", {"type": "session", "event": "logging_started", "ms": int(o["ms"])})
            elif ev == "logging_stopped":
                add(o["seq"], int(o["ms"]) - t0, "session", {"type": "session", "event": "logging_stopped", "ms": int(o["ms"])})
            elif ev == "recovered":
                # Appended by mcap_index.recover_bag to a bag whose writer was killed: the run has
                # no logging_stopped, and this line says what was salvaged (sorts last by seq).
                stats["recovered"] = True
                add(o["seq"], int(o["ms"]) - t0, "session", {"type": "session", "event": "recovered", "ms": int(o["ms"]), "recovered": True,
                                                              **{k: o[k] for k in ("salvaged_records", "torn", "torn_error", "file") if k in o}})
        elif t == TOPIC_BROWSER:
            o = _json_of(r)
            if not isinstance(o, dict) or "raw" not in o:
                stats["skipped"] += 1
                continue
            seq, rx_ms, raw = int(o["seq"]), int(o["rx_ms"]), o["raw"]
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                obj = {"type": "log", "event": "unparsed", "raw": raw}
            kind = obj.get("type") if isinstance(obj, dict) else None
            if o.get("line"):
                # Exactly LogWriter.write_inbound: dir + rx_ms defaults, then the v2 compaction.
                if isinstance(obj, dict):
                    obj.setdefault("dir", B.ARENA_DIR)
                    obj.setdefault("rx_ms", rx_ms)
                    if level == "behavior_v2" and obj.get("event") == "arena_command":
                        arr = B.compact_arena_command(obj, t0)
                        if arr is not None:
                            obj = arr
                add(seq, rx_ms - t0, "browser", obj)
                stats["browser_lines"] += 1
            elif kind == "rows":
                # LogWriter.write_rows's validation, row by row, same seq (one message).
                rows = obj.get("rows")
                if isinstance(rows, list):
                    for i, row in enumerate(rows):
                        if not (isinstance(row, list) and row and isinstance(row[0], str) and 1 <= len(row[0]) <= 4):
                            continue
                        if len(row) < B.ROW_MIN_LEN.get(row[0], 2):
                            continue
                        add(seq, rx_ms - t0, "browser", row)
                        stats["rows"] += 1
            elif kind == "connector_command":
                cid = obj.get("id")
                connector = str(obj.get("connector") or "bias")
                command = str(obj.get("command") or "")
                params = obj.get("params") if isinstance(obj.get("params"), dict) else {}
                plugin = obj.get("plugin")
                ms = rx_ms - t0
                add(seq, ms, "browser", {"type": "connector", "src": connector, "kind": "command", "dir": "browser→bridge", "ms": ms,
                                         "id": cid, "plugin": plugin, "command": command, "params": params})
                stats["connector_cmds"] += 1
                if connector not in conn_set:
                    err = f"no connector {connector!r} on this bridge (have {sorted(conn_set)})"
                    add(seq, ms, "browser", {"type": "connector", "src": connector, "kind": "reply", "dir": "bridge", "ms": ms, "via": "ws",
                                             "id": cid, "plugin": plugin, "command": command, "ok": False, "outcome": "error", "error": err})
                else:
                    pending[str(cid)] = {"plugin": plugin, "connector": connector}
            # log_export and anything else the live writer never wrote: nothing.
        elif t == TOPIC_FRAME:
            fr = _json_of(r)
            if not isinstance(fr, dict):
                stats["skipped"] += 1
                continue
            seq = fr.get("wseq", fr.get("seq") if "has_ft" in fr else None)
            if seq is None:
                stats["skipped"] += 1
                continue
            line = frame_line(fr, level, fields_by_fc)
            if line is None:  # a flagged untracked frame: recorded, never a line
                stats["bad_frames"] = stats.get("bad_frames", 0) + 1
                continue
            add(seq, int(fr["ms"]), "frame", line)
            stats["frames"] += 1
        elif t == TOPIC_EVENT:
            o = _json_of(r)
            if not isinstance(o, dict) or "seq" not in o:
                stats["skipped"] += 1
                continue
            seq = o.pop("seq")
            own = o.get("ms")
            add(seq, int(own) if isinstance(own, (int, float)) else 0, "event", o)
            stats["events"] += 1
        elif t == TOPIC_KINEFLY:
            env = _json_of(r)
            if not isinstance(env, dict) or not isinstance(env.get("raw"), str):
                stats["skipped"] += 1
                continue
            try:
                pkt = json.loads(env["raw"])
            except json.JSONDecodeError:
                continue
            rel = max(0, int(r["log_ns"] // 1_000_000) - t0)  # received just before the open: line at 0
            kseq = pkt.get("sequence") if isinstance(pkt.get("sequence"), int) else int(env.get("seq") or 0)
            derived.append((rel, RANK["derived"], r["log_ns"], kf_row(rel, pkt, kseq)))
            stats["kf"] += 1
        elif t in CONNECTOR_TOPIC_SRC:
            env = _json_of(r)
            if not isinstance(env, dict):
                stats["skipped"] += 1
                continue
            src, kind = CONNECTOR_TOPIC_SRC[t]
            rel = max(0, int(r["log_ns"] // 1_000_000) - t0)
            ev = {"type": "connector", "src": src, "kind": kind, "dir": "bridge", "ms": rel}
            for k, v in env.items():
                if k != "src":
                    ev[k] = v
            if kind == "reply" and env.get("id") is not None:
                p = pending.pop(str(env.get("id")), None)
                if p is not None:
                    ev["via"] = "ws"
                    ev["plugin"] = p["plugin"]
            derived.append((rel, RANK["derived"], r["log_ns"], ev))
            stats[src] = stats.get(src, 0) + 1
        # /bias/cmd, /scanimage/cmd, /fictrac/*: recorded for the record; no line of their own.

    if order == "time":
        allrows = [(ms, rk, sq, obj) for (sq, ms, rk, obj) in seq_lines] + [(ms, rk, 10**18 + ns, obj) for (ms, rk, ns, obj) in derived]
        allrows.sort(key=lambda x: (x[0], x[1], x[2]))
        lines = [x[3] for x in allrows]
    else:
        seq_lines.sort(key=lambda x: (x[0], x[2]))
        lines = [x[3] for x in seq_lines]
        if derived:
            # Insert each derived line after the last sequenced line whose own ms ≤ its ms
            # (anchors are the sequenced lines' own clocks, made monotone with a running max).
            anchors = []
            run = -10**12
            for _, ms, _, _ in seq_lines:
                run = max(run, ms)
                anchors.append(run)
            derived.sort(key=lambda x: (x[0], x[2]))
            inserts: list[tuple[int, object]] = []
            for ms, _, _, obj in derived:
                pos = bisect.bisect_right(anchors, ms)
                inserts.append((pos, obj))
            out = []
            j = 0
            for i, ln in enumerate(lines):
                while j < len(inserts) and inserts[j][0] <= i:
                    out.append(inserts[j][1])
                    j += 1
                out.append(ln)
            out.extend(obj for _, obj in inserts[j:])
            lines = out
    # The live writer writes nothing after logging_stopped, and the bridge records a device
    # message only together with its shadow line (bridge_node record_device), so every derived
    # record precedes the stop. One received in the same ms as the stop would still sort after it
    # on the tie (ww18 2026-10-15: one kf row): put derived lines found after the stop before it.
    stop_at = next((i for i in range(len(lines) - 1, -1, -1) if isinstance(lines[i], dict)
                    and lines[i].get("type") == "session" and lines[i].get("event") == "logging_stopped"), None)
    if stop_at is not None and derived:
        derived_ids = {id(x[3]) for x in derived}
        tail = lines[stop_at + 1:]
        moved = [ln for ln in tail if id(ln) in derived_ids]
        stats["moved_before_stop"] = len(moved)
        lines = lines[:stop_at] + moved + [lines[stop_at]] + [ln for ln in tail if id(ln) not in derived_ids]
    # The frame_schema / session-open lines were given seq = the open record's seq and rank 0,
    # so they stay first; a logging_stopped line from a crash-truncated bag may be missing.
    stats.setdefault("recovered", False)
    report = {"t0": t0, "level": level, "order": order, "lines": len(lines), **stats,
              "closed": any(isinstance(l, dict) and l.get("type") == "session" and l.get("event") == "logging_stopped" for l in lines)}
    return lines, report


def convert_bag(path, level: str | None = None, order: str = "seq", recover: bool = False) -> tuple[str, dict]:
    records, info = read_all(path, recover=recover)
    lines, report = convert(records, level=level, order=order)
    report.update({"bag": str(path), "bag_records": info.get("records"), "torn": info.get("torn"), "read_error": info.get("error")})
    return B.dumps_jsonl(lines), report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bag", help="a rosbag2 bag directory or a single .mcap file")
    ap.add_argument("--out", help="output path (default: <bag stem>.jsonl beside the bag; '-' = stdout)")
    ap.add_argument("--level", choices=B.LOG_LEVELS, default=None, help="log level to derive (default: the run's acked level)")
    ap.add_argument("--order", choices=("seq", "time"), default="seq")
    ap.add_argument("--recover", action="store_true", help="scan a torn/unfinished bag record by record (like `mcap recover`)")
    ap.add_argument("--report", action="store_true", help="print the conversion report as JSON to stderr")
    a = ap.parse_args(argv)
    try:
        text, report = convert_bag(a.bag, level=a.level, order=a.order, recover=a.recover)
    except Exception as exc:
        print(f"[convert] {type(exc).__name__}: {exc}", file=sys.stderr)
        if not a.recover:
            print("[convert] hint: an unfinished bag (crash) needs --recover", file=sys.stderr)
        return 2
    if a.out == "-":
        sys.stdout.write(text)
    else:
        p = Path(a.bag)
        out = Path(a.out) if a.out else (p.parent / (p.name[:-4] if p.name.endswith(".bag") else p.stem)).with_suffix(".jsonl")
        out.write_text(text, encoding="utf-8", newline="\n")  # LF on Windows too, like bridge 3.4's export
        report["out"] = str(out)
    print(json.dumps(report), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
