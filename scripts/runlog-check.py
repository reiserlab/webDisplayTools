#!/usr/bin/env python3
"""runlog-check.py — completeness checks for Studio run logs (overnight test plan §2: L1, L2, L5, L7).

    pixi run python scripts/runlog-check.py soak-logs/arena-log-*.jsonl*  [--json]

Per file: run_metadata (firmware label, sd_card, sd_diag), stream_schema, trial_quality present and AFTER the last
controller row (v0.78 export ordering), controller-accepted 0x70 count vs host-accepted `a` rows, drainer stats from
the soak iteration-end event (dropped / gaps / notStored / errors), FicTrac rows per trial-second, display_gap ↔
trial_quality provenance. Exit 1 when any file fails a check. Standalone (no pytest), gzip-aware.
"""
import gzip, json, sys

def read(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield n, json.loads(line)
            except Exception:
                yield n, None

def check_file(path):
    c = {"file": path, "problems": []}
    meta = schema = tq = None; tq_line = 0; last_ctl_line = 0
    cc70 = a_ok = fictrac = malformed = 0
    trials_planned = 0; iter_end = None; gaps = []; trial_secs = 0.0
    for n, o in read(path):
        if o is None:
            malformed += 1; continue
        if isinstance(o, list):
            k = o[0]
            if isinstance(k, (int, float)):
                fictrac += 1
            elif k == "a":
                if o[4] == 0: a_ok += 1
            elif k in ("cc", "cf", "cs"):
                last_ctl_line = n
                if k == "cc" and len(o) > 5 and o[4] == 0x70 and o[5] == 0: cc70 += 1
            continue
        ev = o.get("event") or o.get("type")
        if ev == "run_metadata": meta = o
        elif ev == "stream_schema": schema = o
        elif ev == "trial_quality": tq = o; tq_line = n
        elif ev == "display_gap": gaps.append(o)
        elif ev == "soak" and o.get("phase") == "iteration-end": iter_end = o
        elif ev == "runner" and o.get("phase") in ("trial_start", "condition-start"):
            trials_planned += 1
        elif ev == "arena_command" and isinstance(o.get("head"), str) and " 03 " in o["head"][:12]:
            pass
    p = c["problems"]
    if not meta: p.append("no run_metadata")
    else:
        fw = (meta.get("firmware") or {}) if isinstance(meta.get("firmware"), dict) else {"label": meta.get("firmware")}
        c["firmware"] = fw.get("label") if isinstance(fw, dict) else fw
        c["sd_card"] = (meta.get("sd_card") or {}).get("label") if isinstance(meta.get("sd_card"), dict) else meta.get("sd_card")
        sdd = (meta.get("sd_card") or {}).get("sd_diag") if isinstance(meta.get("sd_card"), dict) else None
        if sdd not in (None, 0): p.append(f"sd_diag arm {sdd} recorded in run_metadata (production must be 0)")
    if not schema: p.append("no stream_schema")
    if not tq: p.append("no trial_quality event (export ordering / finalize did not run)")
    else:
        if tq_line < last_ctl_line: p.append(f"trial_quality at line {tq_line} BEFORE the last controller row at {last_ctl_line} (tail lost to the export)")
        counts = tq.get("counts") or {}
        c["verdicts"] = counts
        if counts.get("unknown"): p.append(f"{counts['unknown']} trial(s) unknown (coverage) — see reasons in the event")
        if counts.get("fail"): p.append(f"{counts['fail']} trial(s) flagged — display gaps")
        flagged = set(tq.get("flagged_trials") or [])
        for g in gaps:
            if g.get("trial") not in flagged: p.append(f"display_gap for trial {g.get('trial')} but that trial is not flagged")
    c["cc_0x70_ok"] = cc70; c["a_ok"] = a_ok
    if cc70 and a_ok and abs(cc70 - a_ok) > 2: p.append(f"controller-accepted 0x70 {cc70} vs host-accepted {a_ok} differ by {abs(cc70 - a_ok)} (a drain gap if a > cc; a second run in the same file if cc > a)")
    if iter_end and isinstance(iter_end.get("telemetry"), dict):
        t = iter_end["telemetry"]; c["drainer"] = {k: t.get(k) for k in ("dropped", "gaps", "notStored", "errors", "records")}
        # `dropped` is the controller's CUMULATIVE ring-overrun counter: records evicted while nobody drained —
        # normally the gap between runs (log closed → poller paused → 64 KiB ring full in ~8 s). It is a
        # problem only when it happens inside a trial, which trial-quality records as a `ring_overrun`
        # coverage gap (→ unknown). So: info here, verdicts decide.
        for k in ("gaps", "notStored", "errors"):
            if t.get(k): p.append(f"drainer {k} = {t[k]}")
        if t.get("dropped"): c["note"] = f"ring dropped {t['dropped']} records during the file (between runs unless a trial is unknown)"
    c["fictrac_rows"] = fictrac; c["malformed_lines"] = malformed
    if malformed: p.append(f"{malformed} malformed line(s)")
    if fictrac and cc70:
        # ≈ 200 Hz FicTrac vs 200 Hz commands during trials: the ratio should be near 1 (lower = FicTrac gaps)
        c["fictrac_per_cmd"] = round(fictrac / cc70, 2)
        if fictrac / cc70 < 0.8: p.append(f"FicTrac rows / commands = {fictrac / cc70:.2f} (< 0.8: behaviour stream gaps)")
    c["ok"] = not p
    return c

def main(argv):
    as_json = "--json" in argv
    files = [a for a in argv if not a.startswith("--")]
    if not files:
        print(__doc__); return 2
    out = [check_file(f) for f in files]
    if as_json:
        print(json.dumps(out, indent=1))
    else:
        for c in out:
            print(("OK   " if c["ok"] else "FAIL ") + c["file"])
            for k in ("firmware", "sd_card", "verdicts", "cc_0x70_ok", "a_ok", "drainer", "fictrac_per_cmd"):
                if k in c: print(f"      {k}: {c[k]}")
            for pr in c["problems"]: print("      ! " + pr)
        n_ok = sum(1 for c in out if c["ok"])
        print(f"\n{n_ok} / {len(out)} files complete")
    return 0 if all(c["ok"] for c in out) else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
