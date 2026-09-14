#!/usr/bin/env python3
"""Offline tests for scripts/wedge-scan.py (firmware issue #50 Mode-3 wedge
analyzer), wired into `pixi run test`. Synthetic fixtures are generated in a
temp dir at test time (nothing large is committed):
  (a) healthy behavior_v2 run, 2,000 0x70 rows at dt 2–4 ms          → clean
  (b) behavior_v2 wedge: 800 OK, 20 timeouts, runner error 0x8, abort → wedge
  (c) (b) as behavior_v1 objects, gzipped                             → wedge
  (d) one isolated timeout mid-run, then recovery                     → isolated
  (e) truncated last line                                             → incomplete
  (f) Arena Studio .runlog.json envelope                              → no-arena-rows
  plus: empty file, garbage line in an otherwise complete run, spaced-out
  timeouts that must NOT confirm an onset, a SYSTEM_RESET row, a hi-byte frame
  index, and the --json CLI path.

Run: python tests/test-wedge-scan.py
"""
import gzip
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "wedge-scan.py")

# import a hyphenated filename by path
_spec = importlib.util.spec_from_file_location("wedge_scan", SCRIPT)
ws = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ws)

total = 0
failures = 0


def check(name, got, expected):
    global total, failures
    total += 1
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, expected {expected!r}"))
    if not ok:
        failures += 1


def approx(name, got, expected, tol=0.2):
    global total, failures
    total += 1
    ok = got is not None and abs(got - expected) <= tol
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got {got}, expected {expected}")
    if not ok:
        failures += 1


# ── fixture builders ─────────────────────────────────────────────────────────
T0 = 1_789_000_000_000  # epoch ms
DIR = "browser→bridge"


def hex70(index):
    return f"0370{index & 0xFF:02x}{(index >> 8) & 0xFF:02x}"


def head_v1(hexs):
    return " ".join(hexs[i : i + 2] for i in range(0, len(hexs), 2))


def header(level, run_id="testrun1", rig="benchT", proto="soak.yaml"):
    lines = [
        {"type": "session", "event": "logging_started", "file": "arena-log-x.jsonl", "ms": T0},
    ]
    if level == "behavior_v2":
        lines.append({"type": "frame_schema", "level": "behavior_v2", "cols": ["ms", "fc", "idx", "ft", "x", "y", "hd"], "arena_cols": ["t_off", "dt", "hex", "status", "rx_off"], "t0": T0})
    else:
        lines.append({"type": "frame_schema", "level": "behavior_v1", "cols": ["ms", "fc", "idx", "ft", "x", "y", "hd"]})
    lines.append({"type": "log", "event": "run_metadata", "rig_id": rig, "run_id": run_id, "protocol_filename": proto, "arena_config": "G6_2x10", "tool_version": "Arena Studio v0.75", "dir": DIR, "rx_ms": T0})
    lines.append({"type": "log", "event": "runner", "phase": "sequence-start", "total": 3, "dir": DIR, "rx_ms": T0})
    return lines


def arena(level, t_off, dt, hexs, status, error=None):
    """One arena echo in the requested level (v2 compact array or v1 object)."""
    if level == "behavior_v2":
        arr = ["a", t_off, dt, hexs, status, t_off + dt]
        if error is not None:
            arr.append(error)
        return arr
    parts = head_v1(hexs)
    return {
        "type": "log",
        "event": "arena_command",
        "t": T0 + t_off,
        "dt": dt,
        "len": len(hexs) // 2,
        "head": parts,
        "status": status,
        "echo": None if status is None else int(hexs[2:4], 16),
        "ok": None if status is None else status == 0,
        "error": error,
        "dir": DIR,
        "rx_ms": T0 + t_off + dt,
    }


def frame(ms, fc, idx):
    return [ms, fc, idx, float(ms), 0.1, 0.2, 0.3]


def timeout_err(op=0x70):
    return f"response timeout after 500 ms (cmd 0x{op:x})"


def terminal(t_off, phase="sequence-complete"):
    return [
        {"type": "log", "event": "runner", "phase": phase, "dir": DIR, "rx_ms": T0 + t_off},
        {"type": "session", "event": "logging_stopped", "ms": T0 + t_off},
    ]


def build_healthy(level, n=2000, step_ms=10):
    lines = header(level)
    t = 0
    for i in range(n):
        lines.append(frame(t, 1000 + i, i % 200))
        lines.append(arena(level, t, 2 + (i % 3), hex70(i % 200), 0))
        t += step_ms
    lines += terminal(t)
    return lines


def build_wedge(level, n_ok=800, n_timeouts=20, onset_index=0, step_ms=10):
    lines = header(level, run_id="wedgerun")
    t = 0
    for i in range(n_ok):
        lines.append(frame(t, 1000 + i, i % 20))
        lines.append(arena(level, t, 2 + (i % 3), hex70(i % 20), 0))
        t += step_ms
    onset_line = None
    for j in range(n_timeouts):
        dt = 500 + (j % 10)
        idx = onset_index if j == 0 else (onset_index + j) % 20
        lines.append(frame(t, 2000 + j, idx))
        lines.append(arena(level, t, dt, hex70(idx), None, timeout_err()))
        if j == 0:
            onset_line = len(lines)  # 1-based line number of the row just appended
        t += dt
    lines.append({"type": "log", "event": "runner", "phase": "error", "index": 1, "reason": "send failed: " + timeout_err(0x8), "condition": "cl", "error": timeout_err(0x8), "dir": DIR, "rx_ms": T0 + t})
    lines += terminal(t + 1, phase="aborted")
    return lines, onset_line, t


def build_declared_fault(level, n=300, step_ms=10):
    """Rejects (status 1) trip the live detector; the runner declares the fault;
    no timeouts at all — must NOT come out `clean`. Also a bare ["cc"] row."""
    lines = header(level)
    for i in range(n):
        lines.append(arena(level, i * step_ms, 3, hex70(i % 200), 1 if i % 5 == 0 else 0))
    lines.append(["cc"])  # malformed telemetry row — dropped, counted, never a crash
    lines.append(["cf", T0 + n * step_ms, 5000, 1, 7, 36, 129000, 812])
    lines.append({"type": "log", "event": "runner", "phase": "aborted", "summary": {"fault": "controller_unresponsive", "aborted": True}, "dir": DIR, "rx_ms": T0 + n * step_ms})
    lines.append({"type": "session", "event": "logging_stopped", "ms": T0 + n * step_ms})
    return lines


def build_isolated(level, n=600, at=300, gaps=(300,)):
    """OK rows with single timeouts at the given positions (each recovers)."""
    lines = header(level, run_id="isolated")
    t = 0
    for i in range(n):
        if i in gaps:
            lines.append(arena(level, t, 503, hex70(i % 200), None, timeout_err()))
            t += 503
        else:
            lines.append(arena(level, t, 3, hex70(i % 200), 0))
            t += 10
    lines += terminal(t)
    return lines


def write_ndjson(path, lines, gz=False, truncate_last=False, extra_raw=None):
    text = "\n".join(json.dumps(x, separators=(",", ":")) for x in lines) + "\n"
    if truncate_last:
        text = text[: -(len(text.splitlines()[-1]) // 2 + 1)]  # chop mid-way through the last line
    if extra_raw is not None:
        text = extra_raw
    data = text.encode("utf-8")
    if gz:
        with gzip.open(path, "wb") as f:
            f.write(data)
    else:
        with open(path, "wb") as f:
            f.write(data)
    return path


def scan(path, **kw):
    return ws.scan_file(path, kw.get("window", ws.DEFAULT_WINDOW), kw.get("min_followers", ws.DEFAULT_MIN_FOLLOWERS))


with tempfile.TemporaryDirectory() as d:
    def p(name):
        return os.path.join(d, name)

    # (a) healthy v2 ──────────────────────────────────────────────────────
    print("=== (a) healthy behavior_v2, 2,000 x 0x70 at dt 2-4 ms ===")
    r = scan(write_ndjson(p("soak__tester__2026-09-11T10-00-00__abc12345.jsonl"), build_healthy("behavior_v2")))
    check("outcome clean", r["outcome"], "clean")
    check("format", r["format"], "behavior_v2")
    check("cmd70_ok 2000", r["cmd70_ok"], 2000)
    check("cmd70_total 2000", r["cmd70_total"], 2000)
    check("rtt median 3", r["rtt_median_ms"], 3)
    check("rtt p99 4", r["rtt_p99_ms"], 4)
    check("no non-zero status", r["nonzero_status"], 0)
    check("no isolated timeouts", r["isolated_timeouts"], 0)
    check("no onset", (r["onset_line"], r["onset_index"], r["onset_elapsed_s"]), (None, None, None))
    check("run_id from run_metadata", r["run_id"], "testrun1")
    check("bench from run_metadata rig_id", r["bench"], "benchT")
    check("protocol from run_metadata", r["protocol"], "soak.yaml")
    approx("duration ~20 s", r["duration_s"], 20.0, tol=0.3)
    check("frames counted", r["frames"], 2000)
    check("bad_lines 0", r["bad_lines"], 0)
    check("soft degrade none", r["slow_before"], "dt>50ms before onset: 0")
    check("terminal seen", r["terminal"], "sequence-complete")

    # (b) wedge v2 ────────────────────────────────────────────────────────
    print("=== (b) behavior_v2 wedge: 800 OK, 20 timeouts, runner error 0x8, aborted ===")
    lines, onset_line, t_end = build_wedge("behavior_v2", onset_index=0)
    r = scan(write_ndjson(p("wedge.jsonl"), lines))
    check("outcome wedge", r["outcome"], "wedge")
    check("onset 0x70 count before = 800", r["onset_cmd70_count"], 800)
    check("cmd70_ok = 800 (none OK after)", r["cmd70_ok"], 800)
    check("cmd70_total = 820", r["cmd70_total"], 820)
    check("onset index 0", r["onset_index"], 0)
    check("onset line", r["onset_line"], onset_line)
    approx("onset elapsed 8.0 s", r["onset_elapsed_s"], 8.0)
    check("timeouts after onset = 19", r["timeouts_after"], 19)
    check("isolated 0", r["isolated_timeouts"], 0)
    check("first non-0x70 fail = TRIAL_PARAMS via runner", r["first_non70_fail"], "TRIAL_PARAMS (0x08) via runner:error")
    check("rtt stats are pre-onset only (median 3, p99 4)", (r["rtt_median_ms"], r["rtt_p99_ms"]), (3, 4))
    check("runner error surfaced", len(r["runner_errors"]), 1)
    check("terminal aborted", r["terminal"], "aborted")
    check("verbose context has the onset marker", any("<<< ONSET" in c for c in r["_context"]), True)
    check("context has 5 rows before onset", sum(1 for c in r["_context"] if "status 0" in c), 5)
    check("run_id", r["run_id"], "wedgerun")

    # (c) wedge v1, gzipped ───────────────────────────────────────────────
    print("=== (c) same wedge as behavior_v1 objects, gzipped ===")
    lines, onset_line, _ = build_wedge("behavior_v1", onset_index=7)
    r = scan(write_ndjson(p("wedge_v1.jsonl.gz"), lines, gz=True))
    check("outcome wedge", r["outcome"], "wedge")
    check("format behavior_v1", r["format"], "behavior_v1")
    check("onset 0x70 count before = 800", r["onset_cmd70_count"], 800)
    check("onset index 7", r["onset_index"], 7)
    check("onset line", r["onset_line"], onset_line)
    approx("onset elapsed 8.0 s", r["onset_elapsed_s"], 8.0)
    check("timeouts after 19", r["timeouts_after"], 19)
    check("first non-0x70 fail", r["first_non70_fail"], "TRIAL_PARAMS (0x08) via runner:error")
    check("rtt median 3", r["rtt_median_ms"], 3)

    # (d) isolated timeout ────────────────────────────────────────────────
    print("=== (d) one isolated timeout mid-run, recovered ===")
    r = scan(write_ndjson(p("isolated.jsonl"), build_isolated("behavior_v2")))
    check("outcome isolated", r["outcome"], "isolated")
    check("isolated_timeouts 1", r["isolated_timeouts"], 1)
    check("no onset", r["onset_line"], None)
    check("cmd70_ok 599", r["cmd70_ok"], 599)
    check("cmd70_total 600", r["cmd70_total"], 600)

    print("=== (d2) three timeouts spaced > window apart: still isolated, not a wedge ===")
    r = scan(write_ndjson(p("isolated3.jsonl"), build_isolated("behavior_v1", gaps=(100, 200, 400))))
    check("outcome isolated", r["outcome"], "isolated")
    check("isolated_timeouts 3", r["isolated_timeouts"], 3)

    print("=== (d3) two adjacent timeouts (only 1 follower) then recovery: isolated x2 ===")
    r = scan(write_ndjson(p("isolated2adj.jsonl"), build_isolated("behavior_v2", gaps=(100, 101))))
    check("outcome isolated", r["outcome"], "isolated")
    check("isolated_timeouts 2", r["isolated_timeouts"], 2)

    print("=== (d4) three adjacent timeouts then recovery: that IS an onset ===")
    r = scan(write_ndjson(p("three_adj.jsonl"), build_isolated("behavior_v2", gaps=(100, 101, 102))))
    check("outcome wedge", r["outcome"], "wedge")
    check("onset count before 100", r["onset_cmd70_count"], 100)
    check("timeouts after 2", r["timeouts_after"], 2)

    # (e) truncated last line ─────────────────────────────────────────────
    print("=== (e) truncated last line ===")
    # a bridge killed mid-run: no terminal lines, and the last row cut in half
    r = scan(write_ndjson(p("trunc.jsonl"), build_healthy("behavior_v2", n=300)[:-2], truncate_last=True))
    check("bad_lines 1", r["bad_lines"], 1)
    check("outcome incomplete (never clean)", r["outcome"], "incomplete")
    check("flags mention bad_lines and missing terminal", ("bad_lines=1" in " ".join(r["flags"]), "no-terminal-event" in r["flags"]), (True, True))
    check("rows before the cut still counted", r["cmd70_ok"], 299)

    print("=== (e2) garbage line inside an otherwise complete run ===")
    lines = build_healthy("behavior_v1", n=100)
    text = "\n".join(json.dumps(x, separators=(",", ":")) for x in lines[:50]) + "\n{this is not json\n" + "\n".join(json.dumps(x, separators=(",", ":")) for x in lines[50:]) + "\n"
    r = scan(write_ndjson(p("garbage.jsonl"), [], extra_raw=text))
    check("bad_lines 1", r["bad_lines"], 1)
    check("outcome incomplete, not clean", r["outcome"], "incomplete")
    check("terminal still seen", r["terminal"], "sequence-complete")

    print("=== (e3) empty file ===")
    r = scan(write_ndjson(p("empty.jsonl"), [], extra_raw=""))
    check("outcome incomplete", r["outcome"], "incomplete")
    check("cmd70 n/a", r["cmd70_ok"], ws.NA)

    # (f) Studio .runlog.json envelope ────────────────────────────────────
    print("=== (f) Arena Studio .runlog.json envelope ===")
    env = {
        "schema": "arena-studio-runlog/1",
        "intent": "experiment",
        "meta": {"run_id": "d1yatobd", "rig_id": "bench03", "protocol_filename": "fictrac-closed-loop-bias-disturbance-grating.yaml", "tool_version": "Arena Studio v0.71", "timestamp_start": "2026-09-11T19:40:07Z"},
        "events": [
            {"t_iso": "x", "t_offset_s": 0.0, "phase": "sequence-start", "total": 12},
            {"t_iso": "x", "t_offset_s": 0.1, "phase": "step-start", "index": 0},
            {"t_iso": "x", "t_offset_s": 79.9, "phase": "error", "index": 3, "reason": "send failed: response timeout after 500 ms (cmd 0x8)"},
            {"t_iso": "x", "t_offset_s": 80.2, "phase": "aborted"},
        ],
        "summary": {"completed": False, "aborted": True, "steps": 3, "errors": 1, "duration_s": 80.2, "outcome": "ABORTED_BY_USER"},
    }
    path = p("fictrac-closed-loop-bias-disturbance-grating__isabel__2026-09-11T19-40-07__d1yatobd.runlog.json")
    with open(path, "w") as f:
        json.dump(env, f, indent=1)
    r = scan(path)
    check("outcome no-arena-rows", r["outcome"], "no-arena-rows")
    check("format runlog.json", r["format"], "runlog.json")
    check("per-command stats n/a", (r["cmd70_ok"], r["rtt_median_ms"], r["isolated_timeouts"]), (ws.NA, ws.NA, ws.NA))
    check("run_id from meta", r["run_id"], "d1yatobd")
    check("bench from meta", r["bench"], "bench03")
    check("duration from summary", r["duration_s"], 80.2)
    check("studio outcome in flags", any("ABORTED_BY_USER" in f for f in r["flags"]), True)
    check("timeout error event surfaced", ("timeout" in (r["first_non70_fail"] or "").lower(), len(r["runner_errors"])), (True, 1))

    # (g) resets + hi-byte index ──────────────────────────────────────────
    print("=== (g) SYSTEM_RESET row + hi-byte frame index ===")
    lines = header("behavior_v2")
    lines.append(arena("behavior_v2", 0, 5, "0201", 0))  # [len=02, op=01] SYSTEM_RESET
    lines.append(arena("behavior_v2", 50, 4, "02e3", 1))  # GET_FIRMWARE_INFO refused (status 1)
    lines.append(arena("behavior_v2", 100, 3, hex70(300), 0))
    for k in range(3):
        lines.append(arena("behavior_v2", 200 + 500 * k, 500, hex70(300), None, timeout_err()))
    lines += terminal(2000, phase="aborted")
    r = scan(write_ndjson(p("reset.jsonl"), lines))
    check("resets 1", r["resets"], 1)
    check("resets flag", "resets=1" in r["flags"], True)
    check("hi-byte index 300 decoded", r["onset_index"], 300)
    check("onset with only 1 OK before", r["onset_cmd70_count"], 1)
    check("SYSTEM_RESET does not count as 0x70", r["cmd70_total"], 4)
    check("non-zero status counted + attributed", (r["nonzero_status"], r["nonzero_by_op"]), (1, {"GET_FIRMWARE_INFO (0xE3)": 1}))

    # (h) helpers ─────────────────────────────────────────────────────────
    print("=== (h) helpers ===")
    check("opcode_name 0x70", ws.opcode_name(0x70), "SET_FRAME_POSITION (0x70)")
    check("opcode_name unknown", ws.opcode_name(0x5A), "0x5A")
    check("normalize spaced head", ws._normalize_hex("03 70 bf 00"), "0370bf00")
    check("normalize compact hex", ws._normalize_hex("0370BF00"), "0370bf00")
    check("normalize truncated head keeps leading bytes", ws._normalize_hex("03 70 …"), "0370")
    check("normalize non-hex", ws._normalize_hex("zz"), None)
    check("filename meta", ws.meta_from_filename("/x/rig9/p3-full-led25__user__2026-09-08T22-35-50__8cz4yttn.jsonl")["run_id"], "8cz4yttn")
    check("filename meta bench", ws.meta_from_filename("/x/rig9/p3-full-led25__user__2026-09-08T22-35-50__8cz4yttn.jsonl")["bench"], "rig9")
    h = ws.DtHistogram()
    for v in [2, 2, 3, 3, 3, 4, 900, 9000]:
        h.add(v)
    check("histogram median", h.percentile(0.5), 3)
    check("histogram overflow bucket", h.percentile(1.0), ">=5000")
    check("histogram max", h.max, 9000)

    # (i) CLI --json over the whole temp dir ──────────────────────────────
    print("=== (i) CLI --json over a directory ===")
    # declared fault without timeouts + malformed telemetry row
    write_ndjson(p("declared.jsonl"), build_declared_fault("behavior_v2"))
    rd = scan(p("declared.jsonl"))
    check("declared fault → fault-declared (not clean)", rd["outcome"], "fault-declared")
    check("declared_fault reason kept", rd["declared_fault"], "controller_unresponsive")
    check("bare ['cc'] row dropped and counted", rd["ctl_malformed"], 1)
    check("well-formed cf row still decoded (sd max)", rd["ctl_sd_max_us"], 129000)

    out = subprocess.run([sys.executable, SCRIPT, "--json", d], capture_output=True, text=True)
    check("exit code 0", out.returncode, 0)
    rows = json.loads(out.stdout)
    check("one row per file in dir", len(rows), 13)
    check("no _context key without --verbose", any("_context" in r for r in rows), False)
    by = {r["file"]: r["outcome"] for r in rows}
    check("dir scan classifies wedge", by["wedge.jsonl"], "wedge")
    check("dir scan classifies gz wedge", by["wedge_v1.jsonl.gz"], "wedge")
    check("dir scan classifies envelope", by[os.path.basename(path)], "no-arena-rows")
    out2 = subprocess.run([sys.executable, SCRIPT, p("wedge.jsonl")], capture_output=True, text=True)
    check("markdown table has header + row", out2.stdout.count("| wedge.jsonl |"), 1)
    check("markdown footer labels dt honestly", "host-observed round trip" in out2.stdout, True)
    out3 = subprocess.run([sys.executable, SCRIPT, p("does-not-exist.jsonl")], capture_output=True, text=True)
    check("unopenable file → exit 2", out3.returncode, 2)

print("\n=== Summary ===")
print(f"{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
