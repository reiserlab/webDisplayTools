#!/usr/bin/env python3
"""soak_graph.py — hours of the rig graph with the Studio emulator knocking every few minutes.

    pixi run soak                                   # 2 h, an emulator run every 5 min, FicTrac + BIAS simulated
    pixi run -e lyrical soak -- --hours 8 --every 10  # the Lyrical rehearsal on a rig PC, overnight
    pixi run soak -- --fictrac                      # real FicTrac on UDP 60000 instead of the simulator

What it does: starts `nodes/rig.py` (router, FicTrac simulator at 100 Hz or the real FicTrac
adapter, BIAS simulator + node, host monitor, the gateway) ONCE and leaves it running; every
`--every` minutes it drives one recorded run through the gateway with `tests/studio_emulator.py`
(two epochs, connector commands), exactly the Studio's conversation; at the end it stops the graph
the way a rig does (SIGINT / CTRL_BREAK through the process group) and collects the gateway's own
frame accounting. Written for the failure modes a new middleware or Python brings: an emulator run
that cannot connect, times out (an rmw_wait hang looks like this), applies fewer frames than the
others, or a graph that exits by itself. Nothing here needs a controller or a browser.

Output: `runlogs/soak-<stamp>/` with `rig.log` (the graph's stdout), one `report-NNN.json` +
`export-NNN.jsonl` per emulator run, and `soak.json` (environment, every run, the gateway's
shutdown summary). Exit 0 when every run passed and the graph stopped cleanly.

One ROS graph per host: refuse to start if 7447 / 8765 / 60000 are taken (rig_nodes.supervise.preflight).
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from rig_nodes.supervise import popen_group, preflight, signal_group, wait_port

HERE = Path(__file__).resolve().parent
RIG = HERE.parent


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=float, default=2.0, help="how long the graph runs")
    ap.add_argument("--every", type=float, default=5.0, help="minutes between emulator runs")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--epoch-s", type=float, default=8.0)
    ap.add_argument("--fictrac", action="store_true", help="real FicTrac on UDP 60000 (default: the simulator at --rate)")
    ap.add_argument("--rate", type=int, default=100, help="simulated FicTrac rate (Hz)")
    ap.add_argument("--no-bias", action="store_true", help="skip the BIAS simulator + node (and the connector commands)")
    ap.add_argument("--out", default=None, help="result directory (default runlogs/soak-<stamp>)")
    ap.add_argument("--rig-args", default="", help="extra arguments for nodes/rig.py")
    a = ap.parse_args(argv)

    out = Path(a.out) if a.out else RIG / "runlogs" / time.strftime("soak-%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    taken = preflight([("tcp", 7447, "a Zenoh router (another graph)"), ("tcp", 8765, "a Studio gateway"),
                       ("udp", 60000, "a FicTrac receiver")])
    if taken:
        print("[soak] refusing to start:\n  " + "\n  ".join(taken), file=sys.stderr)
        return 2

    rig_argv = [sys.executable, str(RIG / "nodes" / "rig.py"), "--bridge-args", f"--log-dir {out / 'runlogs'}"]
    if not a.fictrac:
        rig_argv += ["--sim", "--sim-args", f"--proto udp --rate {a.rate}"]
    if not a.no_bias:
        rig_argv += ["--bias", "--bias-sim"]
    rig_argv += a.rig_args.split()
    log = open(out / "rig.log", "w", encoding="utf-8", errors="replace")
    rig = popen_group(rig_argv, stdout=log, stderr=subprocess.STDOUT, cwd=str(RIG))
    t_start = time.time()
    up = wait_port("127.0.0.1", 7447, 30.0) and wait_port("127.0.0.1", 8765, 60.0)
    print(f"[soak] {out}  graph up: {up}  ({' '.join(rig_argv[1:])})", flush=True)
    runs: list[dict] = []
    if up:
        time.sleep(3.0)
        deadline = t_start + a.hours * 3600
        n = 0
        while time.time() < deadline and rig.poll() is None:
            n += 1
            rep = out / f"report-{n:03d}.json"
            em_argv = [sys.executable, str(HERE / "studio_emulator.py"), "--epochs", str(a.epochs), "--epoch-s", str(a.epoch_s),
                       "--out", str(out / f"export-{n:03d}.jsonl"), "--report", str(rep)]
            if not a.no_bias:
                em_argv.append("--connector-cmds")
            t0 = time.time()
            try:
                em = subprocess.run(em_argv, capture_output=True, text=True, cwd=str(RIG), timeout=120 + a.epochs * (a.epoch_s + 2) * 2)
                rc, timed_out, tail = em.returncode, False, (em.stdout + em.stderr)[-400:]
            except subprocess.TimeoutExpired as exc:
                rc, timed_out, tail = None, True, str(exc)[-400:]
            r: dict = {}
            if rep.exists():
                try:
                    r = json.loads(rep.read_text(encoding="utf-8"))
                except ValueError:
                    r = {}
            row = {"n": n, "t_min": round((t0 - t_start) / 60, 1), "rc": rc, "timed_out": timed_out,
                   "ok": r.get("ok"), "applied": r.get("applied"), "secs": round(time.time() - t0, 1)}
            runs.append(row)
            good = rc == 0 and bool(r.get("ok"))
            print("[soak]", json.dumps(row), "" if good else "  " + tail.replace("\n", " | "), flush=True)
            if rig.poll() is not None:
                print(f"[soak] the graph EXITED on its own: {rig.returncode}", flush=True)
                break
            time.sleep(max(0.0, a.every * 60 - (time.time() - t0)))

    stop = "n/a"
    if rig.poll() is None:
        signal_group(rig, signal.SIGINT)
        try:
            rig.wait(30)
            stop = f"clean exit {rig.returncode}"
        except subprocess.TimeoutExpired:
            signal_group(rig, signal.SIGTERM)
            try:
                rig.wait(10)
                stop = f"needed SIGTERM, exit {rig.returncode}"
            except subprocess.TimeoutExpired:
                rig.kill()
                stop = "killed"
    else:
        stop = f"exited on its own {rig.returncode}"
    log.close()
    lines = (out / "rig.log").read_text(encoding="utf-8", errors="replace").splitlines()
    keep = ("[bridge-node] {", "shutting down", "samples published", "lines,", "commands handled", "Traceback", "ERROR", "rmw_wait", "stopped")
    summary = [ln for ln in lines if any(k in ln for k in keep)]
    ok_runs = sum(1 for r in runs if r["rc"] == 0 and r["ok"])
    result = {
        "env": {k: os.environ.get(k) for k in ("ROS_DISTRO", "RMW_IMPLEMENTATION", "PIXI_ENVIRONMENT_NAME", "COMPUTERNAME", "HOSTNAME")},
        "python": sys.version.split()[0], "platform": sys.platform, "graph_argv": rig_argv[1:], "graph_up": up,
        "hours": round((time.time() - t_start) / 3600, 2), "runs": runs, "ok_runs": ok_runs, "stop": stop,
        "summary_lines": summary[-40:],
    }
    try:
        from rig_nodes.runtime import runtime_info  # rig-nodes ≥ the distro-switch branch

        result["runtime"] = runtime_info()
    except Exception:
        pass
    (out / "soak.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"[soak] {ok_runs}/{len(runs)} emulator runs ok over {result['hours']} h; graph {stop}; report {out / 'soak.json'}", flush=True)
    for ln in summary[-12:]:
        print("   ", ln[:200])
    return 0 if up and runs and ok_runs == len(runs) and stop.startswith("clean") else 1


if __name__ == "__main__":
    raise SystemExit(main())
