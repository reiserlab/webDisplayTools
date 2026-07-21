#!/usr/bin/env python3
"""Offline tests for fictrac-bridge/bridge.py behavior_v1_row() — the pure ns→ms
timestamp normalization + column mapping that the live scope AND the offline
analysis dashboard depend on. No sockets/WebSocket: the buggy logic is pure, so
this runs offline. Wired into `pixi run test`.

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

print("\n=== Summary ===")
print(f"{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
