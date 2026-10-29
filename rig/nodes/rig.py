#!/usr/bin/env python3
"""rig.py — the one command an ARENA rig runs: Zenoh router + adapters + the Studio gateway, supervised.

    pixi run rig                       # router, fictrac adapter, bridge node
    pixi run rig -- --kinefly --bias   # + Kinefly adapter + BIAS node
    pixi run rig -- --sim              # + the FicTrac simulator (demo without a camera)
    pixi run rig -- --bias --bias-sim  # + a simulated BIAS program (no camera software)
    pixi run rig -- --scanimage        # + the ScanImage node (JSON server on this PC); --si-mock for a stand-in
    pixi run rig -- --foxglove         # + foxglove_bridge (:8766) from the `viz` environment

This file is the arena rig's COMPOSITION (rig-software-repos-and-runners.md §3.2): which nodes an
arena rig runs, in which order, and what happens when one dies. The device nodes and simulators
come from the installed `rig_nodes` package (reiserlab/rig-nodes) and are started as
`python -m rig_nodes.<module>`; the mechanics — process groups, portable signals, the port
preflight, the supervised Child — are `rig_nodes.supervise`. What stays here is policy: the
gateway (bridge_node.py, this directory) and the arena visualization (viz_node.py) are this rig's
own nodes, and the rig exits when the gateway or the router dies (the Studio's WebSocket is gone,
nothing else matters).

Order: the router first (nodes retry until it answers on 127.0.0.1:7447), then every
adapter/node. Each child's stderr is prefixed with its name. Ctrl-C stops everything in
reverse order; a child that dies on its own is reported. Options after a child's name are
passed through, e.g. `--bridge-args "--frames 60"`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import sys
import threading
import time
from pathlib import Path

from rig_nodes import zenoh
from rig_nodes.supervise import Child, preflight, split_args, wait_port

HERE = Path(__file__).resolve().parent
NODES = HERE
ROOT = HERE.parent  # rig/ (the pixi workspace)
# `pixi install -e viz` puts foxglove_bridge in a sibling of the env this runs in: under
# .pixi/envs, or under the `detached-environments` directory when one is configured (the
# Windows short-path setup, WINDOWS-TEST.md).
_ENVS = Path(os.environ["CONDA_PREFIX"]).parent if os.environ.get("CONDA_PREFIX") else ROOT / ".pixi" / "envs"
VIZ_ENV = _ENVS / "viz"
FOXGLOVE_PORT = 8766


def node_argv(module: str, *args: str) -> list[str]:
    """A rig_nodes module as a child process of THIS interpreter (the installed package)."""
    return [sys.executable, "-m", module, *args]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--kinefly", action="store_true", help="also run the Kinefly KF/1 adapter")
    p.add_argument("--bias", action="store_true", help="also run the BIAS camera node")
    p.add_argument("--bias-sim", action="store_true", help="also run the BIAS simulator (a fake BIAS program)")
    p.add_argument("--scanimage", action="store_true", help="also run the ScanImage node (talks to ScanImage's JSON server, default 127.0.0.1:5555)")
    p.add_argument("--si-mock", action="store_true", help="also run the ScanImage JSON-server stand-in (port 5555)")
    p.add_argument("--sim", action="store_true", help="also run the FicTrac simulator (random walk, 50 Hz)")
    p.add_argument("--viz-args", default="", help="extra args for viz_node.py (--deg-per-frame, --frame-dir, --feature-az0, --frames)")
    p.add_argument("--foxglove", action="store_true",
                   help=f"also run foxglove_bridge on ws://127.0.0.1:{FOXGLOVE_PORT} (the `viz` environment; skipped with a note when it is not installed)")
    p.add_argument("--no-router", action="store_true", help="a Zenoh router is already running on this host")
    p.add_argument("--bridge-args", default="", help="extra args for bridge_node.py")
    p.add_argument("--fictrac-args", default="", help="extra args for the FicTrac adapter")
    p.add_argument("--kinefly-args", default="", help="extra args for the Kinefly adapter")
    p.add_argument("--bias-args", default="", help="extra args for the BIAS node")
    p.add_argument("--scanimage-args", default="", help="extra args for the ScanImage node (e.g. --port 5555 --status-every 1)")
    p.add_argument("--sim-args", default="--proto udp --rate 50", help="args for the FicTrac simulator")
    args = p.parse_args(argv)

    py = sys.executable
    # Foxglove is optional twice over: the flag, and the `viz` environment being installed
    # (Qt + foxglove_bridge, ~0.3 GB a rig does not need). Missing env → one line, no crash.
    foxglove = False
    if args.foxglove:
        pixi = shutil.which("pixi") or os.environ.get("PIXI_EXE")
        if not VIZ_ENV.is_dir():
            print(f"[rig] --foxglove: the viz environment is not installed ({VIZ_ENV}) — run `pixi install -e viz`; starting without foxglove_bridge", file=sys.stderr)
        elif not pixi:
            print("[rig] --foxglove: no `pixi` executable on PATH to start the viz environment with; starting without foxglove_bridge", file=sys.stderr)
        else:
            foxglove = True
    # Pre-flight: the ports this rig will bind. A clear line beats the router's Rust
    # panic text or a Python OSError traceback when a second `pixi run rig`, a stray
    # router, or the shipping bridge 3.4 (also ws :8765 + udp :60000) is still running.
    ports = [
        ("tcp", 8765, "a bridge on the Studio WebSocket port — bridge 3.4 (`pixi run bridge` at the repo root) or another rig"),
        ("udp", 60000, "a FicTrac receiver — bridge 3.4 or another fictrac adapter"),
    ]
    if not args.no_router:
        ports.insert(0, ("tcp", zenoh.ROUTER_PORT, "a Zenoh router (another `pixi run rig` / `pixi run router`)"))
    if args.kinefly:
        ports.append(("udp", 60001, "another Kinefly adapter"))
    if args.bias_sim:
        ports.append(("tcp", 5010, "a BIAS program or the BIAS simulator"))
    if args.si_mock:
        ports.append(("tcp", 5555, "ScanImage's JSON server or its stand-in"))
    if foxglove:
        ports.append(("tcp", FOXGLOVE_PORT, "another foxglove_bridge (`pixi run -e viz foxglove-bridge` or another rig --foxglove)"))
    taken = preflight(ports)
    if taken:
        print("[rig] cannot start, ports already bound:\n" + "\n".join(taken) + "\n[rig] stop that process first (or pass --no-router if the router is meant to be shared)", file=sys.stderr)
        return 2
    # The Zenoh config paths come from the installed rig_nodes package (loopback-only), set here so
    # `pixi run rig` is the same command on every platform — a Windows shell would leave pixi's
    # `$PIXI_PROJECT_ROOT` activation value literal.
    os.environ["ZENOH_ROUTER_CONFIG_URI"] = str(zenoh.ROUTER_CONFIG)
    os.environ["ZENOH_SESSION_CONFIG_URI"] = str(zenoh.SESSION_CONFIG)
    zenoh.apply_env_defaults()
    children: list[Child] = []
    if not args.no_router:
        children.append(Child("router", zenoh.router_argv()))
    nodes: list[Child] = [
        Child("fictrac", node_argv("rig_nodes.fictrac_udp_adapter", *split_args(args.fictrac_args))),
    ]
    if args.kinefly:
        nodes.append(Child("kinefly", node_argv("rig_nodes.kinefly_udp_adapter", *split_args(args.kinefly_args))))
    if args.bias_sim:
        nodes.append(Child("bias-sim", node_argv("rig_nodes.sims.bias_sim")))
    if args.bias:
        nodes.append(Child("bias", node_argv("rig_nodes.bias_node", *split_args(args.bias_args))))
    if args.si_mock:
        nodes.append(Child("si-mock", node_argv("rig_nodes.sims.si_json_mock")))
    if args.scanimage:
        nodes.append(Child("scanimage", node_argv("rig_nodes.scanimage_node", *split_args(args.scanimage_args))))
    bridge = Child("bridge", [py, str(NODES / "bridge_node.py"), *split_args(args.bridge_args)])
    nodes.append(bridge)
    if foxglove:
        # The typed republisher (ros-base messages Foxglove plots natively) runs in THIS
        # environment; only foxglove_bridge itself needs the `viz` one.
        nodes.append(Child("viz", [py, str(NODES / "viz_node.py"), *split_args(args.viz_args)]))
        # The pixi task from the `viz` environment (`ros2 run foxglove_bridge foxglove_bridge
        # --ros-args -p port:=8766 -p address:=127.0.0.1`): same solve group, so the same ROS
        # packages; RMW_IMPLEMENTATION + the Zenoh configs pass through the environment.
        nodes.append(Child("foxglove", [pixi, "run", "--manifest-path", str(ROOT / "pixi.toml"), "-e", "viz", "foxglove-bridge"]))
    if args.sim:
        nodes.append(Child("sim", node_argv("rig_nodes.sims.fictrac_sim", *split_args(args.sim_args))))

    stop = threading.Event()
    # SIGBREAK too: on Windows a parent (rig/qc/qc.py, the test harness, anything using
    # rig_nodes.supervise.signal_group) stops this process with CTRL_BREAK_EVENT on its process
    # group, which Python delivers as SIGBREAK, not SIGINT. Unhandled, it ends rig.py before the
    # `finally` below runs, and every node + the router live on as orphans (ww18 QC, 2026-10-29:
    # "graph stopped" with 7447/8765/60000 still bound). bridge_node and host_monitor handle it too.
    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            signal.signal(sig, lambda *_: stop.set())

    print(f"[rig] RMW_IMPLEMENTATION={os.environ.get('RMW_IMPLEMENTATION')}  router config {os.environ.get('ZENOH_ROUTER_CONFIG_URI')}", file=sys.stderr)
    rc = 0
    try:
        for c in children:
            c.start()
        if children:
            if wait_port("127.0.0.1", zenoh.ROUTER_PORT, 15.0):
                print(f"[rig] zenoh router listening on 127.0.0.1:{zenoh.ROUTER_PORT}", file=sys.stderr)
            else:
                print(f"[rig] router did not come up on 127.0.0.1:{zenoh.ROUTER_PORT} within 15 s", file=sys.stderr)
                rc = 1
                return rc
        for c in nodes:
            c.start()
            children.append(c)
            time.sleep(0.3)
        fox = f"   Foxglove → ws://localhost:{FOXGLOVE_PORT} (layouts: rig/foxglove/)" if foxglove else ""
        print(f"[rig] up: {', '.join(c.name for c in children)}  —  Studio → ws://localhost:8765{fox}   (Ctrl-C to stop)", file=sys.stderr)
        while not stop.is_set():
            time.sleep(0.5)
            for c in children:
                if not c.alive():
                    print(f"[rig] {c.name} exited (code {c.returncode})", file=sys.stderr)
                    children.remove(c)
                    if c is bridge or c.name == "router":
                        # Without the router every node retries forever while the Studio still
                        # sees a live WebSocket with no frames — fail loudly instead.
                        print(f"[rig] the {c.name} is gone — stopping the rig", file=sys.stderr)
                        rc = 1
                        stop.set()
                    break
    finally:
        for c in reversed(children):
            c.stop()
        print("[rig] stopped", file=sys.stderr)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
