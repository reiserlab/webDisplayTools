#!/usr/bin/env python3
"""optomotor-oscillation-check.py — what the arena displayed in a run of
protocols/g6_optomotor_osc_walking.yaml or g6_optomotor_osc_flight.yaml, from the
controller's own frame records.

Input: a behavior_v2 run log (.jsonl / .jsonl.gz) with controller telemetry rows
(js/arena-telemetry.js) and the runner's step events:

    ["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us, ...]   one displayed frame change
    {"event":"runner","phase":"step-start","condition":…,"rx_ms":…}

`t_us` is the controller's micros() and `idx` the frame index it showed, so the cf rows are
the arena's reported frame position against the controller clock. The controller clock is
mapped to host time with the smallest (rx - t_us) of the frame rows, and each step's frame
records are the ones inside its interval (--guard-ms cut off both ends). Frame records from
before the first step are ignored: the controller's ring can still hold frames shown before
the log opened (ww18, 2026-11-12).

An open-loop trial (`yaw_osc_*`, `roll_osc_*`) is a pattern of --frames frames holding one
oscillation cycle, played at --fps. The oscillation itself is in the file (checked when
scripts/make-optomotor-osc-patterns.js builds it); what the arena can get wrong is the
playback, so per trial this reports and judges:
    frames/s (pass within --tol of --fps), frame index steps other than +1 (pass: 0),
    frames per cycle seen (pass: --frames) → cycle time and oscillation frequency,
    frame interval median / min / max.
A closed-loop trial (`cl_*`) is host-stepped; its frame records are counted, not judged.

Overall PASS: every open-loop step of the run showed frames and passed. A log without
runner step events is split at pattern changes and pauses instead, and nothing is named.

    python scripts/optomotor-oscillation-check.py run.jsonl
    python scripts/optomotor-oscillation-check.py --json run.jsonl

Standalone, stdlib only. Exit 0 pass, 1 fail, 2 bad arguments or no frame records.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import statistics
import sys

U32 = 1 << 32
OPEN_LOOP = re.compile(r"^(yaw|roll)_osc_")
CLOSED_LOOP = re.compile(r"^cl_")


def read_log(path):
    """→ (rows, steps): rows [(t_s, idx, pattern, rx_ms|None)] in file order with the controller
    clock unwrapped (u32 micros); steps [(rx_ms, condition)] from the runner's step-start events."""
    rows, steps = [], []
    last = None
    wraps = 0
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("{") and '"step-start"' in line:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("event") == "runner" and obj.get("phase") == "step-start" \
                        and isinstance(obj.get("rx_ms"), (int, float)):
                    steps.append((float(obj["rx_ms"]), str(obj.get("condition"))))
                continue
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
            rx = float(arr[1]) if isinstance(arr[1], (int, float)) else None
            rows.append(((t + wraps * U32) / 1e6, arr[4], arr[5], rx))
    return rows, sorted(steps)


def host_offset_ms(rows):
    """Controller → host clock offset (ms): the smallest rx - t over the frame rows (a row is
    received after it was shown, never before), or None without host receive times."""
    lags = [r[3] - r[0] * 1e3 for r in rows if r[3] is not None]
    return min(lags) if lags else None


def by_pattern_and_pause(rows, gap_s):
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


def analyze(seg, a, cond=None):
    ts = [r[0] - seg[0][0] for r in seg]
    idx = [r[1] for r in seg]
    patterns = sorted({r[2] for r in seg})
    seen = max(idx) + 1
    out = {"condition": cond, "pattern": patterns[0] if len(patterns) == 1 else patterns,
           "records": len(seg), "seconds": round(ts[-1], 3), "frame_count_seen": seen}
    if cond is not None and CLOSED_LOOP.match(cond):
        out.update(kind="closed_loop", distinct_frames=len(set(idx)), ok=None)
        return out
    named_open = cond is not None and OPEN_LOOP.match(cond)
    if not named_open and (cond is not None or seen != a.frames):
        out.update(kind="other", ok=None)
        return out
    out["kind"] = "open_loop"
    if len(seg) < 10 or len(patterns) != 1:
        out.update(ok=False, why="too few frame records" if len(seg) < 10 else "more than one pattern in the step")
        return out
    n = a.frames
    steps = [((idx[i + 1] - idx[i] + n // 2) % n) - n // 2 for i in range(len(idx) - 1)]
    unwrapped = [0]
    for d in steps:
        unwrapped.append(unwrapped[-1] + d)
    fps = slope(ts, unwrapped)
    dts = [1e3 * (ts[i + 1] - ts[i]) for i in range(len(ts) - 1)]
    bad_steps = sum(1 for d in steps if d != 1)
    out.update(frames_per_s=round(fps, 3), not_plus_one_steps=bad_steps,
               cycle_s=round(n / fps, 4) if fps > 0 else None, osc_hz=round(fps / n, 5),
               cycles=round(unwrapped[-1] / n, 2),
               frame_interval_ms={"median": round(statistics.median(dts), 3), "min": round(min(dts), 3),
                                  "max": round(max(dts), 3)},
               ok=bad_steps == 0 and seen == n and abs(fps - a.fps) <= a.tol * a.fps)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="behavior_v2 run log (.jsonl / .jsonl.gz) with controller cf rows")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--fps", type=float, default=150.0, help="expected open-loop frames/s (default 150)")
    ap.add_argument("--frames", type=int, default=750, help="frames per open-loop pattern = one cycle (default 750)")
    ap.add_argument("--tol", type=float, default=0.01, help="relative tolerance on frames/s (default 0.01 = 1 %%)")
    ap.add_argument("--guard-ms", type=float, default=100.0, help="cut from both ends of a step (default 100)")
    ap.add_argument("--gap-s", type=float, default=0.5, help="without step events: pause that separates stimuli")
    a = ap.parse_args(argv)

    rows, steps = read_log(a.path)
    if not rows:
        print("no controller frame records (cf rows) in " + a.path, file=sys.stderr)
        return 2
    off = host_offset_ms(rows) if steps else None
    named = off is not None
    before = 0
    res = []
    if named:
        host = [r[0] * 1e3 + off for r in rows]
        before = sum(1 for h in host if h < steps[0][0] - 50.0)   # 50 ms: the offset is a bound, not exact
        for i, (rx, cond) in enumerate(steps):
            end = steps[i + 1][0] if i + 1 < len(steps) else float("inf")
            seg = [r for r, h in zip(rows, host) if rx + a.guard_ms <= h < end - a.guard_ms]
            if seg:
                res.append(analyze(seg, a, cond))
            elif OPEN_LOOP.match(cond):
                res.append({"condition": cond, "kind": "open_loop", "records": 0, "ok": False,
                            "why": "no frame records in this step"})
    else:
        res = [analyze(s, a) for s in by_pattern_and_pause(rows, a.gap_s)]
    judged = [r for r in res if r["ok"] is not None]
    ok = bool(judged) and all(r["ok"] for r in judged)

    if a.json:
        print(json.dumps({"file": a.path, "ok": ok, "records": len(rows), "records_before_run": before,
                          "steps_named": named, "stimuli": res}, indent=1))
        return 0 if ok else 1
    print(f"{a.path}: {len(rows)} frame records, {len(res)} stimuli"
          + (f"; {before} records from before the run ignored" if before else "")
          + ("" if named else "; no runner step events with rx_ms: stimuli are not named, nothing ignored"))
    for i, r in enumerate(res, 1):
        v = {True: "PASS", False: "FAIL", None: "  - "}[r["ok"]]
        head = f"  {v} {i:2d}  {(r['condition'] or '-'):<16} {r['kind']:<11}"
        if r.get("records", 0) == 0 or "why" in r:
            print(f"{head}  {r.get('why', '')}")
        elif r["kind"] == "open_loop":
            fi = r["frame_interval_ms"]
            print(f"{head}  pattern {r['pattern']:<3} {r['seconds']:6.2f} s  {r['frames_per_s']:8.3f} frames/s, "
                  f"{r['frame_count_seen']} frames per cycle = {r['cycle_s']} s ({r['osc_hz']} Hz), {r['cycles']} cycles, "
                  f"steps other than +1: {r['not_plus_one_steps']}, interval {fi['median']} ms (min {fi['min']}, max {fi['max']})")
        elif r["kind"] == "closed_loop":
            print(f"{head}  pattern {r['pattern']}  {r['seconds']:6.2f} s  {r['records']} frame changes, "
                  f"{r['distinct_frames']} distinct frames (host-stepped, not judged)")
        else:
            print(f"{head}  pattern {r['pattern']}  {r['records']} records, frame count seen {r['frame_count_seen']}")
    print("RESULT: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
