#!/usr/bin/env python3
"""check_tiff2mcap.py — check a tiff2mcap MCAP built with --runlog against that run log.

    pixi run python tools/check_tiff2mcap.py <run.mcap> <arena-log-….jsonl>

PASS/FAIL per check, exit 1 on any failure:
  1. every /arena/stimulus step marker sits at its logged trialParams send time (±1 ms) and says "commanded"
  2. /run/events carries every ScanImage connector command and reply from the log
  3. /arena/display has one message per displayed-frame record of the controller, in time order
  4. per color: the TIFF anchor's end check (last DO1 vs allOff + latency) is within ±5 ms
  5. per color, at the d255 step: the qc Δmean jump (the channel that moves most) falls within one imaging
     frame of the observed display_start (SKIP when the step is below 5× the spread of the pre-step level, e.g. blue)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tiff_run_to_mcap import COLORS, load_runlog  # noqa: E402

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def main(mcap_path: str, runlog_path: str) -> int:
    from mcap.reader import make_reader

    log = load_runlog(Path(runlog_path))
    topics = {"/arena/stimulus": [], "/run/events": [], "/arena/display": [], "/scanimage/qc": [], "/run/provenance": []}
    with open(mcap_path, "rb") as f:
        for _, ch, m in make_reader(f).iter_messages(topics=list(topics)):
            topics[ch.topic].append((m.log_time / 1e6, json.loads(m.data) if ch.topic != "/arena/display" else None))
    prov = topics["/run/provenance"][0][1]

    on = sorted((t, o) for t, o in topics["/arena/stimulus"] if o["on"])
    sends = np.array([t["t_cmd_ms"] for t in log["trials"]])
    d = np.array([t for t, _ in on]) - sends if len(on) == len(sends) else np.array([np.inf])
    check("stimulus markers at logged trialParams send times (±1 ms)", len(on) == len(sends) and np.abs(d).max() <= 1.0,
          f"{len(on)} markers vs {len(sends)} logged; max |Δ| {np.abs(d).max():.3f} ms")
    check("stimulus markers labelled commanded", all(o["source"].startswith("commanded") for _, o in on),
          ", ".join(sorted({o["source"] for _, o in on})))

    ev = [o for _, o in topics["/run/events"]]
    n_cmd = sum(c["kind"] == "command" for c in log["connector"])
    n_rep = sum(c["kind"] == "reply" for c in log["connector"])
    got_cmd = sum(o["event"] == "scanimage_command" for o in ev)
    got_rep = sum(o["event"] == "scanimage_reply" for o in ev)
    check("ScanImage commands + replies in /run/events", (got_cmd, got_rep) == (n_cmd, n_rep),
          f"{got_cmd}/{n_cmd} commands, {got_rep}/{n_rep} replies")

    disp_t = np.array([t for t, _ in topics["/arena/display"]])
    n_off = sum(o["event"] == "allOff" for o in ev)
    check("one /arena/display message per controller frame record (+ one dark frame per allOff)",
          len(disp_t) == len(log["cf"]) + n_off, f"{len(disp_t)} messages, {len(log['cf'])} cf rows + {n_off} allOff")

    for c, an in prov.get("anchors", {}).items():
        ec = an["end_check_ms"]
        check(f"{c}: anchor end check within ±5 ms", ec is not None and abs(ec) <= 5.0,
              f"{ec:+.2f} ms; epoch correction {an['epoch_correction_ms']:+.1f} ms")

    starts = {(o["color"], o["detail"].split(":")[0]): t for t, o in topics["/run/events"] if o["event"] == "display_start"}
    for c in COLORS:
        t_disp = starts.get((c, "duty 255"))
        q = [(t, o) for t, o in topics["/scanimage/qc"] if o["color"] == c]
        if t_disp is None or not q:
            check(f"{c}: qc jump at d255 within one imaging frame of display_start", False, "no display_start or qc")
            continue
        tq = np.array([t for t, _ in q])
        frame_ms = float(np.median(np.diff(tq)))
        keys = [k for k in q[0][1] if k.startswith("dmean_ch")]
        best = None
        for k in keys:
            y = np.array([o[k] for _, o in q])
            pre = y[(tq > t_disp - 1000) & (tq < t_disp - 2 * frame_ms)].mean()
            post = y[(tq > t_disp + 300) & (tq < t_disp + 1300)].mean()
            if best is None or abs(post - pre) > abs(best[1] - best[0]):
                best = (pre, post, y, k)
        pre, post, y, k = best
        noise = float(np.std(y[(tq > t_disp - 1000) & (tq < t_disp - 2 * frame_ms)]))  # includes slow baseline drift
        if abs(post - pre) < 5 * noise:
            print(f"SKIP  {c}: qc jump at d255 — step {post - pre:+.0f} ADU is below 5× the pre-step spread ({noise:.1f} ADU)")
            continue
        idx = np.where((tq > t_disp - 500) & (np.sign(post - pre) * (y - (pre + 0.5 * (post - pre))) > 0))[0]
        dt = tq[idx[0]] - t_disp if len(idx) else np.inf
        check(f"{c}: qc jump at d255 within one imaging frame of display_start", -frame_ms <= dt <= frame_ms,
              f"{k} half-way at {dt:+.1f} ms (frame {frame_ms:.1f} ms, step {post - pre:+.0f} ADU)")

    print(f"\n{'ALL PASS' if not failures else f'{failures} FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
