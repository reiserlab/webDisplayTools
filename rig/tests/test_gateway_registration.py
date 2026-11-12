#!/usr/bin/env python3
"""test_gateway_registration.py — the gateway records and derives the 2P rig's and the backlight's topics (static, no graph).

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
  backlight bridge_node records /backlight/cmd|reply|status in every bag and drives the backlight node
           as a connector; mcap_convert derives /backlight/reply|status into connector events; rig.py
           gives the node its serial port (or the simulator's) and refuses --backlight with neither
           before it starts anything

Exit 0 when every check passes.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "nodes"))
import bridge_node  # noqa: E402
import mcap_convert  # noqa: E402
import rig  # noqa: E402

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

    # ── the LED backlight (rig_nodes.backlight_node, the protocol's `backlight` plugin) ──
    bl = ("/backlight/cmd", "/backlight/reply", "/backlight/status")
    check("backlight: bridge_node records /backlight/cmd|reply|status in every bag",
          all(tmap.get(t) == "std_msgs/msg/String" for t in bl), str(sorted(tmap)))
    check("backlight: bridge_node drives the backlight node as a connector (cmd out, reply + status in)",
          bridge_node.CONNECTOR_TOPICS.get("backlight") == {"cmd": bl[0], "reply": bl[1], "status": bl[2]},
          str(bridge_node.CONNECTOR_TOPICS.get("backlight")))
    check("backlight: the converter derives /backlight/reply|status into connector events",
          mcap_convert.CONNECTOR_TOPIC_SRC.get("/backlight/reply") == ("backlight", "reply")
          and mcap_convert.CONNECTOR_TOPIC_SRC.get("/backlight/status") == ("backlight", "status"), "")
    sim = f"socket://127.0.0.1:{rig.BACKLIGHT_SIM_PORT}"
    cases = {
        "port given": (rig.backlight_node_args(["--port", "COM6"], with_sim=True), ["--port", "COM6"]),
        "--port=X form": (rig.backlight_node_args(["--port=/dev/ttyACM0", "--status-every", "2"], with_sim=False),
                          ["--port=/dev/ttyACM0", "--status-every", "2"]),
        "simulator, no port": (rig.backlight_node_args(["--status-every", "2"], with_sim=True), ["--port", sim, "--status-every", "2"]),
        "no port, no simulator": (rig.backlight_node_args([], with_sim=False), None),
    }
    check("backlight: rig.py's node port — as given, else the simulator's socket, else none",
          all(got == want for got, want in cases.values()), str({k: v[0] for k, v in cases.items() if v[0] != v[1]}))
    check("backlight: `rig.py --backlight` with no port and no simulator exits 2 before starting anything",
          rig.main(["--backlight", "--no-router"]) == 2, "")

    n_ok = sum(1 for _, ok, _ in results if ok)
    print(f"\n{n_ok} / {len(results)} checks passed", file=sys.stderr)
    return 0 if n_ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
