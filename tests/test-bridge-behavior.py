#!/usr/bin/env python3
"""Offline tests for the PURE parts of fictrac-bridge/bridge.py. No sockets/WebSocket
— the logic that can actually be wrong is pure, so this runs offline. Wired into
`pixi run test`.

Covers:
  • behavior_v1_row()          the ns→ms timestamp normalization + column mapping
                               that the live scope AND the offline analysis
                               dashboard depend on.
  • bias_angle_deg()           the closed-loop bias/disturbance waveforms (LAB-185):
                               the closed-form integrals, b(0)=0, the ZERO-MEAN
                               position property, and the degenerate no-ops.
  • frame_index_from_fictrac() the heading→frame-index mapping, with bias summed in.

Run: python tests/test-bridge-behavior.py
"""
import os
import sys

# import bridge.py (lives in fictrac-bridge/, not on the default path)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fictrac-bridge"))
import bridge  # noqa: E402

total = 0
failures = 0


def check(name, got, expected):
    global total, failures
    total += 1
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, expected {expected!r}"))
    if not ok:
        failures += 1


def approx(name, got, expected, tol=1e-6):
    global total, failures
    total += 1
    ok = got is not None and abs(got - expected) <= tol
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got {got}, expected {expected}")
    if not ok:
        failures += 1


def rec(fc, x, y, hd, ts):
    """A 25-col FicTrac record with the behavior_v1 columns set (rest 0)."""
    a = [0.0] * 25
    a[0] = fc      # col 1  frame counter
    a[14] = x      # col 15 integrated x
    a[15] = y      # col 16 integrated y
    a[16] = hd     # col 17 heading
    a[21] = ts     # col 22 timestamp (camera hardware clock; ns on our rigs)
    return a


print("=== FT_TS_NS_PER_MS ===")
check("constant is 1e6 (ns per ms)", bridge.FT_TS_NS_PER_MS, 1_000_000.0)

print("=== behavior_v1_row: ns col-22 → ms ft ===")
# ~120.9 Hz: consecutive col-22 values 8_271_561 ns apart (= 8.271561 ms).
NS = 8_271_561
TS0 = 20_000_000_000_000  # absurdly large absolute ns (like the real rigs)
f0 = rec(fc=100, x=0.0, y=0.0, hd=0.0, ts=TS0)
f1 = rec(fc=101, x=0.01, y=-0.02, hd=0.03, ts=TS0 + NS)
f2 = rec(fc=102, x=0.02, y=-0.04, hd=0.06, ts=TS0 + 2 * NS)

# ft0 is the first frame's col-22 (the Pipeline sets it); pure fn does the math.
ft0 = f0[21]
b0 = bridge.behavior_v1_row(f0, index=5, rel_ms=0, ft0=ft0)
b1 = bridge.behavior_v1_row(f1, index=5, rel_ms=8, ft0=ft0)
b2 = bridge.behavior_v1_row(f2, index=5, rel_ms=16, ft0=ft0)

# bridge rounds ft to 3 decimals (µs) — 8.271561 → 8.272, 16.543122 → 16.543.
approx("first frame ft = 0 ms", b0["ft"], 0.0)
approx("second frame ft = 8.272 ms (ns→ms, µs-rounded)", b1["ft"], 8.272)
approx("third frame ft = 16.543 ms", b2["ft"], 16.543)
# The bug this guards against: treating ns as ms would give ~8.27e6, not ~8.27.
check("ft is milliseconds, not raw ns", b1["ft"] < 100, True)

print("=== behavior_v1_row: column mapping + fields ===")
check("fc from col 1", b1["fc"], 101)
check("idx passthrough", b1["idx"], 5)
check("ms passthrough (display axis)", b1["ms"], 8)
check("x from col 15", b1["x"], 0.01)
check("y from col 16", b1["y"], -0.02)
check("hd from col 17", b1["hd"], 0.03)

print("=== drop-safe: ft is an ABSOLUTE timestamp diff, not per-frame dt ===")
# A frame dropped before logging (f1 missing) — f2 still lands at the right ms,
# because ft is (col22 - ft0), not a sum of per-frame deltas (Frank, #143).
b2_after_drop = bridge.behavior_v1_row(f2, index=5, rel_ms=16, ft0=ft0)
approx("ft across a dropped frame = 16.543 ms", b2_after_drop["ft"], 16.543)

print("=== degenerate inputs ===")
# No col 22 (short record) → ft is None (not a crash / not 0).
short = [0.0] * 17
short[0] = 7
check("missing col-22 → ft None", bridge.behavior_v1_row(short, index=1, rel_ms=3, ft0=None)["ft"], None)
check("missing col-22 still maps hd", bridge.behavior_v1_row(short, index=1, rel_ms=3, ft0=None)["fc"], 7)

print("=== bias_angle_deg: types + b(0) = 0 ===")
check("BIAS_TYPES vocabulary", list(bridge.BIAS_TYPES), ["none", "constant", "sine", "square"])
A = 90.0   # peak velocity, deg/s
F = 0.5    # Hz → period 2 s
T = 1.0 / F
for kind in bridge.BIAS_TYPES:
    # Onset must never jump the display: every waveform integrates from zero.
    approx(f"{kind}: b(0) = 0", bridge.bias_angle_deg(kind, A, F, 0.0), 0.0)
check("none is a no-op at any t", bridge.bias_angle_deg("none", A, F, 3.7), 0.0)
check("unknown kind is a no-op (never raises)", bridge.bias_angle_deg("triangle", A, F, 3.7), 0.0)

print("=== bias_angle_deg: constant = A·t (the 'display still rotates' case) ===")
approx("constant 90 deg/s for 2 s = 180 deg", bridge.bias_angle_deg("constant", A, F, 2.0), 180.0)
approx("constant is linear (4 s = 360 deg)", bridge.bias_angle_deg("constant", A, F, 4.0), 360.0)
approx("constant ignores frequency", bridge.bias_angle_deg("constant", A, 7.3, 2.0), 180.0)
approx("negative amplitude reverses", bridge.bias_angle_deg("constant", -A, F, 2.0), -180.0)

print("=== bias_angle_deg: sine = (A/ω)·sin(ωt), ZERO-MEAN in position ===")
# The peak position excursion is A/ω = A/(2πf) — 28.6478.. deg at 90 deg/s, 0.5 Hz.
peak_sine = A / (2 * 3.141592653589793 * F)
approx("sine peak +A/ω at t = T/4", bridge.bias_angle_deg("sine", A, F, T / 4), peak_sine, tol=1e-9)
approx("sine back to 0 at t = T/2", bridge.bias_angle_deg("sine", A, F, T / 2), 0.0, tol=1e-9)
# THE regression guard: an earlier draft used (A/ω)(1−cos ωt), which is one-sided
# (never negative) — the display would drift to one side instead of being pushed
# equally both ways. A negative trough at 3T/4 is what proves the zero-mean form.
approx("sine trough −A/ω at t = 3T/4 (NOT one-sided)", bridge.bias_angle_deg("sine", A, F, 3 * T / 4), -peak_sine, tol=1e-9)
approx("sine periodic: b(T) = 0", bridge.bias_angle_deg("sine", A, F, T), 0.0, tol=1e-9)
approx("sine periodic: b(T + T/4) = peak", bridge.bias_angle_deg("sine", A, F, T + T / 4), peak_sine, tol=1e-9)
approx("sine negative amplitude mirrors", bridge.bias_angle_deg("sine", -A, F, T / 4), -peak_sine, tol=1e-9)
# Halving the excursion by doubling f is the practical consequence of amplitude
# being a VELOCITY: at a fixed A, a faster disturbance covers less ground.
approx("sine at 2f has half the excursion", bridge.bias_angle_deg("sine", A, 2 * F, (T / 2) / 4), peak_sine / 2, tol=1e-9)

print("=== bias_angle_deg: square = symmetric triangle, ±A/(4f) ===")
peak_sq = A / (4 * F)  # 45 deg at 90 deg/s, 0.5 Hz
approx("square peak +A/(4f) at t = T/4", bridge.bias_angle_deg("square", A, F, T / 4), peak_sq)
approx("square crosses 0 at t = T/2", bridge.bias_angle_deg("square", A, F, T / 2), 0.0)
approx("square trough −A/(4f) at t = 3T/4", bridge.bias_angle_deg("square", A, F, 3 * T / 4), -peak_sq)
approx("square periodic: b(T) = 0", bridge.bias_angle_deg("square", A, F, T), 0.0)
approx("square periodic: b(3T + T/4) = peak", bridge.bias_angle_deg("square", A, F, 3 * T + T / 4), peak_sq)
approx("square rises linearly (T/8 → half peak)", bridge.bias_angle_deg("square", A, F, T / 8), peak_sq / 2)
approx("square negative amplitude mirrors", bridge.bias_angle_deg("square", -A, F, T / 4), -peak_sq)

print("=== bias_angle_deg: degenerate frequency ===")
# 0 Hz is the divide-by-ω case. The WEB RUNNER rejects it up front (skips the step
# with a message); the bridge must still degrade to a no-op rather than raise,
# because it runs once per FicTrac frame.
check("sine at 0 Hz → 0.0, no raise", bridge.bias_angle_deg("sine", A, 0.0, 2.0), 0.0)
check("square at 0 Hz → 0.0, no raise", bridge.bias_angle_deg("square", A, 0.0, 2.0), 0.0)
# A negative frequency is a NO-OP, not a mirror: both velocities are cosines, which
# are even in ω. (For the sine's b(t) the sign flips in A/ω and sin(ωt) cancel.)
# Reversing direction is done by negating the AMPLITUDE.
approx("sine at −f equals sine at +f", bridge.bias_angle_deg("sine", A, -F, T / 4), bridge.bias_angle_deg("sine", A, F, T / 4), tol=1e-9)
approx("square at −f equals square at +f", bridge.bias_angle_deg("square", A, -F, T / 4), bridge.bias_angle_deg("square", A, F, T / 4))

print("=== frame_index_from_fictrac: bias folds into the mapping ===")
GAIN = 1.8   # deg of heading per frame index (360/200)
NFR = 200
still = rec(fc=1, x=0.0, y=0.0, hd=0.0, ts=0)  # a fly holding perfectly still
check("no bias + still fly → frame 0", bridge.frame_index_from_fictrac(still, NFR, GAIN, 0.0), 0)
check("bias_deg defaults to 0 (back-compat signature)", bridge.frame_index_from_fictrac(still, NFR, GAIN, 0.0), 0)
# THE feature: a still fly still moves the display, purely from the bias.
check("bias 90 deg → frame 50 with a still fly", bridge.frame_index_from_fictrac(still, NFR, GAIN, 0.0, 90.0), 50)
check("bias 180 deg → frame 100", bridge.frame_index_from_fictrac(still, NFR, GAIN, 0.0, 180.0), 100)
check("bias wraps past a full turn (450 deg → frame 50)", bridge.frame_index_from_fictrac(still, NFR, GAIN, 0.0, 450.0), 50)
check("negative bias wraps non-negative (−90 deg → frame 150)", bridge.frame_index_from_fictrac(still, NFR, GAIN, 0.0, -90.0), 150)
# Bias lives in the same heading-equivalent space as `offset`, so they add...
check("bias adds to offset", bridge.frame_index_from_fictrac(still, NFR, GAIN, 45.0, 45.0), 50)
# ...and a NEGATIVE gain reverses the bias along with the fly coupling.
check("negative gain reverses the bias direction", bridge.frame_index_from_fictrac(still, NFR, -GAIN, 0.0, 90.0), 150)
# gain 0 has no deg→index scale, so there is nothing to map — bias included.
check("gain 0 short-circuits to 0 even with a bias", bridge.frame_index_from_fictrac(still, NFR, 0.0, 0.0, 90.0), 0)
# Fly heading and bias sum: 90 deg of heading + 90 deg of bias = 180 deg → frame 100.
walking = rec(fc=2, x=0.0, y=0.0, hd=3.141592653589793 / 2, ts=0)  # hd = 90 deg
check("heading + bias sum (90 + 90 deg → frame 100)", bridge.frame_index_from_fictrac(walking, NFR, GAIN, 0.0, 90.0), 100)

print("\n=== Summary ===")
print(f"{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
