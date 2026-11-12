#!/usr/bin/env python3
"""remote_relay.py — the gateway's relay for Arena Studio remote-control mode (LAB-357).

The Studio page in remote-control mode is a display that STILL executes the steps; an external
program (rig/nodes/studio_remote.py, or MATLAB through it) starts the runs. This relay sits in
bridge_node.py between the two WebSockets and keeps the bookkeeping:

    executor     the ONE Studio socket that said {"type":"remote_attach","on":true}
    controller   whoever sends a run_request: a ROS node publishing on /arena/run_request (the
                 default — the robot station's sequencer is a ROS node), or another WebSocket
    owner        the controller whose `run` request is active: a WebSocket socket, or "ros" —
                 ALL ROS publishers count as ONE owner (a topic has no sender identity)

Messages (docs/development/studio-remote-control.md is the reference):

    Studio → gateway      remote_attach {on}            → remote_attach_ack {ok, on, error?}
    controller → gateway  run_request {id, action: run|stop|status, …, client?} — the same JSON
                          object on /arena/run_request (std_msgs/String) or on a WebSocket.
        Replies to a ROS request go out on /arena/run_status ONLY (the Studio's statuses, the
        gateway's own, and remote_status); a ROS client matches on `id`. A WebSocket asker
        gets them on its socket (and they are on the topic as well).
        run     no executor / a run is active  → run_status {id, state:"rejected", detail}
                else forwarded VERBATIM to the executor; the socket becomes the owner
        stop    owner only ("run": the run's id, optional; a ROS-owned run stops over ROS, a
                WebSocket-owned one from its socket, never across) → forwarded; the asker gets run_status
                {id, action:"stop", state:"accepted", run:<run id>} (the run's own terminal status
                follows under the RUN's id)
        status  answered here: remote_status {id, executor, active, last}
    Studio → gateway      run_status {id, state, detail?, step?, summary?}
        → forwarded to the owner, published on /arena/run_status, recorded while a bag is open;
          a terminal state (done | aborted | failed | rejected) clears the ownership and gains
          "bag" (the run's bag directory) + "bag_files".

THE ORDER RULE: a run's terminal status leaves this process only AFTER that run's bag is
closed, so the controller can open the file at once. Two things make it true: (1) the Studio
closes the log (`log_control enabled:false`) before it sends the terminal status, and one
socket's messages are handled strictly in order — bridge.py's dispatcher closes the bag (and
Recorder.close() re-indexes it) synchronously before the next message is read; (2) `finish()`
below closes the log ITSELF when a terminal status finds it still open (an executor that
vanished, or a page that did not close it), and only then adds `bag` and forwards.

No ROS imports here: the three sinks (send to a socket, publish, record) and the log hooks are
injected by bridge_node.py, so the bookkeeping is testable on its own.
"""

from __future__ import annotations

import os
import time
from typing import Any, Awaitable, Callable

TERMINAL_STATES = ("done", "aborted", "failed", "rejected")
RUN_STATES = ("accepted", "running") + TERMINAL_STATES
ACTIONS = ("run", "stop", "status")
ROS = "ros"  # the origin / owner token of every request that arrived on /arena/run_request
NO_EXECUTOR = "no Studio in remote-control mode"
STUDIO_GONE = "Studio disconnected"
STUDIO_LEFT = "Studio left remote-control mode"
SECOND_EXECUTOR = "another Studio is already in remote-control mode on this gateway"


def now_ms() -> int:
    return time.time_ns() // 1_000_000


class RemoteRelay:
    """The relay's state + handlers. All methods run on the gateway's asyncio loop.

    send(ws, msg)        deliver one JSON message to one socket (never raises)
    publish(msg, record_only=False)   publish on /arena/run_status + record it when a bag is
                         open (record_only: a status already published, recorded late)
    log_active()         is a run log / bag open right now?
    log_bag()            the open-or-most-recent bag directory path, or None
    close_log()          close the open log + bag; returns the Recorder's close report (dict)
    record_request(raw, rx_ms, ros)   put a run_request into the open bag: /arena/run_request for
                         a ROS request (ros=True), /arena/browser for a WebSocket one
    warn(text)           one line on stderr (and into the open log)
    """

    def __init__(self, *, send: Callable[[Any, dict], Awaitable[None]], publish: Callable[..., None],
                 log_active: Callable[[], bool], log_bag: Callable[[], str | None], close_log: Callable[[], dict],
                 record_request: Callable[[str, int, bool], None], warn: Callable[[str], None],
                 answer_timeout_s: float = 60.0) -> None:
        self._send = send
        self._publish = publish
        self._log_active = log_active
        self._log_bag = log_bag
        self._close_log = close_log
        self._record_request = record_request
        self._warn = warn
        self.answer_timeout_s = float(answer_timeout_s)
        self.executor = None  # the Studio socket in remote-control mode
        self.active: dict | None = None  # the run in progress: {id, owner, state, name, intent, raw, rx_ms, …}
        self.last: dict | None = None  # the most recent terminal run_status (as forwarded)
        self._askers: dict[str, Any] = {}  # forwarded stop-request id → the asking socket

    # ── helpers ──────────────────────────────────────────────────────────────────────
    def _status(self, rid, state: str, **extra) -> dict:
        msg = {"type": "run_status", "id": rid, "state": state}
        msg.update({k: v for k, v in extra.items() if v is not None})
        msg["t_ms"] = now_ms()
        return msg

    async def _deliver(self, target, msg: dict) -> None:
        """To one controller. The ROS owner reads the topic, where every status already is."""
        if target is not None and target is not ROS:
            await self._send(target, msg)

    async def _reply(self, origin, msg: dict, *, publish: bool = True) -> None:
        """A status this gateway originates: to the asker, and on the topic. For a ROS asker the
        topic IS the reply channel, so it is published whatever `publish` says."""
        if publish or origin is ROS:
            self._publish(msg)
        await self._deliver(origin, msg)

    def snapshot(self) -> dict:
        a = self.active
        return {
            "executor": self.executor is not None,
            "active": None if a is None else {k: a.get(k) for k in ("id", "state", "name", "intent", "step", "bag", "origin", "client", "owner_connected")},
            "last": self.last,
        }

    # ── remote_attach (the Studio) ───────────────────────────────────────────────────
    async def on_attach(self, ws, obj: dict) -> None:
        on = bool(obj.get("on"))
        if on:
            if self.executor is not None and self.executor is not ws:
                await self._send(ws, {"type": "remote_attach_ack", "ok": False, "on": False, "error": SECOND_EXECUTOR})
                return
            self.executor = ws
            await self._send(ws, {"type": "remote_attach_ack", "ok": True, "on": True})
            return
        if self.executor is ws:
            self.executor = None
            await self._fail_active(STUDIO_LEFT)
        await self._send(ws, {"type": "remote_attach_ack", "ok": True, "on": False})

    # ── run_request (a controller) ───────────────────────────────────────────────────
    async def on_request(self, ws, obj: dict, raw_text: str) -> None:
        """`ws` = the asking WebSocket, or ROS for a request from /arena/run_request."""
        rid = obj.get("id")
        action = obj.get("action")
        from_ros = ws is ROS
        # What the Studio receives: the WebSocket message verbatim; a ROS message is the same
        # object and only gains the `type` the socket protocol dispatches on.
        fwd = {**obj, "type": "run_request"} if from_ros else obj
        if not isinstance(rid, str) or not rid.strip():
            await self._reply(ws, self._status(rid if isinstance(rid, str) else None, "rejected",
                                               detail="the request has no id (a non-empty string)"), publish=False)
            return
        if action not in ACTIONS:
            await self._reply(ws, self._status(rid, "rejected", detail=f"unknown action {action!r} (one of {', '.join(ACTIONS)})"), publish=False)
            return
        if action != "run" and self._log_active():
            self._record_request(raw_text, now_ms(), from_ros)  # a stop / status during a run is part of its record
        if action == "status":
            await self._reply(ws, {"type": "remote_status", "id": rid, "t_ms": now_ms(), **self.snapshot()}, publish=False)
            return
        if action == "stop":
            a = self.active
            want = obj.get("run")
            if a is None:
                await self._reply(ws, self._status(rid, "rejected", action="stop", detail="no run is active"))
            elif isinstance(want, str) and want != a["id"]:
                await self._reply(ws, self._status(rid, "rejected", action="stop", run=a["id"],
                                                   detail=f"run {want} is not active (the active run is {a['id']})"))
            elif a["owner"] is not ws:
                how = "over ROS" if a["origin"] == ROS else "by a WebSocket controller"
                await self._reply(ws, self._status(rid, "rejected", action="stop", run=a["id"],
                                                   detail=f"busy: run {a['id']} belongs to another controller (started {how}; only its owner may stop it)"))
            elif self.executor is None:  # cannot happen while a run is active; fail closed
                await self._reply(ws, self._status(rid, "rejected", action="stop", run=a["id"], detail=NO_EXECUTOR))
            else:
                self._askers[rid] = ws
                await self._send(self.executor, fwd)
                await self._reply(ws, self._status(rid, "accepted", action="stop", run=a["id"]))
            return
        # action == "run"
        if self.executor is None:
            await self._reply(ws, self._status(rid, "rejected", detail=NO_EXECUTOR))
            return
        if self.active is not None:
            await self._reply(ws, self._status(rid, "rejected", detail=f"busy: run {self.active['id']} is active"))
            return
        if not isinstance(obj.get("protocol"), str) or not obj["protocol"].strip():
            await self._reply(ws, self._status(rid, "rejected", detail='a run request needs "protocol": the YAML text'))
            return
        rx = now_ms()
        client = obj.get("client")
        self.active = {"id": rid, "owner": ws, "owner_connected": True, "state": "requested", "name": obj.get("name"),
                       "intent": obj.get("intent") or "test", "raw": raw_text, "rx_ms": rx, "step": None, "bag": None,
                       "origin": ROS if from_ros else "ws", "client": client[:64] if isinstance(client, str) else None,
                       "bag_opened": False, "pending": [], "t_mono": time.monotonic()}
        if self._log_active():  # a log already open (a fixed --log path): the request goes into it now
            self._record_request(raw_text, rx, from_ros)
            self.active["bag"] = self._log_bag()
        await self._send(self.executor, fwd)  # the Studio validates and answers

    # ── run_status (the Studio) ──────────────────────────────────────────────────────
    async def on_status(self, ws, obj: dict) -> None:
        if ws is not self.executor:
            self._warn("run_status from a socket that is not the attached Studio — ignored")
            return
        rid = obj.get("id")
        state = obj.get("state")
        if not isinstance(rid, str) or state not in RUN_STATES:
            self._warn(f"malformed run_status from the Studio ignored (id {rid!r}, state {state!r})")
            return
        msg = dict(obj)
        msg["type"] = "run_status"
        msg["t_ms"] = now_ms()
        a = self.active
        if a is not None and rid == a["id"] and msg.get("action") is None:
            if state in TERMINAL_STATES:
                await self._finish(msg)
                return
            a["state"] = state
            if isinstance(msg.get("step"), dict):
                a["step"] = msg["step"]
            if not self._log_active():
                a["pending"].append(msg)  # before the run's bag opens: recorded when it does
            self._publish(msg)
            if a["owner_connected"]:
                await self._deliver(a["owner"], msg)
            return
        # Not the active run: the Studio's answer to a forwarded stop, or a late status.
        asker = self._askers.pop(rid, None) if state in TERMINAL_STATES else self._askers.get(rid)
        self._publish(msg)
        await self._deliver(asker, msg)

    async def _finish(self, msg: dict) -> None:
        """A terminal status of the active run: close its bag FIRST, then tell the world."""
        a = self.active
        assert a is not None
        self.active = None
        closed_here = False
        # A run that was rejected before it opened a bag has no record of its own: a log that
        # happens to be open then (the Console's logging toggle) is not this run's to close.
        ran = a["bag_opened"] or msg.get("state") != "rejected"
        if ran and self._log_active():
            # The Studio closes the log before its terminal status; reaching here with it open
            # means the page did not (or it is gone). The controller must find a closed file.
            a["bag"] = self._log_bag() or a["bag"]
            self._close_log()
            closed_here = True
        bag = a.get("bag") if ran else None
        if bag:
            msg["bag"] = bag
            files = bag_files(bag)
            if files:
                msg["bag_files"] = files
            if closed_here:
                msg["bag_closed_by"] = "gateway"
        self.last = msg
        self._publish(msg)
        if a["owner_connected"]:
            await self._deliver(a["owner"], msg)

    async def _fail_active(self, detail: str) -> None:
        a = self.active
        if a is None:
            return
        await self._finish(self._status(a["id"], "failed", detail=detail, step=a.get("step")))

    # ── lifecycle hooks from bridge_node ─────────────────────────────────────────────
    def on_log_open(self) -> None:
        """A run log (and bag) just opened. If a remote run is active it is THIS run's bag:
        remember it, and put the request + the statuses sent before it opened into it."""
        a = self.active
        if a is None:
            return
        a["bag"] = self._log_bag()
        a["bag_opened"] = True
        self._record_request(a["raw"], a["rx_ms"], a["origin"] == ROS)
        pending, a["pending"] = a["pending"], []
        for m in pending:
            self._publish(m, record_only=True)

    async def tick(self) -> None:
        """Called by the gateway's watchdog (every 0.5 s): a forwarded run request the Studio
        never answered must not hold the gateway busy forever."""
        a = self.active
        if a is not None and a["state"] == "requested" and time.monotonic() - a["t_mono"] > self.answer_timeout_s:
            await self._fail_active(f"the Studio did not answer the run request within {self.answer_timeout_s:g} s")

    async def on_disconnect(self, ws) -> None:
        """A socket closed. The executor's loss fails the active run; a controller's loss only
        orphans it (the Studio keeps executing; the operator's STOP still works)."""
        for rid in [k for k, v in self._askers.items() if v is ws]:
            self._askers.pop(rid, None)
        if ws is self.executor:
            self.executor = None
            await self._fail_active(STUDIO_GONE)
            return
        a = self.active
        if a is not None and a["owner"] is ws:
            a["owner_connected"] = False
            self._warn(f"the controller that owns run {a['id']} disconnected — the run continues; only STOP at the Studio can end it early")


def bag_files(bag: str) -> list[str]:
    """The MCAP file names inside a bag directory (empty when it cannot be listed)."""
    try:
        return sorted(f for f in os.listdir(bag) if f.endswith(".mcap"))
    except OSError:
        return []
