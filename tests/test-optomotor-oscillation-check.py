#!/usr/bin/env python3
"""scripts/optomotor-oscillation-check.py on synthetic run logs.

Builds the controller frame rows (["cf", rx, t_us, seq, idx, pattern, sd_us, spi_us]) the
arena would report for one repetition of g6_optomotor_open_loop_oscillation.yaml and checks
that the checker passes the right run and fails a wrong frame rate, a wrong direction pair,
a skipped frame and a log without the oscillation. The controller clock crosses its u32
wrap inside the run.
"""
import importlib.util
import io
import json
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


def check(name, ok, info=""):
    global total, failed
    total += 1
    failed += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{' — ' + str(info) if info != '' else ''}")


def make_log(rot_fps=80.0, osc_fps=200.0, ccw_sign=-1, skip_at=None, with_osc=True, jitter_us=40):
    """One cw / ccw / osc repetition, 10 s each, 5 s dark between; returns the file path."""
    t = (1 << 32) - 7_000_000  # 7 s before the u32 micros wrap
    seq = 0
    lines = ['{"event":"session","format":"behavior_v2"}', '["a",1,2,3]']

    def play(pattern, n_frames, fps, seconds, sign=1):
        nonlocal t, seq
        count = int(round(abs(fps) * seconds))
        for k in range(count):
            if skip_at is not None and pattern == 2 and k == skip_at:
                continue
            idx = (sign * k) % n_frames
            # deterministic +/- jitter, as SD load + SPI time would add
            tu = int(t + k * 1e6 / abs(fps) + ((k * 7919) % (2 * jitter_us + 1)) - jitter_us)
            lines.append(json.dumps(["cf", 1700000000000 + seq, tu % (1 << 32), seq, idx, pattern, 300, 900]))
            seq += 1
        t += int(seconds * 1e6)

    play(1, 20, rot_fps, 10, +1)
    t += 5_000_000
    play(1, 20, rot_fps, 10, ccw_sign)
    t += 5_000_000
    if with_osc:
        play(2, 200, osc_fps, 10, +1)
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
check("three stimuli: rotation, rotation, oscillation",
      [s["kind"] for s in st] == ["rotation", "rotation", "oscillation"])
check("cw +80 frames/s, 4 Hz", abs(st[0]["frames_per_s"] - 80) < 0.1 and abs(st[0]["temporal_hz"] - 4) < 0.01,
      st[0]["frames_per_s"])
check("ccw -80 frames/s", abs(st[1]["frames_per_s"] + 80) < 0.1 and st[1]["direction"].endswith("(-)"))
osc = st[2]
check("oscillation 1.000 Hz across the clock wrap", abs(osc["osc_hz"] - 1.0) < 0.002, osc["osc_hz"])
check("oscillation amplitude 20 px", abs(osc["amplitude_px"] - 20) < 0.3, osc["amplitude_px"])
check("oscillation residual is the pixel rounding", osc["rms_residual_px"] < 0.5, osc["rms_residual_px"])
check("oscillation 10 cycles, every step +1", abs(osc["cycles"] - 10) < 0.05 and osc["not_plus_one_steps"] == 0)

code, rep = run(make_log(osc_fps=180.0))
check("oscillation at 180 frames/s fails (0.9 Hz)", code == 1 and abs(rep["stimuli"][2]["osc_hz"] - 0.9) < 0.005,
      rep["stimuli"][2]["osc_hz"])
code, rep = run(make_log(rot_fps=60.0))
check("rotation at 60 frames/s fails", code == 1 and not rep["stimuli"][0]["ok"])
code, rep = run(make_log(skip_at=777))
check("a skipped oscillation frame fails", code == 1 and rep["stimuli"][2]["not_plus_one_steps"] == 1)
code, rep = run(make_log(with_osc=False))
check("a run without the oscillation fails", code == 1)

fd, empty = tempfile.mkstemp(suffix=".jsonl")
os.close(fd)
code, rep = run(empty)
check("no frame records → exit 2", code == 2 and rep is None)

print(f"\n{total - failed} / {total} checks passed")
sys.exit(1 if failed else 0)
