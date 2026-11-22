#!/usr/bin/env python3
"""studio_remote.py — start Arena Studio runs from a program (remote-control mode, LAB-357).

The Studio page must be in remote-control mode (Run view → "Remote control", or open it with
`?remote=1` and click Connect once). The Studio STILL executes the steps; this client only asks
it to, through the rig gateway (`pixi run rig`), and waits for the result. First use: flow
control between protocols — run one, read its bag, choose the next.

    from studio_remote import StudioRemote
    studio = StudioRemote()                                   # over ROS 2 (the default)
    result = studio.run("protocols/short_test.yaml", intent="experiment",
                        metadata={"experimenter": "reiserm", "genotype": "CS", "notes": "block 1"})
    if result["state"] == "done":
        analyze(result["bag"])                                # the run's bag is closed by now
        studio.run(next_protocol_text, name="next.yaml")

    pixi run remote -- run protocols/short_test.yaml --experiment --experimenter reiserm --genotype CS --json
    pixi run remote -- status
    pixi run remote -- stop
    pixi run remote -- --ws status                            # the gateway's WebSocket instead of ROS

TWO TRANSPORTS, one API:
  transport="ros" (default)  publishes the request on `/arena/run_request` and reads
                             `/arena/run_status` (std_msgs/String JSON) — the same graph the robot
                             station's sequencer lives on. Needs `rclpy` (the rig pixi environment).
  transport="ws"             the gateway's WebSocket (`url`, ws://localhost:8765). Pure Python
                             (`websockets`); `rclpy` is never imported.

Synchronous on purpose, so MATLAB can call it through `py.studio_remote.StudioRemote` (or a
system call to the command line).

`run()` returns the TERMINAL run_status as a dict: `state` is one of
    done      the protocol completed (no fault, not aborted)
    aborted   stopped on request — `detail` says by the operator at the Studio or by the controller
    failed    controller fault, bridge lost, the Studio disconnected, or the run threw
    rejected  it did not start — `detail` says why (no Studio in remote-control mode, busy, the
              YAML did not load, an experiment without Experimenter / Genotype, the controller
              preflight refused, …)
plus `detail`, `summary` (the Studio runner's summary), `step`, and `bag` + `bag_files` (the
run's MCAP bag directory on the gateway PC) when the run recorded one. The gateway sends the
terminal status only after that bag is closed, so it can be opened at once.

Ownership: whoever sent `run` owns the run, and only the owner's `stop` is accepted. All ROS
clients are ONE owner (a topic has no sender identity), so any ROS client may stop a run that was
started over ROS; a WebSocket run is owned by its socket. A run started over one transport
cannot be stopped over the other. A second `run` during a run is `rejected` ("busy"). STOP at
the Studio always works.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import queue
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

DEFAULT_URL = "ws://localhost:8765"
RUN_REQUEST_TOPIC = "/arena/run_request"
RUN_STATUS_TOPIC = "/arena/run_status"
TRANSPORTS = ("ros", "ws")
TERMINAL_STATES = ("done", "aborted", "failed", "rejected")
METADATA_KEYS = ("experimenter", "genotype", "age", "sex", "fly_number", "notes")
STOP_GRACE_S = 20.0  # after a stop request: how long to wait for the run's terminal status
GATEWAY_GONE_S = 5.0  # ROS: the gateway's subscription absent this long while waiting = it is gone
WS_MAX_SIZE = 16 * 1024 * 1024  # the gateway's own limit (bridge.py WS_MAX_SIZE)


class StudioRemoteError(RuntimeError):
    """The gateway could not be reached, does not relay remote control, or the link dropped."""


# ── transport: WebSocket ─────────────────────────────────────────────────────────────
class _WsChannel:
    """One synchronous WebSocket connection to the gateway. `websockets.sync.client.connect()` is
    used through its context-manager protocol (the only form websockets ≥ 16 supports without a
    warning; on older versions the connection object is its own context manager), held open by
    hand so a run keeps its owner socket until it ends."""

    def __init__(self, url: str, open_timeout: float) -> None:
        from websockets.sync.client import connect

        self.url = url
        try:
            try:
                cm = connect(url, max_size=WS_MAX_SIZE, open_timeout=open_timeout, proxy=None)  # never through an HTTP proxy
            except TypeError:  # websockets < 15 has no `proxy` argument
                cm = connect(url, max_size=WS_MAX_SIZE, open_timeout=open_timeout)
            self._cm = cm
            self._ws = cm.__enter__()
        except (OSError, TimeoutError) as exc:
            raise StudioRemoteError(f"cannot reach the gateway at {url} ({exc}) — is `pixi run rig` running?") from exc
        # Is this the rig gateway? Bridge 3.4 answers hello without `remote` and would swallow a
        # run_request into its log without ever answering.
        self.send({"type": "hello", "client": "studio_remote.py", "v": 1})
        end = time.monotonic() + 3.0
        ack = None
        while ack is None and time.monotonic() < end:
            m = self.recv(max(0.0, end - time.monotonic()))
            if m is not None and m.get("type") == "hello_ack":
                ack = m
        if ack is None or ack.get("remote") is not True:
            self.close()
            raise StudioRemoteError(f"the bridge at {url} does not relay remote control"
                                    + (f" (it is {ack.get('bridge')!r})" if ack else " (no hello_ack)")
                                    + " — run the rig gateway: cd rig && pixi run rig")

    def send(self, obj: dict) -> None:
        self._ws.send(json.dumps(obj))

    def recv(self, timeout: float | None):
        """The next JSON object from the gateway (the hub's `frame` broadcasts included — the
        caller filters), or None after `timeout` seconds."""
        from websockets.exceptions import ConnectionClosed

        end = None if timeout is None else time.monotonic() + timeout
        while True:
            remaining = None if end is None else end - time.monotonic()
            if remaining is not None and remaining <= 0:
                return None
            try:
                raw = self._ws.recv(timeout=remaining)
            except TimeoutError:
                return None
            except ConnectionClosed as exc:
                raise StudioRemoteError(f"the gateway connection closed ({exc})") from exc
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if isinstance(msg, dict):
                return msg

    def close(self) -> None:
        try:
            self._cm.__exit__(None, None, None)
        except Exception:  # noqa: BLE001 — already closed
            pass


# ── transport: ROS 2 ─────────────────────────────────────────────────────────────────
class _RosLink:
    """One ROS node per StudioRemote: a publisher on /arena/run_request and a subscription on
    /arena/run_status, in a PRIVATE rclpy context (the host program's own rclpy use, its SIGINT
    handling and its executor are left alone) and with a private executor. Created on first use
    and kept, so discovery is paid once. `rclpy` is imported here, never at module import.

    Only API that exists on both ROS 2 Jazzy and Lyrical is used (create_publisher /
    create_subscription, Publisher.get_subscription_count, Node.count_publishers,
    SingleThreadedExecutor.spin_once, a Context passed to init / Node / executor)."""

    def __init__(self, timeout_s: float = 5.0) -> None:
        try:
            try:
                import rig_nodes._common  # noqa: F401  — applies the loopback Zenoh configuration to the environment (reiserlab/rig-nodes)
                from rig_nodes import zenoh as rig_zenoh
            except ImportError:
                rig_zenoh = None  # a plain ROS 2 environment: whatever RMW the environment names
            # This workspace tells rmw_zenoh to wait for its router without limit
            # (ZENOH_ROUTER_CHECK_ATTEMPTS=0), so rclpy.init() would block forever on a PC where
            # the rig is not running. Look for the router first — only when the environment
            # is the package's own loopback configuration, whose endpoint is known.
            if (rig_zenoh is not None and os.environ.get("RMW_IMPLEMENTATION") == "rmw_zenoh_cpp"
                    and os.environ.get("ZENOH_SESSION_CONFIG_URI") == str(rig_zenoh.SESSION_CONFIG)):
                from rig_nodes.supervise import wait_port

                if not wait_port("127.0.0.1", rig_zenoh.ROUTER_PORT, max(0.5, timeout_s)):
                    raise StudioRemoteError(f"no gateway on the ROS graph (no Zenoh router on 127.0.0.1:{rig_zenoh.ROUTER_PORT} "
                                            f"after {timeout_s:g} s) — is `pixi run rig` running?")
            import rclpy
            from rclpy.context import Context
            from rclpy.executors import SingleThreadedExecutor
            from rclpy.node import Node
            from rclpy.qos import QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile, QoSReliabilityPolicy
            from std_msgs.msg import String
        except ImportError as exc:
            raise StudioRemoteError(f'transport "ros" needs rclpy ({exc}) — run inside the rig pixi environment '
                                    '(cd rig && pixi run …), or use transport="ws"') from exc
        self._rclpy = rclpy
        self._String = String
        self._ctx = Context()
        try:  # no signal handlers: Ctrl-C stays a KeyboardInterrupt, which run() turns into a stop request
            from rclpy.signals import SignalHandlerOptions

            rclpy.init(context=self._ctx, signal_handler_options=SignalHandlerOptions.NO)
        except (ImportError, TypeError):
            rclpy.init(context=self._ctx)
        qos = QoSProfile(reliability=QoSReliabilityPolicy.RELIABLE, history=QoSHistoryPolicy.KEEP_LAST, depth=200,
                         durability=QoSDurabilityPolicy.VOLATILE)  # the gateway's RAW_QOS
        self.node = Node("studio_remote_" + uuid.uuid4().hex[:8], context=self._ctx)
        self._listeners: list[queue.Queue] = []
        self._lock = threading.Lock()
        self._spin_lock = threading.Lock()
        # Subscribe BEFORE the publisher exists, so no answer can precede the subscription.
        self._sub = self.node.create_subscription(String, RUN_STATUS_TOPIC, self._on_status, qos)
        self.pub = self.node.create_publisher(String, RUN_REQUEST_TOPIC, qos)
        self._exec = SingleThreadedExecutor(context=self._ctx)
        self._exec.add_node(self.node)
        self._closed = False
        self.matched_after_s: float | None = None
        atexit.register(self.close)

    def _on_status(self, msg) -> None:
        try:
            obj = json.loads(msg.data)
        except (TypeError, ValueError):
            return
        if not isinstance(obj, dict):
            return
        with self._lock:
            listeners = list(self._listeners)
        for q in listeners:
            q.put(obj)

    def pump(self, timeout: float) -> None:
        """Let the node receive for up to `timeout` s. One thread spins at a time; another
        caller (a stop() from a second thread while run() waits) just yields — the spinning
        thread fills every listener's queue."""
        if self._spin_lock.acquire(blocking=False):
            try:
                self._exec.spin_once(timeout_sec=max(0.0, timeout))
            finally:
                self._spin_lock.release()
        else:
            time.sleep(min(max(0.0, timeout), 0.02))

    def gateway_present(self) -> bool:
        return self.pub.get_subscription_count() > 0

    def wait_matched(self, timeout_s: float) -> None:
        """A message published right after the publisher is created is LOST while discovery is
        still running: wait until the gateway's /arena/run_request subscription has matched this
        publisher and its /arena/run_status publisher is visible."""
        t0 = time.monotonic()
        while True:
            if self.gateway_present() and self.node.count_publishers(RUN_STATUS_TOPIC) > 0:
                if self.matched_after_s is None:
                    self.matched_after_s = time.monotonic() - t0
                    end = time.monotonic() + 0.2  # the gateway's side of the match, a moment later
                    while time.monotonic() < end:
                        self.pump(0.05)
                return
            if time.monotonic() - t0 >= timeout_s:
                self.matched_after_s = None
                raise StudioRemoteError(f"no gateway on the ROS graph (nothing subscribes {RUN_REQUEST_TOPIC} after {timeout_s:g} s) — "
                                        "is `pixi run rig` running, in the same ROS environment (router, RMW)?")
            self.pump(0.05)

    def channel(self, timeout_s: float) -> "_RosChannel":
        if self._closed:
            raise StudioRemoteError("this StudioRemote was closed")
        if not self.gateway_present():
            self.matched_after_s = None  # the gateway left (or never was): match again
        self.wait_matched(timeout_s)
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._listeners.append(q)
        return _RosChannel(self, q)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for step in (lambda: self._exec.remove_node(self.node), self._exec.shutdown, self.node.destroy_node,
                     lambda: self._rclpy.try_shutdown(context=self._ctx)):
            try:
                step()
            except Exception:  # noqa: BLE001 — teardown order races are harmless here
                pass


class _RosChannel:
    """One request's view of the link: its own queue of every /arena/run_status message."""

    def __init__(self, link: _RosLink, q: "queue.Queue") -> None:
        self._link = link
        self._q = q
        self._gone_since: float | None = None
        self._checked = 0.0

    def send(self, obj: dict) -> None:
        m = self._link._String()
        m.data = json.dumps(obj)
        self._link.pub.publish(m)

    def recv(self, timeout: float | None):
        end = None if timeout is None else time.monotonic() + timeout
        while True:
            try:
                return self._q.get_nowait()
            except queue.Empty:
                pass
            now = time.monotonic()
            if end is not None and now >= end:
                return None
            if now - self._checked >= 1.0:  # a topic has no "connection closed": watch the gateway's subscription
                self._checked = now
                if self._link.gateway_present():
                    self._gone_since = None
                else:
                    self._gone_since = self._gone_since or now
                    if now - self._gone_since >= GATEWAY_GONE_S:
                        raise StudioRemoteError(f"the gateway left the ROS graph (no subscriber on {RUN_REQUEST_TOPIC} for {GATEWAY_GONE_S:g} s)")
            self._link.pump(0.1 if end is None else min(0.1, end - now))

    def close(self) -> None:
        with self._link._lock:
            if self._q in self._link._listeners:
                self._link._listeners.remove(self._q)


def read_protocol(protocol, name: str | None = None) -> tuple[str, str]:
    """→ (YAML text, file name). `protocol` is a path (str / Path) or the YAML text itself."""
    if isinstance(protocol, (bytes, bytearray)):
        protocol = protocol.decode("utf-8")
    if isinstance(protocol, os.PathLike):
        path = Path(protocol)
        return path.read_text(encoding="utf-8"), name or path.name
    if not isinstance(protocol, str) or not protocol.strip():
        raise ValueError("protocol must be a path or the YAML text")
    if "\n" not in protocol.strip():  # one line: a path, never a whole protocol
        path = Path(protocol).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"protocol file not found: {protocol}")
        return path.read_text(encoding="utf-8"), name or path.name
    return protocol, name or "remote.yaml"


def _public(msg: dict) -> dict:
    return {k: v for k, v in msg.items() if k != "type"}


class StudioRemote:
    """A controller for one Arena Studio in remote-control mode. One run at a time per object.

    transport            "ros" (default): /arena/run_request + /arena/run_status on the ROS graph;
                         "ws": the gateway's WebSocket at `url`
    url                  the gateway's WebSocket (transport "ws" only)
    connect_timeout_s    ROS: how long to wait for the gateway to appear on the graph;
                         WebSocket: the connection timeout
    client               free text naming this program in the gateway's bookkeeping and the bag
    """

    def __init__(self, transport: str = "ros", url: str = DEFAULT_URL, connect_timeout_s: float = 5.0, client: str | None = None) -> None:
        if isinstance(transport, str) and transport.startswith(("ws://", "wss://")):  # StudioRemote("ws://host:8765")
            transport, url = "ws", transport
        if transport not in TRANSPORTS:
            raise ValueError(f'transport must be "ros" or "ws", not {transport!r}')
        self.transport = transport
        self.url = url
        self.connect_timeout_s = float(connect_timeout_s)
        self.client = client or f"studio_remote.py@{socket.gethostname()}:{os.getpid()}"
        self._ros: _RosLink | None = None
        self._run_ch = None  # the channel run() is waiting on (WebSocket: the owner socket)
        self._run_id: str | None = None
        self._stop_replies: "queue.Queue[dict]" = queue.Queue()
        self._lock = threading.Lock()
        self.last_status: dict | None = None  # the most recent run_status seen by run()

    # ── plumbing ─────────────────────────────────────────────────────────────────────
    def _open(self):
        """A channel for one request: send(obj), recv(timeout) → dict | None, close()."""
        if self.transport == "ws":
            return _WsChannel(self.url, self.connect_timeout_s)
        with self._lock:
            if self._ros is None:
                self._ros = _RosLink(self.connect_timeout_s)
            link = self._ros
        return link.channel(self.connect_timeout_s)

    def close(self) -> None:
        """Release the ROS node (transport "ros"). The object can be used again afterwards."""
        with self._lock:
            link, self._ros = self._ros, None
        if link is not None:
            link.close()

    def __enter__(self) -> "StudioRemote":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @staticmethod
    def _wait(ch, want, timeout_s: float | None):
        """Read until `want(msg)` is true (everything else — other runs' statuses, the hub's
        frames — is skipped). None on timeout."""
        end = None if timeout_s is None else time.monotonic() + timeout_s
        while True:
            remaining = None if end is None else end - time.monotonic()
            if remaining is not None and remaining <= 0:
                return None
            msg = ch.recv(remaining)
            if msg is None:
                return None
            if want(msg):
                return msg

    def _request(self, action: str, **fields) -> dict:
        return {"type": "run_request", "id": uuid.uuid4().hex, "action": action, "client": self.client, **fields}

    # ── run ──────────────────────────────────────────────────────────────────────────
    def run(self, protocol_path_or_text, name: str | None = None, intent: str = "test", metadata: dict | None = None,
            timeout_s: float | None = None, on_status=None) -> dict:
        """Run one protocol in the Studio and wait for it to end. Returns the terminal status.

        protocol_path_or_text  a YAML file path, or the YAML text itself
        name                   the file name the Studio shows / records (default: the path's)
        intent                 "test" (default; not auto-committed) or "experiment" (a recorded run:
                               the Studio requires Experimenter and Fly genotype, as its Run button does)
        metadata               {experimenter, genotype, age, sex, fly_number, notes} — set in the
                               Studio's Run details panel; a key left out keeps the panel's value
        timeout_s              None = wait as long as the run takes. Otherwise: after this many
                               seconds the run is STOPPED and its status returned with
                               "timed_out": True
        on_status              called with every run_status dict (accepted, running + step, terminal)

        Raises StudioRemoteError when the gateway cannot be reached or goes away mid-run
        (then `status()` reports the run's result once it ends), ValueError on a bad argument.
        Ctrl-C while waiting stops the run, then re-raises KeyboardInterrupt.
        """
        if intent not in ("test", "experiment"):
            raise ValueError('intent must be "test" or "experiment"')
        text, fname = read_protocol(protocol_path_or_text, name)
        md = {}
        for k, v in (metadata or {}).items():
            if k not in METADATA_KEYS:
                raise ValueError(f"unknown metadata field {k!r} (one of {', '.join(METADATA_KEYS)})")
            md[k] = "" if v is None else str(v)
        with self._lock:
            if self._run_ch is not None:
                raise StudioRemoteError("this StudioRemote is already waiting on a run")
        ch = self._open()
        req = self._request("run", name=fname, protocol=text, intent=intent, metadata=md)
        rid = req["id"]
        with self._lock:
            self._run_ch, self._run_id = ch, rid
        while not self._stop_replies.empty():
            self._stop_replies.get_nowait()
        try:
            ch.send(req)
            deadline = None if timeout_s is None else time.monotonic() + float(timeout_s)
            timed_out = False
            while True:
                remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
                try:
                    msg = self._wait(ch, lambda m: m.get("type") == "run_status", remaining)
                except KeyboardInterrupt:
                    self._send_stop(ch, rid)
                    final = self._wait_terminal(ch, rid, STOP_GRACE_S, on_status)
                    if final is not None:
                        self.last_status = final
                    raise
                if msg is None:  # timeout_s is over: stop the run, then keep waiting for its end
                    if timed_out:
                        raise TimeoutError(f"run {rid}: no terminal status {STOP_GRACE_S:g} s after the stop request")
                    timed_out = True
                    self._send_stop(ch, rid)
                    deadline = time.monotonic() + STOP_GRACE_S
                    continue
                if msg.get("action") == "stop":  # the gateway's / Studio's answer to a stop request
                    self._stop_replies.put(msg)
                    continue
                if msg.get("id") != rid:
                    continue
                status = _public(msg)
                self.last_status = status
                if on_status is not None:
                    on_status(dict(status))
                if status.get("state") in TERMINAL_STATES:
                    if timed_out:
                        status["timed_out"] = True
                    return status
        finally:
            with self._lock:
                self._run_ch = None
                self._run_id = None
            ch.close()

    def _send_stop(self, ch, rid: str) -> str:
        req = self._request("stop", run=rid)
        try:
            ch.send(req)
        except Exception as exc:  # noqa: BLE001 — the link is gone; the caller's wait reports it
            print(f"[studio_remote] could not send the stop request: {exc}", file=sys.stderr)
        return req["id"]

    def _wait_terminal(self, ch, rid: str, timeout_s: float, on_status=None) -> dict | None:
        try:
            msg = self._wait(ch, lambda m: m.get("type") == "run_status" and m.get("id") == rid
                             and m.get("action") is None and m.get("state") in TERMINAL_STATES, timeout_s)
        except StudioRemoteError:
            return None
        if msg is None:
            return None
        status = _public(msg)
        if on_status is not None:
            on_status(dict(status))
        return status

    # ── stop / status ────────────────────────────────────────────────────────────────
    def stop(self, timeout_s: float = 5.0) -> dict:
        """Ask the Studio to stop the active run. Returns the answer to the REQUEST:
        {"state": "accepted", "action": "stop", "run": <id>} when it was forwarded (the run's own
        terminal status — `aborted`, "stopped by the remote controller" — is what `run()` returns),
        or {"state": "rejected", "detail": …}: no run is active, or another controller owns it.

        Over ROS any client may stop a run that was started over ROS (one shared owner) — also
        from another process (`pixi run remote -- stop`). Over the WebSocket only the socket
        that started the run may: call it from another thread, or from `on_status`, while
        `run()` is waiting; from a different process it is rejected."""
        with self._lock:
            ch, rid = self._run_ch, self._run_id
        if self.transport == "ws" and ch is not None and rid is not None:  # the owner socket is run()'s
            self._send_stop(ch, rid)
            try:
                return _public(self._stop_replies.get(timeout=timeout_s))
            except queue.Empty:
                return {"state": "accepted", "action": "stop", "run": rid, "detail": "stop sent; no answer yet"}
        ch = self._open()
        try:
            req = self._request("stop", **({"run": rid} if rid else {}))
            ch.send(req)
            msg = self._wait(ch, lambda m: m.get("type") == "run_status" and m.get("id") == req["id"], timeout_s)
            if msg is None:
                raise StudioRemoteError(f"no answer to the stop request within {timeout_s:g} s")
            return _public(msg)
        finally:
            ch.close()

    def status(self, timeout_s: float = 5.0) -> dict:
        """The gateway's bookkeeping: {"executor": bool (a Studio is in remote-control mode),
        "active": {id, state, name, intent, step, bag, origin ("ros" | "ws"), client,
        owner_connected} or None, "last": the most recent terminal status or None}."""
        ch = self._open()
        try:
            req = self._request("status")
            ch.send(req)
            msg = self._wait(ch, lambda m: m.get("type") == "remote_status" and m.get("id") == req["id"], timeout_s)
            if msg is None:
                raise StudioRemoteError(f"no answer to the status request within {timeout_s:g} s")
            return {k: v for k, v in msg.items() if k not in ("type", "id")}
        finally:
            ch.close()


# ── command line ─────────────────────────────────────────────────────────────────────
def _describe(status: dict) -> str:
    step = status.get("step") or {}
    text = str(status.get("state"))
    if step.get("i"):
        text += f" — step {step['i']}" + (f" of {step['n']}" if step.get("n") else "") + (f" ({step['condition']})" if step.get("condition") else "")
    if status.get("detail"):
        text += f" — {status['detail']}"
    if status.get("bag"):
        text += f" — bag {status['bag']}"
    return text


def _ws_flag(argv: list[str]) -> list[str]:
    """`--ws` takes an OPTIONAL url: written without one it must not swallow the next word."""
    out = []
    for i, a in enumerate(argv):
        bare = a == "--ws" and not (i + 1 < len(argv) and argv[i + 1].startswith(("ws://", "wss://")))
        out.append("--ws=" + DEFAULT_URL if bare else a)
    return out


def main(argv=None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ws", metavar="URL", default=argparse.SUPPRESS,
                        help=f"use the gateway's WebSocket instead of ROS 2 (URL optional; default {DEFAULT_URL})")
    common.add_argument("--connect-timeout", type=float, default=argparse.SUPPRESS,
                        help="seconds to wait for the gateway (ROS: to appear on the graph; default 5)")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", parents=[common], help="run a protocol in the Studio and wait for it to end (exit 0 only when it is done)")
    r.add_argument("protocol", help="protocol YAML file")
    r.add_argument("--name", default=None, help="file name the Studio shows and records (default: the file's name)")
    r.add_argument("--experiment", action="store_true",
                   help='a recorded run (intent "experiment"; needs --experimenter and --genotype, or the Studio\'s Run details filled in); default is a test run')
    for key in METADATA_KEYS:
        r.add_argument("--" + key.replace("_", "-"), dest=key, default=None, help=f"Run details: {key.replace('_', ' ')}")
    r.add_argument("--timeout", type=float, default=None, help="seconds to wait; then the run is stopped (default: no limit)")
    r.add_argument("--json", action="store_true", help="print the terminal status as JSON on stdout")
    s = sub.add_parser("stop", parents=[common], help="ask the Studio to stop the active run (ROS: any ROS-started run; WebSocket: only from the program that started it)")
    s.add_argument("--json", action="store_true")
    t = sub.add_parser("status", parents=[common], help="is a Studio in remote-control mode? is a run active? the last result")
    t.add_argument("--json", action="store_true")
    a = ap.parse_args(_ws_flag(list(sys.argv[1:] if argv is None else argv)))
    ws_url = getattr(a, "ws", None)
    studio = StudioRemote(transport="ws" if ws_url else "ros", url=ws_url or DEFAULT_URL,
                          connect_timeout_s=getattr(a, "connect_timeout", 5.0))
    try:
        if a.cmd == "status":
            st = studio.status()
            if a.json:
                print(json.dumps(st))
            else:
                act, last = st.get("active"), st.get("last")
                print("Studio in remote-control mode: " + ("yes" if st.get("executor") else "no"))
                print("active run: " + (f"{act.get('id')} {act.get('name') or ''} (started over {act.get('origin')}) — {_describe(act)}" if act else "none"))
                print("last result: " + (f"{last.get('id')} — {_describe(last)}" if last else "none"))
            return 0
        if a.cmd == "stop":
            st = studio.stop()
            print(json.dumps(st) if a.json else "stop: " + _describe(st))
            return 0 if st.get("state") == "accepted" else 1
        metadata = {k: getattr(a, k) for k in METADATA_KEYS if getattr(a, k) is not None}
        final = studio.run(a.protocol, name=a.name, intent="experiment" if a.experiment else "test", metadata=metadata,
                           timeout_s=a.timeout, on_status=lambda st: print("[studio] " + _describe(st), file=sys.stderr, flush=True))
        if a.json:
            print(json.dumps(final))
        return 0 if final.get("state") == "done" else 1
    except KeyboardInterrupt:
        last = studio.last_status
        print("[studio] interrupted — stop requested" + (": " + _describe(last) if last else ""), file=sys.stderr)
        return 130
    except (StudioRemoteError, TimeoutError, FileNotFoundError, ValueError) as exc:
        print(f"[studio_remote] {exc}", file=sys.stderr)
        return 2
    finally:
        studio.close()


if __name__ == "__main__":
    raise SystemExit(main())
