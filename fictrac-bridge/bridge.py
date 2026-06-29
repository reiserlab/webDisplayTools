#!/usr/bin/env python3
"""bridge.py — FicTrac ⇆ browser closed-loop bridge for the G6 Arena Console.

Reads FicTrac records from a socket, maps each one to an arena *frame index*, and
pushes that index to browser clients over a WebSocket. `arena_console.html` applies
the index via SET_FRAME_POSITION (Mode 3). In the reverse direction the browser
sends JSON log events back over the same socket; the bridge appends them to a file
— a browser can't write local files freely, but this local process can.

  FicTrac ──(UDP recv / TCP client)──▶ bridge ──(ws://host:port)──▶ arena_console.html
                                          │  ◀── {"type":"log",…} ──┘
                                          └── append to --log file

Transport roles match real FicTrac (so the same bridge works with fictrac_sim.py):
  --proto udp (default): FicTrac sends datagrams; the bridge binds and receives.
  --proto tcp:           FicTrac's TCP variant is a server; the bridge connects to it.

WebSocket message schema (also documented in README.md):
  bridge → browser:  {"type":"frame", "index":<int>, "seq":<int>, "t":<ms>}
  browser → bridge:  {"type":"hello", "client":"arena_console", "v":1}   (on connect)
                     {"type":"log",   "event":<str>, ...arbitrary, "ms":<int>}

The FicTrac → frame-index policy lives in frame_index_from_fictrac(); edit that one
function to change closed-loop behaviour.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import signal
import sys
import time

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

TWO_PI = 2.0 * math.pi


def now_ms() -> int:
    return int(time.time() * 1000)


# ─────────────────────────────────────────────────────────────────────────────
# Processing policy — THE part you customise.
# ─────────────────────────────────────────────────────────────────────────────
def frame_index_from_fictrac(fields: list[float], n_frames: int, gain: float, offset: float) -> int:
    """Map one FicTrac record to a 0-based arena frame index in [0, n_frames).

    Default policy: drive the frame by the animal's integrated heading (FicTrac
    field 17 → 0-based index 16), wrapped to one revolution across the whole
    pattern. `gain` scales heading→pattern coupling; `offset` (radians) rotates
    the zero. Replace the body to use position (fields 15-16), speed (field 19),
    or any combination.
    """
    heading = fields[16]
    frac = ((heading * gain + offset) / TWO_PI) % 1.0
    idx = int(frac * n_frames)
    return max(0, min(n_frames - 1, idx))


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket hub — coalescing broadcast (always the latest index, never a backlog).
# ─────────────────────────────────────────────────────────────────────────────
class Hub:
    def __init__(self, log: "LogWriter") -> None:
        self._latest: dict | None = None
        self._version = 0
        self._cond = asyncio.Condition()
        self._clients = 0
        self._log = log

    @property
    def clients(self) -> int:
        return self._clients

    async def publish(self, msg: dict) -> None:
        """Make `msg` the latest frame and wake all client senders."""
        async with self._cond:
            self._latest = msg
            self._version += 1
            self._cond.notify_all()

    async def serve_client(self, websocket) -> None:
        self._clients += 1
        peer = getattr(websocket, "remote_address", ("?", 0))
        print(f"[ws] client connected {peer} (total {self._clients})", file=sys.stderr)
        sender = asyncio.create_task(self._send_loop(websocket))
        try:
            await self._recv_loop(websocket)
        finally:
            sender.cancel()
            self._clients -= 1
            print(f"[ws] client disconnected {peer} (total {self._clients})", file=sys.stderr)

    async def _send_loop(self, websocket) -> None:
        """Per-client loop: send the latest frame whenever the version advances.

        If a client falls behind, it simply skips to the newest frame on its next
        wakeup — superseded indices are dropped rather than queued.
        """
        seen = 0
        try:
            while True:
                async with self._cond:
                    await self._cond.wait_for(lambda: self._version != seen)
                    seen = self._version
                    msg = self._latest
                if msg is not None:
                    await websocket.send(json.dumps(msg))
        except (ConnectionClosed, asyncio.CancelledError):
            pass

    async def _recv_loop(self, websocket) -> None:
        """Per-client loop: log inbound browser messages to the --log file."""
        try:
            async for raw in websocket:
                self._log.write_inbound(raw)
        except ConnectionClosed:
            pass


class LogWriter:
    """Appends one JSON line per event to --log (no-op when --log is unset)."""

    def __init__(self, path: str | None, log_frames: bool) -> None:
        self._fh = open(path, "a", buffering=1, encoding="utf-8") if path else None
        self.log_frames = log_frames
        if self._fh:
            self._emit({"type": "session", "event": "bridge_start", "ms": now_ms()})

    def _emit(self, obj: dict) -> None:
        if self._fh:
            self._fh.write(json.dumps(obj) + "\n")

    def write_inbound(self, raw: str | bytes) -> None:
        if not self._fh:
            return
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            obj = {"type": "log", "event": "unparsed", "raw": raw}
        obj.setdefault("dir", "browser→bridge")
        obj.setdefault("rx_ms", now_ms())
        self._emit(obj)

    def write_frame(self, msg: dict, fields: list[float]) -> None:
        if self._fh and self.log_frames:
            self._emit({"type": "frame_out", "dir": "bridge→browser", **msg, "fictrac": fields})

    def close(self) -> None:
        if self._fh:
            self._emit({"type": "session", "event": "bridge_stop", "ms": now_ms()})
            self._fh.close()
            self._fh = None


# ─────────────────────────────────────────────────────────────────────────────
# FicTrac record parsing + dispatch.
# ─────────────────────────────────────────────────────────────────────────────
class Pipeline:
    """Parses FicTrac lines, computes a frame index, and publishes to the hub."""

    def __init__(self, hub: Hub, log: LogWriter, n_frames: int, gain: float, offset: float) -> None:
        self.hub = hub
        self.log = log
        self.n_frames = n_frames
        self.gain = gain
        self.offset = offset
        self.parsed = 0
        self.skipped = 0

    async def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        parts = line.split(",")
        try:
            fields = [float(p) for p in parts]
        except ValueError:
            self.skipped += 1
            return
        if len(fields) < 17:  # need at least through the heading field
            self.skipped += 1
            return
        self.parsed += 1
        index = frame_index_from_fictrac(fields, self.n_frames, self.gain, self.offset)
        msg = {"type": "frame", "index": index, "seq": int(fields[0]), "t": now_ms()}
        await self.hub.publish(msg)
        self.log.write_frame(msg, fields)


# ─────────────────────────────────────────────────────────────────────────────
# Input transports.
# ─────────────────────────────────────────────────────────────────────────────
class _UdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._buf = b""

    def datagram_received(self, data: bytes, addr) -> None:
        # FicTrac sends one record per datagram, but be robust to coalesced or
        # split datagrams by buffering and splitting on newlines.
        self._buf += data
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            self._queue.put_nowait(line.decode("ascii", errors="replace"))
        # No trailing newline? Treat each datagram as a full record anyway.
        if self._buf and b"\n" not in data:
            self._queue.put_nowait(self._buf.decode("ascii", errors="replace"))
            self._buf = b""


async def read_udp(host: str, port: int, queue: asyncio.Queue) -> None:
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _UdpProtocol(queue), local_addr=(host, port)
    )
    print(f"[in] UDP listening on {host}:{port}", file=sys.stderr)
    try:
        await asyncio.Event().wait()  # run until cancelled
    finally:
        transport.close()


async def read_tcp(host: str, port: int, queue: asyncio.Queue) -> None:
    backoff = 0.5
    while True:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            print(f"[in] TCP connected to {host}:{port}", file=sys.stderr)
            backoff = 0.5
            try:
                while True:
                    raw = await reader.readline()
                    if not raw:
                        break  # server closed
                    queue.put_nowait(raw.decode("ascii", errors="replace"))
            finally:
                writer.close()
        except (ConnectionRefusedError, OSError) as exc:
            print(f"[in] TCP connect failed ({exc}); retrying in {backoff:g}s", file=sys.stderr)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 5.0)


async def consume(queue: asyncio.Queue, pipeline: Pipeline) -> None:
    while True:
        line = await queue.get()
        await pipeline.handle_line(line)


async def run(args: argparse.Namespace) -> None:
    log = LogWriter(args.log, args.log_frames)
    hub = Hub(log)
    pipeline = Pipeline(hub, log, args.frames, args.gain, args.offset)
    queue: asyncio.Queue[str] = asyncio.Queue()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # e.g. Windows
            pass

    reader = read_udp if args.proto == "udp" else read_tcp
    tasks = [
        asyncio.create_task(reader(args.in_host, args.in_port, queue)),
        asyncio.create_task(consume(queue, pipeline)),
    ]

    async with serve(hub.serve_client, args.ws_host, args.ws_port):
        print(
            f"[ws] serving ws://{args.ws_host}:{args.ws_port}  "
            f"(frames={args.frames}, proto={args.proto}, log={args.log or 'off'})",
            file=sys.stderr,
        )
        await stop.wait()

    print(
        f"\n[bridge] shutting down (parsed={pipeline.parsed}, skipped={pipeline.skipped})",
        file=sys.stderr,
    )
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    log.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--proto", choices=("udp", "tcp"), default="udp", help="FicTrac transport (default: udp)")
    p.add_argument("--in-host", default="127.0.0.1", help="FicTrac source: UDP bind / TCP connect host (default: 127.0.0.1)")
    p.add_argument("--in-port", type=int, default=60000, help="FicTrac source port (default: 60000)")
    p.add_argument("--ws-host", default="127.0.0.1", help="WebSocket bind host (default: 127.0.0.1)")
    p.add_argument("--ws-port", type=int, default=8765, help="WebSocket port (default: 8765)")
    p.add_argument("--frames", type=int, default=60, help="frame count of the loaded pattern (default: 60)")
    p.add_argument("--gain", type=float, default=1.0, help="heading→pattern coupling gain (default: 1.0)")
    p.add_argument("--offset", type=float, default=0.0, help="heading offset in radians (default: 0.0)")
    p.add_argument("--log", default=None, help="append browser log events (JSONL) to this file")
    p.add_argument("--log-frames", action="store_true", help="also log every outbound frame + source fields")
    args = p.parse_args(argv)

    if args.frames <= 0:
        p.error("--frames must be > 0")

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
