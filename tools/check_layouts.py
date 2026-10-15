#!/usr/bin/env python3
"""check_layouts.py — does every panel of a Foxglove layout have data in a set of MCAP files?

    python check_layouts.py <layout.json> <file.mcap> [<file.mcap> ...]

Opens the files the way Foxglove does with several selected (one merged timeline) and, for every
panel in the layout, resolves what it reads: Plot / StateTransitions / Indicator / Gauge message
paths (`/topic.field`), RawMessages `topicPath`, the 3D panel's topics, the diagnostics panels'
`topicToRender`, and RosOut (`/rosout`). Per path: messages on the topic, values that resolve,
how many are numbers, and their range. Decodes JSON messages and the flat ros2 CDR types the
`viz_node` topics use (Float64, Bool, String); nested ros2 types (DiagnosticArray, MarkerArray)
are counted, not decoded. Exit 1 when a path's topic is missing from every file.
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

from mcap.reader import make_reader


def collect(layout: dict) -> list[tuple[str, str, str]]:
    """(panel id, kind, path-or-topic) for every data reference in the layout."""
    out = []
    for pid, cfg in layout.get("configById", {}).items():
        kind = pid.split("!")[0]
        if kind in ("Plot", "StateTransitions"):
            out += [(pid, "path", p["value"]) for p in cfg.get("paths", []) if p.get("value")]
        elif kind in ("Indicator", "Gauge"):
            if cfg.get("path"):
                out.append((pid, "path", cfg["path"]))
        elif kind == "RawMessages":
            if cfg.get("topicPath"):
                out.append((pid, "topic", cfg["topicPath"]))
        elif kind in ("DiagnosticSummary", "DiagnosticStatusPanel"):
            out.append((pid, "topic", cfg.get("topicToRender", "/diagnostics")))
        elif kind == "3D":
            out += [(pid, "topic", t) for t, tc in cfg.get("topics", {}).items() if tc.get("visible", True)]
        elif kind == "RosOut":
            out.append((pid, "topic", "/rosout"))
    return out


def load(files):
    msgs = {}  # topic -> (schema name, encoding, [data...])
    for p in files:
        with open(p, "rb") as f:
            for sc, ch, m in make_reader(f).iter_messages(log_time_order=False):
                e = msgs.setdefault(ch.topic, (sc.name if sc else "", ch.message_encoding, []))
                e[2].append(m.data)
    return msgs


def field_value(schema: str, enc: str, data: bytes, field: list[str]):
    if enc == "json":
        v = json.loads(data)
        for k in field:
            if not isinstance(v, dict) or k not in v:
                return None, False
            v = v[k]
        return v, True
    if field == ["data"]:
        if schema == "std_msgs/msg/Float64":
            return struct.unpack_from("<d", data, 4)[0], True
        if schema == "std_msgs/msg/Bool":
            return bool(data[4]), True
        if schema == "std_msgs/msg/String":
            (n,) = struct.unpack_from("<I", data, 4)
            return data[8:8 + n].rstrip(b"\0").decode(), True
    return None, None  # not decodable here


def main() -> int:
    layout = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    msgs = load(sys.argv[2:])
    missing = 0
    for pid, kind, ref in collect(layout):
        if kind == "topic":
            topic, field = ref, []
        else:
            topic = max((t for t in msgs if ref == t or ref.startswith(t + ".")), key=len, default=ref.split(".")[0])
            field = ref[len(topic) + 1:].split(".") if ref != topic else []
        if topic not in msgs:
            missing += 1
            print(f"  MISSING  {pid:32} {ref}")
            continue
        schema, enc, datas = msgs[topic]
        if not field:
            print(f"  ok       {pid:32} {ref}  {len(datas)} msgs ({schema or enc})")
            continue
        vals, decodable = [], True
        for d in datas:
            v, ok = field_value(schema, enc, d, field)
            if ok is None:
                decodable = False
                break
            if ok:
                vals.append(v)
        if not decodable:
            print(f"  ok?      {pid:32} {ref}  {len(datas)} msgs ({schema}; field not checked)")
            continue
        nums = [float(v) for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))]
        other = sorted({str(v) for v in vals if not isinstance(v, (int, float)) or isinstance(v, bool)})[:4]
        tag = "ok" if vals else "EMPTY"
        rng = f"  range [{min(nums):.4g}, {max(nums):.4g}]" if nums else ""
        print(f"  {tag:8} {pid:32} {ref}  {len(vals)}/{len(datas)} resolve, {len(nums)} numeric{rng}"
              + (f"  values {other}" if other else ""))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
