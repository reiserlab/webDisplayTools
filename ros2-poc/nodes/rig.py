#!/usr/bin/env python3
"""rig.py — the one command a rig runs: Zenoh router + adapters + bridge node, supervised.

    pixi run rig                       # router, fictrac adapter, bridge node
    pixi run rig -- --kinefly --bias   # + Kinefly adapter + BIAS node
    pixi run rig -- --sim              # + the FicTrac simulator (demo without a camera)
    pixi run rig -- --bias --bias-sim  # + a simulated BIAS program (no camera software)
    pixi run rig -- --scanimage        # + the ScanImage node (JSON server on this PC); --si-mock for a stand-in
    pixi run rig -- --foxglove         # + foxglove_bridge (:8766) from the `viz` environment
    pixi run rig -- --scanimage-frames # + the ScanImage ZMQ frame-stream node (SUB tcp://127.0.0.1:65179; Bergamo, Block R)

Order: the router first (nodes retry until it answers on 127.0.0.1:7447), then every
adapter/node. Each child's stderr is prefixed with its name. Ctrl-C stops everything in
reverse order; a child that dies on its own is reported (and the whole rig exits if it was
the bridge node — the Studio's WebSocket is gone, nothing else matters). Options after a
child's name are passed through, e.g. `--bridge-args "--frames 60"`.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import socket
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NODES = HERE
ROOT = HERE.parent  # ros2-poc/ (the pixi workspace)
SIM = HERE.parents[1] / "fictrac-bridge" / "fictrac_sim.py"
# `pixi install -e viz` puts foxglove_bridge in a sibling of the env this runs in: under
# .pixi/envs, or under the `detached-environments` directory when one is configured (the
# Windows short-path setup for the typed build, WINDOWS-TEST.md).
_ENVS = Path(os.environ["CONDA_PREFIX"]).parent if os.environ.get("CONDA_PREFIX") else ROOT / ".pixi" / "envs"
VIZ_ENV = _ENVS / "viz"
FOXGLOVE_PORT = 8766


sys.path.insert(0, str(HERE))
from _common import SIGKILL, popen_group, signal_group, wait_port  # noqa: E402


def port_in_use(proto: str, port: int, host: str = "127.0.0.1") -> bool:
    """True when binding host:port fails (something else holds it) — or, on Windows, when a
    TCP connect to it succeeds."""
    kind = socket.SOCK_STREAM if proto == "tcp" else socket.SOCK_DGRAM
    s = socket.socket(socket.AF_INET, kind)
    try:
        if proto == "tcp" and os.name != "nt":
            # Ignore TIME_WAIT leftovers from a just-stopped rig; a LIVE listener still fails.
            # Not on Windows: there SO_REUSEADDR lets this probe bind OVER a live listener (ww18
            # 2026-10-15: a running router on 7447 went unreported), and TIME_WAIT does not block
            # a plain bind.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port))
    except OSError:
        return True
    finally:
        s.close()
    if proto == "tcp" and os.name == "nt":
        # Windows: a listener that shares its address blocks NO bind, wildcard or specific — the
        # real BIAS (Qt, 0.0.0.0:5010) on ww18 2026-10-15. Only a connect sees it.
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            pass
    return False


def split_args(s: str) -> list[str]:
    """`--x-args "…"` → argv. POSIX shlex treats `\\` as an escape, so on Windows
    `--video-dir D:\\rec\\reiserm\\ros2-poc` became the drive-relative `D:recreisermros2-poc`
    and BIAS wrote the run's video there (ww18 2026-10-15). Windows: split without escapes,
    then drop the quotes around a token ("C:\\My Videos\\x")."""
    if os.name != "nt":
        return shlex.split(s)
    return [t[1:-1] if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'" else t for t in shlex.split(s, posix=False)]


class Child:
    def __init__(self, name: str, argv: list[str]) -> None:
        self.name = name
        self.argv = argv
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        # Own process group per child (popen_group), so a stop signal reaches wrappers AND
        # what they spawn (`ros2 run … rmw_zenohd` does not forward SIGINT to the router).
        self.proc = popen_group(
            self.argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
        threading.Thread(target=self._pump, name=f"pump-{self.name}", daemon=True).start()

    def _signal(self, sig: int) -> None:
        assert self.proc
        signal_group(self.proc, sig)

    def _pump(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            sys.stderr.write(f"[{self.name:8}] {line}")
        sys.stderr.flush()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self, grace_s: float = 3.0) -> None:
        if not self.alive():
            return
        assert self.proc
        try:
            self._signal(signal.SIGINT)
            self.proc.wait(grace_s)
        except subprocess.TimeoutExpired:
            self._signal(signal.SIGTERM)
            try:
                self.proc.wait(2.0)
            except subprocess.TimeoutExpired:
                self._signal(SIGKILL)
        except (ProcessLookupError, OSError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--kinefly", action="store_true", help="also run the Kinefly KF/1 adapter")
    p.add_argument("--bias", action="store_true", help="also run the BIAS camera node")
    p.add_argument("--bias-sim", action="store_true", help="also run bias_sim.py (a fake BIAS program)")
    p.add_argument("--scanimage", action="store_true", help="also run the ScanImage node (talks to ScanImage's JSON server, default 127.0.0.1:5555)")
    p.add_argument("--scanimage-frames", action="store_true", help="also run the ScanImage frame-stream node (ZMQ SUB on ScanImage's ZMQAddress → /scanimage/frame_meta, frame_stats, preview/ch<id>)")
    p.add_argument("--scanimage-frames-args", default="", help="extra args for scanimage_frames_node.py (e.g. --address tcp://127.0.0.1:65179 --preview-hz 5 --dump frames.jsonl)")
    p.add_argument("--si-mock", action="store_true", help="also run tests/si_json_mock.py (a stand-in for ScanImage's JSON server, port 5555)")
    p.add_argument("--sim", action="store_true", help="also run the FicTrac simulator (random walk, 50 Hz)")
    p.add_argument("--viz-args", default="", help="extra args for viz_node.py (--deg-per-frame, --frame-dir, --feature-az0, --frames)")
    p.add_argument("--foxglove", action="store_true",
                   help=f"also run foxglove_bridge on ws://127.0.0.1:{FOXGLOVE_PORT} (the `viz` environment; skipped with a note when it is not installed)")
    p.add_argument("--no-router", action="store_true", help="a Zenoh router is already running on this host")
    p.add_argument("--bridge-args", default="", help="extra args for bridge_node.py")
    p.add_argument("--fictrac-args", default="", help="extra args for fictrac_udp_adapter.py")
    p.add_argument("--kinefly-args", default="", help="extra args for kinefly_udp_adapter.py")
    p.add_argument("--bias-args", default="", help="extra args for bias_node.py")
    p.add_argument("--scanimage-args", default="", help="extra args for scanimage_node.py (e.g. --port 5555 --status-every 1)")
    p.add_argument("--sim-args", default="--proto udp --rate 50", help="args for fictrac_sim.py")
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
    taken = []
    for proto, port, who in (
        ("tcp", 7447, "a Zenoh router (another `pixi run rig` / `pixi run router`)") if not args.no_router else (None, 0, ""),
        ("tcp", 8765, "a bridge on the Studio WebSocket port — bridge 3.4 (`pixi run bridge` at the repo root) or another rig"),
        ("udp", 60000, "a FicTrac receiver — bridge 3.4 or another fictrac adapter"),
        ("udp", 60001, "another Kinefly adapter") if args.kinefly else (None, 0, ""),
        ("tcp", 5010, "a BIAS program or bias_sim") if args.bias_sim else (None, 0, ""),
        ("tcp", 5555, "ScanImage's JSON server or si_json_mock") if args.si_mock else (None, 0, ""),
        ("tcp", FOXGLOVE_PORT, "another foxglove_bridge (`pixi run -e viz foxglove-bridge` or another rig --foxglove)") if foxglove else (None, 0, ""),
    ):
        if proto and port_in_use(proto, port):
            taken.append(f"  {proto} 127.0.0.1:{port} is in use — probably {who}")
    if taken:
        print("[rig] cannot start, ports already bound:\n" + "\n".join(taken) + "\n[rig] stop that process first (or pass --no-router if the router is meant to be shared)", file=sys.stderr)
        return 2
    # The Zenoh config paths: pixi's activation.env sets them via $PIXI_PROJECT_ROOT, which a
    # Windows shell would leave literal — set them explicitly here so `pixi run rig` is the
    # same command on every platform.
    cfg_dir = HERE.parent / "config"
    os.environ["ZENOH_ROUTER_CONFIG_URI"] = str(cfg_dir / "zenoh-router.json5")
    os.environ["ZENOH_SESSION_CONFIG_URI"] = str(cfg_dir / "zenoh-session.json5")
    os.environ.setdefault("RMW_IMPLEMENTATION", "rmw_zenoh_cpp")
    os.environ.setdefault("ZENOH_ROUTER_CHECK_ATTEMPTS", "0")
    children: list[Child] = []
    if not args.no_router:
        children.append(Child("router", ["ros2", "run", "rmw_zenoh_cpp", "rmw_zenohd"]))
    nodes: list[Child] = [
        Child("fictrac", [py, str(NODES / "fictrac_udp_adapter.py"), *split_args(args.fictrac_args)]),
    ]
    if args.kinefly:
        nodes.append(Child("kinefly", [py, str(NODES / "kinefly_udp_adapter.py"), *split_args(args.kinefly_args)]))
    if args.bias_sim:
        nodes.append(Child("bias-sim", [py, str(NODES / "bias_sim.py")]))
    if args.bias:
        nodes.append(Child("bias", [py, str(NODES / "bias_node.py"), *split_args(args.bias_args)]))
    if args.si_mock:
        nodes.append(Child("si-mock", [py, str(HERE.parent / "tests" / "si_json_mock.py")]))
    if args.scanimage:
        nodes.append(Child("scanimage", [py, str(NODES / "scanimage_node.py"), *split_args(args.scanimage_args)]))
    if args.scanimage_frames:
        # Connects (never binds), so no port pre-flight: ScanImage binds at each acquisition start.
        nodes.append(Child("si-frame", [py, str(NODES / "scanimage_frames_node.py"), *split_args(args.scanimage_frames_args)]))
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
        nodes.append(Child("sim", [py, str(SIM), *split_args(args.sim_args)]))

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    print(f"[rig] RMW_IMPLEMENTATION={os.environ.get('RMW_IMPLEMENTATION')}  router config {os.environ.get('ZENOH_ROUTER_CONFIG_URI')}", file=sys.stderr)
    rc = 0
    try:
        for c in children:
            c.start()
        if children:
            if wait_port("127.0.0.1", 7447, 15.0):
                print("[rig] zenoh router listening on 127.0.0.1:7447", file=sys.stderr)
            else:
                print("[rig] router did not come up on 127.0.0.1:7447 within 15 s", file=sys.stderr)
                rc = 1
                return rc
        for c in nodes:
            c.start()
            children.append(c)
            time.sleep(0.3)
        fox = f"   Foxglove → ws://localhost:{FOXGLOVE_PORT} (layouts: ros2-poc/foxglove/)" if foxglove else ""
        print(f"[rig] up: {', '.join(c.name for c in children)}  —  Studio → ws://localhost:8765{fox}   (Ctrl-C to stop)", file=sys.stderr)
        while not stop.is_set():
            time.sleep(0.5)
            for c in children:
                if not c.alive():
                    code = c.proc.returncode if c.proc else None
                    print(f"[rig] {c.name} exited (code {code})", file=sys.stderr)
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
