#!/usr/bin/env python3
"""test_viz_node.py — the pure math in nodes/viz_node.py (no ROS graph needed).

    pixi run python tests/test_viz_node.py

DisplayAngle (the unwrapped display rotation from the bridge's wrapped index) and
per_frame_rate_dps (rates of FicTrac's integrated cols 20/21). Importing viz_node needs rclpy
and the std/visualization/diagnostic message packages, which every environment here has.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nodes"))
from viz_node import DisplayAngle, per_frame_rate_dps, wrap180  # noqa: E402

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def close(a: float, b: float, tol: float = 1e-9) -> bool:
    return abs(a - b) <= tol


# 1. A 20-frame grating turned forward through 3 periods: the wrapped index cycles 0..19 three
#    times, the unwrapped angle grows by 1.8° a step (60 steps = 108°), never jumping at 19→0.
d = DisplayAngle(1.8, frames=20)
idx = [i % 20 for i in range(61)]
out = [d.step(i, epoch=1) for i in idx]
steps = [b - a for a, b in zip(out, out[1:])]
check("grating forward: every step +1.8° across the wraps", all(close(s, 1.8) for s in steps),
      f"steps {sorted(set(round(s, 3) for s in steps))}")
check("grating forward: 60 steps = 108°", close(out[-1] - out[0], 108.0))

# 2. Backwards through the wrap 0 → 19: −1.8°, not +34.2°.
d = DisplayAngle(1.8, frames=20)
seq = [3, 2, 1, 0, 19, 18]
out = [d.step(i) for i in seq]
check("grating backward through 0→19: −1.8° steps", all(close(b - a, -1.8) for a, b in zip(out, out[1:])))

# 3. Learned modulus (frames=0): the same backward sequence, where 19 is first seen AT the wrap.
d = DisplayAngle(1.8)
out = [d.step(i, epoch=1) for i in seq]
check("learned modulus: wrap at the first sight of the top index", all(close(b - a, -1.8) for a, b in zip(out, out[1:])),
      f"{[round(b - a, 2) for a, b in zip(out, out[1:])]}")

# 4. Learned modulus re-learns at an epoch change (a pre-run test pattern with 129 frames, then
#    the 20-frame grating): after the tare, 19→0 is again a +1 step, not −19.
d = DisplayAngle(1.8)
for i in range(129):
    d.step(i, epoch=0)
before = d.step(0, epoch=1)  # the tare: jump to the start frame
for i in range(1, 20):
    d.step(i, epoch=1)
last19 = d.deg
after = d.step(0, epoch=1)
check("learned modulus resets per epoch (129-frame test pattern, then 20)", close(after - last19, 1.8),
      f"19→0 step {after - last19:+.2f}°")

# 5. A pattern spanning the arena (200 frames × 1.8° = 360°): wrap180(display) is the azimuth.
d = DisplayAngle(1.8, frame_dir=1, az0=10.0, frames=200)
ok = True
for i in list(range(0, 200, 7)) + list(range(199, -1, -9)):
    deg = d.step(i)
    ok &= close(wrap180(deg), wrap180(1.8 * i + 10.0), 1e-6)
check("full-arena pattern: wrap180(display) == feature azimuth", ok)

# 6. frame_dir −1 mirrors the angle.
a, b = DisplayAngle(1.8, frame_dir=1, frames=20), DisplayAngle(1.8, frame_dir=-1, frames=20)
for i in [0, 1, 2, 3, 2, 1, 0, 19, 18]:
    x, y = a.step(i), b.step(i)
check("frame_dir −1 mirrors the rotation", close(x, -y))

# 7. Rates of the integrated FicTrac columns.
r = per_frame_rate_dps(None, 10, 1.0, 100.0)
check("rate: none on the first sample", r is None)
r = per_frame_rate_dps((10, 1.0), 11, 1.0 + math.radians(0.5), 100.0)
check("rate: 0.5° in one frame at 100 Hz = 50 °/s", r is not None and close(r, 50.0, 1e-9))
r = per_frame_rate_dps((10, 1.0), 12, 1.0 + math.radians(1.0), 100.0)
check("rate: a dropped frame does not double it (1° over 2 frames = 50 °/s)", r is not None and close(r, 50.0, 1e-9))
r = per_frame_rate_dps((500, 1.0), 3, 0.0, 100.0)
check("rate: none when the frame counter goes back (FicTrac restarted)", r is None)

print(f"\n{'FAIL' if failures else 'PASS'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
