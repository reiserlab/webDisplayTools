#!/usr/bin/env python3
"""foxglove_json.py — an ARENA String-topic bag → a Foxglove-plottable MCAP, with the arena derivations.

    pixi run fox-json -- <bag dir or .mcap> <out.mcap> [--ball-mm 9]
    pixi run fox-json -- runlogs/<run>.bag <run>.foxglove.mcap --stimulus --panel-layout four-color

The generic rewriter (same messages, same topics, same times, as MCAP `json` messages with a
`jsonschema` per topic) is `rig_nodes.foxglove_json` (reiserlab/rig-nodes). This wrapper adds what
only the arena knows, through its two hooks:

`enrich` (per message), so `docs/foxglove-arena-layout.json` works unchanged:

- /arena/frame: plus `bias_deg` (= `bias`, 0 when absent) and `turning_dps` / `forward_mms`,
  derived exactly as bridge_node.FrameDeriver does for the typed ArenaFrame (two-point
  differences on the FicTrac camera clock `ft`, else the bridge clock `t`; null where the
  typed message has NaN). These three are the only fields the original does not carry;
- /fictrac/raw: `cols`, FicTrac's 25 output columns by name (rig_nodes.fictrac.FICTRAC_COLS),
  parsed from `raw`;
- /arena/browser: `msg`, the browser message parsed from `raw` (the generic envelope rule).

`derive` (once, over the whole time-ordered record stream), with `--stimulus`: the live
dashboard's derived topics are rebuilt (nodes/dashboard_replay.py, the same code the live
stimulus_node / viz_node run): the expected and observed arena display as images, the arena's
rate / lag / health, BIAS's rate and losses, and — from the run's uFMF movie (`--ufmf <file>`, or
found through the run's stopRecording reply) — `/camera/image`. Then
`foxglove/arena-okey-cokey.json` shows the run as it looked live.

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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # dashboard_replay, when this module is imported from elsewhere (tests)


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


def dashboard_deriver(stimulus: dict | None, camera: dict | None):
    """The `derive(records)` hook: the okey-cokey dashboard's topics rebuilt from the bag
    (dashboard_replay.run_streams). Returns (derive, report) — the report fills in when it runs."""
    from dashboard_replay import run_streams

    report: dict = {}

    def derive(records):
        derived, rep = run_streams(records, stimulus, camera)
        report.update(rep)
        return derived

    return derive, report


def convert(src: Path, dst: Path, ball_mm: float, keep_raw: bool = False, stimulus: dict | None = None,
            camera: dict | None = None) -> dict:
    derive, report = None, {}
    if stimulus is not None or camera is not None:
        derive, report = dashboard_deriver(stimulus, camera)
    out = generic_convert(src, dst, enrich=arena_enricher(ball_mm, keep_raw), keep_raw=keep_raw,
                          library="rig foxglove_json.py", metadata={"ball_mm": f"{ball_mm:g}"}, derive=derive)
    if report:
        out["dashboard"] = report
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--ball-mm", type=float, default=9.0, help="ball diameter for forward_mms (default 9, as the bridge)")
    ap.add_argument("--keep-raw", action="store_true", help="keep the `raw` text beside the parsed `cols` / `msg`")
    repo = HERE.parents[1]
    g = ap.add_argument_group("dashboard replay (foxglove/arena-okey-cokey.json)")
    g.add_argument("--stimulus", action="store_true", help="rebuild the expected/observed display, arena + BIAS health, and the camera")
    g.add_argument("--panel-layout", default="g6-green", help="panel LED colors (g6-green, four-color, red-ir-v0.4r2, red-ir-v0.4r1)")
    g.add_argument("--pattern-dir", action="append", default=None, help="where <pattern>.pat files are (repeatable; default the repo's protocols/ + patterns/)")
    g.add_argument("--protocol-dir", action="append", default=None, help="where the run's protocol YAML is (repeatable; default the repo's protocols/)")
    g.add_argument("--display-hz", type=float, default=10.0, help="expected-display image rate while a pattern plays (default 10)")
    g.add_argument("--scale", type=int, default=4, help="screen pixels per LED (default 4)")
    g.add_argument("--ufmf", default="auto", help="the run's uFMF movie (default auto: the file its stopRecording reply names); 'none' to skip")
    g.add_argument("--camera-hz", type=float, default=10.0, help="camera images per second (default 10)")
    g.add_argument("--camera-factor", type=int, default=2, help="camera downsampling, N×N mean (default 2)")
    a = ap.parse_args(argv)
    stim = cam = None
    if a.stimulus:
        stim = {"patterns": a.pattern_dir or [str(repo / "protocols"), str(repo / "patterns")],
                "protocols": a.protocol_dir or [str(repo / "protocols")], "layout": a.panel_layout,
                "display_hz": a.display_hz, "scale": a.scale}
        if a.ufmf != "none":
            cam = {"ufmf": a.ufmf, "hz": a.camera_hz, "factor": a.camera_factor}
    print(json.dumps(convert(a.src, a.dst, a.ball_mm, a.keep_raw, stim, cam)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
