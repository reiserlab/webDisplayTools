#!/usr/bin/env python3
"""stimulus_node.py — the arena's EXPECTED display, its OBSERVED display and its health, live.

Subscribes to `/arena/browser` (every Studio message, published live by bridge_node) and runs
`stimulus_core.StimulusTracker` over it; publishes standard ROS messages Foxglove shows natively:

  sensor_msgs/CompressedImage (PNG)
    /arena/display            what the arena SHOULD show now: the trial's .pat frame at the
                              expected index × duty, in the panels' LED colors (--panel-layout),
                              top of the arena at the top; dark between trials
    /arena/display_observed   the frame the controller reported it put up (telemetry `cf` rows,
                              drained ~10 Hz, so it steps and trails by ~0.1 s)
  std_msgs/Float64  /viz/arena/expected_idx (at --display-hz), /viz/arena/observed_idx + /viz/arena/lag_frames
                    (one per displayed frame the controller reports; lag = observed − expected on the
                    controller clock, 0 = on schedule), /viz/arena/display_rate_hz (frame changes per
                    controller second, 1 Hz), /viz/arena/cmd_fps
  std_msgs/Bool     /viz/arena/ok (health level OK) — for an Indicator panel
  std_msgs/String   /viz/arena/state ("idle|dark|trial"), /viz/arena/condition, /viz/arena/health
                    ("<LEVEL>: <message>"), /arena/stimulus (JSON: condition, pattern, mode, fps,
                    duty, n_frames, … — on change and every second)
  diagnostic_msgs/DiagnosticArray  /diagnostics, status "arena/display" (1 Hz): OK / WARN (rate off
                    by > 5 %, lag > 2 frames, a flagged trial, a slow SD read) / ERROR (a refused
                    display command, an error glyph) / STALE (no frame telemetry while a pattern plays)

Nothing here is logged or fed back. Patterns are found by name under --pattern-dir (recursive);
pattern names come from the run's protocol under --protocol-dir (see stimulus_core).

    pixi run stimulus -- --panel-layout four-color
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import rclpy
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
from rclpy.node import Node
from sensor_msgs.msg import CompressedImage
from std_msgs.msg import Bool, Float64, String

from rig_nodes._common import RELIABLE_QOS, spin, wall_ms
import arena_display as AD
import stimulus_core as SC

REPO = Path(__file__).resolve().parents[2]


class StimulusNode(Node):
    def __init__(self, a: argparse.Namespace) -> None:
        super().__init__("arena_stimulus")
        self.a = a
        self.tr = SC.StimulusTracker(SC.PatternLibrary(a.pattern_dir), SC.ProtocolIndex(a.protocol_dir), stale_s=a.stale_s)
        self.tr.frame_log = []  # every displayed frame → /viz/arena/observed_idx + lag_frames, as the replay
        self.p_img = self.create_publisher(CompressedImage, "/arena/display", 10)
        self.p_obs = self.create_publisher(CompressedImage, "/arena/display_observed", 10)
        f64 = lambda t: self.create_publisher(Float64, t, 10)
        self.p = {k: f64(f"/viz/arena/{k}") for k in ("expected_idx", "observed_idx", "display_rate_hz", "lag_frames", "cmd_fps")}
        self.p_ok = self.create_publisher(Bool, "/viz/arena/ok", 10)
        self.p_state = self.create_publisher(String, "/viz/arena/state", 10)
        self.p_cond = self.create_publisher(String, "/viz/arena/condition", 10)
        self.p_health = self.create_publisher(String, "/viz/arena/health", 10)
        self.p_stim = self.create_publisher(String, "/arena/stimulus", 10)
        self.p_diag = self.create_publisher(DiagnosticArray, "/diagnostics", 10)
        self.create_subscription(String, "/arena/browser", self._browser, RELIABLE_QOS)
        self._last_disp = None
        self._last_disp_t = 0.0
        self._last_obs = None
        self._last_stim = None
        self.create_timer(1.0 / max(1.0, a.display_hz), self._display)
        self.create_timer(1.0, self._slow)
        self.get_logger().info(f"stimulus up: /arena/display (+_observed), /viz/arena/*, /diagnostics; layout {a.panel_layout}; "
                               f"patterns {', '.join(str(d) for d in a.pattern_dir)}")

    # ── helpers ─────────────────────────────────────────────────────────────────
    def _f(self, key: str, v) -> None:
        if isinstance(v, (int, float)):
            m = Float64()
            m.data = float(v)
            self.p[key].publish(m)

    def _s(self, pub, text: str) -> None:
        m = String()
        m.data = text
        pub.publish(m)

    def _image(self, pub, img, frame_id: str) -> None:
        m = CompressedImage()
        m.header.stamp = self.get_clock().now().to_msg()
        m.header.frame_id = frame_id
        m.format = "png"
        m.data = AD.png_bytes(img)
        pub.publish(m)

    def _render(self, pattern: str | None, idx, duty) -> "AD.np.ndarray":
        pat = self.tr.patterns.get(pattern) if pattern else None
        if pat is None:
            return AD.render_placeholder(scale=self.a.scale)
        n = pat["num_frames"]
        return AD.render_frame(pat["frames"][int(idx) % n], pat["gs"], self.a.panel_layout, duty, self.a.scale)

    # ── callbacks ───────────────────────────────────────────────────────────────
    def _browser(self, msg: String) -> None:
        try:
            rec = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        if isinstance(rec, dict):
            self.tr.feed_record(rec)
        for _, idx, _, lag in self.tr.frame_log:
            self._f("observed_idx", idx)
            if lag is not None:
                self._f("lag_frames", lag)
        self.tr.frame_log.clear()

    def _display(self) -> None:
        tr = self.tr
        now = float(wall_ms())
        st = tr.stimulus()
        exp = tr.expected_index(now)
        key = (st["state"], st.get("pattern"), exp, st.get("duty"))
        if key != self._last_disp or time.monotonic() - self._last_disp_t > 1.0:
            if st["state"] == "trial" and exp is not None:
                img = self._render(st.get("pattern"), exp, st.get("duty") or 255)
            else:
                img = AD.render_dark(scale=self.a.scale)
            self._image(self.p_img, img, "arena_display")
            self._last_disp, self._last_disp_t = key, time.monotonic()
            self._f("expected_idx", exp if exp is not None else -1)
        obs = tr.obs
        okey = (obs or {}).get("idx"), (obs or {}).get("pid"), st["state"]
        if obs and okey != self._last_obs:
            name = tr.pid_names.get(obs["pid"])
            duty = (st.get("duty") or 255) if st["state"] == "trial" else 255
            img = self._render(name, obs["idx"], duty) if st["state"] == "trial" else AD.render_dark(scale=self.a.scale)
            self._image(self.p_obs, img, "arena_display_observed")
            self._last_obs = okey
        if tr.changed:
            tr.changed = False
            self._stimulus(st)

    def _stimulus(self, st: dict) -> None:
        self._s(self.p_stim, json.dumps(st, separators=(",", ":")))
        self._s(self.p_state, st["state"])
        self._s(self.p_cond, st.get("condition") or "")
        self._f("cmd_fps", st.get("fps", 0) if st["state"] == "trial" else 0)
        self._last_stim = st

    def _slow(self) -> None:
        tr = self.tr
        h = tr.health(float(wall_ms()))
        v = h["values"]
        self._f("display_rate_hz", v["display_rate_hz"])
        ok = Bool()
        ok.data = h["level"] == SC.OK
        self.p_ok.publish(ok)
        self._s(self.p_health, f"{h['level_name']}: {h['message']}")
        self._stimulus(tr.stimulus())  # once a second for late joiners (StateTransitions dedups)
        arr = DiagnosticArray()
        arr.header.stamp = self.get_clock().now().to_msg()
        s = DiagnosticStatus()
        s.name, s.hardware_id = "arena/display", "g6_controller"
        s.level = bytes([h["level"]])
        s.message = h["message"]
        s.values = [KeyValue(key=k, value="" if x is None else str(x)) for k, x in v.items()]
        arr.status.append(s)
        self.p_diag.publish(arr)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pattern-dir", action="append", default=None,
                   help="where to find <pattern>.pat by name, searched recursively; repeatable (default: the repo's protocols/ and patterns/)")
    p.add_argument("--protocol-dir", action="append", default=None,
                   help="where to find the run's protocol YAML (for pattern names); repeatable (default: the repo's protocols/)")
    p.add_argument("--panel-layout", default="g6-green", choices=sorted(AD.LAYOUTS),
                   help="LED colors of the panels (js/panel-color.js layouts; default g6-green; the okey-cokey arena is four-color)")
    p.add_argument("--display-hz", type=float, default=15.0, help="expected-display update rate (default 15)")
    p.add_argument("--scale", type=int, default=4, help="screen pixels per LED (default 4 → 800×160 for a 2×10)")
    p.add_argument("--stale-s", type=float, default=2.0, help="no frame telemetry this long while a pattern plays → STALE (default 2)")
    args, ros_args = p.parse_known_args(argv)
    args.pattern_dir = args.pattern_dir or [str(REPO / "protocols"), str(REPO / "patterns")]
    args.protocol_dir = args.protocol_dir or [str(REPO / "protocols")]
    rclpy.init(args=ros_args)
    node = StimulusNode(args)
    spin(node)
    print("[stimulus] stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
