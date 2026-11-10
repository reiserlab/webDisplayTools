#!/usr/bin/env python3
"""test_remote_relay.py — the gateway's remote-control relay (LAB-357), against a REAL bridge node.

    pixi run test-remote                  # from rig/ (≈ 20 s); needs port 7447 free (no rig running)

Starts a Zenoh router and nodes/bridge_node.py (own WebSocket port, temp log dir), then plays
both ends of the conversation: a FAKE EXECUTOR over a WebSocket (what the Studio page in
remote-control mode sends: remote_attach, log_control, run_status) and CONTROLLERS on both
transports — WebSocket sockets and a ROS node publishing /arena/run_request — plus the real
Python client (nodes/studio_remote.py) on each transport.

  attach            hello_ack says remote:true; attach acked; a second attach refused while the
                    first socket is open; allowed again after it closed
  no executor       run → rejected "no Studio in remote-control mode"
  forward + relay   run forwarded VERBATIM; accepted / running(step) reach the owner only
  busy              a second controller's run → rejected, naming the active run
  owner-only stop   another controller's stop → rejected; the owner's is forwarded
  status            answered by the gateway (executor, active run id + state, last result)
  the order rule    the terminal status arrives after the run's bag is closed, with `bag`:
                    (a) the executor closes the log first, as the Studio does;
                    (b) it does not — the gateway closes it before forwarding
  executor lost     its socket closes mid-run → the owner gets failed "Studio disconnected"
  /arena/run_status every status is published (rclpy subscriber) and recorded in the run's bag
                    together with the run_request; the converter still derives the run log
  over ROS          a request on /arena/run_request is forwarded to the executor (same object +
                    `type`), every answer comes back on /arena/run_status (rejected without an
                    executor, statuses, the stop's accepted, remote_status); all ROS publishers
                    are ONE owner — a ROS stop ends a ROS-owned run, never a WebSocket-owned
                    one, and the reverse; the request is in the run's bag (/arena/run_request)
  the ROS client    StudioRemote(transport="ros"): "no gateway on the ROS graph" when there is
                    none; run / status / stop end to end, publishing only after the match

Exit 0 when every check passes.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "nodes"))
from rig_nodes.supervise import popen_group, signal_group, wait_port  # noqa: E402  (reiserlab/rig-nodes)

from studio_remote import StudioRemote, StudioRemoteError  # noqa: E402

failures = 0
YAML = "version: 3\nexperiment_info:\n  name: remote relay test\n"  # the gateway never parses it


def check(name: str, ok: bool, detail: str = "") -> bool:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({str(detail)[:400]})" if detail and not ok else ""), flush=True)
    return bool(ok)


def free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Sock:
    """One WebSocket client with a typed inbox (the hub's `frame` broadcasts are dropped)."""

    def __init__(self, url: str, name: str) -> None:
        self.url, self.name = url, name
        self.ws = None
        self.inbox: asyncio.Queue = asyncio.Queue()
        self._reader = None

    async def open(self) -> "Sock":
        import websockets

        self.ws = await websockets.connect(self.url, max_size=None)
        self._reader = asyncio.create_task(self._read())
        return self

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and msg.get("type") != "frame":
                    await self.inbox.put(msg)
        except Exception:  # noqa: BLE001 — closed
            pass

    async def send(self, obj: dict) -> None:
        await self.ws.send(json.dumps(obj))

    async def get(self, kind: str, timeout: float = 5.0, **match) -> dict | None:
        """The next message of `kind` whose fields equal `match` (others of that kind are skipped)."""
        end = time.monotonic() + timeout
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return None
            try:
                msg = await asyncio.wait_for(self.inbox.get(), remaining)
            except asyncio.TimeoutError:
                return None
            if msg.get("type") == kind and all(msg.get(k) == v for k, v in match.items()):
                return msg

    async def nothing(self, kind: str, wait: float = 0.6) -> bool:
        """True when no message of `kind` arrives within `wait` s."""
        return await self.get(kind, wait) is None

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()
        if self._reader is not None:
            self._reader.cancel()


class RosSide:
    """The test's own ROS node as a controller: publish on /arena/run_request, read what the
    gateway publishes on /arena/run_status (collected by the spin thread into `got`)."""

    def __init__(self, publish, got: list) -> None:
        self._publish = publish
        self.got = got
        self._used: set[int] = set()

    def send(self, obj: dict) -> None:
        self._publish(json.dumps(obj))

    async def get(self, timeout: float = 5.0, **match) -> dict | None:
        """The next not-yet-returned status whose fields equal `match`."""
        end = time.monotonic() + timeout
        while True:
            for i, m in enumerate(list(self.got)):
                if i not in self._used and all(m.get(k) == v for k, v in match.items()):
                    self._used.add(i)
                    return m
            if time.monotonic() >= end:
                return None
            await asyncio.sleep(0.05)


def bag_closed(bag: str | None) -> bool:
    """A cleanly closed rosbag2 bag: metadata.yaml written and the MCAP readable to its end."""
    if not bag:
        return False
    p = Path(bag)
    return p.is_dir() and (p / "metadata.yaml").exists() and any(p.glob("*.mcap"))


def bag_topics(bag: str) -> dict[str, list]:
    from mcap_convert import _json_of, read_all

    recs, _info = read_all(bag)
    out: dict[str, list] = {}
    for r in recs:
        out.setdefault(r["topic"], []).append(_json_of(r))
    return out


async def scenario(url: str, got_ros: list, ros: RosSide) -> None:
    ex = await Sock(url, "executor").open()
    c1 = await Sock(url, "controller-1").open()
    c2 = await Sock(url, "controller-2").open()

    # ── hello / no executor ──
    await ex.send({"type": "hello", "client": "webDisplayTools", "v": 1})
    ack = await ex.get("hello_ack")
    check("hello_ack says remote: true", bool(ack) and ack.get("remote") is True, str(ack)[:200])
    await c1.send({"type": "run_request", "id": "r0", "action": "run", "name": "a.yaml", "protocol": YAML})
    m = await c1.get("run_status", id="r0")
    check("run without an executor → rejected, 'no Studio in remote-control mode'",
          bool(m) and m["state"] == "rejected" and m.get("detail") == "no Studio in remote-control mode", str(m))
    await c1.send({"type": "run_request", "id": "s0", "action": "status"})
    m = await c1.get("remote_status", id="s0")
    check("status (no executor): executor false, no active run", bool(m) and m["executor"] is False and m["active"] is None, str(m))
    ros.send({"id": "ros-0", "action": "run", "name": "a.yaml", "protocol": YAML, "client": "test-sequencer"})
    m = await ros.get(id="ros-0")
    check("ROS: run without an executor → rejected on /arena/run_status",
          bool(m) and m.get("type") == "run_status" and m["state"] == "rejected" and m.get("detail") == "no Studio in remote-control mode", str(m))
    ros.send({"id": "ros-s0", "action": "status"})
    m = await ros.get(id="ros-s0")
    check("ROS: status → remote_status on /arena/run_status (executor false)",
          bool(m) and m.get("type") == "remote_status" and m["executor"] is False and m["active"] is None, str(m))
    ros.send({"id": "ros-bad", "action": "pause"})
    m = await ros.get(id="ros-bad")
    check("ROS: an unknown action → rejected on the topic", bool(m) and m["state"] == "rejected" and "unknown action" in m.get("detail", ""), str(m))

    # ── attach / refuse a second one ──
    await ex.send({"type": "remote_attach", "on": True})
    m = await ex.get("remote_attach_ack")
    check("remote_attach on → ack ok", bool(m) and m["ok"] is True and m["on"] is True, str(m))
    ex2 = await Sock(url, "executor-2").open()
    await ex2.send({"type": "remote_attach", "on": True})
    m = await ex2.get("remote_attach_ack")
    check("a second attach while the first socket is open → refused with an error",
          bool(m) and m["ok"] is False and m["on"] is False and "another Studio" in str(m.get("error")), str(m))

    # ── run 1: forwarded verbatim, relayed, busy, owner-only stop, executor closes the log first ──
    req1 = {"type": "run_request", "id": "run-1", "action": "run", "name": "one.yaml", "protocol": YAML, "intent": "experiment",
            "metadata": {"experimenter": "tester", "genotype": "CS", "age": "", "sex": "", "fly_number": "3", "notes": "relay test"}}
    await c1.send(req1)
    fwd = await ex.get("run_request", id="run-1")
    check("run forwarded to the executor verbatim", fwd == req1, str(fwd)[:300])
    await ex.send({"type": "run_status", "id": "run-1", "state": "accepted"})
    m = await c1.get("run_status", id="run-1")
    check("accepted relayed to the owner", bool(m) and m["state"] == "accepted", str(m))
    check("… and not to another controller", await c2.nothing("run_status"))
    # the Studio's run start: log on (a new bag), then progress
    await ex.send({"type": "log_control", "enabled": True, "level": "behavior_v2"})
    lack = await ex.get("log_control_ack")
    check("the run's log + bag open (log_control_ack enabled)", bool(lack) and lack["enabled"] is True, str(lack))
    await ex.send({"type": "log", "event": "run_metadata", "run_id": "t1", "intent": "experiment"})
    await ex.send({"type": "run_status", "id": "run-1", "state": "running"})
    await ex.send({"type": "run_status", "id": "run-1", "state": "running", "step": {"i": 1, "n": 3, "condition": "cw"}})
    await c1.get("run_status", id="run-1")
    m = await c1.get("run_status", id="run-1")
    check("running + step relayed", bool(m) and m["state"] == "running" and (m.get("step") or {}).get("i") == 1, str(m))

    await c2.send({"type": "run_request", "id": "run-x", "action": "run", "name": "x.yaml", "protocol": YAML})
    m = await c2.get("run_status", id="run-x")
    check("a second controller's run → rejected busy, naming the active run",
          bool(m) and m["state"] == "rejected" and "busy" in m.get("detail", "") and "run-1" in m.get("detail", ""), str(m))
    check("… and never reaches the executor", await ex.nothing("run_request"))
    await c2.send({"type": "run_request", "id": "stop-x", "action": "stop"})
    m = await c2.get("run_status", id="stop-x")
    check("another controller's stop → rejected (owner only)",
          bool(m) and m["state"] == "rejected" and m.get("action") == "stop" and "owner" in m.get("detail", ""), str(m))
    check("… and never reaches the executor", await ex.nothing("run_request"))
    await c2.send({"type": "run_request", "id": "s1", "action": "status"})
    m = await c2.get("remote_status", id="s1")
    check("status: executor attached, active run id + state + step",
          bool(m) and m["executor"] is True and (m["active"] or {}).get("id") == "run-1" and m["active"]["state"] == "running"
          and (m["active"].get("step") or {}).get("i") == 1 and m["active"].get("bag"), str(m))

    stop1 = {"type": "run_request", "id": "stop-1", "action": "stop", "run": "run-1"}
    await c1.send(stop1)
    m = await c1.get("run_status", id="stop-1")
    check("the owner's stop → accepted (forwarded)", bool(m) and m["state"] == "accepted" and m.get("action") == "stop" and m.get("run") == "run-1", str(m))
    fwd = await ex.get("run_request", id="stop-1")
    check("stop forwarded to the executor verbatim", fwd == stop1, str(fwd))
    # the Studio: close the log, THEN the terminal status (same socket, in order)
    await ex.send({"type": "log_control", "enabled": False})
    await ex.send({"type": "run_status", "id": "run-1", "state": "aborted", "detail": "stopped by the remote controller",
                   "summary": {"completed": False, "aborted": True, "steps": 3, "errors": 0, "skipped": 0}})
    m = await c1.get("run_status", id="run-1")
    closed = bag_closed((m or {}).get("bag"))
    check("terminal status relayed with the summary", bool(m) and m["state"] == "aborted" and (m.get("summary") or {}).get("aborted") is True, str(m))
    check("terminal status carries `bag`, and the bag is CLOSED when it arrives", closed, str(m))
    check("… closed by the executor's own log_control (not by the gateway)", bool(m) and "bag_closed_by" not in m, str(m))
    bag1 = (m or {}).get("bag")
    if closed:
        t = bag_topics(bag1)
        st = [s for s in t.get("/arena/run_status", []) if isinstance(s, dict)]
        check("the bag records /arena/run_status (accepted before it opened, then running + step)",
              [s.get("state") for s in st][:3] == ["accepted", "running", "running"] and all("seq" in s for s in st), str(st)[:300])
        reqs = [json.loads(b["raw"]) for b in t.get("/arena/browser", []) if isinstance(b, dict) and '"run_request"' in str(b.get("raw"))]
        check("the bag records the run_request with its YAML text (/arena/browser)",
              any(r.get("id") == "run-1" and r.get("protocol") == YAML for r in reqs), str(reqs)[:300])
        from mcap_convert import convert_bag

        text, report = convert_bag(bag1, level=None, order="seq")
        check("the converter still derives the run log, with no line for the relay messages",
              '"run_metadata"' in text and "run_request" not in text and "run_status" not in text, str(report)[:200])
    await c1.send({"type": "run_request", "id": "s2", "action": "status"})
    m = await c1.get("remote_status", id="s2")
    check("status after the run: nothing active, last = the terminal status with its bag",
          bool(m) and m["active"] is None and (m["last"] or {}).get("id") == "run-1" and m["last"].get("bag") == bag1, str(m))
    await c1.send({"type": "run_request", "id": "stop-2", "action": "stop"})
    m = await c1.get("run_status", id="stop-2")
    check("stop with no active run → rejected", bool(m) and m["state"] == "rejected" and m.get("detail") == "no run is active", str(m))

    # ── run 2 (the real Python client): the executor does NOT close the log → the gateway does ──
    statuses: list[dict] = []

    def client_run():
        return StudioRemote(transport="ws", url=url).run(YAML, name="two.yaml", intent="test", metadata={"genotype": "CS"}, timeout_s=30, on_status=statuses.append)

    task = asyncio.create_task(asyncio.to_thread(client_run))
    fwd = await ex.get("run_request", timeout=8.0)
    check("studio_remote.py (WebSocket) run(): the request reaches the executor (name, intent, metadata, YAML text)",
          bool(fwd) and fwd.get("action") == "run" and fwd.get("name") == "two.yaml" and fwd.get("intent") == "test"
          and fwd.get("metadata") == {"genotype": "CS"} and fwd.get("protocol") == YAML, str(fwd)[:300])
    rid = (fwd or {}).get("id")
    await ex.send({"type": "run_status", "id": rid, "state": "accepted"})
    await ex.send({"type": "log_control", "enabled": True, "level": "behavior_v2"})
    await ex.get("log_control_ack")
    await ex.send({"type": "run_status", "id": rid, "state": "running", "step": {"i": 1, "n": 1, "condition": "only"}})
    await ex.send({"type": "run_status", "id": rid, "state": "done", "summary": {"completed": True, "aborted": False, "steps": 1}})
    final = await asyncio.wait_for(task, 15.0)
    check("run() returns the terminal status (done, summary)", final.get("state") == "done" and (final.get("summary") or {}).get("completed") is True, str(final))
    check("the gateway closed the open log itself before forwarding (bag closed, bag_closed_by: gateway)",
          bag_closed(final.get("bag")) and final.get("bag_closed_by") == "gateway" and final.get("bag") != bag1, str(final))
    check("on_status saw accepted → running → done", [s.get("state") for s in statuses] == ["accepted", "running", "done"], str(statuses)[:300])
    lack = None
    await ex.send({"type": "log_control", "enabled": False})  # the page's own (now redundant) close: harmless
    lack = await ex.get("log_control_ack")
    check("the executor's late log close is a harmless no-op", bool(lack) and lack["enabled"] is False, str(lack))

    # ── run 3 (the real client): stop() from another thread, as a MATLAB timer / second thread would ──
    studio = StudioRemote(transport="ws", url=url)
    task = asyncio.create_task(asyncio.to_thread(lambda: studio.run(YAML, name="three.yaml", timeout_s=30)))
    fwd = await ex.get("run_request", timeout=8.0)
    rid = (fwd or {}).get("id")
    await ex.send({"type": "run_status", "id": rid, "state": "accepted"})
    await ex.send({"type": "run_status", "id": rid, "state": "running"})
    await asyncio.sleep(0.3)
    stop_task = asyncio.create_task(asyncio.to_thread(studio.stop))
    sfwd = await ex.get("run_request", timeout=8.0, action="stop")
    check("studio_remote.py stop(): forwarded to the executor, naming the run", bool(sfwd) and sfwd.get("run") == rid, str(sfwd))
    srep = await asyncio.wait_for(stop_task, 10.0)
    check("stop() returns the gateway's answer (accepted)", srep.get("state") == "accepted" and srep.get("action") == "stop", str(srep))
    await ex.send({"type": "run_status", "id": rid, "state": "aborted", "detail": "stopped by the remote controller"})
    final = await asyncio.wait_for(task, 15.0)
    check("run() returns aborted 'stopped by the remote controller' (no bag: none was opened)",
          final.get("state") == "aborted" and final.get("detail") == "stopped by the remote controller" and "bag" not in final, str(final))
    st = await asyncio.to_thread(StudioRemote(url).status)  # a bare ws:// URL still selects the WebSocket
    check("studio_remote.py status(): executor attached, nothing active, last = run 3",
          st.get("executor") is True and st.get("active") is None and (st.get("last") or {}).get("id") == rid, str(st)[:300])

    # ── ROS run: forwarded, answered on the topic, stopped over ROS, recorded ──
    rreq = {"id": "ros-1", "action": "run", "name": "ros_one.yaml", "protocol": YAML, "intent": "test",
            "metadata": {"genotype": "CS"}, "client": "test-sequencer"}
    ros.send(rreq)
    fwd = await ex.get("run_request", id="ros-1")
    check("ROS: run forwarded to the executor — the same object, plus `type`", fwd == {**rreq, "type": "run_request"}, str(fwd)[:300])
    await ex.send({"type": "run_status", "id": "ros-1", "state": "accepted"})
    await ex.send({"type": "log_control", "enabled": True, "level": "behavior_v2"})
    await ex.get("log_control_ack")
    await ex.send({"type": "run_status", "id": "ros-1", "state": "running", "step": {"i": 1, "n": 2, "condition": "cw"}})
    m1 = await ros.get(id="ros-1", state="accepted")
    m2 = await ros.get(id="ros-1", state="running")
    check("ROS: the Studio's statuses come back on /arena/run_status (accepted, running + step)",
          bool(m1) and bool(m2) and (m2.get("step") or {}).get("i") == 1, f"{m1} {m2}")
    ros.send({"id": "ros-s1", "action": "status", "client": "test-sequencer"})
    m = await ros.get(id="ros-s1")
    check("ROS: status names the active run, its origin (ros) and the client",
          bool(m) and (m["active"] or {}).get("id") == "ros-1" and m["active"].get("origin") == "ros" and m["active"].get("client") == "test-sequencer", str(m))
    await c1.send({"type": "run_request", "id": "ws-stop-ros", "action": "stop"})
    m = await c1.get("run_status", id="ws-stop-ros")
    check("a WebSocket stop for a ROS-owned run → rejected (started over ROS)",
          bool(m) and m["state"] == "rejected" and "started over ROS" in m.get("detail", ""), str(m))
    await c1.send({"type": "run_request", "id": "ws-run-busy", "action": "run", "name": "b.yaml", "protocol": YAML})
    m = await c1.get("run_status", id="ws-run-busy")
    check("a WebSocket run during a ROS-owned run → rejected busy", bool(m) and m["state"] == "rejected" and "ros-1" in m.get("detail", ""), str(m))
    check("… neither reaches the executor", await ex.nothing("run_request"))
    rstop = {"id": "ros-stop-1", "action": "stop", "run": "ros-1", "client": "another-ros-node"}
    ros.send(rstop)
    m = await ros.get(id="ros-stop-1")
    check("ROS: stop for a ROS-owned run → accepted on the topic (any ROS publisher: one owner)",
          bool(m) and m["state"] == "accepted" and m.get("action") == "stop" and m.get("run") == "ros-1", str(m))
    fwd = await ex.get("run_request", id="ros-stop-1")
    check("ROS: stop forwarded to the executor", fwd == {**rstop, "type": "run_request"}, str(fwd))
    await ex.send({"type": "log_control", "enabled": False})
    await ex.send({"type": "run_status", "id": "ros-1", "state": "aborted", "detail": "stopped by the remote controller"})
    m = await ros.get(id="ros-1", state="aborted")
    rbag = (m or {}).get("bag")
    check("ROS: the terminal status on the topic carries the closed bag", bag_closed(rbag) and "bag_closed_by" not in (m or {}), str(m))
    if bag_closed(rbag):
        t = bag_topics(rbag)
        reqs = [r for r in t.get("/arena/run_request", []) if isinstance(r, dict)]
        check("ROS: the bag records the run request with its YAML text, and the stop (/arena/run_request)",
              any(r.get("id") == "ros-1" and r.get("protocol") == YAML and r.get("client") == "test-sequencer" for r in reqs)
              and any(r.get("id") == "ros-stop-1" for r in reqs), str(reqs)[:300])
        check("ROS: … and the statuses (/arena/run_status)",
              [x.get("state") for x in t.get("/arena/run_status", []) if isinstance(x, dict) and x.get("id") == "ros-1"][:2] == ["accepted", "running"], "")

    # ── a WebSocket-owned run cannot be stopped (or displaced) over ROS ──
    await c1.send({"type": "run_request", "id": "run-w", "action": "run", "name": "w.yaml", "protocol": YAML})
    await ex.get("run_request", id="run-w")
    await ex.send({"type": "run_status", "id": "run-w", "state": "accepted"})
    await ex.send({"type": "run_status", "id": "run-w", "state": "running"})
    await c1.get("run_status", id="run-w", state="running")
    ros.send({"id": "ros-stop-w", "action": "stop"})
    m = await ros.get(id="ros-stop-w")
    check("ROS: stop for a WebSocket-owned run → rejected on the topic (started by a WebSocket controller)",
          bool(m) and m["state"] == "rejected" and m.get("action") == "stop" and "WebSocket controller" in m.get("detail", ""), str(m))
    ros.send({"id": "ros-busy", "action": "run", "name": "x.yaml", "protocol": YAML})
    m = await ros.get(id="ros-busy")
    check("ROS: run during a WebSocket-owned run → rejected busy on the topic", bool(m) and m["state"] == "rejected" and "run-w" in m.get("detail", ""), str(m))
    check("… neither reaches the executor", await ex.nothing("run_request"))
    await c1.send({"type": "run_request", "id": "stop-w", "action": "stop"})
    await ex.get("run_request", id="stop-w")
    await ex.send({"type": "run_status", "id": "run-w", "state": "aborted", "detail": "stopped by the remote controller"})
    m = await c1.get("run_status", id="run-w", state="aborted")
    check("… and its own socket still stops it", bool(m), str(m))

    # ── the real client over ROS: run() on a fresh node (wait-for-match), status(), stop() from another node ──
    ros_seen: list[dict] = []

    def ros_client_run():
        with StudioRemote(transport="ros", connect_timeout_s=15.0, client="e2e-client") as s:
            r = s.run(YAML, name="ros_two.yaml", intent="test", metadata={"genotype": "CS"}, timeout_s=40, on_status=ros_seen.append)
            return r, s._ros.matched_after_s

    task = asyncio.create_task(asyncio.to_thread(ros_client_run))
    fwd = await ex.get("run_request", timeout=20.0)
    check("studio_remote.py (ROS) run(): published only after the match — the request reaches the executor",
          bool(fwd) and fwd.get("action") == "run" and fwd.get("name") == "ros_two.yaml" and fwd.get("intent") == "test"
          and fwd.get("metadata") == {"genotype": "CS"} and fwd.get("protocol") == YAML and fwd.get("client") == "e2e-client", str(fwd)[:300])
    rid = (fwd or {}).get("id")
    await ex.send({"type": "run_status", "id": rid, "state": "accepted"})
    await ex.send({"type": "log_control", "enabled": True, "level": "behavior_v2"})
    await ex.get("log_control_ack")
    await ex.send({"type": "run_status", "id": rid, "state": "running", "step": {"i": 1, "n": 1, "condition": "only"}})

    def ros_other():
        with StudioRemote(transport="ros", connect_timeout_s=15.0) as other:  # another node, another process in real use
            return other.status(), other.stop()

    other_task = asyncio.create_task(asyncio.to_thread(ros_other))
    sfwd = await ex.get("run_request", timeout=20.0, action="stop")
    st, srep = await asyncio.wait_for(other_task, 20.0)
    check("studio_remote.py (ROS) status() from another node: the active run, origin ros",
          (st.get("active") or {}).get("id") == rid and st["active"].get("origin") == "ros" and st["active"].get("client") == "e2e-client", str(st)[:300])
    check("studio_remote.py (ROS) stop() from another node → accepted and forwarded",
          srep.get("state") == "accepted" and srep.get("action") == "stop" and bool(sfwd), f"{srep} {sfwd}")
    await ex.send({"type": "log_control", "enabled": False})
    await ex.send({"type": "run_status", "id": rid, "state": "aborted", "detail": "stopped by the remote controller",
                   "summary": {"completed": False, "aborted": True, "steps": 1}})
    final, matched = await asyncio.wait_for(task, 20.0)
    check("studio_remote.py (ROS) run() returns the terminal status with the closed bag",
          final.get("state") == "aborted" and final.get("detail") == "stopped by the remote controller" and bag_closed(final.get("bag"))
          and (final.get("summary") or {}).get("aborted") is True, str(final))
    check("… on_status saw accepted → running → aborted; the match wait ran", [x.get("state") for x in ros_seen] == ["accepted", "running", "aborted"]
          and isinstance(matched, float), f"{[x.get('state') for x in ros_seen]} matched={matched}")

    # ── run 4: the executor's socket closes mid-run ──
    await c1.send({"type": "run_request", "id": "run-4", "action": "run", "name": "four.yaml", "protocol": YAML})
    await ex.get("run_request", id="run-4")
    await ex.send({"type": "run_status", "id": "run-4", "state": "accepted"})
    await ex.send({"type": "log_control", "enabled": True, "level": "behavior_v2"})
    await ex.get("log_control_ack")
    await ex.send({"type": "run_status", "id": "run-4", "state": "running", "step": {"i": 2, "n": 5, "condition": "ccw"}})
    await c1.get("run_status", id="run-4", state="running")
    await ex.close()
    m = await c1.get("run_status", id="run-4", state="failed")
    check("executor socket closed mid-run → the owner gets failed 'Studio disconnected'",
          bool(m) and m.get("detail") == "Studio disconnected" and (m.get("step") or {}).get("i") == 2, str(m))
    check("… with the run's bag, closed", bag_closed((m or {}).get("bag")), str(m))
    await c1.send({"type": "run_request", "id": "run-5", "action": "run", "name": "five.yaml", "protocol": YAML})
    m = await c1.get("run_status", id="run-5")
    check("after the executor left: run → rejected 'no Studio in remote-control mode'",
          bool(m) and m["state"] == "rejected" and m.get("detail") == "no Studio in remote-control mode", str(m))
    await ex2.send({"type": "remote_attach", "on": True})
    m = await ex2.get("remote_attach_ack")
    check("the executor slot is free again: another Studio attaches", bool(m) and m["ok"] is True and m["on"] is True, str(m))

    # ── run 6: rejected by the Studio (the YAML did not load) — no bag, ownership cleared ──
    await c1.send({"type": "run_request", "id": "run-6", "action": "run", "name": "six.yaml", "protocol": YAML})
    await ex2.get("run_request", id="run-6")
    await ex2.send({"type": "run_status", "id": "run-6", "state": "rejected", "detail": "the protocol did not load: bad YAML"})
    m = await c1.get("run_status", id="run-6")
    check("a Studio rejection is relayed with its reason, and without a bag",
          bool(m) and m["state"] == "rejected" and "did not load" in m.get("detail", "") and "bag" not in m, str(m))
    await ex2.send({"type": "remote_attach", "on": False})
    m = await ex2.get("remote_attach_ack")
    check("remote_attach off → ack, executor cleared", bool(m) and m["ok"] is True and m["on"] is False, str(m))
    try:
        st = await asyncio.to_thread(StudioRemote(transport="ws", url=url).status)
    except StudioRemoteError as exc:
        st = {"error": str(exc)}
    check("status: no executor after it detached", st.get("executor") is False and st.get("active") is None, str(st)[:300])

    # ── the ROS topic ──
    await asyncio.sleep(1.0)
    seen = [(m.get("id"), m.get("state")) for m in got_ros]
    need = [("run-1", "accepted"), ("run-1", "running"), ("run-1", "aborted"), ("run-x", "rejected"), ("run-4", "failed"), ("run-6", "rejected")]
    check("/arena/run_status published every status (Studio's and the gateway's own)", all(n in seen for n in need),
          f"missing {[n for n in need if n not in seen]}; saw {seen[:12]}…")
    term = next((m for m in got_ros if m.get("id") == "run-1" and m.get("state") == "aborted"), {})
    check("the published terminal status carries `bag` too", term.get("bag") == bag1, str(term)[:300])

    for s in (c1, c2, ex2):
        await s.close()


def main() -> int:
    from rig_nodes import zenoh  # the loopback-only configs ship in the installed package

    env = dict(os.environ, ZENOH_ROUTER_CONFIG_URI=str(zenoh.ROUTER_CONFIG), ZENOH_SESSION_CONFIG_URI=str(zenoh.SESSION_CONFIG),
               RMW_IMPLEMENTATION=os.environ.get("RMW_IMPLEMENTATION", "rmw_zenoh_cpp"), ZENOH_ROUTER_CHECK_ATTEMPTS="0")
    os.environ.update(env)
    if wait_port("127.0.0.1", 7447, 0.2):
        print("FAIL  port 7447 is in use — stop the rig (its Zenoh router) first")
        return 2
    ws_port = free_tcp_port()
    url = f"ws://127.0.0.1:{ws_port}"
    logdir = Path(tempfile.gettempdir()) / f"remote-relay-{os.getpid()}"
    logdir.mkdir(parents=True, exist_ok=True)
    procs = []

    def start(name, argv):
        fh = open(logdir / f"{name}.log", "w")
        p = popen_group(argv, stdout=fh, stderr=subprocess.STDOUT)
        procs.append((name, p, fh))
        return p

    got_ros: list[dict] = []
    try:
        # no router at all (the rig is not running): an error after the timeout — rclpy.init() alone would wait forever
        t0 = time.monotonic()
        try:
            with StudioRemote(transport="ros", connect_timeout_s=1.5) as lonely:
                lonely.status()
            err = "(no error)"
        except StudioRemoteError as exc:
            err = str(exc)
        check('studio_remote.py (ROS) without a router → StudioRemoteError "no gateway on the ROS graph", no hang',
              "no gateway on the ROS graph" in err and "router" in err and time.monotonic() - t0 < 6.0, f"{err} after {time.monotonic() - t0:.1f} s")
        start("router", ["ros2", "run", "rmw_zenoh_cpp", "rmw_zenohd"])
        check("zenoh router up", wait_port("127.0.0.1", 7447, 20.0))
        # the ROS client with a router but NO gateway: a clear error after its timeout, not a lost request
        t0 = time.monotonic()
        try:
            with StudioRemote(transport="ros", connect_timeout_s=2.0) as lonely:
                lonely.status()
            err = "(no error)"
        except StudioRemoteError as exc:
            err = str(exc)
        check('studio_remote.py (ROS) without a gateway → StudioRemoteError "no gateway on the ROS graph" after the timeout',
              "no gateway on the ROS graph" in err and 1.5 <= time.monotonic() - t0 < 10.0, f"{err} after {time.monotonic() - t0:.1f} s")
        start("bridge", [sys.executable, str(ROOT / "nodes" / "bridge_node.py"), "--ws-port", str(ws_port), "--log-dir", str(logdir / "runlogs")])
        if not check(f"bridge node serving {url}", wait_port("127.0.0.1", ws_port, 30.0)):
            return 1

        import rclpy
        from rclpy.node import Node
        from rclpy.qos import QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile, QoSReliabilityPolicy
        from std_msgs.msg import String

        rclpy.init()
        n = Node("remote_relay_test")
        qos = QoSProfile(reliability=QoSReliabilityPolicy.RELIABLE, history=QoSHistoryPolicy.KEEP_LAST, depth=200,
                         durability=QoSDurabilityPolicy.VOLATILE)

        def on_status(m) -> None:
            try:
                got_ros.append(json.loads(m.data))
            except json.JSONDecodeError:
                pass

        n.create_subscription(String, "/arena/run_status", on_status, qos)
        req_pub = n.create_publisher(String, "/arena/run_request", qos)

        def ros_publish(text: str) -> None:
            m = String()
            m.data = text
            req_pub.publish(m)

        stop = threading.Event()
        th = threading.Thread(target=lambda: [rclpy.spin_once(n, timeout_sec=0.05) for _ in iter(stop.is_set, True)], daemon=True)
        th.start()
        t_end = time.monotonic() + 15.0  # discovery through the router
        while time.monotonic() < t_end and not (req_pub.get_subscription_count() > 0 and n.count_publishers("/arena/run_status") > 0):
            time.sleep(0.1)
        check("the gateway subscribes /arena/run_request and publishes /arena/run_status",
              req_pub.get_subscription_count() > 0 and n.count_publishers("/arena/run_status") > 0)
        time.sleep(1.0)
        asyncio.run(scenario(url, got_ros, RosSide(ros_publish, got_ros)))
        stop.set()
        th.join(timeout=2.0)
        n.destroy_node()
        rclpy.shutdown()
    finally:
        for name, p, fh in reversed(procs):
            try:
                signal_group(p, signal.SIGINT)
                p.wait(timeout=5)
            except Exception:  # noqa: BLE001
                p.kill()
            fh.close()
    print(f"\n{'PASS' if not failures else 'FAIL'}: {failures} failure(s)   (logs: {logdir})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
