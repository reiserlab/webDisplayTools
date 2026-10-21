#!/usr/bin/env python3
"""test_stimulus_live.py — the live dashboard path end to end: Studio WebSocket → bridge node →
/arena/browser → stimulus_node → the topics foxglove/arena-okey-cokey.json shows.

    pixi run test-stimulus-live            # ~25 s; needs ports 7447 + 8765 free (no rig running)

Starts a Zenoh router, bridge_node.py and stimulus_node.py (four-color), then plays the REAL
2026-10-14 smoke-run trial (tests/fixtures/okey_smoke_violet_cw.jsonl.gz: run metadata, runner
events, ~800 controller telemetry rows) into the bridge's WebSocket at its recorded pace, as the
Studio would, and listens with rclpy. Pass: the expected display is published as PNG images while
the grating turns and dark after the allOff, the observed index follows, the lag is 0, the display
rate reads 80 Hz, and the arena diagnostic is OK during the trial.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "nodes"))
from _common import popen_group, signal_group, wait_port  # noqa: E402

FIXTURE = HERE / "fixtures" / "okey_smoke_violet_cw.jsonl.gz"
failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


async def play(records, url: str) -> None:
    import websockets

    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "client": "test_stimulus_live", "v": 1}))
        t_first = records[0]["rx_ms"]
        t_start = time.monotonic()
        for r in records:
            due = (r["rx_ms"] - t_first) / 1000.0
            wait = due - (time.monotonic() - t_start)
            if wait > 0:
                await asyncio.sleep(wait)
            await ws.send(r["raw"])
        await asyncio.sleep(1.5)


def main() -> int:
    cfg = ROOT / "config"
    env = dict(os.environ, ZENOH_ROUTER_CONFIG_URI=str(cfg / "zenoh-router.json5"), ZENOH_SESSION_CONFIG_URI=str(cfg / "zenoh-session.json5"),
               RMW_IMPLEMENTATION=os.environ.get("RMW_IMPLEMENTATION", "rmw_zenoh_cpp"), ZENOH_ROUTER_CHECK_ATTEMPTS="0")
    os.environ.update(env)
    if wait_port("127.0.0.1", 8765, 0.2) or wait_port("127.0.0.1", 7447, 0.2):
        print("FAIL  ports 7447/8765 are in use — stop the rig (or bridge 3.4) first")
        return 2
    logdir = Path(tempfile.gettempdir()) / f"stimulus-live-{os.getpid()}"
    logdir.mkdir(parents=True, exist_ok=True)
    procs = []

    def start(name, argv):
        fh = open(logdir / f"{name}.log", "w")
        p = popen_group(argv, stdout=fh, stderr=subprocess.STDOUT)
        procs.append((name, p, fh))
        return p

    py = sys.executable
    records = [json.loads(line) for line in gzip.open(FIXTURE, "rt")]
    got = {"display": [], "observed": [], "obs_idx": [], "lag": [], "rate": [], "diag": [], "state": []}
    try:
        start("router", ["ros2", "run", "rmw_zenoh_cpp", "rmw_zenohd"])
        check("zenoh router up", wait_port("127.0.0.1", 7447, 20.0))
        start("bridge", [py, str(ROOT / "nodes" / "bridge_node.py"), "--log-dir", str(logdir / "runlogs")])
        start("stimulus", [py, str(ROOT / "nodes" / "stimulus_node.py"), "--panel-layout", "four-color",
                           "--protocol-dir", str(HERE / "fixtures" / "protocols-2026-10-14")])
        check("bridge node serving ws://127.0.0.1:8765", wait_port("127.0.0.1", 8765, 20.0))

        import rclpy
        from diagnostic_msgs.msg import DiagnosticArray
        from rclpy.node import Node
        from sensor_msgs.msg import CompressedImage
        from std_msgs.msg import Float64, String

        rclpy.init()
        n = Node("stimulus_live_test")
        n.create_subscription(CompressedImage, "/arena/display", lambda m: got["display"].append((time.monotonic(), m.format, bytes(m.data[:8]), len(m.data))), 50)
        n.create_subscription(CompressedImage, "/arena/display_observed", lambda m: got["observed"].append(time.monotonic()), 50)
        n.create_subscription(Float64, "/viz/arena/observed_idx", lambda m: got["obs_idx"].append(m.data), 50)
        n.create_subscription(Float64, "/viz/arena/lag_frames", lambda m: got["lag"].append(m.data), 50)
        n.create_subscription(Float64, "/viz/arena/display_rate_hz", lambda m: got["rate"].append(m.data), 50)
        n.create_subscription(String, "/viz/arena/state", lambda m: got["state"].append(m.data), 50)
        n.create_subscription(DiagnosticArray, "/diagnostics",
                              lambda m: got["diag"].extend((s.name, s.level[0] if isinstance(s.level, bytes) else s.level, s.message) for s in m.status), 50)
        stop = threading.Event()
        th = threading.Thread(target=lambda: [rclpy.spin_once(n, timeout_sec=0.05) for _ in iter(stop.is_set, True)], daemon=True)
        th.start()
        time.sleep(3.0)  # discovery through the router
        t_play = time.monotonic()
        asyncio.run(play(records, "ws://127.0.0.1:8765"))
        stop.set()
        th.join(timeout=2.0)

        disp = [d for d in got["display"] if d[0] >= t_play]
        check("expected display published as PNG while the grating turns (≥ 100 images)",
              len(disp) >= 100 and all(f == "png" and head == b"\x89PNG\r\n\x1a\n" for _, f, head, _ in disp), f"{len(disp)} images")
        check("observed display published (≥ 30 images)", len(got["observed"]) >= 30, str(len(got["observed"])))
        check("observed index follows the 20-frame grating", len(set(int(x) for x in got["obs_idx"])) == 20, str(sorted(set(got["obs_idx"]))[:25]))
        check("lag 0 frames throughout", got["lag"] and set(got["lag"]) == {0.0}, str(sorted(set(got["lag"]))))
        check("display rate reads 80 Hz during the trial", any(abs(r - 80) < 1.0 for r in got["rate"]), str(got["rate"][-12:]))
        arena = [(lvl, msg) for name, lvl, msg in got["diag"] if name == "arena/display"]
        trial_ok = [m for lvl, m in arena if lvl == 0 and "G6_2x10_toprow_grat20_violet" in m]
        check("arena diagnostic OK naming the pattern during the trial", bool(trial_ok), str(arena[-6:]))
        check("no ERROR/STALE arena diagnostic", all(lvl not in (2, 3) for lvl, _ in arena), str([a for a in arena if a[0] in (2, 3)][:3]))
        check("state goes trial → dark", "trial" in got["state"] and got["state"][-1] == "dark", str(got["state"][-5:]))
        n.destroy_node()
        rclpy.shutdown()
    finally:
        for name, p, fh in reversed(procs):
            try:
                signal_group(p, signal.SIGINT)
                p.wait(timeout=5)
            except Exception:
                p.kill()
            fh.close()
    print(f"\n{'PASS' if not failures else 'FAIL'}: {failures} failure(s)   (logs: {logdir})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
