#!/usr/bin/env python3
"""test_gateway_registration.py — the gateway records and derives the 2P rig's topics (static, no graph).

    pixi run test-gateway                 # from rig/ (≈ 2 s)

The 2P rig's SiPM and ScanImage frame-stream nodes are private (reiserlab/scanimage-2026-bergamo
`2p-rig-nodes/`); this gateway only knows their topic NAMES. These checks are the gateway half of
those nodes' harnesses (#266's test_sipm D1–D3 and #261's test_scanimage_frames §G), kept here
with the code they test:

  SiPM     bridge_node records /sipm/cmd|reply|status in every bag and subscribes it as a connector;
           mcap_convert derives /sipm/reply|status into {"type":"connector","src":"sipm",…} events
  frames   bridge_node records the frame-stream topics (meta, stats, preview meta, preview ch1–4,
           the images as sensor_msgs/CompressedImage) in every bag; mcap_convert derives nothing from
           them (a stream is not a behavior sample)

Exit 0 when every check passes.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "nodes"))
import bridge_node  # noqa: E402
import mcap_convert  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, info: str = "") -> bool:
    results.append((name, bool(ok), info))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else ' — ' + str(info)[:400]}", file=sys.stderr)
    return bool(ok)


def main() -> int:
    lw = bridge_node.RecordingLogWriter(None, "behavior_v2", None, profile="crashsafe", typed=False, export="converted", connectors=[])
    tmap = lw.topics()

    # ── SiPM (was test_sipm D1–D3) ──
    check("sipm: bridge_node records /sipm/cmd|reply|status in every bag",
          all(tmap.get(t) == "std_msgs/msg/String" for t in ("/sipm/cmd", "/sipm/reply", "/sipm/status")), str(sorted(tmap)))
    check("sipm: bridge_node subscribes the SiPM node as a connector",
          bridge_node.CONNECTOR_TOPICS.get("sipm", {}).get("status") == "/sipm/status", str(bridge_node.CONNECTOR_TOPICS.get("sipm")))
    check("sipm: the converter derives /sipm/reply|status into connector events",
          mcap_convert.CONNECTOR_TOPIC_SRC.get("/sipm/status") == ("sipm", "status")
          and mcap_convert.CONNECTOR_TOPIC_SRC.get("/sipm/reply") == ("sipm", "reply"), "")

    # ── the ScanImage frame stream (was test_scanimage_frames §G) ──
    stream = ("/scanimage/frame_meta", "/scanimage/frame_stats", "/scanimage/preview/meta")
    previews = tuple(f"/scanimage/preview/ch{c}" for c in (1, 2, 3, 4))
    check("frames: bridge_node records the stream topics (meta, stats, preview meta, preview ch1–4) in every bag",
          all(t in tmap for t in stream + previews) and all(tmap[t] == "sensor_msgs/msg/CompressedImage" for t in previews)
          and all(tmap[t] == "std_msgs/msg/String" for t in stream), str(sorted(tmap)))
    check("frames: the converter derives nothing from the stream topics (streams are not behavior samples)",
          not any(t in mcap_convert.CONNECTOR_TOPIC_SRC for t in bridge_node.STREAM_TOPICS)
          and "frame_meta" not in Path(mcap_convert.__file__).read_text(encoding="utf-8"), "")

    n_ok = sum(1 for _, ok, _ in results if ok)
    print(f"\n{n_ok} / {len(results)} checks passed", file=sys.stderr)
    return 0 if n_ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
