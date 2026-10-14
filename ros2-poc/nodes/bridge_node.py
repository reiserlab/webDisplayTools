#!/usr/bin/env python3
"""bridge_node.py — the bridge as a ROS 2 node, reusing bridge.py's hub, log writer and dispatcher.

The unmodified Arena Studio connects to ws://localhost:8765 exactly as it does to bridge
3.4, speaks the same message schema (hello/hello_ack, config, log_control(_ack), log,
rows, log_export(_result)) and gets the same `frame` messages. The difference is where
FicTrac records come from: a ROS 2 topic (`/fictrac/raw`, std_msgs/String JSON from
fictrac_udp_adapter.py) instead of a UDP socket owned by this process.

What is REUSED from fictrac-bridge/bridge.py, imported by path, unmodified:
  Hub            — the coalescing WebSocket broadcast (latest frame, never a backlog)
  LogWriter      — the behavior_v2 NDJSON run log (schema line, compact ["a",…] echoes, rows)
  Pipeline       — FicTrac line → heading tare → unwrapped turn → bias → frame index
  make_dispatcher — the browser-message handler (config/log_control/log_export/rows/log)
so the log a Studio run produces here is the same format bridge 3.4 writes and every
reader (closed-loop-report, dashboard, replay, runlog-format tests) already accepts.

What is NEW (small, and all of it is visible in the log):
  * input = ROS subscription. `Pipeline.handle_line` stamps the row's `ms` with ITS OWN
    wall clock at the moment the index is computed (unchanged) — the closed-loop node
    stamps its own sample time, as LAB-303 asks. The adapter's receive stamp travels in
    the envelope and is used only for the `lat_ms` latency statistics.
  * `/arena/frame` — every frame the hub publishes is also published as a ROS topic, so
    `ros2 topic echo/hz` introspect the closed loop and ROS-native nodes can subscribe.
  * other device topics are LOGGED, not applied: `/kinefly/raw` (KF/1) → compact tagged
    rows `["kf", ms, seq, src_t_s, left_rad, right_rad, head_rad, abdomen_rad]`;
    `/bias/reply` and `/bias/status` → `{"type":"connector","src":"bias",…}` events.
    Readers already pass unknown string-tagged arrays and unknown event objects through.
  * a source watchdog: when a logged source goes silent for --source-timeout s during a
    log, a `source_lost` event is written (and `source_resumed` when it returns). A device
    node killed mid-run therefore leaves the log intact AND documented.
  * `connector_status` lines (frames seen, adapter→bridge latency p50/p99 ms per source)
    at log close / export, so a run carries its own transport health.

Not supported here (by design of the PoC): the `fictrac_port` config key cannot re-bind
the socket — the adapter owns it. The request is acknowledged with a warning.

    pixi run bridge-node                      # ws://127.0.0.1:8765, logs on demand to runlogs/
    pixi run bridge-node -- --frames 60 --log-dir /path
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import math
import os
import signal
import sys
import threading
import time
from pathlib import Path

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile, QoSReliabilityPolicy
from std_msgs.msg import String

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRIDGE_PY = REPO / "fictrac-bridge" / "bridge.py"


def load_bridge_module(path: Path = BRIDGE_PY):
    """Import fictrac-bridge/bridge.py by path (it is a script, not a package)."""
    spec = importlib.util.spec_from_file_location("fictrac_bridge", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = load_bridge_module()

NODE_VERSION = f"{B.BRIDGE_VERSION} · ros2-poc (rmw_zenoh, /fictrac/raw, connectors)"
FICTRAC_TOPIC = "/fictrac/raw"
KINEFLY_TOPIC = "/kinefly/raw"
BIAS_CMD_TOPIC = "/bias/cmd"
BIAS_REPLY_TOPIC = "/bias/reply"
BIAS_STATUS_TOPIC = "/bias/status"
FRAME_TOPIC = "/arena/frame"
RAW_QOS = QoSProfile(
    reliability=QoSReliabilityPolicy.RELIABLE,
    history=QoSHistoryPolicy.KEEP_LAST,
    depth=200,
    durability=QoSDurabilityPolicy.VOLATILE,
)
FRAME_QOS = QoSProfile(
    reliability=QoSReliabilityPolicy.BEST_EFFORT,
    history=QoSHistoryPolicy.KEEP_LAST,
    depth=1,
    durability=QoSDurabilityPolicy.VOLATILE,
)
KF_TAG = "kf"


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[k]


def kf_row(rel_ms: int, pkt: dict, seq: int) -> list:
    """KF/1 record → compact tagged row. PURE. Angles are the FIRST (strongest-edge)
    angle of each part when the part is valid, else null — Kinefly's bridge plan: the
    edge identity policy is explicit, index 0 is only the initial single-edge choice."""

    def first_angle(name: str):
        part = pkt.get("parts", {}).get(name) or {}
        if not part.get("valid"):
            return None
        angles = part.get("angles_rad") or []
        return round(float(angles[0]), 5) if angles else None

    t_src = pkt.get("timestamp_s")
    return [
        KF_TAG,
        int(rel_ms),
        int(seq),
        round(float(t_src), 6) if isinstance(t_src, (int, float)) else None,
        first_angle("left"),
        first_angle("right"),
        first_angle("head"),
        first_angle("abdomen"),
    ]


class RosInput:
    """Stands in for bridge.py's InputManager (the dispatcher calls `rebind` on a
    `fictrac_port` config key and reads `.port`). The ROS adapter owns the socket, so a
    port change is acknowledged and logged, not performed."""

    def __init__(self, port: int, warn) -> None:
        self.port = port
        self.proto = "ros2"
        self._warn = warn
        self._warned = False

    def start(self) -> None:
        pass

    async def rebind(self, port: int) -> None:
        if port == self.port:
            return
        if not self._warned:
            self._warned = True
            self._warn(
                f"config fictrac_port {port} ignored: the fictrac adapter owns the UDP socket "
                f"(restart `pixi run fictrac-adapter -- --port {port}`)"
            )

    async def stop(self) -> None:
        pass


class SourceStats:
    """Per-source counters + adapter→bridge latency samples (bounded)."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.count = 0
        self.last_rx_mono = None  # bridge monotonic at last message
        self.lat_ms: list[float] = []
        self.lost = False

    def seen(self, rx_epoch_ms: int | None) -> None:
        self.count += 1
        self.last_rx_mono = time.monotonic()
        if rx_epoch_ms is not None:
            self.lat_ms.append(time.time() * 1000.0 - rx_epoch_ms)
            if len(self.lat_ms) > 5000:
                del self.lat_ms[: len(self.lat_ms) - 5000]

    def summary(self) -> dict:
        return {
            "src": self.name,
            "frames": self.count,
            "lat_ms": {
                "p50": None if not self.lat_ms else round(percentile(self.lat_ms, 0.5), 2),
                "p99": None if not self.lat_ms else round(percentile(self.lat_ms, 0.99), 2),
                "n": len(self.lat_ms),
            },
        }


class RosLogWriter(B.LogWriter):
    """bridge.py's LogWriter + two hooks: `on_open()` after a file opens (writes the
    'where do frames come from' line, resets the source watchdog) and `on_close()` just
    before it closes (writes the per-source connector_status lines). Hooking the writer
    itself covers every close path — log_control off, log_export, shutdown — without
    re-parsing browser messages."""

    on_open = None
    on_close = None

    def _open(self, name: str, event: str) -> None:
        super()._open(name, event)
        if self.on_open is not None:
            self.on_open()

    def close(self) -> None:
        if self._fh is not None and self.on_close is not None:
            self.on_close()
        super().close()


class RosHub(B.Hub):
    """bridge.py's Hub + a ROS mirror of every frame on /arena/frame."""

    def __init__(self, on_message, ros_pub) -> None:
        super().__init__(on_message)
        self._ros_pub = ros_pub

    async def publish(self, msg: dict) -> None:
        await super().publish(msg)
        if self._ros_pub is not None:
            m = String()
            m.data = json.dumps(msg, separators=(",", ":"))
            self._ros_pub.publish(m)


class BridgeNode(Node):
    """ROS side: subscriptions hand data to the asyncio side thread-safely."""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, on_kinefly, on_bias) -> None:
        super().__init__("arena_bridge")
        self._loop = loop
        self._queue = queue
        self._on_kinefly = on_kinefly
        self._on_bias = on_bias
        self.stats = {"fictrac": SourceStats("fictrac"), "kinefly": SourceStats("kinefly"), "bias": SourceStats("bias")}
        self.frame_pub = self.create_publisher(String, FRAME_TOPIC, FRAME_QOS)
        # Studio → bridge connector_command relayed to the BIAS node (LAB-303 connectors).
        self.bias_cmd_pub = self.create_publisher(String, BIAS_CMD_TOPIC, RAW_QOS)
        self.create_subscription(String, FICTRAC_TOPIC, self._fictrac, RAW_QOS)
        self.create_subscription(String, KINEFLY_TOPIC, self._kinefly, RAW_QOS)
        self.create_subscription(String, BIAS_REPLY_TOPIC, lambda m: self._bias("reply", m), RAW_QOS)
        self.create_subscription(String, BIAS_STATUS_TOPIC, lambda m: self._bias("status", m), RAW_QOS)

    @staticmethod
    def _envelope(msg: String) -> dict | None:
        try:
            env = json.loads(msg.data)
        except json.JSONDecodeError:
            return None
        return env if isinstance(env, dict) else None

    def _fictrac(self, msg: String) -> None:
        env = self._envelope(msg)
        if env is None or not isinstance(env.get("raw"), str):
            return
        self.stats["fictrac"].seen(env.get("rx_epoch_ms"))
        # Same hand-off bridge.py's UDP protocol does (queue.put_nowait), from the ROS thread.
        self._loop.call_soon_threadsafe(self._queue.put_nowait, env["raw"])

    def _kinefly(self, msg: String) -> None:
        env = self._envelope(msg)
        if env is None or not isinstance(env.get("raw"), str):
            return
        self.stats["kinefly"].seen(env.get("rx_epoch_ms"))
        self._loop.call_soon_threadsafe(self._on_kinefly, env)

    def _bias(self, kind: str, msg: String) -> None:
        env = self._envelope(msg)
        if env is None:
            return
        self.stats["bias"].seen(env.get("rx_epoch_ms"))
        self._loop.call_soon_threadsafe(self._on_bias, kind, env)


async def run(args: argparse.Namespace) -> None:
    if B.serve is None:
        raise SystemExit("the `websockets` package is required (pixi install)")
    loop = asyncio.get_running_loop()
    log = RosLogWriter(args.log, args.log_level, args.log_dir)
    queue: asyncio.Queue[str] = asyncio.Queue()
    pipeline = B.Pipeline(
        None,
        log,
        args.frames,
        args.deg_per_frame,
        args.offset,
        {"type": "none", "amplitude": 0.0, "frequency": 0.0},
        coupling=args.coupling,
    )

    def rel_ms() -> int:
        return B.now_ms() - pipeline.t0_ms

    def warn(text: str) -> None:
        print(f"[bridge-node] {text}", file=sys.stderr)
        log.write_event({"type": "log", "event": "warn", "dir": "bridge", "level": "WARN", "ms": rel_ms(), "message": text})

    kf_seq = {"n": 0}

    def on_kinefly(env: dict) -> None:
        try:
            pkt = json.loads(env["raw"])
        except (json.JSONDecodeError, KeyError, TypeError):
            return
        kf_seq["n"] += 1
        seq = pkt.get("sequence") if isinstance(pkt.get("sequence"), int) else kf_seq["n"]
        log.write_rows([kf_row(rel_ms(), pkt, seq)])

    # ── connectors: the Studio's connector_command → /bias/cmd, /bias/reply → connector_reply ──
    # One connector today ('bias'); the Studio maps BiasPlugin instances onto it. A command
    # is logged on arrival (dir browser→bridge) and its reply is logged when the node answers
    # (via "ws" marks replies the Studio asked for, as opposed to bias_cmd.py's). The reply
    # goes back to the ASKING websocket only (the hub's broadcast coalesces frames).
    CONNECTORS = {"bias": BIAS_CMD_TOPIC}
    pending: dict[str, dict] = {}  # command id → {"ws", "plugin", "connector", "t"}

    async def ws_reply(websocket, msg: dict) -> None:
        if websocket is None:
            return
        try:
            await websocket.send(json.dumps(msg))
        except Exception:  # ConnectionClosed: the asker left — nothing to deliver to
            pass

    def on_bias(kind: str, env: dict) -> None:
        ev = {"type": "connector", "src": "bias", "kind": kind, "dir": "bridge", "ms": rel_ms()}
        for k, v in env.items():
            if k not in ("src",):
                ev[k] = v
        p = pending.pop(str(env.get("id")), None) if kind == "reply" and env.get("id") is not None else None
        if p is not None:
            ev["via"] = "ws"
            ev["plugin"] = p["plugin"]
        log.write_event(ev)
        if p is not None:
            rep = {"type": "connector_reply", "connector": p["connector"], "plugin": p["plugin"]}
            for k, v in env.items():
                if k not in ("type", "src"):
                    rep[k] = v
            loop.create_task(ws_reply(p["ws"], rep))

    async def on_connector_command(obj: dict, websocket) -> None:
        cid = obj.get("id")
        connector = str(obj.get("connector") or "bias")
        command = str(obj.get("command") or "")
        params = obj.get("params") if isinstance(obj.get("params"), dict) else {}
        plugin = obj.get("plugin")
        log.write_event({"type": "connector", "src": connector, "kind": "command", "dir": "browser→bridge", "ms": rel_ms(),
                         "id": cid, "plugin": plugin, "command": command, "params": params})
        if connector not in CONNECTORS:
            err = f"no connector {connector!r} on this bridge (have {sorted(CONNECTORS)})"
            log.write_event({"type": "connector", "src": connector, "kind": "reply", "dir": "bridge", "ms": rel_ms(), "via": "ws",
                             "id": cid, "plugin": plugin, "command": command, "ok": False, "outcome": "error", "error": err})
            await ws_reply(websocket, {"type": "connector_reply", "id": cid, "connector": connector, "plugin": plugin,
                                       "command": command, "ok": False, "outcome": "error", "error": err})
            return
        pending[str(cid)] = {"ws": websocket, "plugin": plugin, "connector": connector, "t": time.monotonic()}
        m = String()
        m.data = json.dumps({"id": cid, "command": command, "params": params}, separators=(",", ":"))
        node.bias_cmd_pub.publish(m)

    inputs = RosInput(args.fictrac_port, warn)
    dispatch_34 = B.make_dispatcher(pipeline, log, inputs)  # unmodified bridge.py dispatcher

    async def dispatch(raw, websocket=None) -> None:
        """bridge.py's dispatcher + two message kinds: `hello` gains the `connectors` list
        (so the Studio's bridge client knows what it may drive; a ≤ 3.4 bridge never sends
        it) and `connector_command` is relayed to the device node. Everything else is 3.4."""
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        obj = None
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            obj = None
        kind = obj.get("type") if isinstance(obj, dict) else None
        if kind == "hello":
            log.write_inbound(text)
            await ws_reply(websocket, {"type": "hello_ack", "bridge": B.BRIDGE_VERSION, "levels": list(B.LOG_LEVELS),
                                       "level": log.level, "logging": log.active, "connectors": sorted(CONNECTORS)})
            return
        if kind == "connector_command":
            await on_connector_command(obj, websocket)
            return
        await dispatch_34(raw, websocket)

    node = BridgeNode(loop, queue, on_kinefly, on_bias)

    def on_log_open() -> None:
        """A new file: note where its frames come from, and scope the source watchdog to it
        (a source lost/resumed between runs must not leak a half pair into this file)."""
        for s in node.stats.values():
            s.lost = False
            s.last_rx_mono = None
        log.write_event(
            {
                "type": "connector_status",
                "dir": "bridge",
                "ms": rel_ms(),
                "src": "bridge",
                "node": NODE_VERSION,
                "rmw": os.environ.get("RMW_IMPLEMENTATION"),
                "topics": {"fictrac": FICTRAC_TOPIC, "kinefly": KINEFLY_TOPIC, "bias": [BIAS_REPLY_TOPIC, BIAS_STATUS_TOPIC], "frame": FRAME_TOPIC},
            }
        )

    def on_log_close() -> None:
        """One connector_status line per source that produced anything, before the file closes."""
        for s in node.stats.values():
            if s.count:
                log.write_event({"type": "connector_status", "dir": "bridge", "ms": rel_ms(), **s.summary()})

    log.on_open = on_log_open
    log.on_close = on_log_close
    if log.active:  # a fixed --log path opened before the hooks existed
        on_log_open()

    hub = RosHub(dispatch, node.frame_pub)
    pipeline.hub = hub

    # hello_ack must say 3.4 first so the unmodified Studio's _bridgeAtLeast(3,4) passes.
    B.BRIDGE_VERSION = NODE_VERSION

    async def watchdog() -> None:
        while True:
            await asyncio.sleep(0.5)
            for cid, p in list(pending.items()):
                if time.monotonic() - p["t"] > 120.0:  # the Studio gave up long ago (default 10 s)
                    pending.pop(cid, None)
            if not log.active:
                continue
            now = time.monotonic()
            for s in node.stats.values():
                if s.name == "bias" or s.last_rx_mono is None:
                    continue
                silent = now - s.last_rx_mono
                if not s.lost and silent > args.source_timeout:
                    s.lost = True
                    log.write_event({"type": "source_lost", "dir": "bridge", "ms": rel_ms(), "src": s.name, "silence_ms": int(silent * 1000), "frames": s.count})
                    print(f"[bridge-node] source {s.name} silent for {silent:.1f}s (log stays open)", file=sys.stderr)
                elif s.lost and silent <= args.source_timeout:
                    s.lost = False
                    log.write_event({"type": "source_resumed", "dir": "bridge", "ms": rel_ms(), "src": s.name, "frames": s.count})
                    print(f"[bridge-node] source {s.name} resumed", file=sys.stderr)

    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    executor = SingleThreadedExecutor()
    executor.add_node(node)
    ros_thread = threading.Thread(target=executor.spin, name="rclpy-spin", daemon=True)
    ros_thread.start()

    consumer = asyncio.create_task(B.consume(queue, pipeline))
    wd = asyncio.create_task(watchdog())

    async with B.serve(hub.serve_client, args.ws_host, args.ws_port, max_size=B.WS_MAX_SIZE):
        print(
            f"[ws] serving ws://{args.ws_host}:{args.ws_port}  (bridge-node {NODE_VERSION}; "
            f"rmw={os.environ.get('RMW_IMPLEMENTATION')}, in={FICTRAC_TOPIC}, frames={args.frames}, "
            f"coupling={args.coupling:g}, deg_per_frame={args.deg_per_frame:g}, log={args.log or 'on-demand'}, level={log.level})",
            file=sys.stderr,
        )
        await stop.wait()

    print(f"\n[bridge-node] shutting down (parsed={pipeline.parsed}, skipped={pipeline.skipped})", file=sys.stderr)
    for s in node.stats.values():
        if s.count:
            print(f"[bridge-node] {json.dumps(s.summary())}", file=sys.stderr)
    consumer.cancel()
    wd.cancel()
    await asyncio.gather(consumer, wd, return_exceptions=True)
    log.close()  # on_close writes the connector_status lines first
    # Stop the ROS side in order: end the spin, WAIT for its thread, then destroy the node.
    # Destroying while the executor thread is still inside spin() races the Zenoh session
    # teardown and ends the process with "terminate called without an active exception".
    executor.shutdown(timeout_sec=2.0)
    ros_thread.join(timeout=3.0)
    node.destroy_node()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=f"bridge-node {NODE_VERSION}")
    p.add_argument("--ws-host", default="127.0.0.1")
    p.add_argument("--ws-port", type=int, default=8765)
    p.add_argument("--frames", type=int, default=200, help="frame count of the loaded pattern; the Studio re-sends it live (default: 200)")
    p.add_argument("--coupling", type=float, default=1.0)
    p.add_argument("--deg-per-frame", type=float, default=1.8)
    p.add_argument("--offset", type=float, default=0.0)
    p.add_argument("--fictrac-port", type=int, default=60000, help="reported FicTrac port (the adapter owns the socket; informational)")
    p.add_argument("--source-timeout", type=float, default=2.0, help="seconds of silence from a logged source before a source_lost event (default: 2)")
    p.add_argument("--log", default=None, help="fixed log path (else on demand per log_control)")
    p.add_argument("--log-dir", default=str(HERE.parent / "runlogs"), help="directory for on-demand arena-log-*.jsonl (default: ros2-poc/runlogs)")
    p.add_argument("--log-level", choices=B.LOG_LEVELS, default=B.DEFAULT_LOG_LEVEL)
    args, ros_args = p.parse_known_args(argv)
    if args.frames <= 0:
        p.error("--frames must be > 0")
    if not math.isfinite(args.coupling):
        p.error("--coupling must be finite")
    rclpy.init(args=ros_args)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    finally:
        try:
            rclpy.try_shutdown()
        except Exception:  # rclpy's own SIGINT handler may already have shut the context down (races in Jazzy)
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
