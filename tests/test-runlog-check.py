#!/usr/bin/env python3
"""tests/test-runlog-check.py — regression checks for scripts/runlog-check.py (standalone, no pytest).

Covers the three false alarms from the 2026-09-15 lab day: soak-driver header fragments (no run → SKIP, not FAIL),
a controller-fault run whose post-mortem ring dump lands after trial_quality (allowed), and session-cumulative
drainer counters (per-file deltas across the files of one session)."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "runlog-check.py")
T0 = 1789480000000
fails = 0

def check(name, got, exp):
    global fails
    ok = got == exp
    fails += 0 if ok else 1
    print(("  PASS  " if ok else "  FAIL  ") + f"{name}: got {got!r}, expected {exp!r}")

def a_row(t, idx):
    return ["a", t, 3, "037000%02x00" % (idx & 0xff), 0, t + 3]

def cc_row(t, seq, cmd=0x70, status=0):
    return ["cc", T0 + t, 1000 * t, seq, cmd, status, ""]

def meta(run_id):
    return {"type": "log", "event": "run_metadata", "run_id": run_id, "rig_id": "benchT", "log_format": "behavior_v2",
            "firmware": "781efe2b 2x10 test", "sd_card": {"label": "card", "sd_diag": 0}, "rx_ms": T0}

def schema():
    return {"type": "log", "event": "stream_schema", "streams": {"cc": {"cols": ["rx", "t_us", "seq", "cmd", "status", "req"]}}}

def tq(counts, flagged=()):
    return {"type": "log", "event": "trial_quality", "counts": counts, "flagged_trials": list(flagged), "trials": []}

def iter_end(records, gaps, errors, outcome="ok", fault=None):
    return {"type": "log", "event": "soak", "phase": "iteration-end", "iteration": 1, "outcome": outcome, "fault": fault,
            "telemetry": {"records": records, "gaps": gaps, "dropped": 0, "errors": errors, "notStored": 0}}

def write(dirn, name, rows):
    path = os.path.join(dirn, name)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return path

def run(paths):
    out = subprocess.run([sys.executable, SCRIPT, "--json"] + paths, capture_output=True, text=True)
    return out.returncode, json.loads(out.stdout)

def normal(run_id, n=50, records=1000, gaps=0, errors=0, counts=None):
    rows = [{"type": "session", "event": "logging_started", "ms": T0}, meta(run_id), schema()]
    for i in range(n):
        rows.append(a_row(10 * i, i)); rows.append(cc_row(10 * i, i))
    rows.append(iter_end(records, gaps, errors))
    rows.append(tq(counts or {"pass": 1, "fail": 0, "unknown": 0}))
    rows.append({"type": "session", "event": "logging_stopped", "ms": T0 + 10 * n})
    return rows

with tempfile.TemporaryDirectory() as d:
    print("=== header fragment: no run → SKIP, counted out of the denominator ===")
    frag = write(d, "arena-log-frag.jsonl", [
        {"type": "session", "event": "logging_started", "ms": T0},
        {"type": "log", "event": "soak", "phase": "start", "iterations": 3},
        {"type": "log", "event": "soak", "phase": "iteration-start", "iteration": 1},
        cc_row(1, 1, cmd=0xA9), cc_row(2, 2, cmd=0xA9),
        {"type": "session", "event": "logging_stopped", "ms": T0 + 3}])
    good = write(d, "arena-log-good.jsonl", normal("good1"))
    rc, res = run([frag, good])
    check("exit code 0", rc, 0)
    check("fragment skipped", bool(res[0].get("skipped")), True)
    check("fragment ok", res[0]["ok"], True)
    check("good file ok", res[1]["ok"], True)

    print("=== fault run: ring dump after trial_quality + unknown trial are expected, not failures ===")
    rows = [{"type": "session", "event": "logging_started", "ms": T0}, meta("fault1"), schema()]
    for i in range(20):
        rows.append(a_row(10 * i, i)); rows.append(cc_row(10 * i, i))
    rows.append({"type": "log", "event": "probe", "phase": "begin", "policy": "halt", "fault": {"reason": "link_dropped"}})
    rows.append(tq({"pass": 0, "fail": 0, "unknown": 1}))
    for i in range(20, 30):  # the post-reset ring dump lands AFTER the verdict
        rows.append(cc_row(10 * i, i))
    rows.append({"type": "log", "event": "probe", "phase": "end", "outcome": "self-reset"})
    rows.append(iter_end(2000, 1, 1, outcome="fault", fault="link_dropped"))
    fault = write(d, "arena-log-fault.jsonl", rows)
    rc, res = run([fault])
    check("fault detected", res[0].get("fault"), "post-mortem: link_dropped")
    check("ordering not a problem", any("BEFORE the last controller row" in p for p in res[0]["problems"]), False)
    check("unknown not a problem", any("unknown" in p for p in res[0]["problems"]), False)
    check("ordering noted", "note_order" in res[0], True)

    print("=== same fault file WITHOUT a fault marker → ordering IS a problem ===")
    rows2 = [r for r in rows if not (isinstance(r, dict) and r.get("event") == "probe")]
    rows2[-1] = iter_end(2000, 0, 0)
    nofault = write(d, "arena-log-nofault.jsonl", rows2)
    rc, res = run([nofault])
    check("ordering flagged", any("BEFORE the last controller row" in p for p in res[0]["problems"]), True)

    print("=== drainer counters are session-cumulative → per-file deltas ===")
    f1 = write(d, "arena-log-s1.jsonl", normal("s1", records=1000, gaps=1, errors=2))
    f2 = write(d, "arena-log-s2.jsonl", normal("s2", records=2000, gaps=1, errors=2))
    f3 = write(d, "arena-log-s3.jsonl", normal("s3", records=3000, gaps=2, errors=2))
    rc, res = run([f1, f2, f3])
    check("first file carries the session total", sorted(p for p in res[0]["problems"] if p.startswith("drainer")),
          ["drainer errors +2 in this file (session total; first file checked)", "drainer gaps +1 in this file (session total; first file checked)"])
    check("second file: no new counts → clean", res[1]["problems"], [])
    check("third file: +1 gap only", res[2]["problems"], ["drainer gaps +1 in this file"])
    check("a new session (records reset) restarts the baseline",
          run([f3, write(d, "arena-log-t1.jsonl", normal("t1", records=10, gaps=1, errors=0))])[1][1]["problems"],
          ["drainer gaps +1 in this file (session total; first file checked)"])

    print("=== flagged trial still fails, sd_diag arm still fails ===")
    fl = write(d, "arena-log-flag.jsonl", normal("fl", counts={"pass": 0, "fail": 1, "unknown": 0}))
    rc, res = run([fl]); check("flagged → FAIL", (rc, res[0]["ok"]), (1, False))
    rows = normal("arm"); rows[1]["sd_card"]["sd_diag"] = 3
    arm = write(d, "arena-log-arm.jsonl", rows)
    rc, res = run([arm]); check("arm 3 → FAIL", any("sd_diag arm 3" in p for p in res[0]["problems"]), True)

print(f"\n{'OK' if not fails else 'FAILED'}: {fails} failing check(s)")
sys.exit(1 if fails else 0)
