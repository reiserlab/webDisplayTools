#!/usr/bin/env python3
"""Offline tests for scripts/telemetry-report.py (SD-read cost / card-stall / trial-quality report).
Synthetic behavior_v2 fixture with controller rows, generated in a temp dir. Wired into `pixi run test`.

Run: python tests/test-telemetry-report.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "telemetry-report.py")
_spec = importlib.util.spec_from_file_location("telemetry_report", SCRIPT)
tr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tr)

total = 0
failures = 0


def check(name, got, expected):
    global total, failures
    total += 1
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, expected {expected!r}"))
    if not ok:
        failures += 1


def req70(idx):
    return "0370" + f"{idx & 0xff:02x}{idx >> 8:02x}"


def build_fixture(v2=True):
    """Two trials: pattern 36 (200 frames) with a stall cluster, pattern 5 clean."""
    lines = [{"type": "frame_schema", "level": "behavior_v2", "cols": ["ms"], "t0": 1000000},
             {"type": "log", "event": "run_metadata", "firmware": "200fada 2x10 2026-09-13 feat/sd-fastpath-2x10",
              "sd_card": {"label": "SanDisk SC32G 8.0 sn 1234abcd (2023-05) 32 GB SDHC/SDXC FAT32 32 KiB clusters"},
              "log_format": "behavior_v2", "telemetry": "ring-10hz", "ms": 1000000}]
    seq = [100]
    rx = [1000000]
    t_us = [5_000_000]

    def nxt(dt_ms=5):
        seq[0] += 1
        rx[0] += dt_ms
        t_us[0] += dt_ms * 1000
        return seq[0], rx[0], t_us[0]

    def cs(kind, code, arg):
        s, r, t = nxt()
        lines.append(["cs", r, t, s, kind, code, arg])

    def cc(idx, status=0):
        s, r, t = nxt()
        lines.append(["cc", r, t, s, 0x70, status, req70(idx)])

    def cf(idx, pattern, sd, age=4700, sup=0, flags=3):
        s, r, t = nxt()
        row = ["cf", r, t, s, idx, pattern, sd, 770]
        if v2:
            row += [age, sup, flags]
        lines.append(row)

    # trial 1: pattern 36
    cs(7, 0, 36)
    cs(11, 1, 8)
    cf(0, 36, 1978)                      # first-after-open
    idx = 0
    walk = [1] * 20 + [1, 1, -1, -1, 5, -5, 1, 1, 30, 1] * 5
    reads = 1
    for k, step in enumerate(walk):
        cc(idx)                          # repeated index → no read (v2 semantics)
        idx = (idx + step) % 200
        cc(idx)
        reads += 1
        sd = 620 if step == 1 else (1996 if step < 0 else (1461 if step < 10 else 1956))
        cf(idx, 36, sd, age=4700 if k != 30 else 12000, sup=1 if k == 30 else 0)
    # stall cluster: 33 / 41 / 67 ms, body phase, then contexts
    cs(4, 2, 330); cs(12, 0, 0)
    cs(4, 2, 412); cs(12, 0, 0)
    cs(4, 2, 671); cs(12, 0, 0)
    cf(idx + 1, 36, 67100, age=69000)
    cs(4, 2, 80)                          # 8 ms: slow by fw threshold, not over 10 ms
    cs(13, 0, reads + 1)
    # trial 2: pattern 5 (20 frames), clean, one repeated index
    cs(7, 0, 5)
    cs(11, 1, 8)
    cf(0, 5, 598)
    for k in range(1, 20):
        cc(k)
        cf(k, 5, 620)
    cc(19)
    cs(13, 0, 20)
    lines.append({"type": "session", "event": "logging_stopped", "ms": rx[0]})
    return lines


def write(lines, path):
    with open(path, "w") as f:
        for ln in lines:
            f.write(json.dumps(ln, separators=(",", ":")) + "\n")


with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "fixture.jsonl")
    write(build_fixture(), p)
    rep = tr.analyze_file(p)

    print("=== meta ===")
    check("firmware", rep["meta"]["firmware"].startswith("200fada"), True)
    check("sd_card label", rep["meta"]["sd_card"].startswith("SanDisk"), True)

    print("=== reads accounting ===")
    r36 = rep["reads"][36]
    check("pattern 36 accepted cmds", r36["cmds70"], 2 * 70)
    check("pattern 36 index changes (initial index not a change)", r36["index_changes"], 70)
    check("pattern 36 fw reads", r36["reads_fw"], 72)
    check("idx changes per cmd", r36["index_changes_per_cmd"], 0.5)
    check("layout contiguous", r36["layout"], {"contiguous": True, "exfat": False, "sectors_per_cluster": 8})
    check("pattern 5 index changes (repeat not counted)", rep["reads"][5]["index_changes"], 19)

    print("=== step classes ===")
    sc = rep["step_cost_us"][36]
    check("+1 median", sc["+1"]["p50"], 620)
    check("-1 median", sc["-1"]["p50"], 1996)
    check("+2..9 median", sc["+2..9"]["p50"], 1461)
    check("jump median", sc["jump>=10"]["p50"], 1956)
    check("first-after-open", sc["first-after-open"]["n"], 1)

    print("=== stalls ===")
    st = rep["stalls"]
    check("slow reads total (incl. 8 ms)", st["slow_reads_total"], 4)
    check("over threshold", st["over_threshold"], 3)
    check("one cluster", st["clusters"], 1)
    check("cluster ms", st["cluster_rows"][0]["ms"], [33, 41.2, 67.1])
    check("cluster phases", st["cluster_rows"][0]["phases"], ["body", "body", "body"])
    check("cluster trial/pattern", (st["cluster_rows"][0]["trial"], st["cluster_rows"][0]["pattern"]), (1, 36))
    check("duration hist", st["duration_hist_ms"], {33: 1, 41: 1, 67: 1})

    print("=== presentation ===")
    pr = rep["presentation"]
    check("v2 frames counted", pr["v2_frames"] > 80, True)
    check("req_age over threshold", pr["req_age_us"]["over_threshold"], 2)   # 12 ms + 69 ms
    check("req_age max", pr["req_age_us"]["max"], 69000)
    check("superseded frames", pr["superseded_frames"], 1)
    check("contiguous share", pr["contiguous_share"], 1.0)

    print("=== trials ===")
    t = rep["trials"]
    check("two trials", len(t), 2)
    check("statuses", [x["status"] for x in t], ["fail", "pass"])
    check("trial 1 stalls / age gaps / max read", (t[0]["stalls"], t[0]["age_gaps"], t[0]["max_read_ms"]), (3, 2, 67.1))
    check("trial 1 reads_fw", t[0]["reads_fw"], 72)
    check("trial 2 clean", (t[1]["stalls"], t[1]["slow_reads"], t[1]["cmds70"]), (0, 0, 20))
    check("flagged", rep["flagged_trials"], [1])

    print("=== v1 rows (no extras) ===")
    p1 = os.path.join(d, "v1.jsonl")
    write(build_fixture(v2=False), p1)
    rep1 = tr.analyze_file(p1)
    check("v1: no presentation fields", rep1["presentation"]["v2_frames"], 0)
    check("v1: stalls still classify the trial", rep1["trials"][0]["status"], "fail")

    print("=== CLI ===")
    out = subprocess.run([sys.executable, SCRIPT, "--json", p], capture_output=True, text=True)
    check("--json exit 0", out.returncode, 0)
    check("--json parses", json.loads(out.stdout)[0]["stalls"]["clusters"], 1)
    md = subprocess.run([sys.executable, SCRIPT, p], capture_output=True, text=True)
    check("markdown mentions clusters", "1 clusters" in md.stdout, True)
    bad = subprocess.run([sys.executable, SCRIPT, os.path.join(d, "missing.jsonl")], capture_output=True, text=True)
    check("missing file → 2", bad.returncode, 2)

print(f"\n{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
