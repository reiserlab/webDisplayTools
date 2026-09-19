#!/usr/bin/env python3
"""Offline tests for fictrac-bridge/fictrac_sim.py (run-log replay + model fly) and
scripts/closed-loop-report.py. No sockets: the pure pieces are driven directly and the
report is run on a synthetic run log written to a temp dir. Wired into `pixi run test`.

Run: python tests/test-fictrac-sim.py
"""
from __future__ import annotations

import gzip
import importlib.util
import json
import math
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sim = load("fictrac_sim", "fictrac-bridge/fictrac_sim.py")
rep = load("closed_loop_report", "scripts/closed-loop-report.py")
bridge = load("bridge", "fictrac-bridge/bridge.py")

total = 0
failures = 0


def check(name, got, expected):
    global total, failures
    total += 1
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, expected {expected!r}"))
    if not ok:
        failures += 1


def check_close(name, got, expected, tol):
    check(f"{name} ({got:.4g} ≈ {expected:.4g} ±{tol:g})", abs(got - expected) <= tol, True)


print("=== pack_record / wrap ===")
f = sim.pack_record(7, 20.0, 7.0, 0.1, 0.02, 7.0, 1.0, 2.0, 3.0, 4.0)
check("frame counter col 1", f[0], 7)
check_close("heading col 17 wrapped to [0, 2π)", f[16], 7.0 % (2 * math.pi), 1e-12)
check("delta heading col 8", f[7], 0.1)
check("timestamp col 22 in ns", f[21], 7 * 20.0 * 1e6)
check("25 fields", len(f), 25)
check("fmt_record ints for cols 1/23", sim.fmt_record(f).split(", ")[0], "7")
check("wrap180(190) = -170", sim.wrap180(190.0), -170.0)
check("wrap180(-180) stays -180 (range is [-180, 180))", sim.wrap180(-180.0), -180.0)
check("wrap180(180) = -180", sim.wrap180(180.0), -180.0)
check_close("wrap_pi(3π) = -π", sim.wrap_pi(3 * math.pi), -math.pi, 1e-9)
check_close("wrap_pi(0.5) unchanged", sim.wrap_pi(0.5), 0.5, 1e-12)

print("=== feature azimuth ===")
check("frame 0 → az0", sim.feature_azimuth(0, 1.8, 1, 0.0), 0.0)
check_close("idx 50 at 1.8°/frame → +90° right", sim.feature_azimuth(50, 1.8, 1, 0.0), 90.0, 1e-9)
check_close("frame_dir -1 flips", sim.feature_azimuth(50, 1.8, -1, 0.0), -90.0, 1e-9)
check_close("idx 150 wraps to -90", sim.feature_azimuth(150, 1.8, 1, 0.0), -90.0, 1e-9)

print("=== load_runlog_rows (mixed v2 log, gzipped) ===")
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "log.jsonl.gz")
    lines = [
        {"type": "session", "event": "logging_started", "ms": 1000},
        {"type": "frame_schema", "level": "behavior_v2", "cols": ["ms", "fc", "idx", "ft", "x", "y", "hd"], "t0": 1000},
        [0, 10, 0, 0.0, 0.1, 0.2, 0.5],
        ["a", 3, 2, "03700100", 0, 5],
        ["cc", 1005, 40000000, 1, 112, 0, "0100"],
        [20, 11, 1, 20.0, 0.11, 0.21, 0.52],
        [40, 12, 1, 40.0, 0.12, 0.22, None],          # hd null → skipped
        {"type": "log", "event": "runner", "phase": "step-start"},
        "garbage",
        [3000, 13, 2, 60.0, 0.13, 0.23, 6.2],
    ]
    with gzip.open(p, "wt") as fh:
        for l in lines:
            fh.write((json.dumps(l) if not isinstance(l, str) else l) + "\n")
    rows = sim.load_runlog_rows(p)
    check("three usable rows", len(rows), 3)
    check("row = (ms, fc, x, y, hd)", rows[0], (0.0, 10, 0.1, 0.2, 0.5))

    print("=== replay_records: pacing + heading continuity across loops ===")
    recs = list(sim.replay_records(rows, loop=False))
    check("one record per row", len(recs), 3)
    check("first delay 0", recs[0][0], 0.0)
    check_close("20 ms gap → 0.02 s", recs[1][0], 0.02, 1e-9)
    check_close("2960 ms gap clamped to 1 s", recs[2][0], 1.0, 1e-9)
    check_close("heading col 17 = hd", recs[0][1][16], 0.5, 1e-9)
    check_close("delta heading wraps (6.2 − 0.52 → −0.60)", recs[2][1][7], sim.wrap_pi(6.2 - 0.52), 1e-9)
    check_close("timestamp col 22 = ms in ns", recs[1][1][21], 20.0 * 1e6, 1e-3)
    gen = sim.replay_records(rows, loop=True)
    two_passes = [next(gen)[1] for _ in range(6)]
    check_close("loop restart keeps heading continuous", two_passes[3][16], two_passes[2][16], 1e-9)
    check("frame counter keeps counting across the loop", two_passes[5][0], 6)
    check_close("second pass delta heading is a small step, not a jump", abs(two_passes[3][7]), 0.0, 1e-9)

print("=== ModelFly ===")
fly = sim.ModelFly(rate_hz=50, seed=1, kp=2.0, noise_dps=0.0, saccade_rate_hz=0.0)
h0 = fly.heading
for _ in range(50):
    fly.step(30.0)  # feature 30° to the RIGHT
check("kp>0, feature right → heading DEcreases (turns right, FicTrac CCW+)", fly.heading < h0, True)
check_close("1 s at kp 2 × 30° with τ 0.1 → ≈ −60°·(1 − τ/1)", math.degrees(fly.heading - h0), -60.0 + 6.0, 2.0)
fly = sim.ModelFly(rate_hz=50, seed=1, kp=2.0, noise_dps=0.0, saccade_rate_hz=0.0)
for _ in range(50):
    fly.step(-30.0)
check("feature left → heading increases", fly.heading > 0, True)
fly = sim.ModelFly(rate_hz=50, seed=1, kp=2.0, noise_dps=0.0, saccade_rate_hz=0.0)
for _ in range(50):
    fly.step(None)
check("display unseen → no fixation drive", fly.heading, 0.0)

fly = sim.ModelFly(rate_hz=50, seed=2, kv=1.0, noise_dps=0.0, saccade_rate_hz=0.0, tau_s=0.02)
az = 0.0
for _ in range(100):
    az += 0.9  # feature drifting RIGHT at 45 °/s
    fly.step(az)
w = math.degrees(fly.omega)
check_close("kv 1, world moving right at 45°/s → fly turns right at ≈ −45°/s", w, -45.0, 3.0)

a = sim.ModelFly(rate_hz=50, seed=7, kp=1.0)
b = sim.ModelFly(rate_hz=50, seed=7, kp=1.0)
same = all(a.step(10.0) == b.step(10.0) for _ in range(200))
check("deterministic given the seed", same, True)

fly = sim.ModelFly(rate_hz=100, seed=3, noise_dps=0.0, saccade_rate_hz=2.0, saccade_deg=45.0, saccade_ms=80.0)
for _ in range(100 * 60):
    fly.step(None)
check("saccade count over 60 s at 2/s is Poisson-ish (90..150)", 90 <= fly.saccades <= 150, True)
check("saccade lasts 8 frames at 100 Hz", fly.saccade_frames, 8)

fly = sim.ModelFly(rate_hz=50, seed=4, noise_dps=20.0, saccade_rate_hz=0.0, pause_s=1.0, bout_s=1.0, speed_rad_s=1.0)
walked = paused = 0
speed_paused = 0.0
for _ in range(50 * 60):
    r = fly.step(None)
    if fly.walking:
        walked += 1
    else:
        paused += 1
        speed_paused = max(speed_paused, r[18])
check("two-state bouts: both states visited", walked > 500 and paused > 500, True)
check("paused fly has zero forward speed", speed_paused, 0.0)
r = fly.step(None)
check("record heading col 17 wrapped", 0.0 <= r[16] < 2 * math.pi, True)
check_close("col 22 in ns", r[21], fly.frame * 20.0 * 1e6, 1e-3)

print("=== closed-loop-report: bias_angle_deg mirrors the bridge ===")
for kind, amp, fr, t in (("constant", 90, 0, 1.3), ("sine", 90, 0.5, 0.37), ("square", 60, 1.0, 0.61), ("square", 60, 1.0, 0.9), ("none", 5, 1, 2)):
    check_close(f"{kind} A={amp} f={fr} t={t}", rep.bias_angle_deg(kind, amp, fr, t), bridge.bias_angle_deg(kind, amp, fr, t), 1e-9)


def synth_log(path, rejecting: bool, gain=1.8, frames=200, amp=90.0, dur_s=4.0, rate=50):
    """A run with one constant-bias epoch. rejecting=True: the fly's heading exactly cancels the bias."""
    t0 = 1_700_000_000_000
    L = [{"type": "session", "event": "logging_started", "ms": t0},
         {"type": "frame_schema", "level": "behavior_v2", "cols": ["ms", "fc", "idx", "ft", "x", "y", "hd"], "t0": t0},
         {"type": "config", "gain": gain, "frames": frames, "dir": "browser→bridge", "rx_ms": t0 + 100},
         {"type": "log", "event": "runner", "phase": "step-start", "index": 0, "condition": "cl_bias_constant", "rx_ms": t0 + 900},
         {"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": True, "condition": "cl_bias_constant", "rx_ms": t0 + 1000},
         {"type": "bias_config", "dir": "bridge", "ms": 1000, "bias": {"type": "constant", "amplitude": amp, "frequency": 0.0}},
         ]
    hd0_deg = 300.0
    L.append({"type": "heading_tare", "dir": "bridge", "ms": 1000, "hd0_deg": hd0_deg})
    n = int(dur_s * rate)
    for i in range(n + 1):
        t_s = i / rate
        ms = 1000 + int(round(t_s * 1000))
        b = amp * t_s
        rel = -b if rejecting else 0.0              # fly turns against the bias (heading −) or not at all
        hd_deg = hd0_deg + rel
        idx = round((rep.wrap180(rel) + b) / gain) % frames
        L.append([ms, i + 1, idx, t_s * 1000.0, 0.0, 0.0, math.radians(hd_deg % 360.0)])
    L.append({"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": False, "condition": "cl_bias_constant", "rx_ms": t0 + 1000 + int(dur_s * 1000) + 20})
    L.append({"type": "bias_config", "dir": "bridge", "ms": 1000 + int(dur_s * 1000) + 20, "bias": {"type": "none", "amplitude": 0.0, "frequency": 0.0}})
    with open(path, "w") as fh:
        for l in L:
            fh.write(json.dumps(l) + "\n")


print("=== closed-loop-report on synthetic runs ===")
with tempfile.TemporaryDirectory() as d:
    p_rej = os.path.join(d, "rej.jsonl")
    p_no = os.path.join(d, "norej.jsonl")
    synth_log(p_rej, True)
    synth_log(p_no, False)
    R = rep.analyze(p_rej, 0.0, 1, 0.0)
    check("one epoch from runner fictracApply", (len(R["epochs"]), R["epoch_source"]), (1, "runner fictracApply"))
    e = R["epochs"][0]
    check("condition label", e["condition"], "cl_bias_constant")
    check("gain/frames from the config echo", (e["gain"], e["frames"]), (1.8, 200))
    check("bias picked up", e["bias"]["type"], "constant")
    check_close("rejecting fly: rejection ≈ 1", e["rejection"], 1.0, 0.02)
    check_close("rejecting fly: net turn = −bias angle", e["fly"]["net_turn_deg"], -360.0, 1.0)
    check("rejecting fly: display held frontal", e["display"]["frontal_fraction"] > 0.99, True)
    check("idx reconstruction matches the log", e["idx_mismatch_fraction"], 0.0)
    N = rep.analyze(p_no, 0.0, 1, 0.0)["epochs"][0]
    check_close("passive fly: rejection ≈ 0", N["rejection"], 0.0, 0.02)
    check("passive fly: display swept all round (frontal fraction ≈ 1/6)", 0.1 < N["display"]["frontal_fraction"] < 0.25, True)
    check("passive fly: idx span covers the pattern", N["display"]["idx_span"], [0, 199])
    md = rep.to_markdown(R)
    check("markdown has the table row", "cl_bias_constant" in md and "+1.00" in md, True)
    svg = rep.to_svg(R)
    check("svg has three polylines", svg.count("<polyline"), 3)
    out_svg = os.path.join(d, "o.svg")
    rc = rep.main(["--svg", out_svg, "--json", p_rej])
    check("cli exit 0 + svg written", (rc, os.path.getsize(out_svg) > 500), (0, True))

print(f"\n{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
