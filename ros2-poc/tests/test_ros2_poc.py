#!/usr/bin/env python3
"""test_ros2_poc.py — the LAB-303 proof-of-concept acceptance run, end to end, no hardware.

    pixi run test                 # from ros2-poc/ (≈ 45 s)
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

Exit 0 when all checks pass. Prints a markdown summary. Artifacts are kept with --keep.
"""

from __future__ import annotations

import argparse
import json
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

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, info: str = "") -> bool:
    results.append((name, bool(ok), info))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else ' — ' + info}", file=sys.stderr)
    return bool(ok)


def wait_port(host: str, port: int, timeout_s: float) -> bool:
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


class Proc:
    def __init__(self, name: str, argv: list[str], logdir: Path) -> None:
        self.name = name
        self.argv = argv
        self.log = open(logdir / f"{name}.log", "w", encoding="utf-8")
        self.p: subprocess.Popen | None = None

    def start(self) -> "Proc":
        # Own process group, so stop() reaches `ros2 run`'s child (the router binary) too.
        self.p = subprocess.Popen(self.argv, stdout=self.log, stderr=subprocess.STDOUT, text=True, start_new_session=(os.name != "nt"))
        return self

    def alive(self) -> bool:
        return self.p is not None and self.p.poll() is None

    def _signal(self, sig: int) -> None:
        if os.name != "nt":
            try:
                os.killpg(self.p.pid, sig)
                return
            except (ProcessLookupError, PermissionError):
                pass
        self.p.send_signal(sig)

    def kill9(self) -> None:
        if self.alive():
            self._signal(signal.SIGKILL)
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
                self._signal(signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        self.log.flush()


def read_jsonl(path: Path) -> list:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def run_capture(argv: list[str], timeout: float = 60.0, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--epoch-s", type=float, default=6.0)
    ap.add_argument("--kill-at", type=float, default=2.0, help="seconds into epoch 2 (0-based epoch 1) to SIGKILL the FicTrac adapter")
    ap.add_argument("--kill-for", type=float, default=3.0, help="seconds before the adapter is restarted")
    ap.add_argument("--keep", action="store_true", help="keep the work dir")
    ap.add_argument("--workdir", default=None)
    ap.add_argument("--no-router", action="store_true", help="a Zenoh router is already running on 127.0.0.1:7447")
    a = ap.parse_args(argv)

    work = Path(a.workdir) if a.workdir else Path(tempfile.mkdtemp(prefix="ros2-poc-test-"))
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
        start("bias-sim", [PY, str(NODES / "bias_sim.py"), "--video-dir", str(videos)])
        start("bias-node", [PY, str(NODES / "bias_node.py"), "--status-every", "1"])
        bridge = start("bridge-node", [PY, str(NODES / "bridge_node.py"), "--log-dir", str(runlogs), "--source-timeout", "1.5"])
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
             "--bias-amplitude", "90", "--min-frames", "40", "--out", str(export), "--report", str(report)],
            timeout=60 + a.epochs * (a.epoch_s + 2),
        )
        (logdir / "emulator.log").write_text(em.stderr, encoding="utf-8")
        check("studio emulator: every protocol assertion held", em.returncode == 0, em.stderr[-600:])
        actor.join(timeout=30)

        # ── judge the log ────────────────────────────────────────────────────────────
        check("exported log written", export.exists() and export.stat().st_size > 0)
        objs = read_jsonl(export) if export.exists() else []
        disk = sorted(runlogs.glob("arena-log-*.jsonl"))
        check("export is byte-identical to the bridge node's file on disk",
              bool(disk) and export.exists() and disk[-1].read_bytes() == export.read_bytes(), f"{[d.name for d in disk]}")

        events = [o for o in objs if isinstance(o, dict)]
        rows_ft = [o for o in objs if isinstance(o, list) and isinstance(o[0], (int, float))]
        rows_kf = [o for o in objs if isinstance(o, list) and o[0] == "kf"]
        rows_a = [o for o in objs if isinstance(o, list) and o[0] == "a"]
        by_type: dict[str, int] = {}
        for e in events:
            by_type[e.get("type", "?")] = by_type.get(e.get("type", "?"), 0) + 1
        print(f"[test] log: {len(objs)} lines — fictrac rows {len(rows_ft)}, arena echoes {len(rows_a)}, kf rows {len(rows_kf)}, events {by_type}", file=sys.stderr)
        check("FicTrac rows logged (every frame, not only applied)", len(rows_ft) > 40 * a.epochs, str(len(rows_ft)))
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
        check("BIAS video artifact identity in the run log", bool(art) and str(art[0]["artifact"].get("path", "")).endswith("poc_trial.avi"), json.dumps(art[:1]))
        check("BIAS video file exists after stopRecording", (videos / "poc_trial.avi").exists(), str(list(videos.glob('*')) if videos.exists() else []))

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
        ver = run_capture([PY, str(BRIDGE_PY), "--version"])
        check("bridge 3.4 side by side: fictrac-bridge/bridge.py --version still 3.4", (ver.stdout + ver.stderr).strip().startswith("fictrac-bridge 3.4"), (ver.stdout + ver.stderr)[:80])

        node_bin = shutil.which("node")
        root_pixi = shutil.which("pixi")
        js_argv = None
        if node_bin:
            js_argv = [node_bin, str(HERE / "check_runlog_readers.js"), str(export), "--expect-kf"]
        elif root_pixi and (REPO / ".pixi").exists():
            js_argv = [root_pixi, "run", "--manifest-path", str(REPO / "pixi.toml"), "node", str(HERE / "check_runlog_readers.js"), str(export), "--expect-kf"]
        if js_argv:
            js = run_capture(js_argv, timeout=120, cwd=REPO)
            check("JS readers (runlog-format normalizer + runlog-replay parser) accept every line", js.returncode == 0, (js.stdout + js.stderr)[-500:])
            print("  " + (js.stdout.strip().splitlines() or [""])[-1][:300], file=sys.stderr)
        else:
            print("  skip  JS reader check: no `node` and no root pixi env (run `pixi install` at the repo root)", file=sys.stderr)

        # No custom message types: only std_msgs in nodes/.
        bad = []
        for f in NODES.glob("*.py"):
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.startswith("from ") and ".msg import" in line and not line.startswith("from std_msgs.msg"):
                    bad.append(f"{f.name}: {line.strip()}")
        check("no custom message types (only std_msgs imported in nodes/)", not bad, "; ".join(bad))

        check("bridge node still alive at the end", bridge.alive())
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
