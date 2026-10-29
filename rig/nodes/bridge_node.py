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
  * `/arena/browser` — every Studio message is also PUBLISHED live, as received
    (`{"rx_ms", "raw"}`, reliable): trialParams echoes, runner status events, controller
    telemetry rows. The run's bag records the same messages separately (with `seq`, only while
    a log is open), so this is for live consumers such as stimulus_node.py (the expected
    display + arena health); nothing that writes the log reads it.
  * other device topics are LOGGED, not applied: `/kinefly/raw` (KF/1) → compact tagged
    rows `["kf", ms, seq, src_t_s, left_rad, right_rad, head_rad, abdomen_rad]`;
    `/bias/reply`, `/bias/status`, `/scanimage/reply`, `/scanimage/status` → `{"type":"connector","src":<id>,…}` events.
    Readers already pass unknown string-tagged arrays and unknown event objects through.
  * a source watchdog: when a logged source goes silent for --source-timeout s during a
    log, a `source_lost` event is written (and `source_resumed` when it returns). A device
    node killed mid-run therefore leaves the log intact AND documented.
  * `connector_status` lines (frames seen, adapter→bridge latency p50/p99 ms per source)
    at log close / export, so a run carries its own transport health.
  * `/rig/host` (rig_nodes.host_monitor: CPU per core, memory, disk, network, GPU, top processes) is
    recorded into the bag on arrival, so every run carries the PC's pressure alongside it.

Not supported here (by design of the PoC): the `fictrac_port` config key cannot re-bind
the socket — the adapter owns it. The request is acknowledged with a warning.

PLAN B SPIKE (LAB-303, 2026-10-14) — MCAP as the record of truth:
  * While a run's log is open, EVERYTHING is recorded into `<log-dir>/<run>.bag/` with
    rosbag2_py + the MCAP storage plugin (rig_nodes.recorder, reiserlab/rig-nodes): the device topics as received
    (`/fictrac/raw` or the typed `/fictrac/frame`, `/kinefly/raw`, `/bias/cmd|reply|status`, `/sipm/cmd|reply|status`,
    the ScanImage frame-stream topics `/scanimage/frame_meta|frame_stats|preview/*` — streams, bag only; their
    nodes are the 2P rig's, private in reiserlab/scanimage-2026-bergamo `2p-rig-nodes/`),
    `/arena/frame` (the closed-loop evaluation with ITS OWN sample time `t`/`ms`), and two
    bridge-side streams — `/arena/browser` (every browser message, verbatim, with the receive
    stamp) and `/arena/event` (bias_config, heading_tare, connector_status, source_lost, warn)
    — each stamped with the writer's emission sequence number `seq`, plus `/arena/session`.
  * `log_export` answers with the NDJSON DERIVED from the bag (nodes/mcap_convert.py); the
    acked log level is the converter's default level. The live NDJSON writer is KEPT as a
    shadow file during the spike: it is the fidelity reference (`converted == live` is checked
    at every export and printed) and the crash-loss baseline. `--export live` returns it instead.
    A bag the writer never closed (this node was killed mid-run; no metadata.yaml / torn tail)
    is RECOVERED on export — salvaged, indexed, metadata.yaml written by rosbag2's Reindexer,
    `{"event":"recovered"}` appended to its /arena/session (rig_nodes.mcap_index.recover_bag) —
    and the reply carries `recovered: true`; a freshly started node adopts the newest such bag
    in --log-dir for its first export, so the Studio's export after a bridge restart gets the
    salvaged run. A bag with nothing salvageable falls back to the run's shadow NDJSON.
  * ONE ms base per run: the pipeline's t0 is set from the log's open stamp (bridge 3.4 takes
    two now_ms() samples there — comparison.md appendix 4).
  * Typed messages when `rig_interfaces` is built (`pixi install` builds it; see
    interfaces/): `/fictrac/frame` is consumed and `/arena/frame` published/recorded as
    rig_interfaces/ArenaFrame (`--typed auto|on|off`); otherwise std_msgs/String JSON.

    pixi run bridge-node                      # ws://127.0.0.1:8765, logs + bags on demand in runlogs/
    pixi run bridge-node -- --frames 60 --log-dir /path --bag-profile crashsafe
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import math
import os
import re
import signal
import sys
import threading
import time
from pathlib import Path

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.qos import QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile, QoSReliabilityPolicy
from rclpy.serialization import deserialize_message, serialize_message
from sensor_msgs.msg import CompressedImage
from std_msgs.msg import String

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRIDGE_PY = REPO / "fictrac-bridge" / "bridge.py"
sys.path.insert(0, str(HERE))
from rig_nodes._common import mono_ns, probe_interfaces, raise_timer_resolution, wall_ms, wall_ns  # noqa: E402  (reiserlab/rig-nodes, installed package)
from rig_nodes.mcap_index import needs_recovery, recover_bag  # noqa: E402
from rig_nodes.recorder import PROFILES, STRING_TYPE, Recorder  # noqa: E402
from mcap_convert import convert_bag  # noqa: E402
from _rows import FLAG_BAD_FRAME, KF_TAG, fictrac_extras, is_bad_frame_tag, kf_row, parse_fictrac_line  # noqa: E402  (one encoder for the node and the converter)

# Typed messages only when the package imports AND serializes (pixi's `typed` env, or a
# colcon install whose libraries load); otherwise String JSON everywhere.
_IFACES = probe_interfaces()
HAVE_IFACES = _IFACES is not None
ArenaFrame, FicTracFrame = _IFACES if _IFACES else (None, None)  # type: ignore[assignment]


def load_bridge_module(path: Path = BRIDGE_PY):
    """Import fictrac-bridge/bridge.py by path (it is a script, not a package)."""
    spec = importlib.util.spec_from_file_location("fictrac_bridge", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = load_bridge_module()
if os.name == "nt":
    # bridge.py stamps every run-log `ms` / `rx_ms` / t0 through its module-level now_ms() =
    # int(time.time() * 1000): 15.6 ms steps on Windows + Python 3.12 (_common "clocks"). Rebind
    # it in THIS process to the precise wall clock; bridge.py itself (bridge 3.4) is unchanged.
    B.now_ms = wall_ms

NODE_VERSION = f"{B.BRIDGE_VERSION} · rig plan-b (rmw_zenoh, mcap record, connectors, merged frame record)"


def package_versions() -> dict:
    """The rig-nodes package set this gateway runs on (rig-software-repos-and-runners.md §7.7: every
    package version into the run's record). `rig_nodes` from the Python package; `rig_interfaces`
    from its ament index entry (a conda package without a Python distribution); None when absent."""
    out: dict = {}
    try:
        import rig_nodes

        out["rig_nodes"] = getattr(rig_nodes, "__version__", None)
    except Exception:
        out["rig_nodes"] = None
    try:
        from ament_index_python.packages import get_package_share_directory

        xml = Path(get_package_share_directory("rig_interfaces")) / "package.xml"
        m = re.search(r"<version>([^<]+)</version>", xml.read_text(encoding="utf-8"))
        out["rig_interfaces"] = m.group(1) if m else None
    except Exception:
        out["rig_interfaces"] = None
    return out


PACKAGES = package_versions()
FICTRAC_TOPIC = "/fictrac/raw"
FICTRAC_FRAME_TOPIC = "/fictrac/frame"  # typed rig_interfaces/FicTracFrame
BROWSER_TOPIC = "/arena/browser"
EVENT_TOPIC = "/arena/event"
SESSION_TOPIC = "/arena/session"
ARENA_FRAME_TYPE = "rig_interfaces/msg/ArenaFrame"
FICTRAC_FRAME_TYPE = "rig_interfaces/msg/FicTracFrame"
KINEFLY_TOPIC = "/kinefly/raw"
BIAS_CMD_TOPIC = "/bias/cmd"
BIAS_REPLY_TOPIC = "/bias/reply"
BIAS_STATUS_TOPIC = "/bias/status"
BIAS_FRAMES_TOPIC = "/bias/frames"  # every frame's BIAS timestamp, published by the BIAS node at stopRecording (bag only, no run-log line)
SCANIMAGE_CMD_TOPIC = "/scanimage/cmd"
SCANIMAGE_REPLY_TOPIC = "/scanimage/reply"
SCANIMAGE_STATUS_TOPIC = "/scanimage/status"
# The SiPM controller (the 2P rig's read-only node, private: reiserlab/scanimage-2026-bergamo 2p-rig-nodes/): its 1 Hz status carries bias/enable/offsets/
# temperature, the detector settings ScanImage's TIFF header does not have.
SIPM_CMD_TOPIC = "/sipm/cmd"
SIPM_REPLY_TOPIC = "/sipm/reply"
SIPM_STATUS_TOPIC = "/sipm/status"
# ScanImage's ZeroMQ frame stream as topics (the 2P rig's frames node, private, 2p-rig-nodes/; LAB-303 Block R). STREAMS:
# recorded into the bag as received, like /bias/frames, and never derived into a run-log line (the
# telemetry rule: a string-tagged stream is not a behavior sample). The preview images are bounded at
# the source (--preview-hz, 0 = off); ch1..ch4 cover ScanImage's four channels.
SCANIMAGE_FRAME_META_TOPIC = "/scanimage/frame_meta"
SCANIMAGE_FRAME_STATS_TOPIC = "/scanimage/frame_stats"
SCANIMAGE_PREVIEW_META_TOPIC = "/scanimage/preview/meta"
SCANIMAGE_PREVIEW_TOPICS = tuple(f"/scanimage/preview/ch{i}" for i in (1, 2, 3, 4))
COMPRESSED_IMAGE_TYPE = "sensor_msgs/msg/CompressedImage"
STREAM_TOPICS = {
    SCANIMAGE_FRAME_META_TOPIC: STRING_TYPE, SCANIMAGE_FRAME_STATS_TOPIC: STRING_TYPE, SCANIMAGE_PREVIEW_META_TOPIC: STRING_TYPE,
    **{t: COMPRESSED_IMAGE_TYPE for t in SCANIMAGE_PREVIEW_TOPICS},
}
# Device connectors the Studio may drive (LAB-303): connector_command → the node's cmd topic; its
# reply/status topics become {"type":"connector","src":<id>,…} run-log events (derived by the
# converter). Adding a connector = one entry here, a flag in rig.py, a topic pair in mcap_convert.py.
CONNECTOR_TOPICS = {
    "bias": {"cmd": BIAS_CMD_TOPIC, "reply": BIAS_REPLY_TOPIC, "status": BIAS_STATUS_TOPIC},
    "scanimage": {"cmd": SCANIMAGE_CMD_TOPIC, "reply": SCANIMAGE_REPLY_TOPIC, "status": SCANIMAGE_STATUS_TOPIC},
    "sipm": {"cmd": SIPM_CMD_TOPIC, "reply": SIPM_REPLY_TOPIC, "status": SIPM_STATUS_TOPIC},
}
FRAME_TOPIC = "/arena/frame"
# Host pressure from rig_nodes.host_monitor (reiserlab/rig-nodes): recorded on arrival, no run-log line.
HOST_TOPIC = "/rig/host"
HOST_STATS_TYPE = "rig_interfaces/msg/HostStats"
try:  # rig-nodes ≥ 0.3.0; the monitor publishes the same type when it imports (its --typed auto)
    from rig_interfaces.msg import HostStats
except (ImportError, AttributeError):
    HostStats = None
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


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[k]




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
        self.bad = 0  # untracked (FT_BADFR) frames in the current run; FicTrac only

    def seen(self, rx_epoch_ms: int | None, rx_mono_ns: int | None = None) -> None:
        self.count += 1
        self.last_rx_mono = time.monotonic()
        lat = None
        if isinstance(rx_mono_ns, int) and rx_mono_ns > 0:
            # The adapter's mono_ns() and ours are the same system-wide counter on one host
            # (QueryPerformanceCounter on Windows, CLOCK_MONOTONIC / mach time elsewhere): exact,
            # where the whole-ms rx_epoch_ms adds a 0–1 ms floor. Sane range only, else fall back.
            d = (mono_ns() - rx_mono_ns) / 1e6
            lat = d if 0.0 <= d < 10_000.0 else None
        if lat is None and rx_epoch_ms is not None:
            lat = wall_ns() / 1e6 - rx_epoch_ms
        if lat is not None:
            self.lat_ms.append(lat)
            if len(self.lat_ms) > 5000:
                del self.lat_ms[: len(self.lat_ms) - 5000]

    def summary(self) -> dict:
        return {
            "src": self.name,
            "frames": self.count,
            "bad_frames": self.bad,
            "lat_ms": {
                "p50": None if not self.lat_ms else round(percentile(self.lat_ms, 0.5), 2),
                "p99": None if not self.lat_ms else round(percentile(self.lat_ms, 0.99), 2),
                "n": len(self.lat_ms),
            },
        }


NAN = float("nan")
NO_DERIVED = (NAN, NAN)
DEFAULT_BALL_MM = 9.0  # fly-on-ball diameter, as js/kinematics.js ballRadiusMm() assumes


class RecordingLogWriter(B.LogWriter):
    """bridge.py's LogWriter (kept as the SHADOW NDJSON during the spike) + the MCAP record.

    Every emission the live writer makes is also recorded, with a per-run sequence number
    `seq` assigned at the moment the live writer would write the line — so the converter can
    reproduce the live order exactly (`--order seq`) or test the time-ordered alternative.
      * `_open`      → the bag opens FIRST, then the shadow file; `/arena/session` open record
      * write_inbound → `/arena/browser` {seq, rx_ms, raw, line:true}  (hello/config/log/…)
      * record_browser → `/arena/browser` {…, line:false} for rows / log_export / connector_command
      * write_event  → `/arena/event` {seq, …}   (record=False for events the converter DERIVES
                        from device topics: BIAS replies/status and connector commands)
      * record_device → the device message itself (`/kinefly/raw`, `/bias/reply|status`), on
                        the loop next to its shadow line, stamped with the ROS receive time
      * frames       → recorded by RosHub.publish (the emission point), `/arena/frame`
      * close        → `/arena/session` logging_stopped, then the bag closes
    `export_current` returns the CONVERTED log (or the shadow with --export live) and
    prints whether the two are byte-identical — the per-run fidelity self-check.
    Hooks `on_open()` / `on_close()` as before (connector_status lines, watchdog scope)."""

    on_open = None
    on_close = None

    def __init__(self, path, level, log_dir, *, profile: str, typed: bool, export: str, connectors: list[str],
                 max_bag_bytes: int = 0, record_fictrac_raw: bool = False) -> None:
        self.seq = 0
        # 2026-10-18 (docs/development/fictrac-columns-in-the-bag.md): the FicTrac record in the bag
        # is the merged /arena/frame message; the adapter's topics (25 columns + the verbatim line,
        # 68-77 % of a bag) are recorded only on request (--record-fictrac-raw, debugging a tracker).
        self.record_fictrac_raw = bool(record_fictrac_raw)
        self._max_bag_bytes = int(max_bag_bytes or 0)
        self.rec: Recorder | None = None
        self.bag_name: str | None = None
        self.last_bag: dict = {}
        self.last_convert: dict = {}
        self._profile = profile
        self._typed = typed
        self._export = export
        self._connectors = list(connectors)
        self._hub = None  # set by run() once the hub exists
        super().__init__(path, level, log_dir)

    # ── sequence + record helpers ────────────────────────────────────────────────────
    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def _record(self, topic: str, obj: dict) -> None:
        if self.rec is not None:
            self.rec.write_json(topic, obj)

    def topics(self) -> dict[str, str]:
        """Topic → type for the bag (all of them, so a run documents what it could hold)."""
        t = {
            SESSION_TOPIC: STRING_TYPE, BROWSER_TOPIC: STRING_TYPE, EVENT_TOPIC: STRING_TYPE,
            KINEFLY_TOPIC: STRING_TYPE, BIAS_CMD_TOPIC: STRING_TYPE, BIAS_REPLY_TOPIC: STRING_TYPE, BIAS_STATUS_TOPIC: STRING_TYPE, BIAS_FRAMES_TOPIC: STRING_TYPE,
            SCANIMAGE_CMD_TOPIC: STRING_TYPE, SCANIMAGE_REPLY_TOPIC: STRING_TYPE, SCANIMAGE_STATUS_TOPIC: STRING_TYPE,
            SIPM_CMD_TOPIC: STRING_TYPE, SIPM_REPLY_TOPIC: STRING_TYPE, SIPM_STATUS_TOPIC: STRING_TYPE,
            **STREAM_TOPICS,
        }
        t[FRAME_TOPIC] = ARENA_FRAME_TYPE if self._typed else STRING_TYPE
        t[HOST_TOPIC] = HOST_STATS_TYPE if HostStats is not None else STRING_TYPE
        if self.record_fictrac_raw:
            if self._typed:
                t[FICTRAC_FRAME_TOPIC] = FICTRAC_FRAME_TYPE
            else:
                t[FICTRAC_TOPIC] = STRING_TYPE
        return t

    # ── the LogWriter surface ────────────────────────────────────────────────────────
    def _open(self, name: str, event: str) -> None:
        bag = (name[:-6] if name.endswith(".jsonl") else name) + ".bag"
        rec = Recorder(bag, self.topics(), self._profile, max_bag_bytes=self._max_bag_bytes)
        t_open = time.perf_counter()
        self.rec = rec  # visible to the ROS thread first: records during open() are buffered
        open_error = None
        try:
            rec.open()
        except Exception as exc:  # a recorder problem must never take the run (or the WebSocket) down
            open_error = f"{type(exc).__name__}: {exc}"
            self.rec = None
            bag = None
        self.bag_name = bag
        self.seq = 0
        super()._open(name, event)  # shadow file: session + schema lines; sets self._t0
        if open_error:
            print(f"[record] FAILED to open the bag ({open_error}); this run has the live file only", file=sys.stderr)
            self.write_event({"type": "log", "event": "warn", "dir": "bridge", "level": "WARN", "ms": 0,
                              "message": f"mcap record unavailable for this run: {open_error}"}, record=False)
        else:
            self._record(SESSION_TOPIC, {"seq": self.next_seq(), "event": event, "file": name, "ms": self._t0, "level": self.level,
                                         "bag": bag, "connectors": sorted(self._connectors), "node": NODE_VERSION, "typed": self._typed,
                                         "profile": self._profile, "packages": PACKAGES})
            print(f"[record] {bag} ({self._profile}, typed={self._typed}; opened in {1000 * (time.perf_counter() - t_open):.0f} ms)", file=sys.stderr)
        if self.on_open is not None:
            self.on_open()

    def start_new_log(self) -> None:
        if self._explicit and self._fh:  # explicit --log path: a marker inside the open file
            ms = B.now_ms()
            self._emit({"type": "session", "event": "logging_started", "ms": ms})
            self._record(SESSION_TOPIC, {"seq": self.next_seq(), "event": "logging_started", "ms": ms})
            return
        super().start_new_log()

    def write_inbound(self, raw) -> None:
        if not self._fh:
            return
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        rx = B.now_ms()
        self._record(BROWSER_TOPIC, {"seq": self.next_seq(), "rx_ms": rx, "raw": text, "line": True})
        # LogWriter.write_inbound, with the SAME rx stamp as the record (the base would take
        # its own now_ms() a few µs later).
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            obj = {"type": "log", "event": "unparsed", "raw": text}
        obj.setdefault("dir", B.ARENA_DIR)
        obj.setdefault("rx_ms", rx)
        if self.level == "behavior_v2" and obj.get("event") == "arena_command":
            arr = B.compact_arena_command(obj, self._t0)
            if arr is not None:
                self._emit(arr)
                return
            self._verbatim_warned += 1
            if self._verbatim_warned <= 3:
                print(f"[log] arena_command kept verbatim: {B.arena_compact_reason(obj, self._t0)}", file=sys.stderr)
        self._emit(obj)

    def record_browser(self, text: str, rx_ms: int | None = None) -> int | None:
        """A browser message the live writer does not write as a line (rows / log_export /
        connector_command). `rx_ms` lets the caller share ONE clock sample between the record
        and whatever it derives from it (the connector command event's `ms`). Returns the seq
        it got, or None when no run is open."""
        if not self._fh:
            return None
        seq = self.next_seq()
        self._record(BROWSER_TOPIC, {"seq": seq, "rx_ms": B.now_ms() if rx_ms is None else rx_ms, "raw": text, "line": False})
        return seq

    def write_event(self, obj: dict, record: bool = True) -> None:
        if not self._fh:
            return
        if record:
            self._record(EVENT_TOPIC, {"seq": self.next_seq(), **obj})
        super().write_event(obj)

    def record_device(self, topic: str, data: bytes, t_ns: int) -> None:
        """A device message whose shadow line the caller writes next (Kinefly row, BIAS
        reply/status event). Recorded HERE, on the loop and under the same open gate as that
        line, not on the ROS thread on arrival: there a message could reach the bag but not
        the shadow file (arrived just before close) or the shadow file but not the bag
        (arrived just before open) — ww18 2026-10-15, harness `live 2237 vs conv 2236`.
        `t_ns` = the ROS-thread receive time, kept as the MCAP log_time."""
        if self._fh and self.rec is not None:
            self.rec.write_raw(topic, data, t_ns)

    def record_frame(self, msg: dict, extras: dict | None = None, flags: int = 0) -> None:
        """Called by RosHub.publish — the frame's emission point (write_frame follows at once).
        `extras` = the kept FicTrac columns beyond the behavior row (_rows.fictrac_extras), in
        both record forms — the bag's ONLY copy of them since the raw topics stopped being recorded.
        The derived turning_dps / forward_mms are NOT recorded (NaN in the typed record): they are
        live-only, exactly recomputable from x/y/hd/ft, and measured at 16 B per frame of
        incompressible doubles — a fifth of the record (harness bag, 2026-10-18)."""
        if not self._fh or self.rec is None:
            return
        seq = self.next_seq()
        pub_ns = int(msg["t"]) * 1_000_000
        if self._typed:
            self.rec.write_msg(FRAME_TOPIC, arena_frame_msg(msg, seq, NO_DERIVED, extras, flags), pub_ns=pub_ns)
        else:
            rec = {"wseq": seq, **msg, **(extras or {})}
            if flags:
                rec["flags"] = int(flags)
            self.rec.write_json(FRAME_TOPIC, rec, pub_ns=pub_ns)

    def record_bad_frame(self, tag: str, fields: list[float], now: int, t0: int, epoch: int) -> None:
        """An untracked FicTrac frame (tag FT_BADFR): the Pipeline emits no row and no hub frame,
        so without this the bag would show a gap it cannot tell from a dropped datagram. One
        flagged /arena/frame record (flags bit 0; fc/ft_seq when the line carried them, idx -1,
        the floats NaN / null) — the converter writes no line for it (_rows.arena_frame_to_row)."""
        if not self._fh or self.rec is None:
            return
        fc = int(fields[0]) if fields and math.isfinite(fields[0]) else 0
        msg = {"t": now, "ms": now - t0, "fc": fc, "idx": -1, "ft": None, "x": None, "y": None, "hd": None, "epoch": int(epoch)}
        extras = fictrac_extras(fields)
        if not self._typed:  # JSON must stay strict (no NaN tokens): null for the absent floats
            extras = {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in extras.items()}
        self.record_frame(msg, extras, FLAG_BAD_FRAME)

    def close(self) -> None:
        if not self._fh:
            return
        if self.on_close is not None:
            self.on_close()
        ms = B.now_ms()
        self._record(SESSION_TOPIC, {"seq": self.next_seq(), "event": "logging_stopped", "ms": ms})
        self._emit({"type": "session", "event": "logging_stopped", "ms": ms})
        self._fh.close()
        self._fh = None
        if self.rec is not None:
            self.last_bag = self.rec.close()
            self.rec = None
            print(f"[record] closed {self.last_bag.get('bag')}: {self.last_bag.get('records')} records, "
                  f"{self.last_bag.get('bytes_on_disk')} B on disk", file=sys.stderr)

    # ── crash recovery on export ─────────────────────────────────────────────────────
    def torn_bags(self) -> list[str]:
        """Bags in the log dir that a killed writer left behind (no metadata.yaml / torn
        tail), newest first — what a restarted node can still export."""
        d = Path(self._dir or ".")
        try:
            bags = sorted((b for b in d.glob("arena-log-*.bag") if b.is_dir()), reverse=True)
        except OSError:
            return []
        return [str(b) for b in bags if needs_recovery(b)]

    def _adopt_torn_bag(self) -> bool:
        """Nothing open and nothing exported yet in THIS process (a restart after a crash):
        the newest torn bag becomes the export target, with its shadow file as the fallback."""
        torn = self.torn_bags()
        if not torn:
            return False
        self.bag_name = torn[0]
        shadow = torn[0][:-4] + ".jsonl"
        self._name = shadow  # the base class exports the shadow when conversion fails
        print(f"[record] adopting the unclosed bag of a previous run for export: {torn[0]}", file=sys.stderr)
        return True

    def export_current(self):
        if self._fh:
            self.close()
        recovery = None
        if not self._name and not self.bag_name:
            self._adopt_torn_bag()
        name, live = super().export_current()
        if self.bag_name and needs_recovery(self.bag_name):
            # The writer never closed this bag (a crash, LAB-303 ww18 5.7): salvage + index +
            # metadata.yaml FIRST, so the conversion below reads a whole bag and every later
            # reader (Foxglove, ros2 bag info) opens it without --recover.
            recovery = recover_bag(self.bag_name)
            print(f"[recover] {self.bag_name}: {recovery.get('reason')} → salvaged {recovery.get('salvaged_records')} records, "
                  f"metadata.yaml {'written' if (recovery.get('metadata_yaml') or {}).get('written') else 'NOT written'} "
                  f"in {recovery.get('seconds')} s", file=sys.stderr)
            if name is None and self._name and Path(self._name).exists():
                name, live = super().export_current()
        if name is None and self.bag_name:
            name = Path(self.bag_name).name[:-4] + ".jsonl"  # a bag whose shadow file is gone: still exportable
        if name is None or self._export == "live" or not self.bag_name:
            if recovery:
                self.last_convert = {"recovered": True, "recovery": recovery}
            return name, live
        t0 = time.perf_counter()
        try:
            text, report = convert_bag(self.bag_name, level=None, order="seq")
        except Exception as exc:
            print(f"[convert] FAILED ({exc!r}) — exporting the shadow file instead", file=sys.stderr)
            self.last_convert = {"error": repr(exc), "recovered": bool(recovery), "recovery": recovery,
                                 "fallback": "shadow" if live is not None else None}
            return name, live
        report["convert_ms"] = round(1000 * (time.perf_counter() - t0), 1)
        if recovery:
            report["recovered"] = True
            report["recovery"] = recovery
        report["identical_to_live"] = text == live
        if not report["identical_to_live"]:
            a, b = text.splitlines(), (live or "").splitlines()
            report["first_diff_line"] = next((i + 1 for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)) + 1)
            report["lines_live"] = len(b)
        self.last_convert = report
        print(f"[convert] {self.bag_name} → {report['lines']} lines in {report['convert_ms']} ms; "
              f"identical to the live file: {report['identical_to_live']}", file=sys.stderr)
        return name, text


def wrap_to_pi(r: float) -> float:
    """Radians to (-π, π] — js/kinematics.js wrapToPi, so a turning step never spikes at ±π."""
    x = math.fmod(r, 2 * math.pi)
    if x <= -math.pi:
        x += 2 * math.pi
    elif x > math.pi:
        x -= 2 * math.pi
    return x


class FrameDeriver:
    """turning_dps / forward_mms for the TYPED ArenaFrame, from consecutive hub frames.

    The math is js/kinematics.js's (the Studio scope + the course dashboard), reduced to the
    two-point difference a live stream allows: dt from the FicTrac camera clock `ft` (ms,
    col 22 — robust to a dropped frame because it is a timestamp, not an inter-frame dt),
    falling back to the bridge clock `t` when ft is absent; turning = the shortest signed
    heading step / dt in deg/s; forward = (dx·cos h + dy·sin h) / dt × ball radius with h the
    heading at the middle of the step (kinematics.js projects on the center sample).
    NaN on the first frame, when the clock does not advance (also a new run's ft restarting
    at 0), when the clock SOURCE changes between frames, or when fc goes backwards (FicTrac
    restarted). The hub message and the behavior_v1 columns never carry these — the
    derivation lives in one place in the browser (kinematics.js) and in one place here."""

    def __init__(self, ball_mm: float = DEFAULT_BALL_MM) -> None:
        self.radius_mm = (ball_mm if ball_mm > 0 else DEFAULT_BALL_MM) / 2.0
        self._prev: tuple | None = None  # (fc, clock_src, clock_ms, x, y, hd)

    def reset(self) -> None:
        self._prev = None

    def step(self, msg: dict) -> tuple[float, float]:
        try:
            src, clock = ("ft", float(msg["ft"])) if msg.get("ft") is not None else ("t", float(msg["t"]))
            cur = (int(msg["fc"]), src, clock, float(msg["x"]), float(msg["y"]), float(msg["hd"]))
        except (KeyError, TypeError, ValueError):
            self._prev = None
            return NO_DERIVED
        prev, self._prev = self._prev, cur
        if prev is None or prev[1] != src or cur[0] < prev[0]:
            return NO_DERIVED
        dt_s = (clock - prev[2]) / 1000.0
        if not dt_s > 0:
            return NO_DERIVED
        d_hd = wrap_to_pi(cur[5] - prev[5])
        h_mid = prev[5] + d_hd / 2.0
        dx, dy = cur[3] - prev[3], cur[4] - prev[4]
        turning_dps = math.degrees(d_hd) / dt_s
        forward_mms = (dx * math.cos(h_mid) + dy * math.sin(h_mid)) / dt_s * self.radius_mm
        return (turning_dps, forward_mms)


def arena_frame_msg(msg: dict, seq: int, derived: tuple[float, float] = NO_DERIVED, extras: dict | None = None, flags: int = 0):
    """The hub frame → rig_interfaces/ArenaFrame. ONE builder for the published message and
    the recorded one, so the bag and the live topic can never disagree on a field. `extras` =
    _rows.fictrac_extras(fields) of the line the frame came from (cols 5, 6-8, 22 native, 23)."""
    e = extras or fictrac_extras(None)

    def fl(v) -> float:
        return float(v) if v is not None else NAN

    return ArenaFrame(t_ms=int(msg["t"]), ms=int(msg["ms"]), fc=int(msg["fc"]), idx=int(msg["idx"]),
                      has_ft=msg.get("ft") is not None, ft=fl(msg.get("ft")),
                      x=fl(msg.get("x")), y=fl(msg.get("y")), hd=fl(msg.get("hd")), epoch=int(msg.get("epoch", 0)),
                      bias_deg=float(msg.get("bias", 0.0)), seq=seq,
                      turning_dps=float(derived[0]), forward_mms=float(derived[1]),
                      err=fl(e["err"]), dr_lab_x=fl(e["dr_lab_x"]), dr_lab_y=fl(e["dr_lab_y"]), dr_lab_z=fl(e["dr_lab_z"]),
                      ft_seq=int(e["ft_seq"]), ft_ns=int(e["ft_ns"]), flags=int(flags) & 0xFF)


class RosHub(B.Hub):
    """bridge.py's Hub + a ROS mirror of every frame on /arena/frame (String JSON, or a typed
    ArenaFrame when the interfaces are built) + the frame's MCAP record. The typed frame also
    carries the derived turning_dps / forward_mms (FrameDeriver); the String mirror is the hub
    message verbatim, like the WebSocket."""

    def __init__(self, on_message, ros_pub, log: RecordingLogWriter, typed: bool, ball_mm: float = DEFAULT_BALL_MM) -> None:
        super().__init__(on_message)
        self._ros_pub = ros_pub
        self._log = log
        self._typed = typed
        self.deriver = FrameDeriver(ball_mm)
        # The parsed columns of the FicTrac line the consumer is feeding to Pipeline.handle_line
        # right now (set just before the call; handle_line publishes synchronously inside it, and
        # the consumer awaits one line at a time, so the slot is always this frame's).
        self.fields: list[float] | None = None

    async def publish(self, msg: dict) -> None:
        await super().publish(msg)  # the WebSocket hub message to the Studio: unchanged
        derived = self.deriver.step(msg) if self._typed else NO_DERIVED  # live topic only; the record carries NaN
        extras = fictrac_extras(self.fields)
        self._log.record_frame(msg, extras)
        if self._ros_pub is not None:
            if self._typed:
                m = arena_frame_msg(msg, self._log.seq, derived, extras)
            else:
                m = String()  # the hub message + the kept FicTrac columns (what the bag records)
                m.data = json.dumps({**msg, **extras}, separators=(",", ":"))
            self._ros_pub.publish(m)


class BridgeNode(Node):
    """ROS side: subscriptions hand data to the asyncio side thread-safely. Every device
    topic is subscribed RAW (serialized bytes) so the same bytes go to the bag unchanged."""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, on_kinefly, on_connector, log: RecordingLogWriter, typed: bool) -> None:
        super().__init__("arena_bridge")
        self._loop = loop
        self._queue = queue
        self._on_kinefly = on_kinefly
        self._on_connector = on_connector
        self._log = log
        self.typed = typed
        self.stats = {"fictrac": SourceStats("fictrac"), "kinefly": SourceStats("kinefly"), **{c: SourceStats(c) for c in CONNECTOR_TOPICS}}
        self.frame_pub = self.create_publisher(ArenaFrame if typed else String, FRAME_TOPIC, FRAME_QOS)
        self.browser_pub = self.create_publisher(String, BROWSER_TOPIC, RAW_QOS)
        # Studio → bridge connector_command relayed to the device node (LAB-303 connectors).
        self.cmd_pubs = {c: self.create_publisher(String, t["cmd"], RAW_QOS) for c, t in CONNECTOR_TOPICS.items()}
        if typed:
            self.create_subscription(FicTracFrame, FICTRAC_FRAME_TOPIC, self._fictrac_typed, RAW_QOS, raw=True)
        else:
            self.create_subscription(String, FICTRAC_TOPIC, self._fictrac, RAW_QOS, raw=True)
        self.create_subscription(String, KINEFLY_TOPIC, self._kinefly, RAW_QOS, raw=True)
        for c, t in CONNECTOR_TOPICS.items():
            for kind in ("reply", "status"):
                self.create_subscription(String, t[kind], lambda b, c=c, kind=kind, topic=t[kind]: self._connector(c, kind, topic, b), RAW_QOS, raw=True)
        # Recorded on arrival, like /fictrac/raw: it never becomes a run-log line (the stopRecording reply
        # carries its summary), so there is no shadow line to stay in step with.
        self.create_subscription(String, BIAS_FRAMES_TOPIC, lambda b: self._record(BIAS_FRAMES_TOPIC, b), RAW_QOS, raw=True)
        # rig_nodes.host_monitor samples (1 Hz; the monitor publishes RELIABLE, KEEP_LAST 10).
        self.create_subscription(HostStats if HostStats is not None else String, HOST_TOPIC,
                                 lambda b: self._record(HOST_TOPIC, b), RAW_QOS, raw=True)
        # The ScanImage frame stream (meta, stats, preview meta, preview images): the same arrival-time
        # record, raw bytes, no run-log line — the bag is the only place they go.
        for topic, typ in STREAM_TOPICS.items():
            self.create_subscription(CompressedImage if typ == COMPRESSED_IMAGE_TYPE else String, topic,
                                     lambda b, topic=topic: self._record(topic, b), RAW_QOS, raw=True)

    def _record(self, topic: str, data: bytes) -> None:
        rec = self._log.rec
        if rec is not None:
            rec.write_raw(topic, data)

    @staticmethod
    def _envelope(data: bytes) -> dict | None:
        try:
            env = json.loads(deserialize_message(data, String).data)
        except (json.JSONDecodeError, Exception):
            return None
        return env if isinstance(env, dict) else None

    # FicTrac too: the raw message is recorded by the loop's consumer (consume_recording) just
    # before the pipeline turns it into a frame, so a frame in the run always has its raw record
    # (`--level full` takes the 25 fields from it) — ww18: a line that arrived just before the
    # open had a recorded frame but no raw record (`cols [0, 25]`).
    def _fictrac(self, data: bytes) -> None:
        t_ns = wall_ns()
        env = self._envelope(data)
        if env is None or not isinstance(env.get("raw"), str):
            if self._log.record_fictrac_raw:
                self._record(FICTRAC_TOPIC, data)
            return
        self.stats["fictrac"].seen(env.get("rx_epoch_ms"), env.get("rx_mono_ns"))
        # Same hand-off bridge.py's UDP protocol does (queue.put_nowait), from the ROS thread.
        self._loop.call_soon_threadsafe(self._queue.put_nowait, (env["raw"], FICTRAC_TOPIC, data, t_ns))

    def _fictrac_typed(self, data: bytes) -> None:
        t_ns = wall_ns()
        try:
            m = deserialize_message(data, FicTracFrame)
        except Exception:
            if self._log.record_fictrac_raw:
                self._record(FICTRAC_FRAME_TOPIC, data)
            return
        self.stats["fictrac"].seen(int(m.rx_epoch_ms) if m.rx_epoch_ms else None, int(m.rx_mono_ns) if m.rx_mono_ns else None)
        # The closed-loop math stays bridge 3.4's byte for byte: it parses the verbatim line
        # the typed message carries. The typed fields are for ROS-native consumers + the bag.
        self._loop.call_soon_threadsafe(self._queue.put_nowait, (m.raw, FICTRAC_FRAME_TOPIC, data, t_ns))

    # Kinefly + BIAS become shadow-file lines the converter DERIVES from the bag, so their
    # record is made on the loop together with the line (RecordingLogWriter.record_device);
    # only a message that can never become a line is recorded here on arrival.
    def _kinefly(self, data: bytes) -> None:
        t_ns = wall_ns()
        env = self._envelope(data)
        if env is None or not isinstance(env.get("raw"), str):
            self._record(KINEFLY_TOPIC, data)
            return
        self.stats["kinefly"].seen(env.get("rx_epoch_ms"), env.get("rx_mono_ns"))
        self._loop.call_soon_threadsafe(self._on_kinefly, env, data, t_ns)

    def _connector(self, src: str, kind: str, topic: str, data: bytes) -> None:
        t_ns = wall_ns()
        env = self._envelope(data)
        if env is None:
            self._record(topic, data)
            return
        self.stats[src].seen(env.get("rx_epoch_ms"))
        self._loop.call_soon_threadsafe(self._on_connector, src, kind, env, topic, data, t_ns)


async def run(args: argparse.Namespace) -> None:
    if B.serve is None:
        raise SystemExit("the `websockets` package is required (pixi install)")
    loop = asyncio.get_running_loop()
    typed = HAVE_IFACES if args.typed == "auto" else (args.typed == "on")
    if typed and not HAVE_IFACES:
        raise SystemExit("--typed on, but rig_interfaces is not importable (pixi install builds it; or pixi run build-interfaces)")
    CONNECTORS = {c: t["cmd"] for c, t in CONNECTOR_TOPICS.items()}
    log = RecordingLogWriter(args.log, args.log_level, args.log_dir, profile=args.bag_profile, typed=typed,
                             export=args.export, connectors=list(CONNECTORS),
                             max_bag_bytes=int(round(args.max_bag_mb * 1024 * 1024)) if args.max_bag_mb > 0 else 0,
                             record_fictrac_raw=args.record_fictrac_raw)
    queue: asyncio.Queue[tuple[str, str, bytes, int]] = asyncio.Queue()  # (line, topic, raw bytes, receive ns)
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

    def on_kinefly(env: dict, data: bytes, t_ns: int) -> None:
        log.record_device(KINEFLY_TOPIC, data, t_ns)
        try:
            pkt = json.loads(env["raw"])
        except (json.JSONDecodeError, KeyError, TypeError):
            return
        kf_seq["n"] += 1
        seq = pkt.get("sequence") if isinstance(pkt.get("sequence"), int) else kf_seq["n"]
        log.write_rows([kf_row(rel_ms(), pkt, seq)])

    # ── connectors: the Studio's connector_command → /<src>/cmd, /<src>/reply → connector_reply ──
    # CONNECTOR_TOPICS lists them (bias, scanimage); the Studio maps plugin instances onto them. A command
    # is logged on arrival (dir browser→bridge) and its reply is logged when the node answers
    # (via "ws" marks replies the Studio asked for, as opposed to bias_cmd.py's). The reply
    # goes back to the ASKING websocket only (the hub's broadcast coalesces frames).
    pending: dict[str, dict] = {}  # command id → {"ws", "plugin", "connector", "t"}

    async def ws_reply(websocket, msg: dict) -> None:
        if websocket is None:
            return
        try:
            await websocket.send(json.dumps(msg))
        except Exception:  # ConnectionClosed: the asker left — nothing to deliver to
            pass

    def on_connector(src: str, kind: str, env: dict, topic: str, data: bytes, t_ns: int) -> None:
        log.record_device(topic, data, t_ns)
        ev = {"type": "connector", "src": src, "kind": kind, "dir": "bridge", "ms": rel_ms()}
        for k, v in env.items():
            if k not in ("src",):
                ev[k] = v
        p = pending.pop(str(env.get("id")), None) if kind == "reply" and env.get("id") is not None else None
        if p is not None:
            ev["via"] = "ws"
            ev["plugin"] = p["plugin"]
        log.write_event(ev, record=False)  # derived by the converter from /<src>/reply|status
        if p is not None:
            rep = {"type": "connector_reply", "connector": p["connector"], "plugin": p["plugin"]}
            for k, v in env.items():
                if k not in ("type", "src"):
                    rep[k] = v
            loop.create_task(ws_reply(p["ws"], rep))

    async def on_connector_command(obj: dict, websocket, raw_text: str | None = None) -> None:
        cid = obj.get("id")
        connector = str(obj.get("connector") or "bias")
        command = str(obj.get("command") or "")
        params = obj.get("params") if isinstance(obj.get("params"), dict) else {}
        plugin = obj.get("plugin")
        # Recorded as the browser message itself (the converter derives this event + the
        # unknown-connector error reply from it); the shadow file gets the lines as before.
        # ONE clock sample for the record and the event, so the derived `ms` is exact.
        rx = B.now_ms()
        ms = rx - pipeline.t0_ms
        log.record_browser(json.dumps(obj, separators=(",", ":")) if raw_text is None else raw_text, rx_ms=rx)
        log.write_event({"type": "connector", "src": connector, "kind": "command", "dir": "browser→bridge", "ms": ms,
                         "id": cid, "plugin": plugin, "command": command, "params": params}, record=False)
        if connector not in CONNECTORS:
            err = f"no connector {connector!r} on this bridge (have {sorted(CONNECTORS)})"
            log.write_event({"type": "connector", "src": connector, "kind": "reply", "dir": "bridge", "ms": ms, "via": "ws",
                             "id": cid, "plugin": plugin, "command": command, "ok": False, "outcome": "error", "error": err}, record=False)
            await ws_reply(websocket, {"type": "connector_reply", "id": cid, "connector": connector, "plugin": plugin,
                                       "command": command, "ok": False, "outcome": "error", "error": err})
            return
        pending[str(cid)] = {"ws": websocket, "plugin": plugin, "connector": connector, "t": time.monotonic()}
        m = String()
        m.data = json.dumps({"id": cid, "command": command, "params": params}, separators=(",", ":"))
        if log.rec is not None:
            log.rec.write_msg(CONNECTORS[connector], m)
        node.cmd_pubs[connector].publish(m)

    inputs = RosInput(args.fictrac_port, warn)
    dispatch_34 = B.make_dispatcher(pipeline, log, inputs)  # unmodified bridge.py dispatcher

    async def dispatch(raw, websocket=None) -> None:
        """bridge.py's dispatcher + two message kinds: `hello` gains the `connectors` list
        (so the Studio's bridge client knows what it may drive; a ≤ 3.4 bridge never sends
        it) and `connector_command` is relayed to the device node. Everything else is 3.4."""
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        live = String()
        live.data = json.dumps({"rx_ms": B.now_ms(), "raw": text}, separators=(",", ":"))
        node.browser_pub.publish(live)
        obj = None
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            obj = None
        kind = obj.get("type") if isinstance(obj, dict) else None
        if kind == "hello":
            log.write_inbound(text)
            await ws_reply(websocket, {"type": "hello_ack", "bridge": B.BRIDGE_VERSION, "levels": list(B.LOG_LEVELS),
                                       "level": log.level, "logging": log.active, "connectors": sorted(CONNECTORS),
                                       "record": "mcap", "typed": typed, "packages": PACKAGES})
            return
        if kind == "connector_command":
            await on_connector_command(obj, websocket, text)
            return
        if kind == "rows":
            # The live writer writes the rows (write_rows); the bag gets the message itself.
            log.record_browser(text)
            log.write_rows(obj.get("rows"))
            return
        if kind == "log_export":
            log.record_browser(text)  # the last record of the run (the export closes the bag)
            # bridge.py's reply, plus what the converter/recovery reports: `recovered: true`
            # when the bag had to be salvaged first (a restart after a crash), and the
            # conversion report so the asker can see lines/level/fidelity without the log.
            name, content = log.export_current()
            conv = log.last_convert or {}
            if name is not None:
                reply_msg = {"type": "log_export_result", "name": name, "content": content,
                             "recovered": bool(conv.get("recovered")), "record": "mcap"}
                if conv.get("recovered"):
                    reply_msg["recovery"] = conv.get("recovery")
                if conv.get("fallback"):
                    reply_msg["fallback"] = conv["fallback"]
                for k in ("lines", "level", "identical_to_live", "convert_ms", "closed"):
                    if k in conv:
                        reply_msg[k] = conv[k]
            else:
                reply_msg = {"type": "log_export_result", "error": "no log file has been written"}
            await ws_reply(websocket, reply_msg)
            print(f"[log] export → {name or 'nothing'}" + (f" ({len(content)} chars" + (", recovered" if conv.get("recovered") else "") + ")" if content else ""),
                  file=sys.stderr)
            return
        await dispatch_34(raw, websocket)

    node = BridgeNode(loop, queue, on_kinefly, on_connector, log, typed)

    def on_log_open() -> None:
        """A new file: ONE ms base (the pipeline's t0 = the log's open stamp; bridge 3.4 took
        two now_ms() samples a few µs apart), note where its frames come from, and scope the
        source watchdog to it (a source lost/resumed between runs must not leak a half pair)."""
        if log._t0 is not None:
            pipeline.t0_ms = log._t0
        for s in node.stats.values():
            s.lost = False
            s.last_rx_mono = None
            s.bad = 0
        log.write_event(
            {
                "type": "connector_status",
                "dir": "bridge",
                "ms": rel_ms(),
                "src": "bridge",
                "node": NODE_VERSION,
                "rmw": os.environ.get("RMW_IMPLEMENTATION"),
                "record": {"bag": log.bag_name, "profile": log._profile, "typed": typed, "fictrac_raw": log.record_fictrac_raw},
                "topics": {"fictrac": FICTRAC_FRAME_TOPIC if typed else FICTRAC_TOPIC, "kinefly": KINEFLY_TOPIC,
                           "bias": [BIAS_CMD_TOPIC, BIAS_REPLY_TOPIC, BIAS_STATUS_TOPIC, BIAS_FRAMES_TOPIC],
                           "scanimage": [SCANIMAGE_CMD_TOPIC, SCANIMAGE_REPLY_TOPIC, SCANIMAGE_STATUS_TOPIC],
                           "sipm": [SIPM_CMD_TOPIC, SIPM_REPLY_TOPIC, SIPM_STATUS_TOPIC], "frame": FRAME_TOPIC,
                           "browser": BROWSER_TOPIC, "event": EVENT_TOPIC, "session": SESSION_TOPIC},
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

    hub = RosHub(dispatch, node.frame_pub, log, typed, ball_mm=args.ball_mm)
    pipeline.hub = hub
    log._hub = hub

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
                if s.name in CONNECTOR_TOPICS or s.last_rx_mono is None:  # connectors are polled, not streams
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
    if hasattr(signal, "SIGBREAK"):
        # Windows: no add_signal_handler, and rig.py / the harness stop children with
        # CTRL_BREAK_EVENT, whose default action ends the process on the spot — the bag then
        # never gets metadata.yaml and the shadow file no logging_stopped (ww18 2026-10-15).
        signal.signal(signal.SIGBREAK, lambda *_: loop.call_soon_threadsafe(stop.set))

    executor = SingleThreadedExecutor()
    executor.add_node(node)
    ros_thread = threading.Thread(target=executor.spin, name="rclpy-spin", daemon=True)
    ros_thread.start()

    async def consume_recording() -> None:
        """bridge.py's consume() (line → pipeline.handle_line). The line is parsed ONCE more here
        (the same split bridge.py does) so the frame's record can carry the kept FicTrac columns
        beyond the behavior row (hub.fields → RosHub.publish → ArenaFrame err/dr_lab/ft_seq/ft_ns);
        an untracked frame (FT_BADFR) gets a flagged record of its own. With --record-fictrac-raw
        the adapter's message is also recorded under the run's open gate (record_device) — after
        the frame went out, so the bag write is not on the closed-loop path; handle_line never
        opens or closes the log, so the gate is the frame's."""
        fictrac_stats = node.stats["fictrac"]
        while True:
            line, topic, data, t_ns = await queue.get()
            tag, fields = parse_fictrac_line(line)
            hub.fields = fields
            try:
                await pipeline.handle_line(line)
            finally:
                hub.fields = None
            if is_bad_frame_tag(tag):
                fictrac_stats.bad += 1
                log.record_bad_frame(tag, fields, B.now_ms(), pipeline.t0_ms, pipeline.epoch_id)
            if log.record_fictrac_raw:
                log.record_device(topic, data, t_ns)

    consumer = asyncio.create_task(consume_recording())
    wd = asyncio.create_task(watchdog())

    torn = log.torn_bags()
    if torn:
        print(f"[record] {len(torn)} unclosed bag(s) from a previous run in {args.log_dir}: {', '.join(Path(b).name for b in torn[:3])}"
              f"{', …' if len(torn) > 3 else ''} — the next log_export (`pixi run export`) recovers the newest; "
              f"`pixi run reindex -- <bag> --recover` for the others", file=sys.stderr)
    async with B.serve(hub.serve_client, args.ws_host, args.ws_port, max_size=B.WS_MAX_SIZE):
        print(
            f"[ws] serving ws://{args.ws_host}:{args.ws_port}  (bridge-node {NODE_VERSION}; "
            f"rmw={os.environ.get('RMW_IMPLEMENTATION')}, in={FICTRAC_FRAME_TOPIC if typed else FICTRAC_TOPIC}, typed={typed}, "
            f"record=mcap/{args.bag_profile}, export={args.export}, frames={args.frames}, "
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
    p.add_argument("--log-dir", default=str(HERE.parent / "runlogs"), help="directory for on-demand arena-log-*.jsonl (default: rig/runlogs)")
    p.add_argument("--log-level", choices=B.LOG_LEVELS, default=B.DEFAULT_LOG_LEVEL)
    p.add_argument("--ball-mm", type=float, default=DEFAULT_BALL_MM,
                   help=f"ball diameter in mm for the typed frame's forward_mms (default: {DEFAULT_BALL_MM:g}, as the Studio scope assumes)")
    p.add_argument("--typed", choices=("auto", "on", "off"), default="auto",
                   help="consume /fictrac/frame + publish /arena/frame as rig_interfaces types (auto: when the package imports; default)")
    p.add_argument("--bag-profile", choices=sorted(PROFILES), default="crashsafe",
                   help="MCAP writer profile: crashsafe (no chunking, no cache; default — rosbag2's defaults hold a whole short run in an unflushed 768 KiB chunk) or default (rosbag2 defaults)")
    p.add_argument("--max-bag-mb", type=float, default=0.0,
                   help="OPTIONAL: split the bag into <run>_0.mcap, _1.mcap, … at about this many MiB (rosbag2 max_bagfile_size; a threshold, not a hard cap). Default 0 = one file; bags are archived on a share, not pushed to GitHub, so only a size-limited store needs this")
    p.add_argument("--record-fictrac-raw", action="store_true",
                   help="ALSO record the adapter's FicTrac topic (/fictrac/frame or /fictrac/raw: all 25 columns + the verbatim line) in the bag. "
                        "Off by default since 2026-10-18 — the merged /arena/frame record carries the 10 kept columns (docs/development/fictrac-columns-in-the-bag.md); "
                        "`--level full` needs this")
    p.add_argument("--export", choices=("converted", "live"), default="converted",
                   help="what log_export returns: the NDJSON converted from the bag (default) or the live shadow file")
    args, ros_args = p.parse_known_args(argv)
    if args.frames <= 0:
        p.error("--frames must be > 0")
    if not math.isfinite(args.coupling):
        p.error("--coupling must be finite")
    if not (math.isfinite(args.ball_mm) and args.ball_mm > 0):
        p.error("--ball-mm must be > 0")
    if os.name == "nt":
        print(f"[bridge-node] Windows clocks: precise wall clock for every stamp; 1 ms system timer "
              f"{'granted' if raise_timer_resolution() else 'NOT granted'}", file=sys.stderr)
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
