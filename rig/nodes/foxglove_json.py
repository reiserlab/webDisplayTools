#!/usr/bin/env python3
"""foxglove_json.py — an ARENA String-topic bag → a Foxglove-plottable MCAP, with the arena derivations.

    pixi run fox-json -- <bag dir or .mcap> <out.mcap> [--ball-mm 9]

The generic rewriter (same messages, same topics, same times, as MCAP `json` messages with a
`jsonschema` per topic) is `rig_nodes.foxglove_json` (reiserlab/rig-nodes). This wrapper adds what
only the arena knows, through its `enrich` hook, so `docs/foxglove-arena-layout.json` works
unchanged:

- /arena/frame: plus `bias_deg` (= `bias`, 0 when absent) and `turning_dps` / `forward_mms`,
  derived exactly as bridge_node.FrameDeriver does for the typed ArenaFrame (two-point
  differences on the FicTrac camera clock `ft`, else the bridge clock `t`; null where the
  typed message has NaN). These three are the only fields the original does not carry;
- /fictrac/raw: `cols`, FicTrac's 25 output columns by name (rig_nodes.fictrac.FICTRAC_COLS),
  parsed from `raw`;
- /arena/browser: `msg`, the browser message parsed from `raw` (the generic envelope rule).

Slim by default: where `raw` was parsed into `cols` / `msg`, the `raw` text is dropped (it is the
same data twice); `--keep-raw` keeps it. The original bag stays the record of truth.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from rig_nodes.fictrac import FICTRAC_COLS, parse_fictrac_line
from rig_nodes.foxglove_json import convert as generic_convert


def wrap_to_pi(r: float) -> float:
    return (r + math.pi) % (2 * math.pi) - math.pi


class FrameDeriver:
    """bridge_node.FrameDeriver, verbatim math (rig/nodes/bridge_node.py)."""

    def __init__(self, ball_mm: float) -> None:
        self.radius_mm = ball_mm / 2.0
        self._prev = None

    def step(self, msg: dict):
        try:
            src, clock = ("ft", float(msg["ft"])) if msg.get("ft") is not None else ("t", float(msg["t"]))
            cur = (int(msg["fc"]), src, clock, float(msg["x"]), float(msg["y"]), float(msg["hd"]))
        except (KeyError, TypeError, ValueError):
            self._prev = None
            return None, None
        prev, self._prev = self._prev, cur
        if prev is None or prev[1] != src or cur[0] < prev[0]:
            return None, None
        dt_s = (clock - prev[2]) / 1000.0
        if not dt_s > 0:
            return None, None
        d_hd = wrap_to_pi(cur[5] - prev[5])
        h_mid = prev[5] + d_hd / 2.0
        dx, dy = cur[3] - prev[3], cur[4] - prev[4]
        return math.degrees(d_hd) / dt_s, (dx * math.cos(h_mid) + dy * math.sin(h_mid)) / dt_s * self.radius_mm


def arena_enricher(ball_mm: float, keep_raw: bool = False):
    """The `enrich(topic, obj)` hook for rig_nodes.foxglove_json.convert: arena derivations only."""
    deriver = FrameDeriver(ball_mm)

    def enrich(topic: str, obj: dict) -> dict:
        if topic == "/arena/frame" and obj.get("type", "frame") == "frame":
            obj["bias_deg"] = float(obj.get("bias", 0.0) or 0.0)
            obj["turning_dps"], obj["forward_mms"] = deriver.step(obj)
        elif topic == "/fictrac/raw" and isinstance(obj.get("raw"), str):
            _tag, fields = parse_fictrac_line(obj["raw"])
            if fields:
                obj["cols"] = {k: v for k, v in zip(FICTRAC_COLS, fields)}
                if not keep_raw:
                    del obj["raw"]
        return obj

    return enrich


def convert(src: Path, dst: Path, ball_mm: float, keep_raw: bool = False) -> dict:
    return generic_convert(src, dst, enrich=arena_enricher(ball_mm, keep_raw), keep_raw=keep_raw,
                           library="rig foxglove_json.py", metadata={"ball_mm": f"{ball_mm:g}"})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--ball-mm", type=float, default=9.0, help="ball diameter for forward_mms (default 9, as the bridge)")
    ap.add_argument("--keep-raw", action="store_true", help="keep the `raw` text beside the parsed `cols` / `msg`")
    a = ap.parse_args(argv)
    print(json.dumps(convert(a.src, a.dst, a.ball_mm, a.keep_raw)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
