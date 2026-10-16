#!/usr/bin/env python3
"""studio_emulator.py — replays the Arena Studio runner's bridge conversation, without a browser.

This container (and any CI box) has no Web Serial, so the "unmodified Studio connects on
ws://localhost:8765" criterion is checked by speaking EXACTLY what the Studio speaks
(js/fictrac-bridge-client.js + js/arena-runner-g6.js + js/arena-session.js) and asserting
the bridge's answers:

  on connect   hello {client:'webDisplayTools', v:1}  → hello_ack (version ≥ 3.4, levels ⊇ behavior_v2)
               config {fictrac_port, coupling, deg_per_frame, gain, frames}
  run start    log_control {enabled:true, level:'behavior_v2'} → log_control_ack (level == behavior_v2)
               log run_metadata …
  per epoch    log runner step-start
               config {frames, coupling, deg_per_frame, gain, start_frame, epoch:true, bias}
               log runner command fictracApply true
                 … for each frame received: the arena_command echo of SET_FRAME_POSITION (0x70)
                     exactly as arena-session.js _logCommand writes it (so the ["a",…]
                     compaction path runs), honouring the epoch gate like the client does
               log runner command fictracApply false
               config {bias:{type:'none'}}            (stopClosedLoop → _disarmClosedLoop)
  run end      log_control {enabled:false} → ack; log_export → log_export_result (content)

Exit 0 when every assertion held; the exported log is written to --out and a JSON report to
--report. Used by tests/test_ros2_poc.py; also handy by hand against any bridge:

    pixi run python tests/studio_emulator.py --epochs 2 --epoch-s 6 --bias-amplitude 90
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

from websockets.asyncio.client import connect

T0 = time.time()


def mono_ms() -> int:
    return int((time.time() - T0) * 1000)


def arena_echo_set_frame_position(index: int, dt_ms: int = 3) -> dict:
    """The exact object arena-session.js _logCommand builds for SET_FRAME_POSITION 0x70:
    head = the frame bytes (len, cmd, idx lo, idx hi) as spaced lowercase hex; status 0 /
    echo 0x70 / ok true on a normal reply."""
    lo, hi = index & 0xFF, (index >> 8) & 0xFF
    head = f"03 70 {lo:02x} {hi:02x}"
    return {
        "type": "log",
        "event": "arena_command",
        "t": int(time.time() * 1000),
        "dt": dt_ms,
        "len": 4,
        "head": head,
        "status": 0,
        "echo": 0x70,
        "ok": True,
        "error": None,
    }


class Emulator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.cmd_seq = 0
        self.last_epoch = None
        self.a = args
        self.ws = None
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.frames = 0
        self.stale = 0
        self.applied = 0
        self.epoch_seen = None
        self.report: dict = {"asserts": [], "frames_per_epoch": [], "ok": True}

    def check(self, name: str, ok: bool, info: str = "") -> None:
        self.report["asserts"].append({"name": name, "ok": bool(ok), "info": info})
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else ' — ' + info}", file=sys.stderr)
        if not ok:
            self.report["ok"] = False

    async def send(self, obj: dict) -> None:
        await self.ws.send(json.dumps(obj))

    async def wait_for(self, kind: str, timeout: float = 5.0) -> dict | None:
        """Pop messages until one of `kind` arrives; frames seen meanwhile are counted."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                msg = await asyncio.wait_for(self.inbox.get(), remaining)
            except asyncio.TimeoutError:
                return None
            if msg.get("type") == kind:
                return msg
            if msg.get("type") == "frame":
                self.frames += 1

    async def reader(self) -> None:
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self.inbox.put(msg)
        except Exception:
            pass

    async def run_epoch(self, i: int, gate_since) -> int:
        a = self.a
        cond = f"cl_{a.bias_type}_{i}"
        await self.send({"type": "log", "event": "runner", "phase": "step-start", "index": i, "condition": cond})
        cfg = {
            "type": "config",
            "frames": a.frames,
            "coupling": a.coupling,
            "deg_per_frame": a.deg_per_frame,
            "gain": a.deg_per_frame,
            "start_frame": a.start_frame,
            "epoch": True,
            "bias": {"type": a.bias_type, "amplitude": a.bias_amplitude, "frequency": a.bias_frequency},
        }
        await self.send(cfg)
        await self.send({"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": True, "condition": cond})
        # Apply loop: the client withholds frames still stamped with the pre-tare epoch id
        # (the epoch gate) and applies the newest index — one echo per applied frame.
        n = 0
        stale = 0
        end = time.monotonic() + a.epoch_s
        first_idx = None
        new_epoch = None
        while time.monotonic() < end:
            try:
                msg = await asyncio.wait_for(self.inbox.get(), max(0.01, end - time.monotonic()))
            except asyncio.TimeoutError:
                break
            if msg.get("type") != "frame":
                continue
            self.frames += 1
            ep = msg.get("epoch")
            if gate_since is not None and ep is not None and ep == gate_since:
                stale += 1
                continue
            if new_epoch is None:
                new_epoch = ep
                first_idx = msg.get("index")
            n += 1
            await self.send(arena_echo_set_frame_position(int(msg["index"])))
        self.applied += n
        self.stale += stale
        await self.send({"type": "log", "event": "runner", "phase": "command", "op": "fictracApply", "value": False, "condition": cond})
        await self.send({"type": "config", "bias": {"type": "none"}})
        self.report["frames_per_epoch"].append({"epoch": i, "applied": n, "stale_withheld": stale, "epoch_id": new_epoch, "first_index": first_idx})
        self.check(f"epoch {i}: frames applied ≥ {a.min_frames}", n >= a.min_frames, f"{n}")
        self.check(f"epoch {i}: a new epoch id was stamped", new_epoch is not None and new_epoch != gate_since, f"{new_epoch} vs {gate_since}")
        if first_idx is not None:
            # The tared epoch opens on start_frame (± 1 frame of fly motion before the tare row).
            d = (first_idx - a.start_frame) % a.frames
            self.check(f"epoch {i}: opened on start_frame {a.start_frame}", min(d, a.frames - d) <= 1, f"first index {first_idx}")
        return new_epoch

    async def connector(self, command: str, params: dict | None = None, timeout: float = 10.0, connector: str = "bias", plugin: str = "camera") -> dict | None:
        """The runner's connectorCommand: one connector_command, wait for ITS reply by id."""
        self.cmd_seq += 1
        cid = f"emu{self.cmd_seq}"
        await self.send({"type": "connector_command", "id": cid, "connector": connector, "plugin": plugin,
                         "command": command, "params": params or {}})
        t_end = time.monotonic() + timeout
        while time.monotonic() < t_end:
            try:
                m = await asyncio.wait_for(self.inbox.get(), max(0.01, t_end - time.monotonic()))
            except asyncio.TimeoutError:
                break
            if m.get("type") == "connector_reply" and m.get("id") == cid:
                self.report.setdefault("connector_replies", []).append(m)
                return m
            if m.get("type") == "frame":
                self.frames += 1
                self.last_epoch = m.get("epoch", self.last_epoch)
        return None

    async def main(self) -> int:
        a = self.a
        async with connect(a.url, max_size=16 * 1024 * 1024) as ws:
            self.ws = ws
            reader = asyncio.create_task(self.reader())
            await self.send({"type": "hello", "client": "webDisplayTools", "v": 1})
            await self.send({"type": "config", "fictrac_port": 60000, "coupling": a.coupling, "deg_per_frame": a.deg_per_frame, "gain": a.deg_per_frame, "frames": a.frames})
            ack = await self.wait_for("hello_ack")
            self.check("hello_ack received", ack is not None)
            if ack:
                v = str(ack.get("bridge", ""))
                self.report["bridge"] = v
                m = v.split()[0] if v else ""
                try:
                    major, minor = (int(x) for x in m.split(".")[:2])
                    at_least_34 = (major, minor) >= (3, 4)
                except ValueError:
                    at_least_34 = False
                self.check("bridge version parses as ≥ 3.4 (supportsStartFrame)", at_least_34, v)
                self.check("behavior_v2 advertised", "behavior_v2" in (ack.get("levels") or []), str(ack.get("levels")))
                self.report["connectors"] = ack.get("connectors")
                if a.connector_cmds:
                    self.check("hello_ack advertises the bias connector", "bias" in (ack.get("connectors") or []), str(ack.get("connectors")))
                if a.scanimage_cmds:
                    self.check("hello_ack advertises the scanimage connector", "scanimage" in (ack.get("connectors") or []), str(ack.get("connectors")))
            await self.send({"type": "log_control", "enabled": True, "level": "behavior_v2"})
            lack = await self.wait_for("log_control_ack")
            self.check("log_control_ack: behavior_v2 in force", bool(lack) and lack.get("enabled") is True and lack.get("level") == "behavior_v2", str(lack))
            self.report["log_file"] = lack.get("file") if lack else None
            await self.send({"type": "log", "event": "run_metadata", "rig_id": a.rig_id, "log_format": "behavior_v2",
                             "protocol_sha256": None, "client": "studio_emulator.py", "frames": a.frames})
            # Pre-run: let a few frames flow so the epoch gate has a "since" id (the Studio
            # sees frames before the first trial too).
            await asyncio.sleep(0.5)
            since = None
            while not self.inbox.empty():
                m = self.inbox.get_nowait()
                if m.get("type") == "frame":
                    self.frames += 1
                    since = m.get("epoch", since)
            if a.connector_cmds:
                # The runner's path for a `camera` plugin, through the bridge (connector_command),
                # not bias_cmd.py: connect → startRecording → getTimestamp → stopRecording, plus an
                # unknown command. Done BEFORE the epochs so it cannot interleave with the
                # harness's own bias_cmd sequence mid-run (one BIAS, one capture at a time).
                r = await self.connector("connect")
                self.check("connector_command connect → reply ok", bool(r) and r.get("ok") is True, str(r)[:200])
                r = await self.connector("startRecording", {"filename": a.connector_video})
                self.check("connector_command startRecording → reply ok", bool(r) and r.get("ok") is True, str(r)[:200])
                self.check("startRecording reply carries the video artifact", bool(r) and isinstance(r.get("artifact"), dict) and bool(r["artifact"].get("path")), str((r or {}).get("artifact")))
                await asyncio.sleep(0.5)
                r = await self.connector("getTimestamp")
                self.check("connector_command getTimestamp → reply ok with a number", bool(r) and r.get("ok") is True and isinstance(r.get("value"), (int, float)), str(r)[:200])
                r = await self.connector("stopRecording")
                self.check("connector_command stopRecording → reply ok", bool(r) and r.get("ok") is True, str(r)[:200])
                r = await self.connector("bogusCommand")
                self.check("unknown command → reply error (not a hang)", bool(r) and r.get("ok") is False and r.get("outcome") == "error", str(r)[:200])
                # Frames kept flowing meanwhile; re-sync the epoch gate's "since" id.
                if self.last_epoch is not None:
                    since = self.last_epoch
            if a.scanimage_cmds:
                # The runner's path for a `scanimage` plugin (ScanImage's JSON server behind
                # scanimage_node.py): the 2P protocol's per-color sequence, plus the refusals and
                # the UNKNOWN path (a get the mock never answers → timeout → reconnect → reconcile).
                async def si(command: str, params: dict | None = None, timeout: float = 20.0) -> dict | None:
                    return await self.connector(command, params, timeout, connector="scanimage", plugin="scanimage")
                r = await si("ping")
                self.check("scanimage ping → ok, acqState idle", bool(r) and r.get("ok") is True and (r.get("value") or {}).get("acqState") == "idle", str(r)[:200])
                r = await si("setFileStem", {"stem": "emu_violet_d7"})
                self.check("scanimage setFileStem → ok, stem echoed", bool(r) and r.get("ok") is True and (r.get("value") or {}).get("logFileStem") == "emu_violet_d7", str(r)[:200])
                r = await si("set", {"property": "hStackManager.framesPerSlice", "value": 30})
                self.check("scanimage set framesPerSlice (allowlisted) → ok", bool(r) and r.get("ok") is True and r.get("value") == 30, str(r)[:200])
                r = await si("set", {"property": "hScan2D.bidirectional", "value": True})
                self.check("scanimage set of a non-allowlisted property → refused by the node (error, never sent)", bool(r) and r.get("ok") is False and r.get("outcome") == "error" and not r.get("steps"), str(r)[:200])
                r = await si("grab")
                self.check("scanimage grab → ok, acqState grab, TIFF artifact with stem + counter", bool(r) and r.get("ok") is True and (r.get("value") or {}).get("acqState") == "grab"
                           and isinstance(r.get("artifact"), dict) and r["artifact"].get("kind") == "tiff" and r["artifact"].get("stem") == "emu_violet_d7" and r["artifact"].get("counter") is not None, str(r)[:300])
                r = await si("waitIdle", {"timeout_s": 10})
                self.check("scanimage waitIdle → ok once the grab finished (acqState idle)", bool(r) and r.get("ok") is True and (r.get("value") or {}).get("acqState") == "idle", str(r)[:200])
                r = await si("abort")
                self.check("scanimage abort → ok (idle)", bool(r) and r.get("ok") is True and (r.get("value") or {}).get("acqState") == "idle", str(r)[:200])
                r = await si("get", {"property": "hRoiManager.scanZoomFactor"})
                self.check("scanimage get the mock never answers → outcome unknown + reconciled status (B2-style silence)", bool(r) and r.get("outcome") == "unknown" and isinstance(r.get("reconciled"), dict) and r["reconciled"].get("acqState") == "idle", str(r)[:300])
                r = await si("ping")
                self.check("scanimage ping after the timeout → ok (connection rebuilt)", bool(r) and r.get("ok") is True, str(r)[:200])
                r = await si("bogusCommand")
                self.check("scanimage unknown command → reply error (not a hang)", bool(r) and r.get("ok") is False and r.get("outcome") == "error", str(r)[:200])
                if self.last_epoch is not None:
                    since = self.last_epoch
            for i in range(a.epochs):
                since = await self.run_epoch(i, since)
                if a.iti_s > 0:
                    # ITI: frames keep flowing and are NOT applied (apply off), like the Studio.
                    t_end = time.monotonic() + a.iti_s
                    while time.monotonic() < t_end:
                        try:
                            m = await asyncio.wait_for(self.inbox.get(), max(0.01, t_end - time.monotonic()))
                        except asyncio.TimeoutError:
                            break
                        if m.get("type") == "frame":
                            self.frames += 1
                            since = m.get("epoch", since)
            await self.send({"type": "log", "event": "runner", "phase": "sequence-done", "epochs": a.epochs})
            await self.send({"type": "log_control", "enabled": False})
            off = await self.wait_for("log_control_ack")
            self.check("log_control_ack: logging off", bool(off) and off.get("enabled") is False, str(off))
            await self.send({"type": "log_export"})
            exp = await self.wait_for("log_export_result", timeout=15.0)
            self.check("log_export_result with content", bool(exp) and isinstance(exp.get("content"), str) and len(exp["content"]) > 0, str(exp)[:200] if exp else "none")
            if exp and exp.get("content"):
                with open(a.out, "w", encoding="utf-8", newline="\n") as fh:  # keep the received bytes (LF) on Windows
                    fh.write(exp["content"])
                self.report["export_name"] = exp.get("name")
                self.report["export_bytes"] = len(exp["content"])
            reader.cancel()
        self.report.update({"frames_total": self.frames, "applied": self.applied, "stale_withheld": self.stale})
        if a.report:
            with open(a.report, "w", encoding="utf-8") as fh:
                json.dump(self.report, fh, indent=1)
        print(f"[emulator] frames {self.frames}, applied {self.applied}, stale withheld {self.stale}, ok={self.report['ok']}", file=sys.stderr)
        return 0 if self.report["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="ws://127.0.0.1:8765")
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--epoch-s", type=float, default=6.0)
    p.add_argument("--iti-s", type=float, default=1.0)
    p.add_argument("--frames", type=int, default=200)
    p.add_argument("--coupling", type=float, default=1.0)
    p.add_argument("--deg-per-frame", type=float, default=1.8)
    p.add_argument("--start-frame", type=int, default=0)
    p.add_argument("--bias-type", default="constant", choices=("none", "constant", "sine", "square"))
    p.add_argument("--bias-amplitude", type=float, default=90.0)
    p.add_argument("--bias-frequency", type=float, default=0.0)
    p.add_argument("--min-frames", type=int, default=50, help="assert at least this many applied frames per epoch")
    p.add_argument("--rig-id", default="ros2-poc")
    p.add_argument("--connector-cmds", action="store_true", help="also drive the bias connector (startRecording/getTimestamp/stopRecording) through connector_command, as the Studio runner does")
    p.add_argument("--connector-video", default="poc_studio.avi", help="startRecording filename for --connector-cmds")
    p.add_argument("--scanimage-cmds", action="store_true", help="also drive the scanimage connector (ping/setFileStem/set/grab/waitIdle/abort/get/bogus) through connector_command")
    p.add_argument("--out", default="studio-export.jsonl", help="where to write the exported log")
    p.add_argument("--report", default=None, help="JSON report path")
    args = p.parse_args(argv)
    try:
        return asyncio.run(Emulator(args).main())
    except (ConnectionRefusedError, OSError) as exc:
        print(f"[emulator] cannot connect to {args.url}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
