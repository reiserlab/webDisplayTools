#!/usr/bin/env python3
"""scripts/optomotor-oscillation-check.py on synthetic run logs.

Builds the controller frame rows (["cf", rx, t_us, seq, idx, pattern, sd_us, spi_us]) and
runner step events a shortened walking run would log (open-loop trials back to back, then a
host-stepped closed-loop trial) and checks that the checker passes the right run, ignores
frame records from before the run, and fails a wrong frame rate, a skipped frame, a trial
that showed nothing and a wrong pattern length. The controller clock crosses its u32 wrap.
"""
import importlib.util
import io
import json
import math
import os
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
spec = importlib.util.spec_from_file_location(
    "osc_check", os.path.join(ROOT, "scripts", "optomotor-oscillation-check.py"))
osc_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(osc_check)

total = failed = 0
HOST0 = 1_700_000_000_000  # host epoch ms at controller time 0; a row is received 3..40 ms after it is shown
OL = ["yaw_osc_2p5hz", "yaw_osc_10hz", "roll_osc_5hz"]


def check(name, ok, info=""):
    global total, failed
    total += 1
    failed += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{' — ' + str(info) if info != '' else ''}")


def make_log(fps=150.0, n_frames=750, trial_s=10, steps=True, stale=False, skip_at=None, blank=None):
    """Three open-loop trials (no gap between them), one closed-loop trial, a finish step.
    stale: frame records of a Console play, ended 30 s before the run, drained when the log opens.
    skip_at: drop one frame record of the second trial. blank: a trial that shows no frame."""
    t = (1 << 32) - 12_000_000  # the controller clock wraps inside the run (or inside the stale play)
    seq = 0
    lines = ['{"event":"session","format":"behavior_v2"}', '["a",1,2,3]']
    stale_rx = None

    def step(cond):
        if steps:
            lines.append(json.dumps({"type": "log", "event": "runner", "phase": "step-start",
                                     "condition": cond, "rx_ms": HOST0 + t / 1e3 - 4}))

    def cf(tu, idx, pattern):
        nonlocal seq
        rx = stale_rx if stale_rx is not None else HOST0 + tu / 1e3 + 3 + (seq * 13) % 38
        lines.append(json.dumps(["cf", rx, int(tu) % (1 << 32), seq, idx, pattern, 300, 900]))
        seq += 1

    def play(pattern, n, rate, seconds, skip=None):
        nonlocal t
        for k in range(int(round(rate * seconds))):
            if k != skip:
                cf(t + k * 1e6 / rate + ((k * 7919) % 81) - 40, k % n, pattern)   # ±40 µs jitter
        t += int(seconds * 1e6)

    if stale:
        stale_rx = HOST0 + (t + 52_000_000) / 1e3 + 5
        play(6, 200, 42.46, 22)
        stale_rx = None
        t += 30_000_000
    step("fictrac_setup")
    for i, cond in enumerate(OL):
        step(cond)
        if blank == cond:
            t += int(trial_s * 1e6)
        else:
            play(10 + i, n_frames, fps, trial_s, skip_at if i == 1 else None)
    step("cl_grating_bias")   # host-stepped: a frame change now and then, long pauses at the turnarounds
    for k in range(120):
        cf(t + k * 80_000 + (700_000 if k > 60 else 0), int(100 + 17 * math.sin(k / 9)) % 200, 20)
    t += 11_000_000
    step("finish")
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def run(path, *extra):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = osc_check.main(["--json", path, *extra])
    os.unlink(path)
    return code, (json.loads(out.getvalue()) if out.getvalue().strip() else None)


code, rep = run(make_log())
st = rep["stimuli"]
check("good run passes", code == 0 and rep["ok"], code)
check("stimuli named by their steps, in order", [s["condition"] for s in st] == OL + ["cl_grating_bias"])
check("open loop: 150 frames/s across the clock wrap",
      all(abs(s["frames_per_s"] - 150) < 0.05 for s in st[:3]), [s["frames_per_s"] for s in st[:3]])
check("open loop: 750 frames per cycle = 5 s = 0.2 Hz",
      all(s["frame_count_seen"] == 750 and abs(s["cycle_s"] - 5) < 0.002 and abs(s["osc_hz"] - 0.2) < 1e-4
          for s in st[:3]))
check("open loop: every step +1, about 2 cycles each",
      all(s["not_plus_one_steps"] == 0 and 1.9 < s["cycles"] <= 2.0 for s in st[:3]))
check("open loop: even 6.667 ms frame interval", all(abs(s["frame_interval_ms"]["median"] - 6.667) < 0.05 for s in st[:3]))
check("closed loop is counted, not judged", st[3]["kind"] == "closed_loop" and st[3]["ok"] is None
      and st[3]["records"] > 100)

code, rep = run(make_log(stale=True))
check("frame records from before the run are ignored", code == 0 and rep["records_before_run"] > 900
      and [s["condition"] for s in rep["stimuli"]] == OL + ["cl_grating_bias"], rep["records_before_run"])
code, rep = run(make_log(fps=140.0))
check("140 frames/s fails", code == 1 and abs(rep["stimuli"][0]["frames_per_s"] - 140) < 0.05)
code, rep = run(make_log(fps=200.0, n_frames=1000), "--fps", "200", "--frames", "1000")
check("another frame rate and pattern length pass with --fps / --frames", code == 0)
code, rep = run(make_log(skip_at=444))
check("a skipped frame fails", code == 1 and rep["stimuli"][1]["not_plus_one_steps"] == 1
      and rep["stimuli"][0]["ok"] and rep["stimuli"][2]["ok"])
code, rep = run(make_log(blank="roll_osc_5hz"))
check("an open-loop step that showed nothing fails", code == 1 and rep["stimuli"][2]["records"] == 0)
code, rep = run(make_log(n_frames=200))
check("a pattern of the wrong length fails", code == 1 and rep["stimuli"][0]["frame_count_seen"] == 200)

code, rep = run(make_log(steps=False))
check("without step events: split at pattern changes, unnamed, open loop still judged",
      code == 0 and not rep["steps_named"] and sum(1 for s in rep["stimuli"] if s["kind"] == "open_loop") == 3)

fd, empty = tempfile.mkstemp(suffix=".jsonl")
os.close(fd)
code, rep = run(empty)
check("no frame records → exit 2", code == 2 and rep is None)

print(f"\n{total - failed} / {total} checks passed")
sys.exit(1 if failed else 0)
