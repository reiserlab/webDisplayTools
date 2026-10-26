#!/usr/bin/env python3
"""viz_node.py — republish the JSON streams as STANDARD ROS messages that Foxglove plots natively.

Foxglove cannot plot a JSON string hidden in std_msgs/String, so this node turns the PoC's
envelopes into typed messages from packages already in ros-base (no custom message types):

  std_msgs/Float64 (plot any of these as `<topic>.data`)
    /viz/fictrac/heading_deg   FicTrac col 17 heading, degrees 0–360
    /viz/fictrac/turn_deg      unwrapped turn since the node started (Σ wrap180(Δheading))
    /viz/fictrac/speed_dps     col 19 (rad/frame) × measured frame rate, degrees per second
    /viz/fictrac/fwd_rad, /viz/fictrac/side_rad   cols 20 / 21 (integrated since FicTrac started)
    /viz/fictrac/fwd_dps, /viz/fictrac/side_dps   rates of cols 20 / 21, degrees per second —
                               the same units as speed_dps, so the three share one plot
    /viz/fictrac/rate_hz       measured FicTrac frame rate (1 Hz update)
    /viz/arena/index           displayed frame index (from the bridge's /arena/frame)
    /viz/arena/azimuth_deg     feature azimuth in the fly's view = wrap180(frame_dir·idx·deg_per_frame + az0)
    /viz/arena/display_deg     the display's UNWRAPPED rotation: Σ wrapped index steps × frame_dir ×
                               deg_per_frame (DisplayAngle). A periodic pattern (a 20-frame grating)
                               keeps azimuth_deg inside one period; this follows the fly's turn
    /viz/arena/bias_deg        live bias angle when a waveform runs (else 0)
    /viz/kinefly/left_deg, right_deg, lmr_deg, wbf_hz
    /viz/bias/frame_count, /viz/bias/fps
  std_msgs/Bool     /viz/bias/reachable, /viz/bias/capturing, /viz/bias/logging
  std_msgs/String   /viz/bias/state ("unreachable|idle|preview|recording") — StateTransitions panel
                    /viz/last_error ("<iso time> <src>: <text>")
  diagnostic_msgs/DiagnosticArray  /diagnostics (1 Hz): one status per source — fictrac, kinefly,
                    bias, arena — OK (data flowing), STALE (seen, then silent > --stale-s),
                    WARN (never seen), ERROR (BIAS unreachable / last reply failed); values carry
                    rate_hz, messages, last_seq, adapter→viz latency, last_error.
  visualization_msgs/MarkerArray   /viz/markers (--markers-hz, default 20): the ball (sphere +
                    markings rotated by FicTrac's lab-frame orientation, cols 12–14), the fly
                    (arrow, fixed, facing +X), the arena (translucent cylinder) and the pattern
                    feature (bar on the wall at wrap180(display_deg), which is the azimuth for a
                    pattern spanning the arena and the pattern's rotation for a grating), a
                    text readout.

Pure presentation: nothing here is logged or fed back. Foxglove connects through the stock
foxglove_bridge (`pixi run foxglove`, ws://localhost:8766); layouts in foxglove/*.json.

    pixi run viz -- --deg-per-frame 1.8 --frame-dir 1 --feature-az0 0 [--frames 20]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time

import rclpy
from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
from geometry_msgs.msg import Point
from rclpy.node import Node
from std_msgs.msg import Bool, ColorRGBA, Float64, String
from visualization_msgs.msg import Marker, MarkerArray

from _common import RELIABLE_QOS, spin

BALL_R = 1.0
ARENA_R = 3.2
ARENA_H = 1.6


def wrap180(deg: float) -> float:
    return ((deg + 180.0) % 360.0) - 180.0


class DisplayAngle:
    """The display's unwrapped rotation, from the WRAPPED frame index the bridge reports.

    The bridge sends idx mod n_frames, so a periodic pattern (a 20-frame grating at 1.8°/frame)
    only ever reports 0…19 and its azimuth spans one 36° period while the fly turns through
    thousands of degrees. Summing the index steps, each taken the short way round the modulus,
    recovers the rotation: Σ step × frame_dir × deg_per_frame. It starts at the first frame's
    azimuth (frame_dir·idx·deg_per_frame + az0), so for a pattern that spans the arena
    (n·deg_per_frame = 360) wrap180(deg) equals the feature azimuth.

    The modulus is `frames` when given; otherwise it is learned within each epoch (the bridge's
    `epoch` counts heading tares, i.e. trial starts, where the pattern may change) as the
    largest index seen + 1. That is enough because a wrap always passes through the largest
    index (19→0 or 0→19), which is then already counted. A jump at an epoch start (the tare
    moving the display to its start frame) is kept as the step it is.
    """

    def __init__(self, deg_per_frame: float, frame_dir: int = 1, az0: float = 0.0, frames: int = 0) -> None:
        self.dpf, self.dir, self.az0 = deg_per_frame, frame_dir, az0
        self.fixed = frames if frames and frames > 1 else 0
        self.n = self.fixed
        self.deg: float | None = None
        self._prev: int | None = None
        self._epoch = None

    def step(self, idx: int, epoch=None) -> float:
        if not self.fixed:
            if epoch != self._epoch:
                self.n = 0
            self.n = max(self.n, idx + 1)
        self._epoch = epoch
        if self._prev is None:
            self.deg = self.dir * idx * self.dpf + self.az0
        else:
            d = idx - self._prev
            if self.n > 1:
                d = (d + self.n // 2) % self.n - self.n // 2
            self.deg += self.dir * d * self.dpf
        self._prev = idx
        return self.deg


def per_frame_rate_dps(prev: tuple | None, fc: int, value: float, frame_rate_hz: float):
    """deg/s of an integrated FicTrac quantity (cols 20/21, rad) between consecutive samples:
    Δvalue / Δframe-counter × frame rate, so a dropped frame does not double the rate. None on
    the first sample or when the counter does not advance (a FicTrac restart)."""
    if prev is None or fc <= prev[0] or frame_rate_hz <= 0:
        return None
    return math.degrees(value - prev[1]) / (fc - prev[0]) * frame_rate_hz


def rotvec_to_quat(rx: float, ry: float, rz: float):
    """Axis-angle rotation vector (rad) → (x, y, z, w)."""
    a = math.sqrt(rx * rx + ry * ry + rz * rz)
    if a < 1e-12:
        return (0.0, 0.0, 0.0, 1.0)
    s = math.sin(a / 2.0) / a
    return (rx * s, ry * s, rz * s, math.cos(a / 2.0))


def rotate(q, v):
    """Rotate vector v by quaternion q = (x, y, z, w)."""
    x, y, z, w = q
    vx, vy, vz = v
    # t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx))


def color(r, g, b, a=1.0) -> ColorRGBA:
    c = ColorRGBA()
    c.r, c.g, c.b, c.a = float(r), float(g), float(b), float(a)
    return c


# Fixed markings on the unit ball (so rotation is visible): 12 points, deterministic.
MARKINGS = []
for i in range(12):
    th = 2.0 * math.pi * i / 12.0
    ph = 0.6 * math.sin(3.0 * th) + (0.3 if i % 2 else -0.3)
    MARKINGS.append((math.cos(ph) * math.cos(th), math.cos(ph) * math.sin(th), math.sin(ph)))


class Source:
    def __init__(self, name: str) -> None:
        self.name = name
        self.count = 0
        self.last_mono = None
        self.last_seq = None
        self.lat_ms = None
        self.last_error = None
        self.last_error_t = None
        self._rate_n = 0
        self._rate_t = time.monotonic()
        self.rate_hz = 0.0

    def seen(self, seq=None, rx_epoch_ms=None) -> None:
        self.count += 1
        self._rate_n += 1
        self.last_mono = time.monotonic()
        if seq is not None:
            self.last_seq = seq
        if rx_epoch_ms is not None:
            self.lat_ms = time.time() * 1000.0 - rx_epoch_ms

    def tick_rate(self) -> float:
        now = time.monotonic()
        dt = now - self._rate_t
        self.rate_hz = self._rate_n / dt if dt > 0 else 0.0
        self._rate_n = 0
        self._rate_t = now
        return self.rate_hz

    def error(self, text: str) -> None:
        self.last_error = text
        self.last_error_t = time.time()


class VizNode(Node):
    def __init__(self, a: argparse.Namespace) -> None:
        super().__init__("arena_viz")
        self.a = a
        self.src = {k: Source(k) for k in ("fictrac", "kinefly", "bias", "arena")}
        f64 = lambda t: self.create_publisher(Float64, t, 10)
        self.p = {
            "heading": f64("/viz/fictrac/heading_deg"),
            "turn": f64("/viz/fictrac/turn_deg"),
            "speed": f64("/viz/fictrac/speed_dps"),
            "fwd": f64("/viz/fictrac/fwd_rad"),
            "side": f64("/viz/fictrac/side_rad"),
            "fwd_dps": f64("/viz/fictrac/fwd_dps"),
            "side_dps": f64("/viz/fictrac/side_dps"),
            "ft_rate": f64("/viz/fictrac/rate_hz"),
            "index": f64("/viz/arena/index"),
            "az": f64("/viz/arena/azimuth_deg"),
            "display": f64("/viz/arena/display_deg"),
            "bias": f64("/viz/arena/bias_deg"),
            "left": f64("/viz/kinefly/left_deg"),
            "right": f64("/viz/kinefly/right_deg"),
            "lmr": f64("/viz/kinefly/lmr_deg"),
            "wbf": f64("/viz/kinefly/wbf_hz"),
            "frames": f64("/viz/bias/frame_count"),
            "fps": f64("/viz/bias/fps"),
        }
        self.p_bool = {
            "reachable": self.create_publisher(Bool, "/viz/bias/reachable", 10),
            "capturing": self.create_publisher(Bool, "/viz/bias/capturing", 10),
            "logging": self.create_publisher(Bool, "/viz/bias/logging", 10),
        }
        self.p_state = self.create_publisher(String, "/viz/bias/state", 10)
        self.p_err = self.create_publisher(String, "/viz/last_error", 10)
        self.p_diag = self.create_publisher(DiagnosticArray, "/diagnostics", 10)
        self.p_markers = self.create_publisher(MarkerArray, "/viz/markers", 10)

        self.create_subscription(String, "/fictrac/raw", self._fictrac, RELIABLE_QOS)
        self.create_subscription(String, "/kinefly/raw", self._kinefly, RELIABLE_QOS)
        self.create_subscription(String, "/bias/status", self._bias_status, RELIABLE_QOS)
        self.create_subscription(String, "/bias/reply", self._bias_reply, RELIABLE_QOS)
        # RELIABLE_QOS (depth 200) like the others: with depth 10 this subscription dropped 15 of
        # 9,969 frames when a ww18 bag was replayed at 1x (2026-10-16).
        self.create_subscription(String, "/arena/frame", self._arena, RELIABLE_QOS)

        # State for the markers
        self.quat = (0.0, 0.0, 0.0, 1.0)
        self.heading_deg = 0.0
        self.turn_deg = 0.0
        self._prev_hd = None
        self._prev_motion = None  # (frame counter, col 20, col 21) of the previous FicTrac frame
        self.idx = 0
        self.az_deg = 0.0
        self.display = DisplayAngle(a.deg_per_frame, a.frame_dir, a.feature_az0, a.frames)
        self.display_deg = None
        self.bias_deg = 0.0
        self.bias_active = False
        self.bias_state = "unreachable"
        self.create_timer(1.0, self._diagnostics)
        self.create_timer(1.0 / max(1.0, a.markers_hz), self._markers)
        self.get_logger().info("typed republisher up: /viz/*, /diagnostics, /viz/markers (Foxglove via foxglove_bridge :8766)")

    # ── helpers ─────────────────────────────────────────────────────────────────
    def _pub(self, key: str, value: float) -> None:
        m = Float64()
        m.data = float(value)
        self.p[key].publish(m)

    def _pub_bool(self, key: str, value: bool) -> None:
        m = Bool()
        m.data = bool(value)
        self.p_bool[key].publish(m)

    def _pub_str(self, pub, text: str) -> None:
        m = String()
        m.data = text
        pub.publish(m)

    @staticmethod
    def _env(msg: String):
        try:
            e = json.loads(msg.data)
        except json.JSONDecodeError:
            return None
        return e if isinstance(e, dict) else None

    def _note_error(self, src: str, text: str) -> None:
        self.src[src].error(text)
        self._pub_str(self.p_err, f"{time.strftime('%H:%M:%S')} {src}: {text}")

    # ── subscriptions ───────────────────────────────────────────────────────────
    def _fictrac(self, msg: String) -> None:
        env = self._env(msg)
        if not env or not isinstance(env.get("raw"), str):
            return
        parts = env["raw"].split(",")
        if parts and parts[0].strip()[:2].upper() == "FT":
            if parts[0].strip() != "FT":
                return
            parts = parts[1:]
        try:
            f = [float(p) for p in parts]
        except ValueError:
            return
        if len(f) < 21:
            return
        s = self.src["fictrac"]
        s.seen(int(f[0]), env.get("rx_epoch_ms"))
        hd = math.degrees(f[16]) % 360.0
        if self._prev_hd is not None:
            self.turn_deg += wrap180(hd - self._prev_hd)
        self._prev_hd = hd
        self.heading_deg = hd
        self.quat = rotvec_to_quat(f[11], f[12], f[13])
        self._pub("heading", hd)
        self._pub("turn", self.turn_deg)
        rate = s.rate_hz or self.a.assume_rate
        self._pub("speed", math.degrees(f[18]) * rate)
        self._pub("fwd", f[19])
        self._pub("side", f[20])
        fc = int(f[0])
        prev = self._prev_motion
        fwd = per_frame_rate_dps(prev and (prev[0], prev[1]), fc, f[19], rate)
        side = per_frame_rate_dps(prev and (prev[0], prev[2]), fc, f[20], rate)
        if fwd is not None and side is not None:
            self._pub("fwd_dps", fwd)
            self._pub("side_dps", side)
        self._prev_motion = (fc, f[19], f[20])

    def _kinefly(self, msg: String) -> None:
        env = self._env(msg)
        if not env or not isinstance(env.get("raw"), str):
            return
        try:
            pkt = json.loads(env["raw"])
        except json.JSONDecodeError:
            return
        self.src["kinefly"].seen(pkt.get("sequence"), env.get("rx_epoch_ms"))
        parts = pkt.get("parts") or {}

        def angle(name):
            p = parts.get(name) or {}
            a = p.get("angles_rad") or []
            return math.degrees(a[0]) if p.get("valid") and a else None

        l, r = angle("left"), angle("right")
        if l is not None:
            self._pub("left", l)
        if r is not None:
            self._pub("right", r)
        if l is not None and r is not None:
            self._pub("lmr", l - r)
        aux = parts.get("aux") or {}
        if aux.get("frequency_valid") and isinstance(aux.get("frequency_hz"), (int, float)):
            self._pub("wbf", aux["frequency_hz"])

    def _bias_status(self, msg: String) -> None:
        st = self._env(msg)
        if st is None:
            return
        s = self.src["bias"]
        s.seen(None, st.get("rx_epoch_ms"))
        reachable = bool(st.get("reachable"))
        capturing = bool(st.get("capturing"))
        logging_ = bool(st.get("logging"))
        self._pub_bool("reachable", reachable)
        self._pub_bool("capturing", capturing)
        self._pub_bool("logging", logging_)
        if isinstance(st.get("frameCount"), (int, float)):
            self._pub("frames", st["frameCount"])
        if isinstance(st.get("framesPerSec"), (int, float)):
            self._pub("fps", st["framesPerSec"])
        state = "unreachable" if not reachable else ("recording" if capturing and logging_ else "preview" if capturing else "idle")
        self.bias_state = state
        # Published on EVERY status tick (1 Hz), not only on change, so a dashboard that
        # connects mid-run sees the current state within a second (StateTransitions dedups).
        self._pub_str(self.p_state, state)
        if not reachable:
            s.error(str(st.get("error") or "unreachable"))

    def _bias_reply(self, msg: String) -> None:
        rep = self._env(msg)
        if rep is None:
            return
        self.src["bias"].seen(None, rep.get("rx_epoch_ms"))
        if not rep.get("ok"):
            self._note_error("bias", f"{rep.get('command')}: {rep.get('outcome')} — {rep.get('error')}")

    def _arena(self, msg: String) -> None:
        fr = self._env(msg)
        if fr is None or fr.get("type") != "frame":
            return
        self.src["arena"].seen(fr.get("fc"))
        idx = fr.get("index")
        if isinstance(idx, int):
            self.idx = idx
            self._pub("index", idx)
            self.az_deg = wrap180(self.a.frame_dir * idx * self.a.deg_per_frame + self.a.feature_az0)
            self._pub("az", self.az_deg)
            self.display_deg = self.display.step(idx, fr.get("epoch"))
            self._pub("display", self.display_deg)
        b = fr.get("bias")
        self.bias_active = isinstance(b, (int, float))
        self.bias_deg = float(b) if self.bias_active else 0.0
        self._pub("bias", self.bias_deg)

    # ── timers ──────────────────────────────────────────────────────────────────
    def _diagnostics(self) -> None:
        arr = DiagnosticArray()
        arr.header.stamp = self.get_clock().now().to_msg()
        now = time.monotonic()
        for s in self.src.values():
            rate = s.tick_rate()
            self._pub("ft_rate", rate) if s.name == "fictrac" else None
            st = DiagnosticStatus()
            st.name = f"arena/{s.name}"
            st.hardware_id = s.name
            if s.last_mono is None:
                st.level, st.message = DiagnosticStatus.WARN, "never seen"
            elif now - s.last_mono > self.a.stale_s:
                st.level, st.message = DiagnosticStatus.STALE, f"silent {now - s.last_mono:.0f} s"
            elif s.name == "bias" and self.bias_state == "unreachable":
                st.level, st.message = DiagnosticStatus.ERROR, "BIAS unreachable"
            elif s.name == "bias" and s.last_error_t and time.time() - s.last_error_t < 10:
                st.level, st.message = DiagnosticStatus.ERROR, s.last_error or "error"
            else:
                st.level, st.message = DiagnosticStatus.OK, f"{rate:.0f} Hz" if s.name != "bias" else self.bias_state
            vals = [("rate_hz", f"{rate:.1f}"), ("messages", str(s.count)), ("last_seq", str(s.last_seq)),
                    ("latency_ms", "" if s.lat_ms is None else f"{s.lat_ms:.1f}"),
                    ("last_error", s.last_error or ""),
                    ("last_error_time", time.strftime("%H:%M:%S", time.localtime(s.last_error_t)) if s.last_error_t else "")]
            st.values = [KeyValue(key=k, value=v) for k, v in vals]
            arr.status.append(st)
        self.p_diag.publish(arr)

    def _marker(self, mid: int, mtype: int, ns: str = "arena") -> Marker:
        m = Marker()
        m.header.frame_id = self.a.frame_id
        m.header.stamp = self.get_clock().now().to_msg()
        m.ns, m.id, m.type, m.action = ns, mid, mtype, Marker.ADD
        m.pose.orientation.w = 1.0
        m.frame_locked = True
        return m

    def _markers(self) -> None:
        arr = MarkerArray()
        # 0: the ball, rotated by FicTrac's lab-frame orientation
        ball = self._marker(0, Marker.SPHERE)
        ball.pose.orientation.x, ball.pose.orientation.y, ball.pose.orientation.z, ball.pose.orientation.w = self.quat
        ball.scale.x = ball.scale.y = ball.scale.z = 2 * BALL_R
        ball.color = color(0.85, 0.85, 0.88, 0.95)
        arr.markers.append(ball)
        # 1: markings on the ball (rotate fixed surface points by the same quaternion)
        marks = self._marker(1, Marker.SPHERE_LIST)
        marks.scale.x = marks.scale.y = marks.scale.z = 0.14
        marks.color = color(0.1, 0.1, 0.12, 1.0)
        for v in MARKINGS:
            x, y, z = rotate(self.quat, v)
            p = Point()
            p.x, p.y, p.z = x * BALL_R * 1.01, y * BALL_R * 1.01, z * BALL_R * 1.01
            marks.points.append(p)
        arr.markers.append(marks)
        # 2: the fly — fixed on top of the ball, facing +X (the world turns around it)
        fly = self._marker(2, Marker.ARROW)
        tail, tip = Point(), Point()
        tail.x, tail.y, tail.z = -0.25, 0.0, BALL_R + 0.08
        tip.x, tip.y, tip.z = 0.45, 0.0, BALL_R + 0.08
        fly.points = [tail, tip]
        fly.scale.x, fly.scale.y, fly.scale.z = 0.08, 0.18, 0.18
        fly.color = color(0.0, 0.9, 0.46, 1.0)
        arr.markers.append(fly)
        # 3: the arena, a translucent cylinder around the fly
        cyl = self._marker(3, Marker.CYLINDER)
        cyl.pose.position.z = BALL_R + 0.3
        cyl.scale.x = cyl.scale.y = 2 * ARENA_R
        cyl.scale.z = ARENA_H
        cyl.color = color(0.2, 0.6, 1.0, 0.12)
        arr.markers.append(cyl)
        # 4: the pattern feature on the wall (right-positive → −Y), at the display's rotation: the
        #    feature azimuth for a pattern that spans the arena, and for a periodic pattern (a
        #    grating) a point of the pattern turning with it rather than its phase in one period
        az = math.radians(wrap180(self.display_deg) if self.display_deg is not None else self.az_deg)
        feat = self._marker(4, Marker.CUBE)
        feat.pose.position.x = (ARENA_R - 0.08) * math.cos(az)
        feat.pose.position.y = -(ARENA_R - 0.08) * math.sin(az)
        feat.pose.position.z = BALL_R + 0.3
        # yaw the bar to lie along the wall
        yaw = -az
        feat.pose.orientation.z, feat.pose.orientation.w = math.sin(yaw / 2), math.cos(yaw / 2)
        feat.scale.x, feat.scale.y, feat.scale.z = 0.08, 0.5, ARENA_H * 0.9
        feat.color = color(1.0, 0.85, 0.2, 0.95)
        arr.markers.append(feat)
        # 5: readout
        txt = self._marker(5, Marker.TEXT_VIEW_FACING)
        txt.pose.position.z = BALL_R + ARENA_H + 0.6
        txt.scale.z = 0.3
        txt.color = color(0.9, 0.93, 0.95, 1.0)
        txt.text = (f"idx {self.idx}   display {self.display_deg or 0.0:+.0f}°   turn {self.turn_deg:+.0f}°"
                    f"   heading {self.heading_deg:.0f}°"
                    + (f"   bias {self.bias_deg:+.0f}°" if self.bias_active else ""))
        arr.markers.append(txt)
        self.p_markers.publish(arr)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--deg-per-frame", type=float, default=1.8, help="pattern pitch, display degrees per frame index (default: 1.8)")
    p.add_argument("--frame-dir", type=int, default=1, choices=(1, -1), help="+1: an index increase moves the feature RIGHT (default)")
    p.add_argument("--feature-az0", type=float, default=0.0, help="feature azimuth at index 0, degrees, right-positive (default: 0)")
    p.add_argument("--frames", type=int, default=0,
                   help="pattern frame count (the index modulus) for display_deg; 0 = learn it per epoch from the indices (default)")
    p.add_argument("--assume-rate", type=float, default=50.0, help="FicTrac frame rate used for speed before the first measured second (default: 50)")
    p.add_argument("--markers-hz", type=float, default=20.0, help="3D marker update rate (default: 20)")
    p.add_argument("--stale-s", type=float, default=2.0, help="seconds of silence before a source reads STALE (default: 2)")
    p.add_argument("--frame-id", default="arena", help="fixed frame for the markers (default: arena)")
    args, ros_args = p.parse_known_args(argv)
    rclpy.init(args=ros_args)
    node = VizNode(args)
    spin(node)
    print("[viz] stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
