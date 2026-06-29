#!/usr/bin/env python3
"""fictrac_sim.py — emit random data that looks like live FicTrac socket output.

FicTrac (https://github.com/rjdmoore/fictrac) streams one record per camera frame
as a comma-space-separated, newline-terminated line of 25 fields. This generator
produces plausible-looking records from a smooth random walk so the bridge and the
browser closed-loop UI can be exercised without a camera or a real FicTrac install.

Transport roles mirror real FicTrac so `bridge.py` is identical for sim and real:
  --proto udp (default): FicTrac is the *sender*. This sim `sendto`s each line to
                         (host, port); the bridge binds and receives.
  --proto tcp:           FicTrac's TCP variant is a *server*. This sim listens and
                         accepts one client (the bridge), then streams to it.

FicTrac output columns (1-based), per doc/data_header.txt:
   1     frame counter (starts at 1)
   2-4   delta rotation vector, camera coords (rad)
   5     rotation-estimate error score
   6-8   delta rotation vector, lab coords (rad)
   9-11  absolute orientation, camera coords (rad)
  12-14  absolute orientation, lab coords (rad)
  15-16  integrated x/y position, lab coords (rad; scale by ball radius)
  17     integrated animal heading, lab coords (rad)
  18     instantaneous movement direction, lab coords (rad)
  19     movement speed (rad/frame)
  20-21  integrated forward/side motion (rad)
  22     timestamp (video position or epoch ms)
  23     sequence counter within the current tracking sequence
  24     ms since previous frame
  25     frame-capture time (ms since midnight)
"""

from __future__ import annotations

import argparse
import math
import random
import socket
import sys
import time

N_FIELDS = 25
DEFAULT_PORT = 60000


def fmt_record(fields: list[float]) -> str:
    """Format one record exactly like FicTrac: ', '-joined, newline-terminated.

    The frame counter (field 1) and sequence counter (field 23) are integers on
    the wire; everything else is a float.
    """
    out = []
    for i, v in enumerate(fields):
        if i in (0, 22):  # frame counter, sequence counter
            out.append(str(int(v)))
        else:
            out.append(f"{v:.6f}")
    return ", ".join(out) + "\n"


class Walker:
    """Smooth random walk producing deterministic FicTrac-like records.

    Deterministic given --seed: values come only from the seeded RNG and the
    frame counter, never from the wall clock, so two runs with the same seed
    emit byte-identical records regardless of pacing.
    """

    def __init__(self, rate_hz: float, seed: int | None) -> None:
        self.rng = random.Random(seed)
        self.dt = 1.0 / rate_hz
        self.dt_ms = 1000.0 * self.dt
        self.frame = 0
        self.heading = 0.0  # integrated heading (rad), field 17
        self.x = 0.0  # integrated x (rad), field 15
        self.y = 0.0  # integrated y (rad), field 16
        self.fwd = 0.0  # integrated forward motion, field 20
        self.side = 0.0  # integrated side motion, field 21

    def _gauss(self, sigma: float) -> float:
        return self.rng.gauss(0.0, sigma)

    def next_record(self) -> list[float]:
        self.frame += 1

        # Per-frame deltas: a small turn and a small forward step.
        d_head = self._gauss(0.05)
        speed = abs(self._gauss(0.03))  # rad/frame, field 19
        move_dir = self.heading + self._gauss(0.1)  # field 18

        # Integrate the lab-frame state.
        self.heading = (self.heading + d_head) % (2.0 * math.pi)
        self.x += speed * math.cos(self.heading)
        self.y += speed * math.sin(self.heading)
        self.fwd += speed
        self.side += speed * math.sin(d_head)

        ts_ms = self.frame * self.dt_ms  # field 22 (monotonic)
        seq = self.frame  # field 23
        delta_ms = self.dt_ms  # field 24
        abs_ms = (self.frame * self.dt_ms) % 86_400_000.0  # field 25, ms since midnight

        fields = [0.0] * N_FIELDS
        fields[0] = self.frame  # 1
        fields[1] = self._gauss(0.02)  # 2-4 delta rot cam
        fields[2] = self._gauss(0.02)
        fields[3] = d_head + self._gauss(0.01)
        fields[4] = abs(self._gauss(0.005))  # 5 error score
        fields[5] = self._gauss(0.02)  # 6-8 delta rot lab
        fields[6] = self._gauss(0.02)
        fields[7] = d_head
        fields[8] = self._gauss(0.02)  # 9-11 abs rot cam
        fields[9] = self._gauss(0.02)
        fields[10] = self.heading + self._gauss(0.01)
        fields[11] = self._gauss(0.02)  # 12-14 abs rot lab
        fields[12] = self._gauss(0.02)
        fields[13] = self.heading
        fields[14] = self.x  # 15-16 integrated x/y
        fields[15] = self.y
        fields[16] = self.heading  # 17 integrated heading
        fields[17] = move_dir % (2.0 * math.pi)  # 18 movement direction
        fields[18] = speed  # 19 movement speed
        fields[19] = self.fwd  # 20-21 integrated fwd/side
        fields[20] = self.side
        fields[21] = ts_ms  # 22 timestamp
        fields[22] = seq  # 23 sequence counter
        fields[23] = delta_ms  # 24 delta ms
        fields[24] = abs_ms  # 25 abs ms since midnight
        return fields


def run_udp(walker: Walker, host: str, port: int, rate_hz: float, count: int) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dst = (host, port)
    print(f"[sim] UDP → {host}:{port} at {rate_hz:g} Hz (Ctrl-C to stop)", file=sys.stderr)
    _pace_loop(walker, lambda b: sock.sendto(b, dst), rate_hz, count)


def run_tcp(walker: Walker, host: str, port: int, rate_hz: float, count: int) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(1)
    print(f"[sim] TCP server on {host}:{port} — waiting for a client …", file=sys.stderr)
    while True:
        conn, peer = srv.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        print(f"[sim] client connected from {peer[0]}:{peer[1]}", file=sys.stderr)
        try:
            _pace_loop(walker, conn.sendall, rate_hz, count)
            return  # finite count completed
        except (BrokenPipeError, ConnectionResetError):
            print("[sim] client disconnected — waiting for a new one …", file=sys.stderr)
        finally:
            conn.close()


def _pace_loop(walker, send, rate_hz: float, count: int) -> None:
    """Emit records at ~rate_hz using a perf-counter schedule (no drift)."""
    dt = 1.0 / rate_hz
    start = time.perf_counter()
    n = 0
    while count <= 0 or n < count:
        send(fmt_record(walker.next_record()).encode("ascii"))
        n += 1
        target = start + n * dt
        delay = target - time.perf_counter()
        if delay > 0:
            time.sleep(delay)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--proto", choices=("udp", "tcp"), default="udp", help="transport (default: udp)")
    p.add_argument("--host", default="127.0.0.1", help="UDP destination / TCP bind address (default: 127.0.0.1)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default: {DEFAULT_PORT})")
    p.add_argument("--rate", type=float, default=50.0, help="frames per second (default: 50)")
    p.add_argument("--seed", type=int, default=None, help="RNG seed for reproducible output")
    p.add_argument("--count", type=int, default=0, help="number of frames to emit then exit (0 = forever)")
    args = p.parse_args(argv)

    if args.rate <= 0:
        p.error("--rate must be > 0")

    walker = Walker(rate_hz=args.rate, seed=args.seed)
    try:
        if args.proto == "udp":
            run_udp(walker, args.host, args.port, args.rate, args.count)
        else:
            run_tcp(walker, args.host, args.port, args.rate, args.count)
    except KeyboardInterrupt:
        print("\n[sim] stopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
