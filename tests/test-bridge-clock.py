#!/usr/bin/env python3
"""Offline tests for fictrac-bridge/bridge.py's wall clock (now_ms), wired into
`pixi run test`:
  1. Everywhere: now_ms() is an int of epoch ms that agrees with time.time().
  2. Where the stdlib clock is kept (macOS, Linux, Windows on Python 3.13+): now_ms() is
     exactly int(time.time() * 1000), so run logs there are byte-identical to before.
  3. Windows only (guarded): the GetSystemTimePreciseAsFileTime clock has the right epoch
     and units, never goes backwards, and ticks every ms instead of every ~15.6 ms timer tick.

Run: python tests/test-bridge-clock.py
"""
import os
import sys
import time

# import bridge.py (lives in fictrac-bridge/, not on the default path)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fictrac-bridge"))
import bridge  # noqa: E402

total = 0
failures = 0


def check(name, ok, detail=""):
    global total, failures
    total += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok or not detail else f" — {detail}"))
    if not ok:
        failures += 1


def distinct_ms(clock, window_s=0.05):
    """Distinct values `clock` returns while busy-sampling it for `window_s` seconds."""
    seen = []
    end = time.perf_counter() + window_s
    while time.perf_counter() < end:
        v = clock()
        if not seen or v != seen[-1]:
            seen.append(v)
    return seen


IS_WINDOWS = os.name == "nt"
STDLIB_KEPT = not IS_WINDOWS or sys.version_info >= (3, 13)

print("1. now_ms() everywhere")
v = bridge.now_ms()
ref = time.time() * 1000
check("returns an int", type(v) is int, f"got {type(v).__name__}")
check("agrees with time.time() within 50 ms", abs(v - ref) <= 50, f"now_ms {v}, time.time {ref:.1f}")
samples = [bridge.now_ms() for _ in range(10000)]
check("never goes backwards", all(b >= a for a, b in zip(samples, samples[1:])))

print("2. stdlib clock kept" + ("" if STDLIB_KEPT else " (skipped: Windows, Python <= 3.12)"))
if STDLIB_KEPT:
    check("now_ms is the stdlib-backed function", bridge.now_ms.__name__ == "now_ms",
          f"got {bridge.now_ms.__name__}")
    real_time = bridge.time.time
    try:
        for t in (0.0, 1.0009, 1760547600.1234567, 1760547600.9999):
            bridge.time.time = lambda t=t: t
            check(f"now_ms() == int(time.time() * 1000) at t={t}", bridge.now_ms() == int(t * 1000),
                  f"got {bridge.now_ms()}")
    finally:
        bridge.time.time = real_time
if not IS_WINDOWS:
    check("no precise clock off Windows", bridge._windows_precise_now_ms() is None)

print("3. Windows precise clock" + ("" if IS_WINDOWS else " (skipped: not Windows)"))
if IS_WINDOWS:
    precise = bridge._windows_precise_now_ms()
    check("GetSystemTimePreciseAsFileTime is available", precise is not None)
    if precise is not None:
        if not STDLIB_KEPT:
            check("now_ms is the precise clock", bridge.now_ms.__name__ == "precise_now_ms",
                  f"got {bridge.now_ms.__name__}")
        p = precise()
        ref = time.time() * 1000
        check("returns an int", type(p) is int, f"got {type(p).__name__}")
        # A wrong epoch or tick unit would be off by years or by a factor of 10; a coarse
        # time.time() lags the precise clock by at most one timer tick (15.625 ms).
        check("epoch and units match time.time() within 50 ms", abs(p - ref) <= 50,
              f"precise {p}, time.time {ref:.1f}")
        ps = [precise() for _ in range(10000)]
        check("never goes backwards", all(b >= a for a, b in zip(ps, ps[1:])))
        # 50 ms of busy sampling: a 1 ms clock shows ~50 values, the 15.625 ms tick at most 4.
        seen = distinct_ms(precise)
        check("ticks every ms (>= 25 distinct values in 50 ms)", len(seen) >= 25,
              f"{len(seen)} distinct values")

print(f"{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
