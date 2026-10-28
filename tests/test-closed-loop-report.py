#!/usr/bin/env python3
"""Offline tests for scripts/closed-loop-report.py: bias_angle_deg mirrors fictrac-bridge/bridge.py and
the report is run on synthetic run logs written to a temp dir. Wired into `pixi run test`.
(Until 2026-10-26 this file also tested fictrac_sim.py; those tests moved with the simulator to
reiserlab/rig-nodes, tests/test_fictrac_sim.py.)

Run: python tests/test-closed-loop-report.py
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
print("=== closed-loop-report: bias_angle_deg mirrors the bridge ===")
for kind, amp, fr, t in (("constant", 90, 0, 1.3), ("sine", 90, 0.5, 0.37), ("square", 60, 1.0, 0.61), ("square", 60, 1.0, 0.9), ("none", 5, 1, 2)):
    check_close(f"{kind} A={amp} f={fr} t={t}", rep.bias_angle_deg(kind, amp, fr, t), bridge.bias_angle_deg(kind, amp, fr, t), 1e-9)


def synth_log(path, rejecting: bool, gain=1.8, frames=200, amp=90.0, dur_s=4.0, rate=50, coupling=None, spin_dps=0.0):
    """A run with one constant-bias epoch. rejecting=True: the fly's heading exactly cancels the bias."""
    t0 = 1_700_000_000_000
    L = [{"type": "session", "event": "logging_started", "ms": t0},
         {"type": "frame_schema", "level": "behavior_v2", "cols": ["ms", "fc", "idx", "ft", "x", "y", "hd"], "t0": t0},
         {"type": "config", "gain": gain, "frames": frames, "dir": "browser→bridge", "rx_ms": t0 + 100}
            if coupling is None else
         {"type": "config", "coupling": coupling, "deg_per_frame": gain, "frames": frames, "dir": "browser→bridge", "rx_ms": t0 + 100},
         {"type": "log", "event": "runner", "phase": "step-start", "index": 0, "condition": "cl_bias_constant", "rx_ms": t0 + 900},
         {"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": True, "condition": "cl_bias_constant", "rx_ms": t0 + 1000},
         {"type": "bias_config", "dir": "bridge", "ms": 1000, "bias": {"type": "constant", "amplitude": amp, "frequency": 0.0}},
         ]
    hd0_deg = 300.0
    # Real runner ordering (Isabel's 2026-09-21 bench logs): the PREVIOUS trial's stopClosedLoop
    # pushes `bias: none` (+ a tare) a few ms before this trial's fictracApply, and the real
    # waveform push (+ its tare) lands a few ms AFTER it. The report must pair the epoch with the
    # LAST push near its start, not the first — the first is the stale `none`.
    L.insert(4, {"type": "bias_config", "dir": "bridge", "ms": 996, "bias": {"type": "none", "amplitude": 0.0, "frequency": 0.0}})
    L.insert(5, {"type": "heading_tare", "dir": "bridge", "ms": 997, "hd0_deg": 123.4})
    L.append({"type": "heading_tare", "dir": "bridge", "ms": 1001, "hd0_deg": hd0_deg})
    n = int(dur_s * rate)
    for i in range(n + 1):
        t_s = i / rate
        ms = 1000 + int(round(t_s * 1000))
        b = amp * t_s
        k_eff = coupling if coupling else 1.0
        rel = -b / k_eff if rejecting else spin_dps * t_s   # holds the display (Δheading = −b/k), spins, or sits still
        hd_deg = hd0_deg + rel
        if coupling is None:
            idx = round((rep.wrap180(rel) + b) / gain) % frames            # bridge ≤ 3.2: wrapped, coupling 1
        else:
            idx = round((coupling * rel + b) / gain) % frames              # bridge 3.3: UNWRAPPED × coupling
        L.append([ms, i + 1, idx, t_s * 1000.0, 0.0, 0.0, math.radians(hd_deg % 360.0)])
    L.append({"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": False, "condition": "cl_bias_constant", "rx_ms": t0 + 1000 + int(dur_s * 1000) + 20})
    L.append({"type": "bias_config", "dir": "bridge", "ms": 1000 + int(dur_s * 1000) + 20, "bias": {"type": "none", "amplitude": 0.0, "frequency": 0.0}})
    with open(path, "w") as fh:
        for l in L:
            fh.write(json.dumps(l) + "\n")


def synth_start_frame_log(path, epochs, ignore_start_frame=False, coupling=-1.0, pitch=1.8, frames=200, rate=50, dur_s=2.0):
    """A bridge-3.4 run shaped like the 2026-10-27 ww18 bench logs: each epoch's startClosedLoop config
    carries `start_frame` (+ `epoch`, `offset: 0` from the plugin config), each stopClosedLoop config
    carries `offset: 0` and no start_frame. `epochs` = [(condition, start_frame or None, spin_dps)].
    The logged idx follows the bridge: offset = (start_frame mod frames) × pitch, one-shot per epoch.
    ignore_start_frame=True writes idx as a ≤3.3 bridge would (opens on frame 0)."""
    t0 = 1_700_000_000_000
    L = [{"type": "session", "event": "logging_started", "ms": t0},
         {"type": "frame_schema", "level": "behavior_v2", "cols": ["ms", "fc", "idx", "ft", "x", "y", "hd"], "t0": t0}]
    base = {"type": "config", "fictrac_port": 60000, "coupling": coupling, "deg_per_frame": pitch, "gain": pitch,
            "offset": 0, "frames": frames, "bias": {"type": "none", "amplitude": 0, "frequency": 0}, "dir": "browser→bridge"}
    fc = 0
    start = 1000
    for k, (cond, sf, spin) in enumerate(epochs):
        cfg = dict(base, epoch=True, rx_ms=t0 + start - 4)
        if sf is not None:
            cfg["start_frame"] = sf
        L.append(cfg)
        hd0 = 40.0 + 97.0 * k
        L.append({"type": "heading_tare", "dir": "bridge", "ms": start - 3, "hd0_deg": hd0, "reason": "epoch", "epoch": k + 1})
        L.append({"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": True, "condition": cond, "rx_ms": t0 + start})
        offset = 0.0 if sf is None or ignore_start_frame else (sf % frames) * pitch
        n = int(dur_s * rate)
        for i in range(n + 1):
            t_s = i / rate
            rel = spin * t_s
            idx = round((coupling * rel + offset) / pitch) % frames
            fc += 1
            L.append([start + int(round(t_s * 1000)), fc, idx, t_s * 1000.0, 0.0, 0.0, math.radians((hd0 + rel) % 360.0)])
        end = start + int(dur_s * 1000) + 20
        L.append({"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": False, "condition": cond, "rx_ms": t0 + end})
        L.append(dict(base, rx_ms=t0 + end + 1))   # stopClosedLoop: offset 0, bias none, no start_frame
        start = end + 1000
    with open(path, "w") as fh:
        for l in L:
            fh.write(json.dumps(l) + "\n")


print("=== closed-loop-report: start_frame (bridge 3.4) ===")
st = {}
rep.apply_config(st, {"deg_per_frame": 1.8, "frames": 200, "offset": 0, "start_frame": 275})
ps = bridge.Pipeline(None, None, 200, 1.8, 0.0)
check("start_frame → offset mirrors the bridge (mod frames, × pitch; overrides offset)", (st["start_frame"], st["offset"]), (75, ps.start_frame_to_offset(275)))
rep.apply_config(st, {"offset": 0})
check("a later config's offset ends the start_frame (one-shot)", (st.get("start_frame"), st["offset"]), (None, 0.0))
rep.apply_config(st, {"start_frame": 25, "frames": 100, "deg_per_frame": 3.6})
check("start_frame uses the same message's pitch + frame count", st["offset"], 25 * 3.6)
with tempfile.TemporaryDirectory() as d:
    eps = [("epoch_a_frame25", 25, 30.0), ("epoch_b_frame75", 275, -45.0), ("epoch_c_no_start", None, 20.0)]
    p_sf = os.path.join(d, "start_frame.jsonl")
    synth_start_frame_log(p_sf, eps)
    S = rep.analyze(p_sf, 0.0, 1, 0.0)["epochs"]
    check("three epochs", len(S), 3)
    check("start_frame per epoch (mod frames; none on a plain epoch)", [e["start_frame"] for e in S], [25, 75, None])
    check("offset per epoch = start_frame × pitch", [e["offset_deg"] for e in S], [45.0, 135.0, 0.0])
    check("idx reconstruction exact on start_frame epochs (was 100 % before bridge-3.4 support)",
          [e["idx_mismatch_fraction"] for e in S], [0.0, 0.0, 0.0])
    md = rep.to_markdown(rep.analyze(p_sf, 0.0, 1, 0.0))
    check("markdown shows frames @start and names start_frame in the legend", ("200 @25" in md, "200 @75" in md, "start_frame" in md), (True, True, True))
    # A log whose idx ignored start_frame (a ≤3.3 bridge that dropped the key) must still be FLAGGED:
    # the report models the 3.4 bridge from the config the browser sent.
    p_old = os.path.join(d, "start_frame_ignored.jsonl")
    synth_start_frame_log(p_old, eps, ignore_start_frame=True)
    O = rep.analyze(p_old, 0.0, 1, 0.0)["epochs"]
    check("idx that ignored start_frame → mismatch on those epochs only", [e["idx_mismatch_fraction"] for e in O], [1.0, 1.0, 0.0])


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
    # bridge 3.3 logs: coupling 0.75, a fly spinning 720 deg with no bias — the reconstruction must
    # use the UNWRAPPED turn x coupling (wrapping would mismatch after the first revolution).
    p_k = os.path.join(d, "k075.jsonl")
    synth_log(p_k, False, coupling=0.75, amp=0.0, dur_s=8.0, spin_dps=90.0)
    K = rep.analyze(p_k, 0.0, 1, 0.0)["epochs"][0]
    check("coupling read from the config echo", [K["coupling"], K["deg_per_frame"]], [0.75, 1.8])
    check("coupling 0.75 spinning fly: idx reconstruction exact across two revolutions", K["idx_mismatch_fraction"], 0.0)
    check_close("net turn 720 deg", K["fly"]["net_turn_deg"], 720.0, 0.5)
    check("markdown shows k and pitch", "k 0.75" in rep.to_markdown(rep.analyze(p_k, 0.0, 1, 0.0)), True)
    # The natural loop on the fly-on-ball rigs is coupling −1: a fly that HOLDS the display against a
    # constant bias turns +b (not −b), and rejection must still read +1 (normalized by the coupling).
    p_n = os.path.join(d, "kneg1_rej.jsonl")
    synth_log(p_n, True, coupling=-1.0)
    N1 = rep.analyze(p_n, 0.0, -1, 0.0)["epochs"][0]
    check_close("coupling -1, display held → rejection +1", N1["rejection"], 1.0, 0.02)
    check_close("...the fly turned WITH the bias angle (+360)", N1["fly"]["net_turn_deg"], 360.0, 1.0)
    check("coupling -1 held display: idx reconstruction exact", N1["idx_mismatch_fraction"], 0.0)
    p_z = os.path.join(d, "k0.jsonl")
    synth_log(p_z, False, coupling=0.0, spin_dps=45.0)
    check("coupling 0: rejection undefined", rep.analyze(p_z, 0.0, 1, 0.0)["epochs"][0]["rejection"], None)
    svg = rep.to_svg(R)
    check("svg has three polylines", svg.count("<polyline"), 3)
    out_svg = os.path.join(d, "o.svg")
    rc = rep.main(["--svg", out_svg, "--json", p_rej])
    check("cli exit 0 + svg written", (rc, os.path.getsize(out_svg) > 500), (0, True))

print(f"\n{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
