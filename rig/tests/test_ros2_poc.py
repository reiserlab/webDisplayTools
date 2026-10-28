#!/usr/bin/env python3
"""test_ros2_poc.py — the LAB-303 proof-of-concept acceptance run, end to end, no hardware.

    pixi run test                 # from rig/ (≈ 45 s)
    pixi run test -- --epoch-s 4 --keep

Brings up the WHOLE graph in this process's pixi env — Zenoh router, FicTrac UDP adapter,
Kinefly KF/1 adapter + synthetic producer, BIAS simulator + BIAS node, the bridge node —
then drives it the way a rig does: `fictrac_sim.py --model fly --kp 2` (a fixating model
fly on the WebSocket, FicTrac untouched) and tests/studio_emulator.py (the Studio runner's
exact bridge conversation, 3 constant-bias epochs). During epoch 2 the FicTrac adapter is
KILLED (SIGKILL) and restarted 3 s later. BIAS commands are issued mid-run through the
node. Then the exported log is judged:

  criteria (LAB-303, 2026-10-14 comment)                       how it is checked here
  ─────────────────────────────────────────────────────────────────────────────────────
  pixi install, no manual steps; one `pixi run rig`             this test runs in that env; rig.py is the launcher
  no custom message types                                       std_msgs/String everywhere (grep in CI below)
  FicTrac via the sim through a UDP→ROS adapter, untouched      fictrac_sim.py unmodified, adapter in nodes/
  Kinefly fork via a KF/1 adapter                               kinefly_sim.py (KF/1 bytes) → adapter → ["kf",…] rows
  BIAS via the Mac port                                         bias_sim.py here; real BIAS = same HTTP interface
  unmodified Studio passes the closed-loop report               emulator speaks the client's protocol; report:
                                                                rejection > 0.8 on uninterrupted epochs, idx mismatch 0
  … and the runlog format tests                                 js/runlog-format + runlog-replay readers accept every line;
                                                                bridge.py --convert v2→v1→v2 is byte-identical
  the closed-loop node stamps its own sample time               Pipeline.handle_line's now_ms() (reused); lat stats logged
  bridge 3.4 stays installed side by side                       root fictrac-bridge/bridge.py --version still 3.4
  a device node killed mid-run leaves the log intact            adapter SIGKILLed in epoch 2: source_lost/resumed logged,
                                                                file complete, every reader still parses it

PLAN B SPIKE additions (LAB-303, 2026-10-14) — the log the Studio receives is now DERIVED from
the MCAP bag the bridge node records, so the same criteria are judged against the CONVERTED
log, plus:
  bag present per run, every topic recorded            ros2 bag info + the mcap reader
  conversion fidelity vs the live writer's shadow file every sequenced line byte-identical and in
                                                        order; DERIVED lines (Kinefly rows, BIAS
                                                        events) same content, |Δms| within tolerance
  log levels as a converter option                     bag → behavior_v1 == bridge.py --convert of the
                                                        v2; full level refused without the raw FicTrac
                                                        topics (2026-10-18), still served by an old bag
  the merged FicTrac record (2026-10-18)               /arena/frame carries err, dr_lab_x/y/z, ft_seq, ft_ns
                                                        from the SAME line as x/y/hd; no /fictrac/* topic
                                                        recorded by default; an FT_BADFR frame = a flagged
                                                        record and no row; frame records ≤ 72 B/frame compressed
  ordering: `seq` (live order) vs `time`               same lines; count of same-ms swaps; identical
                                                        closed-loop report either way
  typed topics when rig_interfaces is built          ArenaFrame / FicTracFrame schemas in the bag
  crash: bridge node SIGKILLed mid-run                 what `--recover` + conversion salvages from the
                                                        bag (both writer profiles) vs the line-buffered
                                                        NDJSON — reported, crashsafe profile gated;
                                                        then a RESTARTED node's log_export recovers the
                                                        bag on its own (recovered:true, whole bag left)
  host monitor (2026-10-28; rig_nodes.host_monitor)   /rig/host in the bag ≥ 0.8 Hz, fields = the installed
                                                        HostStats (typed) / the read fields (JSON), the graph's
                                                        nodes pinned; its own CPU ≤ 2 % of a core, ≤ 5 % of the
                                                        compressed bag — skipped (info) when the installed
                                                        rig_nodes has no host monitor

Exit 0 when all checks pass. Prints a markdown summary. Artifacts are kept with --keep.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
POC = HERE.parent
REPO = POC.parent
NODES = POC / "nodes"
SIM = REPO / "fictrac-bridge" / "fictrac_sim.py"
BRIDGE_PY = REPO / "fictrac-bridge" / "bridge.py"
PY = sys.executable
sys.path.insert(0, str(NODES))
from _common import SIGKILL, popen_group, signal_group, wait_port  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, info: str = "") -> bool:
    results.append((name, bool(ok), info))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else ' — ' + info}", file=sys.stderr)
    return bool(ok)



class Proc:
    def __init__(self, name: str, argv: list[str], logdir: Path) -> None:
        self.name = name
        self.argv = argv
        self.log = open(logdir / f"{name}.log", "w", encoding="utf-8")
        self.p: subprocess.Popen | None = None

    def start(self) -> "Proc":
        # Own process group (nodes/_common.popen_group), so stop() reaches `ros2 run`'s child too.
        self.p = popen_group(self.argv, stdout=self.log, stderr=subprocess.STDOUT, text=True)
        return self

    def alive(self) -> bool:
        return self.p is not None and self.p.poll() is None

    def _signal(self, sig: int) -> None:
        signal_group(self.p, sig)

    def kill9(self) -> None:
        if self.alive():
            self._signal(SIGKILL)
            self.p.wait(5)

    def stop(self) -> None:
        if not self.alive():
            return
        try:
            self._signal(signal.SIGINT)
            self.p.wait(5)
        except subprocess.TimeoutExpired:
            self._signal(signal.SIGTERM)
            try:
                self.p.wait(3)
            except subprocess.TimeoutExpired:
                self._signal(SIGKILL)
        except (ProcessLookupError, OSError, ValueError):
            pass
        self.log.flush()


def read_jsonl(path: Path) -> list:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def run_capture(argv: list[str], timeout: float = 60.0, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)


def find_node() -> str | None:
    """`node` for the JS reader check: PATH, this checkout's root pixi env, or — in a git
    worktree under <main>/.claude/worktrees/<name> — the main checkout's root env."""
    n = shutil.which("node")
    if n:
        return n
    for root in (REPO, *REPO.parents[:3]):
        env = root / ".pixi" / "envs" / "default"
        # conda's Windows layout puts node.exe at the env root, not in bin/
        for cand in ((env / "node.exe", env / "bin" / "node.exe") if os.name == "nt" else (env / "bin" / "node",)):
            if cand.exists():
                return str(cand)
    return None


def free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def read_jsonl_lines(path: Path) -> list[str]:
    return [l for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def is_derived(line: str) -> bool:
    """Lines the converter DERIVES from device topics (no writer sequence number): Kinefly
    rows and BIAS reply/status connector events. Everything else is sequenced."""
    if line.startswith('["kf",'):
        return True
    if line.startswith('{"type":"connector","src":"') and ('","kind":"reply"' in line[:64] or '","kind":"status"' in line[:64]):
        return True  # any connector (bias, scanimage, …)
    return False


def compare_logs(live: list[str], conv: list[str]) -> dict:
    """Converted vs live: sequenced lines must be identical and in order; derived lines must
    pair up with identical content apart from `ms`, whose difference is measured."""
    seq_live = [l for l in live if not is_derived(l)]
    seq_conv = [l for l in conv if not is_derived(l)]
    der_live = [l for l in live if is_derived(l)]
    der_conv = [l for l in conv if is_derived(l)]
    first_diff = next((i + 1 for i, (a, b) in enumerate(zip(seq_live, seq_conv)) if a != b), None)
    out = {"lines_live": len(live), "lines_conv": len(conv), "sequenced_identical": seq_live == seq_conv,
           "sequenced_first_diff": first_diff, "derived_live": len(der_live), "derived_conv": len(der_conv),
           "byte_identical": live == conv}

    def strip_ms(line: str):
        o = json.loads(line)
        if isinstance(o, list):
            return ("kf", json.dumps(o[:1] + o[2:], separators=(",", ":"))), o[1]
        ms = o.pop("ms", None)
        return (o.get("kind"), json.dumps(o, separators=(",", ":"), sort_keys=True)), ms

    dl = [strip_ms(l) for l in der_live]
    dc = [strip_ms(l) for l in der_conv]
    content_equal = [k for k, _ in dl] == [k for k, _ in dc]
    out["derived_content_equal"] = content_equal
    if content_equal and dl:
        d = sorted(abs((a - b)) for (_, a), (_, b) in zip(dl, dc) if isinstance(a, (int, float)) and isinstance(b, (int, float)))
        if d:
            out["derived_dms"] = {"p50": d[len(d) // 2], "p99": d[int(len(d) * 0.99)], "max": d[-1], "n": len(d)}
    # Placement: how many derived lines sit after a different sequenced neighbour than in the live file?
    def prev_seq(lines):
        res, last = [], None
        for l in lines:
            if is_derived(l):
                res.append(last)
            else:
                last = l
        return res
    pl, pc = prev_seq(live), prev_seq(conv)
    out["derived_misplaced"] = sum(1 for a, b in zip(pl, pc) if a != b) if len(pl) == len(pc) else None
    return out


def bag_summary(bag: Path) -> dict:
    """Topic → message count + schema names, read with the pure-Python mcap reader."""
    sys.path.insert(0, str(NODES))
    from mcap_convert import _json_of, read_all  # noqa: E402

    recs, info = read_all(bag)
    by_topic: dict[str, int] = {}
    schemas = set()
    lag = []
    bias_frames_t = 0  # BIAS frame timestamps carried by /bias/frames (all chunks, all recordings)
    for r in recs:
        by_topic[r["topic"]] = by_topic.get(r["topic"], 0) + 1
        if r["schema"]:
            schemas.add(r["schema"])
        if r["topic"] == "/arena/frame" and r.get("pub_ns"):
            lag.append((r["log_ns"] - r["pub_ns"]) / 1e6)
        if r["topic"] == "/bias/frames":
            o = _json_of(r)
            if isinstance(o, dict) and isinstance(o.get("t"), list):
                bias_frames_t += len(o["t"])
    lag.sort()
    files = sorted(bag.glob("*.mcap"))
    return {"records": info.get("records"), "topics": by_topic, "schemas": sorted(schemas), "torn": info.get("torn"),
            "bias_frames_t": bias_frames_t,
            "bytes": sum(f.stat().st_size for f in files), "metadata_yaml": (bag / "metadata.yaml").exists(),
            "frame_lag_ms": {"p50": round(lag[len(lag) // 2], 3), "p99": round(lag[int(len(lag) * 0.99)], 3), "max": round(lag[-1], 3)} if lag else None}


def host_monitor_values(bag: Path) -> dict:
    """/rig/host in the bag: sample count over the run, field names vs the request's HostStats.msg,
    per-core sanity, pinned groups, the monitor's own CPU, and its share of the compressed payload."""
    import statistics

    import zstandard

    sys.path.insert(0, str(NODES))
    from mcap_convert import _json_of, decode_cdr, read_records  # noqa: E402

    try:  # the field contract is rig-nodes' (rig_interfaces/HostStats); without the typed build the
        # JSON samples are checked for the fields this harness reads
        from rig_interfaces.msg import HostStats

        want = sorted(HostStats.get_fields_and_field_types())
    except (ImportError, AttributeError):
        want = None
    host, other, t_ns, objs = [], [], [], []
    gen = read_records(bag)
    try:
        while True:
            r = next(gen)
            t_ns.append(r["log_ns"])
            if r["topic"] != "/rig/host":
                other.append(r["data"])
                continue
            host.append(r["data"])
            try:  # String JSON → its object; a typed HostStats → its fields (the converter's decoder)
                objs.append(_json_of({"msg": decode_cdr(r["schema"], r.get("schema_text"), r["data"])}))
            except Exception:
                objs.append(None)
    except StopIteration:
        pass
    good = [o for o in objs if isinstance(o, dict)]
    need = {"core_busy_mean", "core_busy_peak", "monitor_cpu_cores", "procs"}
    bad = sorted({k for o in good for k in (set(o) ^ set(want) if want else need - set(o))})
    cores_ok = bool(good) and all(len(o["core_busy_mean"]) == len(o["core_busy_peak"]) == (os.cpu_count() or 0)
                                  and all(p + 1e-6 >= m for m, p in zip(o["core_busy_mean"], o["core_busy_peak"])) for o in good)
    self_cpu = [o["monitor_cpu_cores"] for o in good[2:] if isinstance(o.get("monitor_cpu_cores"), (int, float))]
    level = 19  # the bag's zstd "Slowest" (recorder.py `default` profile; crashsafe is reindexed to it)
    zh = len(zstandard.ZstdCompressor(level=level).compress(b"".join(host))) if host else 0
    za = len(zstandard.ZstdCompressor(level=level).compress(b"".join(host + other))) if host or other else 0
    run_s = (max(t_ns) - min(t_ns)) / 1e9 if t_ns else None
    return {"samples": len(host), "run_s": round(run_s, 1) if run_s else None, "fields_ok": bool(good) and len(good) == len(objs) and not bad,
            "bad_fields": bad, "cores_ok": cores_ok, "ncpu": len(good[0]["core_busy_mean"]) if good else None,
            "groups": sorted({p["group"] for o in good for p in o.get("procs", []) if p.get("group")}),
            "self_cpu_median": round(statistics.median(self_cpu), 4) if self_cpu else None,
            "self_cpu_max": round(max(self_cpu), 4) if self_cpu else None,
            "bytes_per_sample": round(sum(map(len, host)) / len(host)) if host else None,
            "share_compressed": round(zh / za, 4) if za else None,
            "host_kb_per_h_zstd": round(zh / run_s * 3600 / 1024) if run_s else None}


def typed_frame_values(bag: Path) -> dict:
    """The recorded /arena/frame ArenaFrame messages, decoded with the converter's pure-Python
    CDR decoder from the schema text IN THE BAG, judged by VALUE — a schema name alone said
    nothing when two builds of the interfaces met in one process (2026-10-14: the bridge wrote
    108-byte frames whose derived fields were garbage and the bag's schema text was the old
    .msg, while every schema-name check passed). Returns counts for the check + its info."""
    sys.path.insert(0, str(NODES))
    from mcap_convert import read_all  # noqa: E402

    recs, _ = read_all(bag)
    frames = [r["msg"] for r in recs if r["topic"] == "/arena/frame" and r.get("msg") and "has_ft" in r["msg"]
              and not (int(r["msg"].get("flags") or 0) & 1)]  # flagged untracked frames carry NaN by design
    frames.sort(key=lambda m: m["seq"])
    out = {"n": len(frames), "decode_errors": sum(1 for r in recs if r["topic"] == "/arena/frame" and r.get("decode_error")),
           "has_derived": bool(frames) and all(k in frames[0] for k in ("turning_dps", "forward_mms"))}
    if not frames or not out["has_derived"]:
        return out
    fin = lambda v: isinstance(v, float) and math.isfinite(v)  # noqa: E731
    out["core_finite"] = all(fin(m["x"]) and fin(m["y"]) and fin(m["hd"]) and (fin(m["ft"]) or not m["has_ft"]) for m in frames)
    out["fc_monotonic"] = all(b["fc"] > a["fc"] for a, b in zip(frames, frames[1:]))
    # Live-only since 2026-10-18: the recorded copy carries NaN (16 B/frame of incompressible doubles,
    # exactly recomputable); the derivation itself is checked on FrameDeriver directly (below).
    out["derived_nan_in_bag"] = all(math.isnan(m["turning_dps"]) and math.isnan(m["forward_mms"]) for m in frames)
    out["ok"] = out["core_finite"] and out["fc_monotonic"] and out["derived_nan_in_bag"]
    return out


def frame_deriver_values() -> dict:
    """The live derived channels' math, on the class itself (bridge_node.FrameDeriver): two frames
    20 ms apart, 0.02 rad along the heading and 0.01 rad of turn → js/kinematics.js's numbers."""
    sys.path.insert(0, str(NODES))
    from bridge_node import FrameDeriver  # noqa: E402  (imports rclpy; no node is created)

    d = FrameDeriver(9.0)
    first = d.step({"fc": 1, "ft": 0.0, "t": 0, "x": 0.0, "y": 0.0, "hd": 0.0})
    turning, forward = d.step({"fc": 2, "ft": 20.0, "t": 20, "x": 0.02, "y": 0.0, "hd": 0.01})
    want_t = math.degrees(0.01) / 0.02
    want_f = (0.02 * math.cos(0.005)) / 0.02 * 4.5
    return {"first_nan": all(math.isnan(v) for v in first), "turning_dps": round(turning, 4), "forward_mms": round(forward, 4),
            "ok": all(math.isnan(v) for v in first) and abs(turning - want_t) < 1e-6 and abs(forward - want_f) < 1e-6}


def frame_extras_values(bag: Path) -> dict:
    """The kept FicTrac columns on the /arena/frame records (typed or String path), judged by VALUE
    against the behavior columns of the SAME record: fictrac_sim writes col 8 = its heading step
    and col 17 = the accumulated heading, so wrap(Δhd) == dr_lab_z frame to frame proves the extras
    come from the line that produced x/y/hd (an off-by-one join would fail it); col 23 = the frame
    number (ft_seq == fc); col 5 finite (the sim writes 0). Flagged records are the untracked frames."""
    sys.path.insert(0, str(NODES))
    from mcap_convert import _json_of, read_all  # noqa: E402

    recs, _ = read_all(bag)
    frames, bad = [], []
    for r in recs:
        if r["topic"] != "/arena/frame" or not r.get("msg"):
            continue
        fr = r["msg"] if "has_ft" in r["msg"] else _json_of(r)
        if not isinstance(fr, dict):
            continue
        (bad if int(fr.get("flags") or 0) & 1 else frames).append(fr)
    frames.sort(key=lambda f: int(f.get("seq", f.get("wseq", 0))))
    out = {"n": len(frames), "bad": len(bad), "bad_fc": [int(b.get("fc") or 0) for b in bad][:5]}
    if not frames:
        return out
    fin = lambda v: isinstance(v, (int, float)) and math.isfinite(v)  # noqa: E731
    out["extras_present"] = all(k in frames[0] for k in ("err", "dr_lab_x", "dr_lab_y", "dr_lab_z", "ft_seq", "ft_ns"))
    if not out["extras_present"]:
        return out
    out["err_finite"] = all(fin(f["err"]) for f in frames)
    out["dr_finite"] = all(fin(f["dr_lab_x"]) and fin(f["dr_lab_y"]) and fin(f["dr_lab_z"]) for f in frames)
    out["ft_seq_eq_fc"] = all(int(f["ft_seq"]) == int(f["fc"]) for f in frames)
    out["ft_ns_monotonic"] = all(int(b["ft_ns"]) > int(a["ft_ns"]) for a, b in zip(frames, frames[1:]) if int(b["fc"]) > int(a["fc"]))

    def wrap(r: float) -> float:
        return (r + math.pi) % (2 * math.pi) - math.pi

    pairs = [(a, b) for a, b in zip(frames, frames[1:]) if int(b["fc"]) == int(a["fc"]) + 1]
    aligned = sum(1 for a, b in pairs if abs(wrap(float(b["hd"]) - float(a["hd"])) - float(b["dr_lab_z"])) < 5e-5)  # hd is 5-dp rounded
    out["pairs"] = len(pairs)
    out["aligned_frac"] = round(aligned / len(pairs), 3) if pairs else None
    out["ok"] = out["err_finite"] and out["dr_finite"] and out["ft_seq_eq_fc"] and out["ft_ns_monotonic"] and (out["aligned_frac"] or 0) >= 0.95
    return out


def frame_record_size(bag: Path, export: Path) -> dict:
    """The /arena/frame records AS RECORDED, rewritten alone in the final layout (chunk-only index,
    zstd 19 — mcap_index.reindex's settings), against the gzip of the export's frame rows: the ratio
    the 2026-10-18 decision accepted (docs/development/fictrac-columns-in-the-bag.md §3)."""
    import gzip
    import io

    from mcap.reader import make_reader
    from mcap.writer import CompressionType, IndexType, Writer

    sys.path.insert(0, str(NODES))
    from mcap_index import ZSTD_LEVEL, _zstd_level  # noqa: E402

    buf = io.BytesIO()
    n = 0
    with _zstd_level(ZSTD_LEVEL):
        w = Writer(buf, compression=CompressionType.ZSTD, index_types=IndexType.ALL & ~IndexType.MESSAGE)
        w.start(profile="ros2", library="test_ros2_poc")
        ch = None
        for f in sorted(bag.glob("*.mcap")):
            with open(f, "rb") as fh:
                for schema, _chan, m in make_reader(fh).iter_messages(topics=["/arena/frame"], log_time_order=False):
                    if ch is None:
                        ch = w.register_channel("/arena/frame", "cdr", w.register_schema(schema.name if schema else "frame", "ros2msg", schema.data if schema else b""))
                    n += 1
                    w.add_message(ch, log_time=m.log_time, publish_time=m.publish_time, data=m.data, sequence=n)
        w.finish()
    rows = b"\n".join(l for l in export.read_bytes().splitlines() if l.startswith(b"[") and not l.startswith(b'["')) + b"\n"
    gz = len(gzip.compress(rows, 9))
    return {"frames": n, "bag_frame_bytes": len(buf.getvalue()), "rows_gz": gz, "ratio": round(len(buf.getvalue()) / gz, 2) if gz else None}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--epoch-s", type=float, default=6.0)
    ap.add_argument("--kill-at", type=float, default=2.0, help="seconds into epoch 2 (0-based epoch 1) to SIGKILL the FicTrac adapter")
    ap.add_argument("--kill-for", type=float, default=3.0, help="seconds before the adapter is restarted")
    ap.add_argument("--keep", action="store_true", help="keep the work dir")
    ap.add_argument("--workdir", default=None)
    ap.add_argument("--no-router", action="store_true", help="a Zenoh router is already running on 127.0.0.1:7447")
    ap.add_argument("--bag-profile", default="crashsafe", choices=("default", "crashsafe"), help="MCAP writer profile for the main run (default: crashsafe)")
    ap.add_argument("--no-crash", action="store_true", help="skip the crash phase (bridge node SIGKILLed mid-run, both profiles)")
    a = ap.parse_args(argv)

    work = Path(a.workdir) if a.workdir else Path(tempfile.mkdtemp(prefix="rig-test-"))
    work.mkdir(parents=True, exist_ok=True)
    logdir = work / "proc-logs"
    logdir.mkdir(exist_ok=True)
    runlogs = work / "runlogs"
    export = work / "studio-export.jsonl"
    report = work / "emulator-report.json"
    videos = work / "bias-videos"
    procs: list[Proc] = []
    print(f"[test] work dir {work}", file=sys.stderr)

    def start(name: str, argv: list[str]) -> Proc:
        pr = Proc(name, argv, logdir).start()
        procs.append(pr)
        return pr

    kill_report: dict = {}
    try:
        # ── bring the graph up ───────────────────────────────────────────────────────
        if not a.no_router:
            start("router", ["ros2", "run", "rmw_zenoh_cpp", "rmw_zenohd"])
            check("zenoh router listening on 127.0.0.1:7447", wait_port("127.0.0.1", 7447, 20.0))
        fictrac = start("fictrac-adapter", [PY, str(NODES / "fictrac_udp_adapter.py"), "--status-every", "0"])
        start("kinefly-adapter", [PY, str(NODES / "kinefly_udp_adapter.py"), "--status-every", "0"])
        # The sim on a free port, not BIAS's 5010: a rig PC often has the real BIAS open.
        bias_port = free_tcp_port()
        start("bias-sim", [PY, str(NODES / "bias_sim.py"), "--port", str(bias_port), "--video-dir", str(videos)])
        start("bias-node", [PY, str(NODES / "bias_node.py"), "--port", str(bias_port), "--status-every", "1", "--video-dir", str(videos)])
        # ScanImage stand-in on a free port (a rig PC may have the real JSON server on 5555): short
        # grabs, a short start delay, and one allowlisted property it never answers (the UNKNOWN path).
        si_port = free_tcp_port()
        start("si-mock", [PY, str(HERE / "si_json_mock.py"), "--port", str(si_port), "--grab-s", "1.0", "--start-delay-s", "0.2", "--stall-on", "hSI.hRoiManager.scanZoomFactor"])
        start("scanimage-node", [PY, str(NODES / "scanimage_node.py"), "--port", str(si_port), "--status-every", "1", "--timeout-s", "1.5"])
        from rig import HOST_MONITOR_MODULE, host_monitor_available  # noqa: E402

        host_mon = host_monitor_available()
        if host_mon:  # the command line rig.py uses
            start("host-monitor", [PY, "-m", HOST_MONITOR_MODULE, "--log-dir", str(runlogs), "--py-root", str(POC)])
        else:
            print(f"  info  host monitor: the installed rig_nodes has no {HOST_MONITOR_MODULE} — its checks are skipped", file=sys.stderr)
        bridge_argv = [PY, str(NODES / "bridge_node.py"), "--log-dir", str(runlogs), "--source-timeout", "1.5", "--bag-profile", a.bag_profile]
        bridge = start("bridge-node", bridge_argv)
        check("bridge node serving ws://127.0.0.1:8765", wait_port("127.0.0.1", 8765, 20.0))
        time.sleep(1.5)  # discovery
        start("kinefly-sim", [PY, str(NODES / "kinefly_sim.py"), "--rate", "100", "--seed", "1"])
        start("model-fly", [PY, str(SIM), "--model", "fly", "--kp", "2", "--seed", "1", "--rate", "50"])
        time.sleep(1.5)

        # ── side actors during the run: BIAS commands + the adapter kill ─────────────
        def bias_cmd(*args: str) -> dict:
            r = run_capture([PY, str(NODES / "bias_cmd.py"), *args, "--json", "--timeout", "10"], timeout=30)
            try:
                return json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"rc": r.returncode, "err": r.stderr[-300:]}
            except json.JSONDecodeError:
                return {"rc": r.returncode, "err": r.stderr[-300:]}

        bias_replies: dict = {}

        def wait_for_log_line(predicate, timeout_s: float) -> bool:
            """Tail the bridge node's on-disk run log until a line satisfies `predicate`."""
            end = time.monotonic() + timeout_s
            while time.monotonic() < end:
                files = sorted(runlogs.glob("arena-log-*.jsonl"))
                if files:
                    try:
                        for line in files[-1].read_text(encoding="utf-8").splitlines():
                            if predicate(line):
                                return True
                    except OSError:
                        pass
                time.sleep(0.1)
            return False

        def side_actor() -> None:
            t_run0 = time.monotonic()
            bias_replies["connect"] = bias_cmd("connect")
            bias_replies["startRecording"] = bias_cmd("startRecording", "--filename", "poc_trial.avi")
            # Kill the FicTrac adapter `kill_at` s after epoch index 1 OPENS — anchored on the
            # runner's own fictracApply line in the log, not on a wall-clock estimate.
            kill_report["anchored"] = wait_for_log_line(
                lambda l: '"op":"fictracApply"' in l and '"value":true' in l and '"condition":"cl_constant_1"' in l,
                timeout_s=30 + a.epoch_s * 2,
            )
            time.sleep(a.kill_at)
            kill_report["killed_at_ms"] = int((time.monotonic() - t_run0) * 1000)
            fictrac.kill9()
            kill_report["adapter_rc"] = fictrac.p.returncode if fictrac.p else None
            time.sleep(a.kill_for)
            fictrac.start()
            kill_report["restarted_at_ms"] = int((time.monotonic() - t_run0) * 1000)
            time.sleep(1.0)
            # One untracked FicTrac frame, tagged as the real tracker tags it (bridge.py: "FT_BADFR").
            # The adapter forwards any datagram, the pipeline skips it; the bag must still show it as
            # a flagged /arena/frame record (2026-10-18), the run log must not.
            try:
                sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sk.sendto(b"FT_BADFR, 424242, 0\n", ("127.0.0.1", 60000))
                sk.close()
            except OSError as exc:
                kill_report["bad_frame_send_error"] = repr(exc)
            bias_replies["getTimestamp"] = bias_cmd("getTimestamp")
            # stopRecording once the LAST epoch has opened (same anchor, so it lands inside the run).
            last = f"cl_constant_{a.epochs - 1}"
            wait_for_log_line(
                lambda l: '"op":"fictracApply"' in l and '"value":true' in l and f'"condition":"{last}"' in l,
                timeout_s=30 + a.epoch_s * a.epochs,
            )
            time.sleep(1.0)
            bias_replies["stopRecording"] = bias_cmd("stopRecording")

        actor = threading.Thread(target=side_actor, name="side-actor", daemon=True)
        actor.start()

        # ── the Studio's conversation ────────────────────────────────────────────────
        em = run_capture(
            [PY, str(HERE / "studio_emulator.py"), "--epochs", str(a.epochs), "--epoch-s", str(a.epoch_s), "--iti-s", "1",
             "--bias-amplitude", "90", "--min-frames", "40", "--out", str(export), "--report", str(report),
             "--connector-cmds", "--connector-video", "poc_studio.avi", "--scanimage-cmds"],
            timeout=75 + a.epochs * (a.epoch_s + 2),
        )
        (logdir / "emulator.log").write_text(em.stderr, encoding="utf-8")
        check("studio emulator: every protocol assertion held", em.returncode == 0, em.stderr[-600:])
        actor.join(timeout=30)

        # ── judge the log ────────────────────────────────────────────────────────────
        check("exported log written (CONVERTED from the MCAP bag)", export.exists() and export.stat().st_size > 0)
        objs = read_jsonl(export) if export.exists() else []
        disk = sorted(runlogs.glob("arena-log-*.jsonl"))
        bags = sorted(runlogs.glob("arena-log-*.bag"))
        main_bag = bags[-1] if bags else None
        check("MCAP bag recorded for the run (metadata.yaml + .mcap)", main_bag is not None and (main_bag / "metadata.yaml").exists() and any(main_bag.glob("*.mcap")), str([b.name for b in bags]))
        bagsum = bag_summary(main_bag) if main_bag else {}
        print(f"[test] bag: {bagsum.get('records')} records, {bagsum.get('bytes')} B, topics {bagsum.get('topics')}, schemas {bagsum.get('schemas')}, frame lag {bagsum.get('frame_lag_ms')}", file=sys.stderr)
        want_topics = ["/arena/session", "/arena/browser", "/arena/event", "/arena/frame", "/kinefly/raw", "/bias/cmd", "/bias/reply", "/bias/status",
                       "/scanimage/cmd", "/scanimage/reply", "/scanimage/status"]
        missing = [t for t in want_topics if not bagsum.get("topics", {}).get(t)]
        check("every stream recorded in the bag (session, browser, event, frame, kinefly, bias + scanimage cmd/reply/status)",
              not missing, f"missing {missing}")
        raw_ft = {t: n for t, n in bagsum.get("topics", {}).items() if t.startswith("/fictrac/")}
        check("raw FicTrac topics NOT recorded by default (2026-10-18: the merged /arena/frame record is the FicTrac record; --record-fictrac-raw opts in)",
              not any(raw_ft.values()), str(raw_ft))
        typed = any(s.startswith("rig_interfaces/") for s in bagsum.get("schemas", []))
        check("typed messages in the bag when rig_interfaces is built (else String fallback, reported)",
              True, "")
        print(f"  info  typed topics: {typed} ({bagsum.get('schemas')})", file=sys.stderr)
        fl = bagsum.get("frame_lag_ms") or {}
        check("recorder log_time lags the closed-loop node's own sample time (p99 < 20 ms; the record carries BOTH)", bool(fl) and fl.get("p99", 99) < 20.0, str(fl))
        # Fidelity: the converted export vs the live writer's shadow file.
        live_lines = read_jsonl_lines(disk[-1]) if disk else []
        conv_lines = read_jsonl_lines(export) if export.exists() else []
        cmpr = compare_logs(live_lines, conv_lines)
        print(f"[test] fidelity: {json.dumps(cmpr)}", file=sys.stderr)
        check("conversion fidelity: every sequenced line byte-identical to the live writer, in order",
              cmpr.get("sequenced_identical") and cmpr["lines_live"] > 0, f"first diff at sequenced line {cmpr.get('sequenced_first_diff')}")
        dms = cmpr.get("derived_dms") or {}
        # Derived lines carry the recorder's receive time; the live writer stamped them when its
        # loop got to them. The two drift apart only when the loop is busy (this run kills and
        # restarts an adapter and runs BIAS commands mid-stream): p99 ≤ 5 ms, worst ≤ 50 ms.
        check("conversion fidelity: derived lines (kf rows, BIAS events) same content, |Δms| p99 ≤ 5 ms (worst ≤ 50 ms)",
              cmpr.get("derived_content_equal") and cmpr["derived_live"] == cmpr["derived_conv"]
              and (not dms or (dms.get("p99", 99) <= 5 and dms.get("max", 999) <= 50)),
              f"live {cmpr['derived_live']} vs conv {cmpr['derived_conv']}, Δms {dms}")
        print(f"  info  byte-identical overall: {cmpr.get('byte_identical')}; derived lines placed after a different neighbour: {cmpr.get('derived_misplaced')} of {cmpr['derived_live']}", file=sys.stderr)

        events = [o for o in objs if isinstance(o, dict)]
        rows_ft = [o for o in objs if isinstance(o, list) and isinstance(o[0], (int, float))]
        rows_kf = [o for o in objs if isinstance(o, list) and o[0] == "kf"]
        rows_a = [o for o in objs if isinstance(o, list) and o[0] == "a"]
        by_type: dict[str, int] = {}
        for e in events:
            by_type[e.get("type", "?")] = by_type.get(e.get("type", "?"), 0) + 1
        print(f"[test] log: {len(objs)} lines — fictrac rows {len(rows_ft)}, arena echoes {len(rows_a)}, kf rows {len(rows_kf)}, events {by_type}", file=sys.stderr)
        check("FicTrac rows logged (every frame, not only applied)", len(rows_ft) > 40 * a.epochs, str(len(rows_ft)))
        # ── the merged FicTrac record (2026-10-18) ───────────────────────────────────
        ev = frame_extras_values(main_bag) if main_bag else {}
        check("merged record: err, dr_lab_x/y/z, ft_seq, ft_ns ride on every /arena/frame record and come from the SAME line as x/y/hd "
              "(wrap(Δhd) == dr_lab_z on ≥ 95 % of consecutive frames; ft_seq == fc; ft_ns monotonic)",
              ev.get("ok", False), json.dumps(ev))
        bad_row = any(isinstance(o, list) and isinstance(o[0], (int, float)) and o[1] == 424242 for o in objs)
        check("untracked frame (FT_BADFR) → one flagged /arena/frame record carrying its fc, and NO run-log row",
              ev.get("bad", 0) >= 1 and 424242 in ev.get("bad_fc", []) and not bad_row,
              json.dumps({"bad": ev.get("bad"), "bad_fc": ev.get("bad_fc"), "row_in_log": bad_row, "send_error": kill_report.get("bad_frame_send_error")}))
        cs_ft = [e for e in objs if isinstance(e, dict) and e.get("type") == "connector_status" and e.get("src") == "fictrac"]
        check("connector_status (fictrac) reports bad_frames ≥ 1", bool(cs_ft) and (cs_ft[-1].get("bad_frames") or 0) >= 1, str(cs_ft[-1] if cs_ft else None))
        check('["a",…] compact arena echoes logged', len(rows_a) > 40 * (a.epochs - 1), str(len(rows_a)))
        check('["kf",…] Kinefly rows logged (KF/1 → adapter → bridge)', len(rows_kf) > 100, str(len(rows_kf)))
        kf_ok = all(len(r) == 8 and isinstance(r[1], int) and isinstance(r[2], int) and r[4] is not None and r[5] is not None for r in rows_kf[:50])
        check("kf rows carry left/right wing angles", kf_ok)

        lost = [e for e in events if e.get("type") == "source_lost" and e.get("src") == "fictrac"]
        resumed = [e for e in events if e.get("type") == "source_resumed" and e.get("src") == "fictrac"]
        check("adapter SIGKILL mid-run → source_lost logged", len(lost) >= 1, json.dumps(kill_report))
        check("adapter restart → source_resumed logged", len(resumed) >= 1)
        check("log file ends with logging_stopped (intact after the kill)",
              bool(events) and events[-1].get("type") == "session" and events[-1].get("event") == "logging_stopped")

        bias_ev = [e for e in events if e.get("type") == "connector" and e.get("src") == "bias"]
        bias_rep = [e for e in bias_ev if e.get("kind") == "reply"]
        bias_st = [e for e in bias_ev if e.get("kind") == "status"]
        art = [e for e in bias_rep if isinstance(e.get("artifact"), dict)]
        check("BIAS command/reply pairs in the run log", len(bias_rep) >= 3, f"{len(bias_rep)} replies: {[r.get('command') for r in bias_rep]}")
        check("BIAS status lines in the run log", len(bias_st) >= 3, str(len(bias_st)))
        check("BIAS video artifact identity in the run log", any(str(e["artifact"].get("path", "")).endswith("poc_trial.avi") for e in art), json.dumps([e["artifact"] for e in art]))
        check("BIAS video file exists after stopRecording", (videos / "poc_trial.avi").exists(), str(list(videos.glob('*')) if videos.exists() else []))
        # The Studio runner's path (LAB-303 connectors): connector_command over the WebSocket →
        # /bias/cmd → /bias/reply → connector_reply to the asking client; both halves logged.
        ws_cmd = [e for e in bias_ev if e.get("kind") == "command"]
        ws_rep = [e for e in bias_rep if e.get("via") == "ws"]
        check("Studio-path connector commands logged (browser→bridge)", [e.get("command") for e in ws_cmd] == ["connect", "startRecording", "getTimestamp", "stopRecording", "bogusCommand"], str([e.get("command") for e in ws_cmd]))
        check("Studio-path replies logged with via=ws and the plugin name", len(ws_rep) >= 3 and all(e.get("plugin") == "camera" for e in ws_rep), f"{len(ws_rep)} via=ws replies")
        check("Studio-path startRecording video exists", (videos / "poc_studio.avi").exists(), str(list(videos.glob('*')) if videos.exists() else []))
        # Windows ww18 2026-10-15: the artifact named a file BIAS never wrote (its writer adds an
        # auto-naming suffix) and the per-frame timestamps stayed in a stamp log BIAS overwrites.
        stop_art = [e["artifact"] for e in bias_rep if e.get("command") == "stopRecording" and isinstance(e.get("artifact"), dict)]
        logs = [a.get("stamp_log") or {} for a in stop_art]
        check("stopRecording reports the video BIAS wrote + its frame-timestamp log (resolved, bytes, stamp_log.frames)",
              bool(stop_art) and all(a.get("resolved") and (a.get("bytes") or 0) > 0 and (s.get("frames") or 0) > 0 for a, s in zip(stop_art, logs)),
              json.dumps(stop_art)[:400])
        check("every frame timestamp of those stamp logs is in the bag (/bias/frames)",
              bool(logs) and bagsum.get("bias_frames_t") == sum(s.get("frames") or 0 for s in logs),
              f"bag {bagsum.get('bias_frames_t')} vs stamp logs {[s.get('frames') for s in logs]}")

        # The ScanImage connector (JSON server stand-in): the Studio-path sequence the 2P protocol uses.
        si_ev = [e for e in events if e.get("type") == "connector" and e.get("src") == "scanimage"]
        si_rep = [e for e in si_ev if e.get("kind") == "reply"]
        si_st = [e for e in si_ev if e.get("kind") == "status"]
        si_cmd = [e.get("command") for e in si_ev if e.get("kind") == "command"]
        check("ScanImage command/reply pairs in the run log (via=ws, plugin scanimage)", len(si_rep) >= 8 and all(e.get("via") == "ws" and e.get("plugin") == "scanimage" for e in si_rep), f"{len(si_rep)} replies: {[r.get('command') for r in si_rep]}")
        check("ScanImage status lines in the run log carry acqState", len(si_st) >= 2 and all("acqState" in e for e in si_st if e.get("reachable")), str(len(si_st)))
        check("Studio-path ScanImage commands logged in order", si_cmd == ["ping", "setFileStem", "set", "set", "grab", "waitIdle", "abort", "get", "ping", "bogusCommand"], str(si_cmd))
        grab = [e for e in si_rep if e.get("command") == "grab"]
        check("grab reply in the run log carries the TIFF artifact (stem, counter, path)", bool(grab) and grab[0].get("ok") and isinstance(grab[0].get("artifact"), dict)
              and grab[0]["artifact"].get("kind") == "tiff" and grab[0]["artifact"].get("stem") == "emu_violet_d7" and grab[0]["artifact"].get("counter") is not None, json.dumps([g.get("artifact") for g in grab]))
        unk = [e for e in si_rep if e.get("command") == "get"]
        check("ScanImage UNKNOWN outcome logged with the reconciled status", bool(unk) and unk[0].get("outcome") == "unknown" and isinstance(unk[0].get("reconciled"), dict), json.dumps(unk)[:300])
        cs = [e for e in events if e.get("type") == "connector_status" and e.get("src") == "fictrac"]
        p99 = cs[-1]["lat_ms"]["p99"] if cs else None
        check("connector_status: adapter→bridge latency p99 < 50 ms", p99 is not None and p99 < 50.0, str(cs[-1] if cs else None))

        # ── closed-loop report (root scripts/, stdlib only) ─────────────────────────
        rep = run_capture([PY, str(REPO / "scripts" / "closed-loop-report.py"), "--json", str(export)], timeout=60)
        check("closed-loop-report runs", rep.returncode == 0, rep.stderr[-300:])
        epochs = []
        if rep.returncode == 0:
            R = json.loads(rep.stdout)
            epochs = R.get("epochs", [])
            check(f"report finds {a.epochs} epochs from runner fictracApply", len(epochs) == a.epochs and R.get("epoch_source") == "runner fictracApply", f"{len(epochs)} ({R.get('epoch_source')})")
            for i, e in enumerate(epochs):
                interrupted = i == 1
                mism = e.get("idx_mismatch_fraction")
                rows = e.get("rows") or 0
                # The report's epoch opens at the fictracApply event's ms. A FicTrac row
                # computed with the PREVIOUS mapping can carry that same ms (it is written
                # before the config line in the file — the bridge handled it first), and the
                # report then reconstructs it with the new epoch's bias/tare. That is one row
                # of 1 ms resolution at the boundary, identical with bridge 3.4; the mapping
                # itself is exact, so the bar is "≤ 1 boundary row", not literally 0.
                n_mism = round((mism or 0.0) * rows) if rows else (0 if mism == 0.0 else 99)
                check(f"epoch {i} ({e.get('condition')}): idx reconstruction exact (≤ 1 boundary row of {rows})", n_mism <= 1, f"fraction {mism}")
                rej = e.get("rejection")
                if not interrupted:
                    check(f"epoch {i}: model fly rejects the bias (rejection > 0.8)", rej is not None and rej > 0.8, str(rej))
                else:
                    print(f"  info  epoch {i} (adapter killed for {a.kill_for}s): rejection {rej}, rows {e.get('rows')}", file=sys.stderr)
            md = run_capture([PY, str(REPO / "scripts" / "closed-loop-report.py"), str(export)], timeout=60).stdout
            (work / "closed-loop-report.md").write_text(md, encoding="utf-8")

        # ── format: convert round trip + JS readers ─────────────────────────────────
        v1 = work / "export.v1.jsonl"
        v2 = work / "export.v2.jsonl"
        c1 = run_capture([PY, str(BRIDGE_PY), "--convert", str(export), str(v1)])
        c2 = run_capture([PY, str(BRIDGE_PY), "--convert", str(v1), str(v2)]) if c1.returncode == 0 else None
        check("bridge.py --convert v2→v1→v2 byte-identical", c2 is not None and c2.returncode == 0 and v2.read_bytes() == export.read_bytes(),
              (c1.stderr + (c2.stderr if c2 else ""))[-300:])
        # ── log levels are a converter option; order modes ───────────────────────────
        conv = [PY, str(NODES / "mcap_convert.py"), str(main_bag)]
        bv1 = work / "bag.v1.jsonl"
        bfull = work / "bag.full.jsonl"
        btime = work / "bag.time.jsonl"
        r1 = run_capture(conv + ["--level", "behavior_v1", "--out", str(bv1)])
        check("bag → behavior_v1 == bridge.py --convert of the behavior_v2 (byte-identical)",
              r1.returncode == 0 and c1.returncode == 0 and bv1.read_bytes() == v1.read_bytes(), r1.stderr[-200:])
        rf = run_capture(conv + ["--level", "full", "--out", str(bfull)])
        check("bag → full level REFUSED without the raw FicTrac topics (the error names --record-fictrac-raw)",
              rf.returncode != 0 and "--record-fictrac-raw" in rf.stderr, rf.stderr[-200:])
        # A bag from before 2026-10-18 (two records per frame, raw FicTrac topic present) still
        # converts, full level included. The bench bags are untracked: checked when present.
        old_bags = [b for b in sorted((POC / "runlogs").glob("arena-log-20261014-*.bag")) if (b / "metadata.yaml").exists()]
        if old_bags:
            ob = old_bags[0]
            ob_out, ob_full = work / "oldbag.v2.jsonl", work / "oldbag.full.jsonl"
            r_ob = run_capture([PY, str(NODES / "mcap_convert.py"), str(ob), "--out", str(ob_out)], timeout=180)
            r_of = run_capture([PY, str(NODES / "mcap_convert.py"), str(ob), "--level", "full", "--out", str(ob_full)], timeout=180)
            ob_rows = sum(1 for o in read_jsonl(ob_out) if isinstance(o, list) and isinstance(o[0], (int, float))) if r_ob.returncode == 0 else 0
            of_ff = [o for o in (read_jsonl(ob_full) if r_of.returncode == 0 else []) if isinstance(o, dict) and o.get("type") == "fictrac_frame"]
            n25 = sum(1 for o in of_ff if len(o.get("fictrac") or []) == 25)
            # ww18 2026-10-15: one frame per bag may lack its raw record (a line that arrived just before the open).
            check(f"pre-2026-10-18 bag ({ob.name}) still converts; its full level carries the 25 FicTrac columns",
                  r_ob.returncode == 0 and ob_rows > 0 and r_of.returncode == 0 and len(of_ff) == ob_rows and n25 >= len(of_ff) - 1,
                  f"rc {r_ob.returncode}/{r_of.returncode}, rows {ob_rows}, full frames {len(of_ff)}, with 25 cols {n25}")
        else:
            print("  skip  pre-2026-10-18 bag check: no runlogs/arena-log-20261014-*.bag in this checkout (the bench bags are untracked)", file=sys.stderr)
        rt = run_capture(conv + ["--order", "time", "--out", str(btime)])
        time_lines = read_jsonl_lines(btime) if rt.returncode == 0 else []
        swaps = sum(1 for x, y in zip(conv_lines, time_lines) if x != y)
        check("order `time` (a separate closed-loop process would need it): same lines as the live order",
              rt.returncode == 0 and sorted(time_lines) == sorted(conv_lines), rt.stderr[-200:])
        rep_t = run_capture([PY, str(REPO / "scripts" / "closed-loop-report.py"), "--json", str(btime)], timeout=60)
        same_report = rep.returncode == 0 and rep_t.returncode == 0 and json.loads(rep.stdout).get("epochs") == json.loads(rep_t.stdout).get("epochs")
        check("order `time`: closed-loop report identical to the live-order report", same_report, rep_t.stderr[-200:])
        print(f"  info  order time vs seq: {swaps} of {len(conv_lines)} positions differ (same-ms ties)", file=sys.stderr)
        ver = run_capture([PY, str(BRIDGE_PY), "--version"])
        check("bridge 3.4 side by side: fictrac-bridge/bridge.py --version still 3.4", (ver.stdout + ver.stderr).strip().startswith("fictrac-bridge 3.4"), (ver.stdout + ver.stderr)[:80])

        js_argv = None
        node_bin = find_node()
        if node_bin:
            js_argv = [node_bin, str(HERE / "check_runlog_readers.js"), str(export), "--expect-kf"]
        if js_argv:
            js = run_capture(js_argv, timeout=120, cwd=REPO)
            check("JS readers (runlog-format normalizer + runlog-replay parser) accept every line", js.returncode == 0, (js.stdout + js.stderr)[-500:])
            print("  " + (js.stdout.strip().splitlines() or [""])[-1][:300], file=sys.stderr)
        else:
            print("  skip  JS reader check: no `node` and no root pixi env (run `pixi install` at the repo root)", file=sys.stderr)

        # Plan B item 3/4: typed topics when the interfaces package is built in this env.
        ifc = run_capture([PY, str(NODES / "build_interfaces.py"), "--check"], timeout=60)
        have_ifaces = ifc.returncode == 0
        if have_ifaces:
            check("typed: rig_interfaces importable → ArenaFrame recorded in the bag (and no FicTracFrame by default)",
                  typed and bagsum.get("topics", {}).get("/arena/frame", 0) > 0 and not bagsum.get("topics", {}).get("/fictrac/frame"), str(bagsum.get("schemas")))
            tv = typed_frame_values(main_bag) if main_bag else {}
            check("typed: ArenaFrame VALUES decode from the bag's own schema — core fields finite, fc monotonic, "
                  "turning_dps/forward_mms NaN in the bag (live-only)",
                  tv.get("ok", False), json.dumps(tv))
        else:
            print("  info  rig_interfaces not importable here: String topics used (pixi install builds it on osx/linux; Windows needs MSVC)", file=sys.stderr)
        fd = frame_deriver_values()
        check("FrameDeriver (live turning_dps / forward_mms): NaN on the first frame, kinematics.js's numbers on the second", fd.get("ok", False), json.dumps(fd))
        # Size: the FicTrac record alone in the final layout. The guard is an absolute per-frame budget
        # (adding one incompressible double costs ≈ 8 B/frame): 72 B/frame compressed, against the
        # 63.7 B/frame this 25 s run measured on 2026-10-18 (≈ 3 B of that is the file's fixed overhead
        # spread over 1 084 frames) and the bench bags' ≈ 45-55 (docs/development/fictrac-columns-in-the-
        # bag.md §3). The ratio to the gzip of the frame rows is reported only — it swings with the
        # fly's dynamics and a short run's fixed overhead. The String path's JSON record is reported only.
        sz = frame_record_size(main_bag, export) if main_bag and export.exists() else {}
        if sz.get("frames"):
            sz["bytes_per_frame"] = round(sz["bag_frame_bytes"] / sz["frames"], 1)
        whole = {"bag_bytes": bagsum.get("bytes"), "export_gz": len(__import__("gzip").compress(export.read_bytes(), 9)) if export.exists() else None}
        print(f"  info  size: frame records {json.dumps(sz)}; whole bag (incl. kinefly/bias/browser) {json.dumps(whole)}", file=sys.stderr)
        if typed:
            check("size: /arena/frame records in the final layout (chunk-only index, zstd 19) ≤ 72 B/frame compressed", bool(sz) and (sz.get("bytes_per_frame") or 999) <= 72.0, json.dumps(sz))

        # ── host monitor (/rig/host, rig_nodes.host_monitor) ─────────────────────────────
        hm = host_monitor_values(main_bag) if main_bag and host_mon else {}
        if host_mon:
            print(f"  info  host monitor: {json.dumps({k: v for k, v in hm.items() if k not in ('fields_ok', 'groups')})}", file=sys.stderr)
            check("host monitor: /rig/host recorded in the bag, ≥ 0.8 samples per second of the run",
                  (hm.get("samples") or 0) >= 0.8 * (hm.get("run_s") or 99), f"{hm.get('samples')} samples over {hm.get('run_s')} s")
            check("host monitor: every sample has the HostStats fields (the installed rig_interfaces' when typed)",
                  hm.get("fields_ok", False), str(hm.get("bad_fields")))
            check("host monitor: one entry per logical CPU, busiest sub-window ≥ the window mean on every core",
                  hm.get("cores_ok", False), f"{hm.get('ncpu')} CPUs")
            check("host monitor: the graph's processes pinned by script (py:bridge_node, py:fictrac_udp_adapter, py:host_monitor)",
                  {"py:bridge_node", "py:fictrac_udp_adapter", "py:host_monitor"} <= set(hm.get("groups") or []), str(hm.get("groups")))
            check("host monitor cost: its own CPU ≤ 2 % of one core (median after the first 2 samples)",
                  hm.get("self_cpu_median") is not None and hm["self_cpu_median"] <= 0.02, f"median {hm.get('self_cpu_median')} max {hm.get('self_cpu_max')} cores")
            check("host monitor storage: /rig/host ≤ 5 % of the run's compressed payload (zstd, as the bag)",
                  hm.get("share_compressed") is not None and hm["share_compressed"] <= 0.05, f"{hm.get('share_compressed')} ({hm.get('host_kb_per_h_zstd')} KB/h)")
        check("bridge node still alive at the end of the main run", bridge.alive())

        # ── crash phase: SIGKILL the bridge node mid-run, both writer profiles ────────
        crash_results: dict = {}
        if not a.no_crash:
            bridge.stop()
            for profile in ("crashsafe", "default"):
                for f in runlogs.glob("arena-log-*"):
                    pass  # earlier runs stay; we pick the newest below
                before = set(runlogs.glob("arena-log-*.jsonl"))
                cb = start(f"bridge-crash-{profile}", [PY, str(NODES / "bridge_node.py"), "--log-dir", str(runlogs), "--source-timeout", "1.5", "--bag-profile", profile])
                check(f"crash phase ({profile}): bridge node serving", wait_port("127.0.0.1", 8765, 20.0))
                time.sleep(1.5)
                em_out = work / f"crash-{profile}.export.jsonl"
                em_thread = threading.Thread(
                    target=lambda: run_capture([PY, str(HERE / "studio_emulator.py"), "--epochs", "1", "--epoch-s", "6", "--iti-s", "0",
                                                "--bias-amplitude", "90", "--min-frames", "1", "--out", str(em_out)], timeout=60),
                    daemon=True)
                em_thread.start()
                # Anchor: the run's fictracApply line in the NEW shadow file, then 2.5 s of closed loop.
                end = time.monotonic() + 30
                shadow = None
                while time.monotonic() < end and shadow is None:
                    new = sorted(set(runlogs.glob("arena-log-*.jsonl")) - before)
                    if new:
                        try:
                            if any('"op":"fictracApply"' in l and '"value":true' in l for l in new[-1].read_text(encoding="utf-8").splitlines()):
                                shadow = new[-1]
                        except OSError:
                            pass
                    time.sleep(0.1)
                time.sleep(2.5)
                t_kill = time.time()
                cb.kill9()
                em_thread.join(timeout=20)
                bag = Path(str(shadow)[:-6] + ".bag") if shadow else None
                res = {"profile": profile, "shadow": str(shadow), "bag": str(bag), "killed_epoch_ms": int(t_kill * 1000)}
                if shadow and shadow.exists():
                    raw = shadow.read_text(encoding="utf-8", errors="replace")
                    lines = raw.split("\n")
                    torn_last = bool(lines and lines[-1].strip())  # no trailing newline → a torn line
                    good = []
                    for l in lines:
                        if not l.strip():
                            continue
                        try:
                            good.append(json.loads(l))
                        except json.JSONDecodeError:
                            pass
                    res["ndjson"] = {"lines": len(good), "frames": sum(1 for o in good if isinstance(o, list) and isinstance(o[0], (int, float))), "torn_last_line": torn_last,
                                     "last_frame_ms": max([o[0] for o in good if isinstance(o, list) and isinstance(o[0], (int, float))] or [None])}
                rc = run_capture([PY, str(NODES / "mcap_convert.py"), str(bag), "--recover", "--out", str(work / f"crash-{profile}.recovered.jsonl")], timeout=60) if bag and bag.exists() else None
                if rc is not None and rc.returncode == 0:
                    rep_line = rc.stderr.strip().splitlines()[-1]
                    try:
                        R = json.loads(rep_line)
                    except json.JSONDecodeError:
                        R = {"raw": rep_line}
                    rec_objs = read_jsonl(work / f"crash-{profile}.recovered.jsonl")
                    res["mcap"] = {"records": R.get("bag_records"), "lines": R.get("lines"), "frames": R.get("frames"), "torn": R.get("torn"),
                                   "last_frame_ms": max([o[0] for o in rec_objs if isinstance(o, list) and isinstance(o[0], (int, float))] or [None])}
                    res["mcap_files"] = [f.name for f in bag.glob("*")]
                else:
                    res["mcap"] = {"error": (rc.stderr[-300:] if rc else "no bag")}
                    res["mcap_files"] = [f.name for f in bag.glob("*")] if bag and bag.exists() else []
                crash_results[profile] = res
                print(f"[test] crash ({profile}): {json.dumps(res)}", file=sys.stderr)
                nd, mc = res.get("ndjson") or {}, res.get("mcap") or {}
                if profile == "crashsafe":
                    check("crash (crashsafe profile): --recover + convert salvages the run up to the kill (frames within 10 of the NDJSON, file intact)",
                          mc.get("frames") is not None and nd.get("frames") is not None and nd["frames"] - mc["frames"] <= 10 and mc["frames"] > 0,
                          f"ndjson frames {nd.get('frames')} vs recovered {mc.get('frames')}")
                    # ── auto-recovery on export (LAB-303 adoption week): the rig restarts the bridge
                    # node after a crash; the Studio's (or `pixi run export`'s) next log_export must get
                    # the salvaged run WITHOUT anyone running --recover by hand, flagged `recovered:true`,
                    # and leave a whole bag behind (metadata.yaml + index) for every later reader.
                    cb2 = start("bridge-restart", [PY, str(NODES / "bridge_node.py"), "--log-dir", str(runlogs), "--source-timeout", "1.5", "--bag-profile", profile])
                    restart_ok = wait_port("127.0.0.1", 8765, 20.0)
                    rx_out = work / "crash-crashsafe.restart-export.jsonl"
                    rx = run_capture([PY, str(NODES / "export_log.py"), "--json", "--out", str(rx_out)], timeout=60) if restart_ok else None
                    meta: dict = {}
                    if rx is not None and rx.returncode == 0:
                        try:
                            meta = json.loads(rx.stdout.strip().splitlines()[-1])
                        except (json.JSONDecodeError, IndexError):
                            meta = {"raw": rx.stdout[-200:]}
                    rx_objs = read_jsonl(rx_out) if rx_out.exists() else []
                    rx_frames = sum(1 for o in rx_objs if isinstance(o, list) and isinstance(o[0], (int, float)))
                    marker = next((o for o in rx_objs if isinstance(o, dict) and o.get("type") == "session" and o.get("event") == "recovered"), None)
                    rec = meta.get("recovery") or {}
                    res["restart_export"] = {"rc": rx.returncode if rx else None, "recovered": meta.get("recovered"), "whole": rec.get("whole"),
                                             "salvaged_records": rec.get("salvaged_records"), "frames": rx_frames, "marker": bool(marker),
                                             "reason": rec.get("reason")}
                    check("crash (crashsafe): a restarted bridge node recovers the unclosed bag on log_export itself (recovered:true, frames == --recover, `recovered` session marker)",
                          restart_ok and meta.get("recovered") is True and rec.get("whole") is True and rx_frames == mc.get("frames") and marker is not None,
                          json.dumps(res["restart_export"]))
                    plain = run_capture([PY, str(NODES / "mcap_convert.py"), str(bag), "--out", str(work / "crash-crashsafe.plain.jsonl")], timeout=60)
                    plain_frames = sum(1 for o in read_jsonl(work / "crash-crashsafe.plain.jsonl") if isinstance(o, list) and isinstance(o[0], (int, float))) if plain.returncode == 0 else None
                    indexed = False
                    try:
                        from mcap.reader import make_reader

                        for f in bag.glob("*.mcap"):
                            with open(f, "rb") as fh:
                                summ = make_reader(fh).get_summary()
                                indexed = summ is not None and bool(summ.chunk_indexes)
                    except Exception as exc:
                        res["restart_export"]["index_error"] = repr(exc)
                    bak = [f.name for f in bag.glob("*.torn.bak")]
                    res["restart_export"].update({"metadata_yaml": (bag / "metadata.yaml").exists(), "indexed": indexed, "plain_frames": plain_frames, "torn_bak": bak})
                    check("crash (crashsafe): the recovered bag is whole — metadata.yaml, chunk index, converts WITHOUT --recover to the same frames, torn original kept as .torn.bak",
                          (bag / "metadata.yaml").exists() and indexed and plain.returncode == 0 and plain_frames == rx_frames and len(bak) == 1,
                          json.dumps({k: res["restart_export"][k] for k in ("metadata_yaml", "indexed", "plain_frames", "torn_bak")}))
                    cb2.stop()
                else:
                    print(f"  info  crash (default profile): NDJSON kept {nd.get('frames')} frames; the bag's recovered frames: {mc.get('frames')} "
                          f"(rosbag2 defaults buffer a 768 KiB chunk + a message cache until close)", file=sys.stderr)
                check(f"crash ({profile}): the line-buffered NDJSON lost at most its last line", nd.get("lines", 0) > 0, str(nd))
            (work / "crash-results.json").write_text(json.dumps(crash_results, indent=1), encoding="utf-8")
    finally:
        for pr in reversed(procs):
            pr.stop()
        for pr in procs:
            pr.log.close()

    n_ok = sum(1 for _, ok, _ in results if ok)
    print(f"\n{n_ok} / {len(results)} checks passed", file=sys.stderr)
    summary = ["| check | result |", "|---|---|"] + [f"| {n} | {'PASS' if ok else 'FAIL — ' + i.replace('|', '/')[:120]} |" for n, ok, i in results]
    (work / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print("\n".join(summary))
    if not a.keep and n_ok == len(results):
        shutil.rmtree(work, ignore_errors=True)
    else:
        print(f"[test] artifacts kept in {work}", file=sys.stderr)
    return 0 if n_ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
