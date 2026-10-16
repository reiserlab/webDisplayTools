#!/usr/bin/env python3
"""led_sweep_si.py — FALLBACK for the 2P color LED-intensity sweep (2026-10-16): drive ScanImage's
grabs from a plain script on the microscope PC while the Arena Studio runs the matching protocol by
hand (Console → Test experiment), so the day's data is still collected if the connector path
(bridge node + scanimage_node.py) fails on site.

Same condition table as protocols/g6_2p_color_led_sweep.yaml, same TIFF layout (one grab per
color, stem "<color>_sweep"), so the analysis does not change. Alignment is the controller's
Digital IO 1 frame-transfer pulse recorded by ScanImage, exactly as in the connector path.

Talks to ScanImage's built-in JSON server (`hJ = most.network.json.Server(5555)` in MATLAB) over
a persistent TCP connection, the way scanimage_node.py does: length-prefixed JSON, one client,
scalar properties only, two fixed evals (startGrab, abort). No ROS, no pixi: the Python that ships
with the rig PC is enough (stdlib only).

    python tools/led_sweep_si.py --dry-run                 # print the plan, touch nothing
    python tools/led_sweep_si.py --ping                    # one get of acqState, then exit
    python tools/led_sweep_si.py --colors violet blue      # a subset
    python tools/led_sweep_si.py                           # the whole sweep, prompting before each grab

Sequence per color: set logFileStem → startGrab → wait `--settle` s → (operator starts the Studio
condition for this color — the script prints the cue and, unless --no-prompt, waits for Enter) →
poll acqState until idle (the grab length is framesPerSlice, set once at the start) → next color.
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import sys
import time

COLORS = ("violet", "blue", "green", "yellow")  # bank 0..3: 405, 470, 525, 590 nm
DUTIES = (7, 15, 31, 63, 127, 255)
STEP_S = 3.0
SETTLE_S = 1.0
FRAMES_PER_GRAB = 640  # ≥ (settle + 6 × step) × scan frame rate (29 Hz → 19 s → 551), with margin


class SiTimeout(TimeoutError):
    pass


class SiError(RuntimeError):
    pass


class JsonClient:
    """ScanImage JSON server client (ported from scanimage_node.py / si_remote.py)."""

    def __init__(self, host: str, port: int, timeout_s: float) -> None:
        self.host, self.port, self.timeout_s = host, port, timeout_s
        self._sock: socket.socket | None = None

    def drop(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _recv_exact(self, n: int) -> bytes:
        assert self._sock is not None
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("server closed the connection")
            buf += chunk
        return buf

    def request(self, msg: dict, timeout_s: float | None = None) -> dict:
        data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        to = timeout_s if timeout_s is not None else self.timeout_s
        try:
            if self._sock is None:
                self._sock = socket.create_connection((self.host, self.port), timeout=to)
            self._sock.settimeout(to)
            self._sock.sendall(struct.pack("<Q", len(data)) + data)  # one write (B4)
            n = struct.unpack("<Q", self._recv_exact(8))[0]
            body = self._recv_exact(n)
        except socket.timeout as exc:
            self.drop()
            raise SiTimeout(f"no complete reply within {to:g}s (connection dropped; UNKNOWN whether it took effect)") from exc
        except (ConnectionError, OSError) as exc:
            self.drop()
            raise OSError(f"ScanImage JSON server unreachable at {self.host}:{self.port}: {exc}") from exc
        rep = json.loads(body.decode("utf-8"))
        if isinstance(rep, dict) and rep.get("error"):
            raise SiError(str(rep["error"]))
        return rep

    def get(self, prop: str):
        return self.request({"command": "get", "property": prop}).get("value")

    def set(self, prop: str, value):
        return self.request({"command": "set", "property": prop, "value": value}).get("actual", value)

    def eval(self, expr: str, timeout_s: float) -> None:
        self.request({"command": "eval", "function": expr, "num_outputs": 0}, timeout_s)


def wait_state(cli: JsonClient, want: str, timeout_s: float, poll_s: float = 0.5) -> str:
    end = time.monotonic() + timeout_s
    st = cli.get("hSI.acqState")
    while st != want and time.monotonic() < end:
        time.sleep(poll_s)
        st = cli.get("hSI.acqState")
    return str(st)


def log(results: list, **row) -> None:
    row["t"] = time.strftime("%H:%M:%S")
    results.append(row)
    print("  " + json.dumps(row), flush=True)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5555)
    p.add_argument("--colors", nargs="+", default=list(COLORS), choices=COLORS)
    p.add_argument("--duties", nargs="+", type=int, default=list(DUTIES), help="panel duty levels (for the plan + cue only; the Studio protocol sets them)")
    p.add_argument("--step", type=float, default=STEP_S, help="s per duty level in the Studio protocol (plan + wait budget)")
    p.add_argument("--settle", type=float, default=SETTLE_S, help="s after the grab starts before cueing the stimulus")
    p.add_argument("--frames", type=int, default=FRAMES_PER_GRAB, help="framesPerSlice to set once (0 = leave ScanImage's value)")
    p.add_argument("--stem-suffix", default="_sweep", help='TIFF stem = "<color><suffix>"')
    p.add_argument("--timeout", type=float, default=2.0, help="per-request timeout (s)")
    p.add_argument("--grab-timeout", type=float, default=15.0, help="startGrab is synchronous in ScanImage (1.2–2.4 s on the Bergamo PC)")
    p.add_argument("--no-prompt", action="store_true", help="do not wait for Enter before each grab (time the Studio by the printed cue)")
    p.add_argument("--dry-run", action="store_true", help="print the plan and exit; nothing is sent")
    p.add_argument("--ping", action="store_true", help="read acqState and the file settings, then exit")
    p.add_argument("--results", default=None, help="write the per-step JSON lines here too")
    a = p.parse_args(argv)

    per_color = a.settle + len(a.duties) * a.step
    print(f"[plan] {len(a.colors)} colors × {len(a.duties)} duties × {a.step:g} s (+{a.settle:g} s settle) = {per_color:g} s of grab per color; "
          f"framesPerSlice {a.frames or 'unchanged'}; stems {[c + a.stem_suffix for c in a.colors]}; duties {a.duties}")
    if a.dry_run:
        for c in a.colors:
            print(f"  {c}: set stem {c + a.stem_suffix!r} → startGrab → {a.settle:g} s → Studio runs {c} duties {a.duties} ({a.step:g} s each) → allOff → wait idle")
        print("[plan] dry run: nothing sent")
        return 0

    cli = JsonClient(a.host, a.port, a.timeout)
    results: list = []
    try:
        st = cli.get("hSI.acqState")
        fps = cli.get("hSI.hRoiManager.scanFrameRate")
        info = {"acqState": st, "scanFrameRate": fps, "logFilePath": cli.get("hSI.hScan2D.logFilePath"),
                "logFileStem": cli.get("hSI.hScan2D.logFileStem"), "logFileCounter": cli.get("hSI.hScan2D.logFileCounter"),
                "loggingEnable": cli.get("hSI.hChannels.loggingEnable"), "framesPerSlice": cli.get("hSI.hStackManager.framesPerSlice"),
                "channelSave": cli.get("hSI.hChannels.channelSave"), "bidirectional": cli.get("hSI.hScan2D.bidirectional")}
        print(f"[si] {json.dumps(info)}")
        if a.ping:
            return 0
        if st != "idle":
            print(f"[si] acqState is {st!r}; abort it in ScanImage first", file=sys.stderr)
            return 1
        if not info["loggingEnable"]:
            print("[si] WARNING: logging is OFF in ScanImage — grabs will not write TIFFs. Enable logging, then rerun.", file=sys.stderr)
            return 1
        if not info["logFilePath"]:
            print("[si] WARNING: logFilePath is empty — set it to the F: data folder in ScanImage, then rerun.", file=sys.stderr)
            return 1
        need = per_color * float(fps or 29.0)
        if a.frames:
            actual = cli.set("hSI.hStackManager.framesPerSlice", int(a.frames))
            log(results, step="set", property="framesPerSlice", value=a.frames, actual=actual)
            if a.frames < need:
                print(f"[si] WARNING: framesPerSlice {a.frames} < {need:.0f} needed for {per_color:g} s at {fps} Hz", file=sys.stderr)
        for color in a.colors:
            stem = color + a.stem_suffix
            if not a.no_prompt:
                input(f"\n[{color}] Studio: select the {color} block (duties {a.duties}), hand on Run. Press Enter to START THE GRAB…")
            actual = cli.set("hSI.hScan2D.logFileStem", stem)
            counter = cli.get("hSI.hScan2D.logFileCounter")
            log(results, step="setFileStem", color=color, stem=actual, counter=counter)
            t0 = time.perf_counter()
            try:
                cli.eval("hSI.startGrab()", a.grab_timeout)
            except SiTimeout as exc:
                log(results, step="grab", color=color, outcome="unknown", error=str(exc))
                st = wait_state(cli, "grab", 5.0)
                if st != "grab":
                    print(f"[{color}] grab outcome unknown and acqState is {st!r}; stopping", file=sys.stderr)
                    return 3
            st = wait_state(cli, "grab", 5.0)
            log(results, step="grab", color=color, acqState=st, start_ms=round((time.perf_counter() - t0) * 1000))
            if st != "grab":
                print(f"[{color}] startGrab returned but acqState is {st!r}; stopping", file=sys.stderr)
                return 1
            time.sleep(a.settle)
            print(f"\a[{color}] >>> RUN THE {color.upper()} BLOCK IN THE STUDIO NOW ({len(a.duties)} × {a.step:g} s) <<<", flush=True)
            budget = per_color + 20.0
            st = wait_state(cli, "idle", budget)
            frames = cli.get("hSI.hDisplay.lastFrameNumber")
            counter2 = cli.get("hSI.hScan2D.logFileCounter")
            log(results, step="waitIdle", color=color, acqState=st, lastFrameNumber=frames, counter_after=counter2)
            if st != "idle":
                print(f"[{color}] still {st!r} after {budget:g} s — aborting the grab", file=sys.stderr)
                cli.eval("hSI.abort()", a.grab_timeout)
                log(results, step="abort", color=color, acqState=wait_state(cli, "idle", 5.0))
        print("\n[done] all colors grabbed; arena should be dark (allOff in the Studio).")
        return 0
    except (SiError, OSError) as exc:
        print(f"[si] error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[si] interrupted — aborting any running grab", file=sys.stderr)
        try:
            cli.eval("hSI.abort()", a.grab_timeout)
        except Exception:
            pass
        return 130
    finally:
        if a.results and results:
            with open(a.results, "a", encoding="utf-8", newline="\n") as fh:
                for r in results:
                    fh.write(json.dumps(r) + "\n")
        cli.drop()


if __name__ == "__main__":
    raise SystemExit(main())
