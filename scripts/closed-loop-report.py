#!/usr/bin/env python3
"""closed-loop-report.py — what the fly did versus what the arena showed, per closed-loop epoch.

Input: a bridge run log (.jsonl / .jsonl.gz, behavior_v1 or behavior_v2) from a FicTrac Mode-3 run —
a real fly, `fictrac_sim.py --replay`, or `fictrac_sim.py --model fly`. Stdlib only.

For every closed-loop epoch (runner `fictracApply` true → false; falls back to `bias_config`
pushes when the runner events are absent, e.g. Console-only use) it reports:

  * the condition name, bias waveform, coupling / display pitch and frame modulus in force;
  * the FLY: net heading change, mean and RMS angular velocity (deg/s), from the `hd` column
    unwrapped (FicTrac heading is CCW-positive: a positive net turn is a LEFT turn);
  * the DISPLAY: the feature's azimuth in the fly's view, az = wrap180(frame_dir·idx·dpf + az0),
    as mean |az|, the fraction of time it was frontal (|az| < 30°) and its circular mean — a
    fixating fly keeps |az| small; a mis-signed rig parks it near ±180°;
  * the BIAS: b(t) reconstructed analytically from the `bias_config` event + each row's `ms`, and
    REJECTION = −slope of unwrapped heading regressed on b(t) — 1.0 = the fly fully counter-turned
    the disturbance (display held still), 0 = ignored it, negative = followed it;
  * a CONSISTENCY check: `round((coupling · Δheading + offset + b)/deg_per_frame) mod frames` (bridge 3.3,
    unwrapped) — or `round((wrap180(hd − hd0) + b)/gain)` for older logs — vs the logged idx
    (the LAB-185 bench check — mismatches beyond ±1 frame mean the log and the mapping disagree).

Usage:
    python scripts/closed-loop-report.py run.jsonl.gz                 # markdown table
    python scripts/closed-loop-report.py --json run.jsonl.gz
    python scripts/closed-loop-report.py --svg out.svg run.jsonl.gz   # + one strip chart per epoch
    python scripts/closed-loop-report.py --frame-dir -1 --feature-az0 90 run.jsonl.gz

Exit 0; 2 on bad arguments.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sys

FRONTAL_DEG = 30.0
BIAS_TYPES = ("none", "constant", "sine", "square")


def wrap180(deg: float) -> float:
    return ((deg + 180.0) % 360.0) - 180.0


def bias_angle_deg(kind: str, amp_dps: float, freq_hz: float, t_s: float) -> float:
    """Mirror of fictrac-bridge/bridge.py bias_angle_deg (kept in sync by tests/test-fictrac-sim.py)."""
    if kind == "constant":
        return amp_dps * t_s
    if kind == "sine":
        w = 2.0 * math.pi * freq_hz
        return (amp_dps / w) * math.sin(w * t_s) if w else 0.0
    if kind == "square":
        if freq_hz == 0.0:
            return 0.0
        period = 1.0 / abs(freq_hz)
        quarter = period / 4.0
        peak = amp_dps * quarter
        phase = t_s % period
        if phase <= quarter:
            return amp_dps * phase
        if phase <= 3.0 * quarter:
            return peak - amp_dps * (phase - quarter)
        return -peak + amp_dps * (phase - 3.0 * quarter)
    return 0.0


def open_text(path: str):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def _num(v, default=None):
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else default


def parse_log(path: str) -> dict:
    """Rows + the events the report needs, all on the bridge's relative-ms timebase."""
    rows = []                # (ms, fc, idx, hd_deg)
    bias_events = []         # (ms, {type, amplitude, frequency})
    tares = []               # (ms, hd0_deg)
    configs = []             # (ms, {gain?, frames?})
    applies = []             # (ms, on: bool, condition)
    steps = []               # (ms, condition)
    t0 = None
    with open_text(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, list):
                if len(o) >= 7 and isinstance(o[0], (int, float)) and o[6] is not None:
                    rows.append((float(o[0]), int(o[1]), int(o[2]), math.degrees(float(o[6]))))
                continue
            if not isinstance(o, dict):
                continue
            typ = o.get("type")
            if typ == "frame_schema" and _num(o.get("t0")) is not None:
                t0 = _num(o.get("t0"))
            elif typ == "session" and o.get("event") == "logging_started" and t0 is None:
                t0 = _num(o.get("ms"))
            elif typ == "fictrac_frame" and isinstance(o.get("fictrac"), list) and len(o["fictrac"]) >= 17:
                f = o["fictrac"]
                rows.append((float(o.get("t", 0)), int(f[0]), int(o.get("index", 0)), math.degrees(float(f[16]))))
            elif typ == "bias_config" and isinstance(o.get("bias"), dict):
                bias_events.append((_num(o.get("ms"), 0.0), o["bias"]))
            elif typ == "heading_tare":
                tares.append((_num(o.get("ms"), 0.0), _num(o.get("hd0_deg"), 0.0)))
            elif typ == "config":
                rel = _rel(o.get("rx_ms"), t0)
                if rel is not None:
                    configs.append((rel, {k: o[k] for k in ("gain", "deg_per_frame", "coupling", "offset", "frames") if _num(o.get(k)) is not None}))
            elif typ == "log" and o.get("event") == "runner":
                rel = _rel(o.get("rx_ms"), t0)
                if rel is None:
                    continue
                if o.get("phase") == "command" and o.get("op") == "fictracApply":
                    applies.append((rel, bool(o.get("value")), o.get("condition")))
                elif o.get("phase") == "step-start":
                    steps.append((rel, o.get("condition")))
    return {"rows": rows, "bias": bias_events, "tares": tares, "configs": configs,
            "applies": applies, "steps": steps, "t0": t0}


def _rel(rx_ms, t0):
    rx = _num(rx_ms)
    if rx is None:
        return None
    return rx - t0 if t0 is not None else rx


def find_epochs(log: dict) -> list[dict]:
    """[{start_ms, end_ms, condition}] — from runner fictracApply events, else bias_config pairs."""
    epochs = []
    if log["applies"]:
        open_at = None
        cond = None
        for ms, on, c in log["applies"]:
            if on and open_at is None:
                open_at, cond = ms, c
            elif not on and open_at is not None:
                epochs.append({"start_ms": open_at, "end_ms": ms, "condition": cond})
                open_at = None
        if open_at is not None:
            last = log["rows"][-1][0] if log["rows"] else open_at
            epochs.append({"start_ms": open_at, "end_ms": last, "condition": cond})
        return epochs
    # Fallback: a non-none bias_config opens an epoch, the next bias_config closes it.
    open_at = None
    for ms, b in log["bias"]:
        if open_at is not None:
            epochs.append({"start_ms": open_at, "end_ms": ms, "condition": None})
            open_at = None
        if b.get("type", "none") != "none":
            open_at = ms
    if open_at is not None and log["rows"]:
        epochs.append({"start_ms": open_at, "end_ms": log["rows"][-1][0], "condition": None})
    return epochs


def _latest_before(items, ms, default=None, slack_ms=0.0):
    out = default
    for t, v in items:
        if t <= ms + slack_ms:
            out = v
        else:
            break
    return out


def _last_within(items, start_ms, end_ms, default=None):
    """The LAST (time, value) with start−50 ms ≤ time ≤ end — returns (time, value) or (None, default).

    Last, not first: the runner's stopClosedLoop pushes `bias: none` a few ms BEFORE the next
    startClosedLoop pushes the real waveform (both land inside the slack around the epoch start),
    and the bridge latches one heading tare per push. Taking the first would pair every epoch with
    the previous trial's `none` and a stale tare — exactly the 90 % idx-mismatch Isabel saw on the
    2026-09-21 bench logs.
    """
    hit = (None, default)
    for t, v in items:
        if t > end_ms:
            break
        if t >= start_ms - 50.0:
            hit = (t, v)
    return hit


def unwrap_deg(seq):
    out = []
    prev = None
    acc = 0.0
    for v in seq:
        if prev is not None:
            acc += wrap180(v - prev)
        out.append(acc)
        prev = v
    return out


def _ols_slope(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 1e-9:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx


def analyze_epoch(log: dict, ep: dict, deg_per_frame: float, frame_dir: int, az0: float) -> dict:
    rows = [r for r in log["rows"] if ep["start_ms"] <= r[0] <= ep["end_ms"]]
    cfg = {}
    for t, c in log["configs"]:
        if t <= ep["start_ms"] + 500.0:
            cfg.update(c)
    # bridge 3.3 logs carry `coupling` + `deg_per_frame` (unwrapped-heading mapping); older logs
    # carry only `gain` (= the pitch, wrapped-heading mapping, coupling 1).
    coupling = _num(cfg.get("coupling"))
    pitch = _num(cfg.get("deg_per_frame")) or _num(cfg.get("gain"), 1.8)
    gain = pitch
    offset = _num(cfg.get("offset"), 0.0) or 0.0
    frames = int(_num(cfg.get("frames"), 200) or 200)
    dpf = deg_per_frame if deg_per_frame else abs(pitch)
    # The waveform + tare that govern this epoch = the LAST push in the window around its start
    # (see _last_within). Fall back to the latest push before the start (Console-only use).
    bias_t0, bias = _last_within(log["bias"], ep["start_ms"], ep["start_ms"] + 1500.0)
    if bias is None:
        bias_t0 = _latest_before([(t, t) for t, _ in log["bias"]], ep["start_ms"], ep["start_ms"])
        bias = _latest_before(log["bias"], ep["start_ms"], {"type": "none", "amplitude": 0.0, "frequency": 0.0})
    _, hd0 = _last_within(log["tares"], ep["start_ms"], ep["start_ms"] + 1500.0)
    if hd0 is None:
        _, hd0 = _last_within(log["tares"], ep["start_ms"], ep["end_ms"])
    out = {
        "condition": ep.get("condition"), "start_s": round(ep["start_ms"] / 1000.0, 2),
        "duration_s": round((ep["end_ms"] - ep["start_ms"]) / 1000.0, 2), "rows": len(rows),
        "gain": gain, "deg_per_frame": pitch, "coupling": coupling, "frames": frames, "bias": bias,
        "hd0_deg": None if hd0 is None else round(hd0, 2),
    }
    if len(rows) < 3:
        out["note"] = "too few FicTrac rows"
        return out
    ms = [r[0] for r in rows]
    hd = [r[3] for r in rows]
    idx = [r[2] for r in rows]
    rel_hd = unwrap_deg(hd)
    dur_s = max((ms[-1] - ms[0]) / 1000.0, 1e-6)
    omegas = [(rel_hd[i] - rel_hd[i - 1]) / max((ms[i] - ms[i - 1]) / 1000.0, 1e-3) for i in range(1, len(rows))]
    az = [wrap180(frame_dir * i * dpf + az0) for i in idx]
    frontal = sum(1 for a in az if abs(a) < FRONTAL_DEG) / len(az)
    cm = math.degrees(math.atan2(sum(math.sin(math.radians(a)) for a in az), sum(math.cos(math.radians(a)) for a in az)))
    kind = str(bias.get("type", "none"))
    amp = _num(bias.get("amplitude"), 0.0) or 0.0
    freq = _num(bias.get("frequency"), 0.0) or 0.0
    b = [bias_angle_deg(kind, amp, freq, (m - bias_t0) / 1000.0) if kind != "none" and bias_t0 is not None else 0.0 for m in ms]
    out.update({
        "fly": {
            "net_turn_deg": round(rel_hd[-1], 1),
            "mean_omega_dps": round(rel_hd[-1] / dur_s, 2),
            "rms_omega_dps": round(math.sqrt(sum(w * w for w in omegas) / len(omegas)), 1),
        },
        "display": {
            "mean_abs_az_deg": round(sum(abs(a) for a in az) / len(az), 1),
            "frontal_fraction": round(frontal, 3),
            "circular_mean_az_deg": round(cm, 1),
            "idx_span": [min(idx), max(idx)],
        },
    })
    if kind != "none":
        slope = _ols_slope(b, rel_hd)
        out["bias_angle_end_deg"] = round(b[-1], 1)
        out["rejection"] = None if slope is None else round(-slope, 3)
    if hd0 is not None and pitch:
        mism = 0
        if coupling is None:
            # bridge <= 3.2: wrapped tared difference, coupling 1
            for h_, i_, b_ in zip(hd, idx, b):
                pred = round((wrap180(h_ - hd0) + offset + b_) / pitch) % frames
                d = (pred - i_) % frames
                if min(d, frames - d) > 1:
                    mism += 1
        else:
            # bridge 3.3: UNWRAPPED turn since the tare row x coupling; the bias is outside it
            tare_t = _last_within(log["tares"], ep["start_ms"], ep["start_ms"] + 1500.0)[0]
            i0 = next((i for i, m in enumerate(ms) if tare_t is not None and m >= tare_t), 0)
            rel_from_tare = [r - rel_hd[i0] for r in rel_hd]
            for r_, i_, b_ in zip(rel_from_tare, idx, b):
                pred = round((coupling * r_ + offset + b_) / pitch) % frames
                d = (pred - i_) % frames
                if min(d, frames - d) > 1:
                    mism += 1
        out["idx_mismatch_fraction"] = round(mism / len(rows), 4)
    out["_series"] = {"t": [(m - ms[0]) / 1000.0 for m in ms], "hd": rel_hd, "az": az, "b": b}
    return out


def analyze(path: str, deg_per_frame: float, frame_dir: int, az0: float) -> dict:
    log = parse_log(path)
    epochs = [analyze_epoch(log, ep, deg_per_frame, frame_dir, az0) for ep in find_epochs(log)]
    return {"file": os.path.basename(path), "fictrac_rows": len(log["rows"]), "epochs": epochs,
            "epoch_source": "runner fictracApply" if log["applies"] else "bias_config pushes"}


def _kpitch(e):
    """'k 0.75 · 1.8°/f' for bridge-3.3 logs, 'gain 1.8' (pitch, coupling 1) for older ones."""
    if e.get("coupling") is not None:
        return f"k {e['coupling']:g} · {e['deg_per_frame']:g}°/f"
    return f"gain {e['gain']:g}"


def _bias_label(b):
    k = b.get("type", "none")
    if k == "none":
        return "none"
    if k == "constant":
        return f"constant {b.get('amplitude', 0):g}°/s"
    return f"{k} {b.get('amplitude', 0):g}°/s @{b.get('frequency', 0):g} Hz"


def to_markdown(rep: dict) -> str:
    out = [f"# Closed-loop report — {rep['file']}", "",
           f"{rep['fictrac_rows']} FicTrac rows · {len(rep['epochs'])} closed-loop epoch(s) (from {rep['epoch_source']})", ""]
    if not rep["epochs"]:
        out.append("_no closed-loop epochs found_")
        return "\n".join(out)
    out.append("| # | condition | dur s | bias | coupling · °/frame | frames | fly net turn ° | fly ω mean / rms °/s | feature mean\\|az\\| ° | frontal | rejection | idx mismatch |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, e in enumerate(rep["epochs"], 1):
        if "fly" not in e:
            out.append(f"| {i} | {e.get('condition') or '—'} | {e['duration_s']} | {_bias_label(e['bias'])} | {_kpitch(e)} | {e['frames']} | — | — | — | — | — | {e.get('note', '')} |")
            continue
        rej = e.get("rejection")
        out.append(
            f"| {i} | {e.get('condition') or '—'} | {e['duration_s']} | {_bias_label(e['bias'])} | {_kpitch(e)} | {e['frames']} "
            f"| {e['fly']['net_turn_deg']:+} | {e['fly']['mean_omega_dps']:+} / {e['fly']['rms_omega_dps']} "
            f"| {e['display']['mean_abs_az_deg']} | {e['display']['frontal_fraction']:.0%} "
            f"| {'—' if rej is None else f'{rej:+.2f}'} "
            f"| {'—' if 'idx_mismatch_fraction' not in e else f'{e['idx_mismatch_fraction']:.2%}'} |"
        )
    out.append("")
    out.append("_rejection: −slope of unwrapped heading on the bias angle — 1 = fully counter-turned (display held), 0 = ignored, "
               "negative = followed. frontal: fraction of rows with the feature within ±30°. idx mismatch: logged frame vs "
               "round((coupling · Δheading + offset + bias) / deg_per_frame) mod frames (bridge 3.3, unwrapped) or round((wrap180(hd − hd0) + bias)/gain) (older logs), beyond ±1 frame._")
    return "\n".join(out)


def to_svg(rep: dict, width: int = 900, row_h: int = 150) -> str:
    """One strip chart per epoch: fly heading (blue), feature azimuth (green), bias angle (orange)."""
    eps = [e for e in rep["epochs"] if "_series" in e]
    h = 40 + row_h * max(1, len(eps))
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{h}" font-family="monospace" font-size="11">',
             '<rect width="100%" height="100%" fill="#0f1419"/>',
             f'<text x="10" y="18" fill="#e6edf3">{rep["file"]} — blue: fly heading (° rel., CCW+) · green: feature azimuth (° right+) · orange: bias angle (°)</text>']
    for k, e in enumerate(eps):
        y0 = 30 + k * row_h
        s = e["_series"]
        t = s["t"]
        tmax = max(t[-1], 1e-3)
        pl, pr, pt, pb = 60, width - 20, y0 + 16, y0 + row_h - 18
        lab = f"{k + 1}. {e.get('condition') or ''} {_bias_label(e['bias'])} {_kpitch(e)}"
        if e.get("rejection") is not None:
            lab += f" rejection {e['rejection']:+.2f}"
        lab += f" frontal {e['display']['frontal_fraction']:.0%}"
        parts.append(f'<text x="{pl}" y="{y0 + 12}" fill="#8b949e">{lab}</text>')
        parts.append(f'<line x1="{pl}" y1="{(pt + pb) / 2:.0f}" x2="{pr}" y2="{(pt + pb) / 2:.0f}" stroke="#2d3640"/>')
        parts.append(f'<rect x="{pl}" y="{pt}" width="{pr - pl}" height="{pb - pt}" fill="none" stroke="#2d3640"/>')

        def poly(vals, color, lo, hi):
            span = max(hi - lo, 1e-6)
            pts = " ".join(f"{pl + (pr - pl) * ti / tmax:.1f},{pb - (pb - pt) * (v - lo) / span:.1f}" for ti, v in zip(t, vals))
            parts.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="1"/>')

        hd, b = s["hd"], s["b"]
        lo = min(min(hd), min(b), -10.0)
        hi = max(max(hd), max(b), 10.0)
        poly(b, "#f0883e", lo, hi)
        poly(hd, "#58a6ff", lo, hi)
        poly(s["az"], "#00e676", -180.0, 180.0)
        parts.append(f'<text x="{pl - 55}" y="{pt + 10}" fill="#58a6ff">{hi:+.0f}°</text>')
        parts.append(f'<text x="{pl - 55}" y="{pb}" fill="#58a6ff">{lo:+.0f}°</text>')
        parts.append(f'<text x="{pr - 40}" y="{pb + 14}" fill="#8b949e">{tmax:.0f} s</text>')
        parts.append(f'<text x="{pr + 2}" y="{pt + 10}" fill="#00e676">+180</text>')
    parts.append("</svg>")
    return "\n".join(parts)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="+", help="run log(s), .jsonl or .jsonl.gz")
    p.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    p.add_argument("--svg", help="write strip charts (first file) to this SVG path")
    p.add_argument("--deg-per-frame", type=float, default=0.0, help="display degrees per frame index (default: |gain| from the log)")
    p.add_argument("--frame-dir", type=int, choices=(1, -1), default=1, help="+1: an index increase moves the feature right (default)")
    p.add_argument("--feature-az0", type=float, default=0.0, help="feature azimuth at frame 0, deg right = + (default 0)")
    args = p.parse_args(argv)
    for f in args.files:
        if not os.path.isfile(f):
            p.error(f"file not found: {f}")
    reps = [analyze(f, args.deg_per_frame, args.frame_dir, args.feature_az0) for f in args.files]
    if args.svg:
        with open(args.svg, "w", encoding="utf-8") as fh:
            fh.write(to_svg(reps[0]))
        print(f"[report] wrote {args.svg}", file=sys.stderr)
    for r in reps:
        for e in r["epochs"]:
            e.pop("_series", None)
    if args.json:
        print(json.dumps(reps if len(reps) > 1 else reps[0], indent=1))
    else:
        print("\n\n".join(to_markdown(r) for r in reps))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
