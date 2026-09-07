#!/usr/bin/env python3
"""Offline tests for fictrac-bridge/bridge.py — no sockets/WebSocket, wired into
`pixi run test`:
  1. behavior_v1_row(): the pure ns→ms timestamp normalization + column mapping the
     live scope AND the offline analysis dashboard depend on.
  2. behavior_v2 (docs/development/runlog-behavior-v2-plan.md Part 1): compact
     arena-echo encode/decode invariants, v1→v2→v1 round trip on real line samples
     (ok / status-1 reject / timeout / non-null error / unknown key → raise), the
     legacy no-schema path, LogWriter output per level, and the log_control /
     hello acknowledgements of the dispatcher.

Run: python tests/test-bridge-behavior.py
"""
import asyncio
import json
import os
import sys
import tempfile

# import bridge.py (lives in fictrac-bridge/, not on the default path)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fictrac-bridge"))
import bridge  # noqa: E402

total = 0
failures = 0


def check(name, got, expected):
    global total, failures
    total += 1
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, expected {expected!r}"))
    if not ok:
        failures += 1


def approx(name, got, expected, tol=1e-6):
    global total, failures
    total += 1
    ok = got is not None and abs(got - expected) <= tol
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got {got}, expected {expected}")
    if not ok:
        failures += 1


def rec(fc, x, y, hd, ts):
    """A 25-col FicTrac record with the behavior_v1 columns set (rest 0)."""
    a = [0.0] * 25
    a[0] = fc      # col 1  frame counter
    a[14] = x      # col 15 integrated x
    a[15] = y      # col 16 integrated y
    a[16] = hd     # col 17 heading
    a[21] = ts     # col 22 timestamp (camera hardware clock; ns on our rigs)
    return a


print("=== FT_TS_NS_PER_MS ===")
check("constant is 1e6 (ns per ms)", bridge.FT_TS_NS_PER_MS, 1_000_000.0)

print("=== behavior_v1_row: ns col-22 → ms ft ===")
# ~120.9 Hz: consecutive col-22 values 8_271_561 ns apart (= 8.271561 ms).
NS = 8_271_561
TS0 = 20_000_000_000_000  # absurdly large absolute ns (like the real rigs)
f0 = rec(fc=100, x=0.0, y=0.0, hd=0.0, ts=TS0)
f1 = rec(fc=101, x=0.01, y=-0.02, hd=0.03, ts=TS0 + NS)
f2 = rec(fc=102, x=0.02, y=-0.04, hd=0.06, ts=TS0 + 2 * NS)

# ft0 is the first frame's col-22 (the Pipeline sets it); pure fn does the math.
ft0 = f0[21]
b0 = bridge.behavior_v1_row(f0, index=5, rel_ms=0, ft0=ft0)
b1 = bridge.behavior_v1_row(f1, index=5, rel_ms=8, ft0=ft0)
b2 = bridge.behavior_v1_row(f2, index=5, rel_ms=16, ft0=ft0)

# bridge rounds ft to 3 decimals (µs) — 8.271561 → 8.272, 16.543122 → 16.543.
approx("first frame ft = 0 ms", b0["ft"], 0.0)
approx("second frame ft = 8.272 ms (ns→ms, µs-rounded)", b1["ft"], 8.272)
approx("third frame ft = 16.543 ms", b2["ft"], 16.543)
# The bug this guards against: treating ns as ms would give ~8.27e6, not ~8.27.
check("ft is milliseconds, not raw ns", b1["ft"] < 100, True)

print("=== behavior_v1_row: column mapping + fields ===")
check("fc from col 1", b1["fc"], 101)
check("idx passthrough", b1["idx"], 5)
check("ms passthrough (display axis)", b1["ms"], 8)
check("x from col 15", b1["x"], 0.01)
check("y from col 16", b1["y"], -0.02)
check("hd from col 17", b1["hd"], 0.03)

print("=== drop-safe: ft is an ABSOLUTE timestamp diff, not per-frame dt ===")
# A frame dropped before logging (f1 missing) — f2 still lands at the right ms,
# because ft is (col22 - ft0), not a sum of per-frame deltas (Frank, #143).
b2_after_drop = bridge.behavior_v1_row(f2, index=5, rel_ms=16, ft0=ft0)
approx("ft across a dropped frame = 16.543 ms", b2_after_drop["ft"], 16.543)

print("=== degenerate inputs ===")
# No col 22 (short record) → ft is None (not a crash / not 0).
short = [0.0] * 17
short[0] = 7
check("missing col-22 → ft None", bridge.behavior_v1_row(short, index=1, rel_ms=3, ft0=None)["ft"], None)
check("missing col-22 still maps hd", bridge.behavior_v1_row(short, index=1, rel_ms=3, ft0=None)["fc"], 7)


# ═════════════════════════════════════════════════════════════════════════════
# behavior_v2 — compact arena echo + round trip + ack (plan Part 1)
# ═════════════════════════════════════════════════════════════════════════════
def canon(o):
    return bridge.canonical_json(o)


def check_raises(name, fn, exc=bridge.RunlogFormatError):
    global total, failures
    total += 1
    try:
        fn()
    except exc:
        print(f"  PASS  {name} (raised {exc.__name__})")
        return
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL  {name} — raised {type(e).__name__}: {e}")
    else:
        print(f"  FAIL  {name} — did not raise")
    failures += 1


T0 = 1788636439304  # a real logging_started.ms (rig03-sr run rydc2tql)
# Real v1 lines (verbatim shapes from the course corpus; values trimmed).
A_OK = json.loads('{"type":"log","event":"arena_command","t":1788636442353,"dt":7,"len":4,"head":"03 70 2e 00","status":0,"echo":112,"ok":true,"error":null,"dir":"browser→bridge","rx_ms":1788636442360}')
A_REJECT = json.loads('{"type":"log","event":"arena_command","t":1788636442400,"dt":4,"len":4,"head":"03 70 31 00","status":1,"echo":112,"ok":false,"error":null,"dir":"browser→bridge","rx_ms":1788636442405}')
A_TIMEOUT = json.loads('{"type":"log","event":"arena_command","t":1788636442467,"dt":505,"len":4,"head":"03 70 a6 00","status":null,"echo":null,"ok":null,"error":"response timeout after 500 ms (cmd 0x70)","dir":"browser→bridge","rx_ms":1788636442972}')
# Synthetic: a decoded reply AND an error string (not seen in the corpus; must survive).
A_ERR_WITH_STATUS = dict(A_REJECT, error="post-decode warning", t=1788636442500, rx_ms=1788636442504)
A_OTHER_CMD = json.loads('{"type":"log","event":"arena_command","t":1788636442600,"dt":9,"len":4,"head":"03 a0 01 00","status":0,"echo":160,"ok":true,"error":null,"dir":"browser→bridge","rx_ms":1788636442610}')

print("=== behavior_v2: compact_arena_command / expand_arena_command ===")
check("ok line → 6-element array", bridge.compact_arena_command(A_OK, T0), ["a", 3049, 7, "03702e00", 0, 3056])
check("status-1 reject → status kept", bridge.compact_arena_command(A_REJECT, T0)[4], 1)
arr_to = bridge.compact_arena_command(A_TIMEOUT, T0)
check("timeout → status null + error as 7th element", arr_to, ["a", 3163, 505, "0370a600", None, 3668, "response timeout after 500 ms (cmd 0x70)"])
check("error with status → 7 elements", len(bridge.compact_arena_command(A_ERR_WITH_STATUS, T0)), 7)
for name, o in [("ok", A_OK), ("reject", A_REJECT), ("timeout", A_TIMEOUT), ("error+status", A_ERR_WITH_STATUS), ("other cmd 0xa0", A_OTHER_CMD)]:
    back = bridge.expand_arena_command(bridge.compact_arena_command(o, T0), T0)
    check(f"expand(compact({name})) == original (canonical)", canon(back), canon(o))
    check(f"expand({name}) preserves v1 key order", list(back), list(bridge.ARENA_COMMAND_KEYS))
check("expanded timeout has echo/ok null (not derived)", (bridge.expand_arena_command(arr_to, T0)["echo"], bridge.expand_arena_command(arr_to, T0)["ok"]), (None, None))
check("is_arena_array: compact line", bridge.is_arena_array(["a", 1, 2, "03700000", 0, 3]), True)
check("is_arena_array: behavior frame array is NOT", bridge.is_arena_array([5, 9052, 39, 0.0, 1.42578, -3.19222, 1.21378]), False)

print("=== behavior_v2: lines that must NOT be compacted (verbatim fallback / strict raise) ===")
def not_compactable(name, o):
    check(f"lenient: {name} → None", bridge.compact_arena_command(o, T0), None)
    check_raises(f"strict: {name} raises", lambda: bridge.compact_arena_command(o, T0, strict=True))
not_compactable("unknown extra key", dict(A_OK, extra=1))
not_compactable("missing key", {k: v for k, v in A_OK.items() if k != "len"})
not_compactable("echo != command byte", dict(A_OK, echo=113))
not_compactable("ok inconsistent with status", dict(A_OK, ok=False))
not_compactable("status null but ok set", dict(A_TIMEOUT, ok=False))
not_compactable("len != head bytes", dict(A_OK, len=5))
not_compactable("truncated head (' …')", dict(A_OK, head="03 8d 00 01 02 03 04 05 …", len=12))
not_compactable("uppercase hex head", dict(A_OK, head="03 70 2E 00"))
not_compactable("float t", dict(A_OK, t=1788636442353.5))
not_compactable("other dir", dict(A_OK, dir="bridge→browser"))
not_compactable("non-string error", dict(A_OK, error={"code": 1}))
not_compactable("not an arena_command", {"type": "log", "event": "runner", "phase": "x"})
check_raises("expand: malformed array raises", lambda: bridge.expand_arena_command(["a", 1, 2, "037", 0, 3], T0))
check_raises("expand: non-int offset raises", lambda: bridge.expand_arena_command(["a", 1.5, 2, "03700000", 0, 3], T0))

print("=== behavior_v2: v1 → v2 → v1 file round trip ===")
V1_FILE = [
    {"type": "session", "event": "logging_started", "file": "arena-log-x.jsonl", "ms": T0},
    {"type": "frame_schema", "level": "behavior_v1", "cols": bridge.BEHAVIOR_V1_COLS},
    json.loads('{"type":"log_control","enabled":true,"level":"behavior_v1","dir":"browser→bridge","rx_ms":1788636439305}'),
    json.loads('{"type":"log","event":"run_metadata","rig_id":"rig03-sr","run_id":"rydc2tql","experimenter":"x","genotype":"g","notes":"","protocol_filename":"p.yaml","protocol_sha256":"00","arena_config":"G6_2x10","rig":"cshl_g6_2x10_ball","firmware":"v1","dir":"browser→bridge","rx_ms":1788636439306}'),
    json.loads('{"type":"log","event":"runner","phase":"trial-running","index":0,"durationSec":40,"params":{"mode":3,"patternId":36,"frameRate":0,"gain":0,"initPos":0,"duration":0,"duty":0},"condition":"c","status":0,"ok":true,"dir":"browser→bridge","rx_ms":1788636442300}'),
    [5, 9052, 39, 0.0, 1.42578, -3.19222, 1.21378],
    A_OK,
    [13, 9053, 39, 8.272, 1.42579, -3.19221, 1.21379],
    A_REJECT,
    A_TIMEOUT,
    A_ERR_WITH_STATUS,
    json.loads('{"type":"config","fictrac_port":60000,"gain":1.8,"offset":0,"frames":200,"dir":"browser→bridge","rx_ms":1788636442700}'),
    {"type": "session", "event": "logging_stopped", "ms": T0 + 40000},
]
v2 = bridge.convert_v1_to_v2(V1_FILE)
check("same line count", len(v2), len(V1_FILE))
check("v2 schema replaces the v1 schema in place", v2[1], {"type": "frame_schema", "level": "behavior_v2", "cols": bridge.BEHAVIOR_V1_COLS, "arena_cols": ["t_off", "dt", "hex", "status", "rx_off"], "t0": T0})
check("t0 = logging_started.ms", v2[1]["t0"], T0)
check("arena lines became 'a' arrays", sum(1 for o in v2 if bridge.is_arena_array(o)), 4)
check("frame arrays unchanged", v2[5], V1_FILE[5])
check("runner line verbatim", v2[4], V1_FILE[4])
check("detect_format(v1) = behavior_v1", bridge.detect_format(V1_FILE), "behavior_v1")
check("detect_format(v2) = behavior_v2", bridge.detect_format(v2), "behavior_v2")
back = bridge.convert_v2_to_v1(v2)
check("round trip: line count", len(back), len(V1_FILE))
check("round trip: every line canonical-identical", [canon(a) == canon(b) for a, b in zip(V1_FILE, back)], [True] * len(V1_FILE))
check("round trip: v1 schema restored exactly", back[1], V1_FILE[1])
check("v2 is smaller", len(bridge.dumps_jsonl(v2)) < len(bridge.dumps_jsonl(V1_FILE)), True)
check_raises("v1→v2 of a v2 file raises", lambda: bridge.convert_v1_to_v2(v2))
check_raises("v2→v1 of a v1 file raises", lambda: bridge.convert_v2_to_v1(V1_FILE))
check_raises("strict v1→v2 with an unknown arena key raises", lambda: bridge.convert_v1_to_v2(V1_FILE[:6] + [dict(A_OK, extra=1)]))
check("lenient v1→v2 keeps the unknown-key line verbatim", bridge.convert_v1_to_v2(V1_FILE[:6] + [dict(A_OK, extra=1)], strict=False)[-1], dict(A_OK, extra=1))
check_raises("v2 schema with unknown key raises", lambda: bridge.convert_v2_to_v1([dict(v2[1], foo=1)] + v2[2:]))
check_raises("v2 schema with other arena_cols raises", lambda: bridge.convert_v2_to_v1([dict(v2[1], arena_cols=["x"])] + v2[2:]))
check_raises("v1 schema with unknown key raises", lambda: bridge.convert_v1_to_v2([V1_FILE[0], dict(V1_FILE[1], extra=1)]))

print("=== behavior_v2: legacy file without a frame_schema (pre-#140 / full level) ===")
LEGACY = [
    {"type": "session", "event": "logging_started", "file": "arena-log-y.jsonl", "ms": T0},
    json.loads('{"type":"log_control","enabled":true,"dir":"browser→bridge","rx_ms":1788636439305}'),
    {"type": "fictrac_frame", "seq": 1999753, "index": 54, "t": T0 + 19, "fictrac": [1999753.0] + [0.0] * 24},
    A_OK,
    {"type": "session", "event": "logging_stopped", "ms": T0 + 500},
]
lv2 = bridge.convert_v1_to_v2(LEGACY)
check("detect_format(legacy full) = full", bridge.detect_format(LEGACY), "full")
check("detect_format(pre-#140) = legacy", bridge.detect_format([LEGACY[0], {"type": "fictrac_frame", "seq": 1, "index": 2, "t": 3}]), "legacy")
check("schema inserted after the session line", (lv2[1]["type"], lv2[1]["level"]), ("frame_schema", "behavior_v2"))
check("inserted schema has cols null (no positional frames)", lv2[1]["cols"], None)
check("one extra line in v2", len(lv2), len(LEGACY) + 1)
check("arena line compacted in legacy file", bridge.is_arena_array(lv2[4]), True)
lback = bridge.convert_v2_to_v1(lv2)
check("legacy round trip: line count restored", len(lback), len(LEGACY))
check("legacy round trip: identical", [canon(a) == canon(b) for a, b in zip(LEGACY, lback)], [True] * len(LEGACY))

print("=== behavior_v2: --convert file round trip (.jsonl and .jsonl.gz) ===")
with tempfile.TemporaryDirectory() as d:
    src = os.path.join(d, "in.jsonl")
    with open(src, "w", encoding="utf-8") as fh:
        for o in V1_FILE:
            fh.write(json.dumps(o) + "\n")  # non-compact separators, like the July logs
    gz = os.path.join(d, "out.jsonl.gz")
    back_path = os.path.join(d, "back.jsonl")
    check("main(--convert v1→v2.gz) exits 0", bridge.main(["--convert", src, gz]), 0)
    check("gz output detected as behavior_v2", bridge.detect_format(bridge.read_jsonl(gz)), "behavior_v2")
    check("main(--convert v2.gz→v1) exits 0", bridge.main(["--convert", gz, back_path]), 0)
    check("file round trip identical", [canon(o) for o in bridge.read_jsonl(back_path)], [canon(o) for o in V1_FILE])
    check("--to v2 on a v2 file fails cleanly (exit 1)", bridge.main(["--convert", gz, os.path.join(d, "x.jsonl"), "--to", "v2"]), 1)
    check("gzip output is reproducible (mtime 0)", bridge.write_jsonl(gz, v2) == bridge.write_jsonl(os.path.join(d, "again.jsonl.gz"), v2) and open(gz, "rb").read() == open(os.path.join(d, "again.jsonl.gz"), "rb").read(), True)

print("=== LogWriter: levels + what lands in the file ===")
def write_session(level, inbound, frames=1):
    with tempfile.TemporaryDirectory() as d:
        lw = bridge.LogWriter(None, level, d)
        check(f"[{level}] fresh writer level", lw.level, level)
        lw.start_new_log()
        for raw in inbound:
            lw.write_inbound(raw)
        beh = {"ms": 5, "fc": 9052, "idx": 39, "ft": 0.0, "x": 1.42578, "y": -3.19222, "hd": 1.21378}
        for _ in range(frames):
            lw.write_frame(beh, [9052.0] + [0.0] * 24)
        name = lw.current_name
        lw.close()
        return bridge.read_jsonl(os.path.join(d, name))

check("default level is behavior_v2", bridge.LogWriter(None).level, "behavior_v2")
check("legacy log_frames=True → full", bridge.LogWriter(None, True).level, "full")
check("legacy log_frames=False → default", bridge.LogWriter(None, False).level, "behavior_v2")
check("log_frames alias", bridge.LogWriter(None, "full").log_frames, True)
check_raises("unknown level at construction raises", lambda: bridge.LogWriter(None, "bogus"), ValueError)
lw = bridge.LogWriter(None)
check("set_level accepts behavior_v1", lw.set_level("behavior_v1"), True)
check("set_level rejects unknown and keeps level", (lw.set_level("behavior_v9"), lw.level), (False, "behavior_v1"))
check("set_level accepts full / behavior_v2", (lw.set_level("full"), lw.set_level("behavior_v2"), lw.level), (True, True, "behavior_v2"))

a_raw = json.dumps({k: v for k, v in A_OK.items() if k not in ("dir", "rx_ms")})  # as the browser sends it
lines = write_session("behavior_v2", [a_raw, '{"type":"log","event":"runner","phase":"sequence-start","total":1}', "not json"])
sch = lines[1]
check("[v2] schema line level/arena_cols", (sch["level"], sch["arena_cols"]), ("behavior_v2", bridge.BEHAVIOR_V2_ARENA_COLS))
check("[v2] schema t0 == session line ms", sch["t0"], lines[0]["ms"])
check("[v2] schema cols = behavior cols", sch["cols"], bridge.BEHAVIOR_V1_COLS)
check("[v2] arena_command written as 'a' array", bridge.is_arena_array(lines[2]), True)
exp = bridge.expand_arena_command(lines[2], sch["t0"])
check("[v2] expanded echo matches the browser payload (+ dir, rx_ms stamps)", {k: exp[k] for k in A_OK if k not in ("rx_ms",)}, {k: A_OK[k] for k in A_OK if k not in ("rx_ms",)})
check("[v2] rx_ms stamped as int", isinstance(exp["rx_ms"], int), True)
check("[v2] runner line verbatim object", lines[3]["phase"], "sequence-start")
check("[v2] unparsed inbound kept", lines[4]["event"], "unparsed")
check("[v2] frame row unchanged 7-array", lines[5], [5, 9052, 39, 0.0, 1.42578, -3.19222, 1.21378])
check("[v2] file converts back to v1 cleanly", bridge.detect_format(bridge.convert_v2_to_v1(lines)), "behavior_v1")
bad = dict(A_OK); bad["head"] = "03 8d 00 01 02 03 04 05 …"; bad["len"] = 12
lines = write_session("behavior_v2", [json.dumps({k: v for k, v in bad.items() if k not in ("dir", "rx_ms")})])
check("[v2] non-fitting echo kept verbatim (lossless fallback)", (isinstance(lines[2], dict), lines[2]["head"]), (True, bad["head"]))

lines = write_session("behavior_v1", [a_raw])
check("[v1] schema line unchanged shape", lines[1], {"type": "frame_schema", "level": "behavior_v1", "cols": bridge.BEHAVIOR_V1_COLS})
check("[v1] arena_command stays an object", isinstance(lines[2], dict) and lines[2]["event"] == "arena_command", True)
check("[v1] frame row 7-array", len(lines[3]), 7)
lines = write_session("full", [a_raw])
check("[full] no schema line", any(o.get("type") == "frame_schema" for o in lines if isinstance(o, dict)), False)
check("[full] fictrac_frame object with 25 cols", (lines[2]["type"], len(lines[2]["fictrac"])), ("fictrac_frame", 25))

print("=== dispatcher: hello_ack + log_control_ack ===")
class FakeWs:
    def __init__(self):
        self.sent = []
    async def send(self, s):
        self.sent.append(json.loads(s))

class FakeInputs:
    port = 60000
    async def rebind(self, port):
        self.port = port

async def drive():
    with tempfile.TemporaryDirectory() as d:
        log = bridge.LogWriter(None, bridge.DEFAULT_LOG_LEVEL, d)
        pipeline = bridge.Pipeline(None, log, 200, 1.8, 0.0)
        dispatch = bridge.make_dispatcher(pipeline, log, FakeInputs())
        ws = FakeWs()
        await dispatch(json.dumps({"type": "hello", "client": "webDisplayTools", "v": 1}), ws)
        hello = ws.sent[-1]
        await dispatch(json.dumps({"type": "log_control", "enabled": True, "level": "behavior_v2"}), ws)
        ack_v2 = ws.sent[-1]
        f_v2 = log.current_name
        await dispatch(json.dumps({"type": "log_control", "enabled": False}), ws)
        ack_off = ws.sent[-1]
        await dispatch(json.dumps({"type": "log_control", "enabled": True, "level": "behavior_v9"}), ws)
        ack_bogus = ws.sent[-1]
        await dispatch(json.dumps({"type": "log_control", "enabled": False}), ws)
        await dispatch(json.dumps({"type": "log_control", "enabled": True, "level": "behavior_v1"}), ws)
        ack_v1 = ws.sent[-1]
        await dispatch(json.dumps({"type": "log_control", "enabled": False}), ws)
        await dispatch(json.dumps({"type": "log_control", "enabled": True}), None)  # no websocket: must not crash
        await dispatch(json.dumps({"type": "log_control", "enabled": False}), None)
        first = bridge.read_jsonl(os.path.join(d, f_v2))
        return hello, ack_v2, ack_off, ack_bogus, ack_v1, first

hello, ack_v2, ack_off, ack_bogus, ack_v1, first = asyncio.run(drive())
check("hello_ack type", hello["type"], "hello_ack")
check("hello_ack advertises levels (v2 first)", hello["levels"], ["behavior_v2", "behavior_v1", "full"])
check("hello_ack carries the bridge version + current level", (hello["bridge"], hello["level"], hello["logging"]), (bridge.BRIDGE_VERSION, "behavior_v2", False))
check("log_control_ack v2: enabled + level + file", (ack_v2["type"], ack_v2["enabled"], ack_v2["level"], ack_v2["requested"], ack_v2["file"].startswith("arena-log-")), ("log_control_ack", True, "behavior_v2", "behavior_v2", True))
check("log_control_ack off: enabled false, level kept", (ack_off["enabled"], ack_off["level"]), (False, "behavior_v2"))
check("unknown level: ack reports the level ACTUALLY in force", (ack_bogus["level"], ack_bogus["requested"], ack_bogus["enabled"]), ("behavior_v2", "behavior_v9", True))
check("behavior_v1 still selectable", ack_v1["level"], "behavior_v1")
check("the v2 file: hello + log_control logged, schema is v2", (first[0]["type"], first[1]["level"], first[2]["type"]), ("session", "behavior_v2", "log_control"))

print("\n=== Summary ===")
print(f"{total - failures} / {total} checks passed")
sys.exit(1 if failures else 0)
