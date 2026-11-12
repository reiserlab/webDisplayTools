#!/usr/bin/env python3
"""optomotor-oscillation-check.py — what the arena displayed in a run of
protocols/g6_optomotor_open_loop_oscillation.yaml, from the controller's own frame records.

Input: a behavior_v2 run log (.jsonl / .jsonl.gz) with controller telemetry rows
(js/arena-telemetry.js):

    ["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us, ...]   one displayed frame change

`t_us` is the controller's micros() and `idx` the frame index it showed, so the rows are the
arena's reported frame position against the controller clock. Rows are split into stimuli at
a pattern change or a pause over --gap-s, and each stimulus is classified by its frame count:

  rotation (--grating-frames, default 20): direction, frames/s, temporal frequency
  oscillation (--osc-frames, default 200): frames/s, then the frame index is mapped to the
      pattern's shift, round(A * sin(2*pi*idx/N)), and a sinusoid is fitted to shift(t):
      frequency, amplitude, RMS residual

Verdict per stimulus and overall. Pass: rotation speed within --tol of ±--rot-fps and a
steady +1 / -1 index step; oscillation frequency within --tol of --osc-hz, amplitude within
--tol of A, RMS residual under 1 px, no skipped frame index.

    python scripts/optomotor-oscillation-check.py run.jsonl
    python scripts/optomotor-oscillation-check.py --json run.jsonl

Standalone, stdlib only. Exit 0 pass, 1 fail, 2 bad arguments or no frame records.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
import sys

U32 = 1 << 32


def read_cf(path):
    """[(t_s, idx, pattern)] in file order, controller clock unwrapped (u32 micros)."""
    rows = []
    last = None
    wraps = 0
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith('["cf"'):
                continue
            try:
                arr = json.loads(line)
            except ValueError:
                continue
            if len(arr) < 6 or not all(isinstance(arr[i], int) for i in (2, 4, 5)):
                continue
            t = arr[2]
            if last is not None and t < last - U32 // 2:
                wraps += 1
            last = t
            rows.append(((t + wraps * U32) / 1e6, arr[4], arr[5]))
    return rows


def segments(rows, gap_s):
    seg = []
    for r in rows:
        if seg and (r[2] != seg[-1][2] or r[0] - seg[-1][0] > gap_s):
            yield seg
            seg = []
        seg.append(r)
    if seg:
        yield seg


def slope(ts, ys):
    """Least-squares slope of ys against ts."""
    n = len(ts)
    mt, my = sum(ts) / n, sum(ys) / n
    den = sum((t - mt) ** 2 for t in ts)
    return sum((t - mt) * (y - my) for t, y in zip(ts, ys)) / den if den else float("nan")


def fit_sine(ts, ys, f):
    """Least-squares a*sin + b*cos + c at frequency f → (amplitude, rms residual)."""
    w = 2 * math.pi * f
    s = [math.sin(w * t) for t in ts]
    c = [math.cos(w * t) for t in ts]
    n = len(ts)
    # normal equations for [a, b, c0]
    m = [[sum(x * y for x, y in zip(p, q)) for q in (s, c, [1.0] * n)] for p in (s, c, [1.0] * n)]
    v = [sum(x * y for x, y in zip(p, ys)) for p in (s, c, [1.0] * n)]
    for i in range(3):  # Gauss-Jordan, 3x3
        piv = m[i][i]
        if abs(piv) < 1e-12:
            return float("nan"), float("inf")
        m[i] = [x / piv for x in m[i]]
        v[i] /= piv
        for j in range(3):
            if j != i:
                k = m[j][i]
                m[j] = [x - k * y for x, y in zip(m[j], m[i])]
                v[j] -= k * v[i]
    a, b, c0 = v
    res = [y - (a * si + b * ci + c0) for y, si, ci in zip(ys, s, c)]
    return math.hypot(a, b), math.sqrt(sum(r * r for r in res) / n)


def best_frequency(ts, ys, f0):
    """Frequency that minimizes the residual, searched around f0 (coarse grid, then refined)."""
    lo, hi = 0.5 * f0, 1.5 * f0
    best = f0
    for _ in range(4):
        step = (hi - lo) / 200
        cands = [lo + i * step for i in range(201)]
        best = min(cands, key=lambda f: fit_sine(ts, ys, f)[1])
        lo, hi = best - 2 * step, best + 2 * step
    return best


def analyze(seg, a):
    ts = [r[0] - seg[0][0] for r in seg]
    idx = [r[1] for r in seg]
    n_frames = max(idx) + 1
    out = {"pattern": seg[0][2], "records": len(seg), "frame_count_seen": n_frames,
           "seconds": round(ts[-1], 3)}
    if len(seg) < 10:
        out.update(kind="short", ok=None)
        return out
    known = {a.grating_frames: "rotation", a.osc_frames: "oscillation"}
    kind = known.get(n_frames)
    if kind is None:
        out.update(kind="other", ok=None)
        return out
    n = n_frames
    steps = [((idx[i + 1] - idx[i] + n // 2) % n) - n // 2 for i in range(len(idx) - 1)]
    unwrapped = [0]
    for d in steps:
        unwrapped.append(unwrapped[-1] + d)
    fps = slope(ts, unwrapped)
    dts = [ts[i + 1] - ts[i] for i in range(len(ts) - 1)]
    out.update(kind=kind, frames_per_s=round(fps, 3),
               frame_interval_ms={"median": round(1e3 * statistics.median(dts), 3),
                                  "max": round(1e3 * max(dts), 3)})
    if kind == "rotation":
        sign = 1 if fps > 0 else -1
        steady = all(d == sign for d in steps)
        out.update(direction="toward increasing column index (+)" if sign > 0 else "toward decreasing column index (-)",
                   temporal_hz=round(abs(fps) / a.grating_frames, 4), steady_step=steady,
                   ok=steady and abs(abs(fps) - a.rot_fps) <= a.tol * a.rot_fps)
        return out
    skipped = sum(1 for d in steps if d != 1)
    pos = [round(a.osc_amp * math.sin(2 * math.pi * i / n)) for i in idx]
    f = best_frequency(ts, pos, a.osc_hz)
    amp, rms = fit_sine(ts, pos, f)
    out.update(osc_hz=round(f, 4), amplitude_px=round(amp, 3), rms_residual_px=round(rms, 3),
               cycles=round(ts[-1] * f, 2), not_plus_one_steps=skipped,
               ok=(skipped == 0 and abs(f - a.osc_hz) <= a.tol * a.osc_hz
                   and abs(amp - a.osc_amp) <= a.tol * a.osc_amp and rms < 1.0))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="behavior_v2 run log (.jsonl / .jsonl.gz) with controller cf rows")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--gap-s", type=float, default=0.5, help="pause that separates two stimuli (default 0.5)")
    ap.add_argument("--grating-frames", type=int, default=20)
    ap.add_argument("--rot-fps", type=float, default=80.0, help="expected |frames/s| of the rotation (default 80)")
    ap.add_argument("--osc-frames", type=int, default=200)
    ap.add_argument("--osc-hz", type=float, default=1.0)
    ap.add_argument("--osc-amp", type=float, default=20.0, help="oscillation amplitude in px (default 20)")
    ap.add_argument("--tol", type=float, default=0.02, help="relative tolerance (default 0.02 = 2 %%)")
    a = ap.parse_args(argv)

    rows = read_cf(a.path)
    if not rows:
        print("no controller frame records (cf rows) in " + a.path, file=sys.stderr)
        return 2
    res = [analyze(s, a) for s in segments(rows, a.gap_s)]
    judged = [r for r in res if r["ok"] is not None]
    kinds = [r["kind"] for r in judged]
    ok = bool(judged) and all(r["ok"] for r in judged) and "rotation" in kinds and "oscillation" in kinds
    if a.json:
        print(json.dumps({"file": a.path, "ok": ok, "stimuli": res}, indent=1))
        return 0 if ok else 1
    print(f"{a.path}: {len(rows)} frame records, {len(res)} stimuli")
    for i, r in enumerate(res, 1):
        v = {True: "PASS", False: "FAIL", None: "  - "}[r["ok"]]
        head = f"  {v} {i:2d}  pattern {r['pattern']:<3} {r['kind']:<11} {r['seconds']:6.2f} s"
        if r["kind"] == "rotation":
            print(f"{head}  {r['frames_per_s']:+8.2f} frames/s = {r['temporal_hz']:.3f} Hz  {r['direction']}"
                  f"  interval {r['frame_interval_ms']['median']} ms (max {r['frame_interval_ms']['max']})")
        elif r["kind"] == "oscillation":
            print(f"{head}  {r['frames_per_s']:+8.2f} frames/s  sinusoid {r['osc_hz']:.4f} Hz, "
                  f"amplitude {r['amplitude_px']} px, RMS residual {r['rms_residual_px']} px, "
                  f"{r['cycles']} cycles, steps other than +1: {r['not_plus_one_steps']}")
        else:
            print(f"{head}  {r['records']} records, frame count seen {r['frame_count_seen']}")
    print("RESULT: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
