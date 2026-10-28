#!/usr/bin/env python3
"""dashboard_replay.py — rebuild the live dashboard's derived topics from a finished run's bag.

Used by `foxglove_json.py --stimulus` so `foxglove/arena-okey-cokey.json` works on a replayed
run exactly as it does live. It runs the SAME pure code the live nodes run — stimulus_core
(the expected/observed display and arena health), arena_display (the pixels), rig_nodes.bias_health
(BIAS rate and losses) — over the bag's `/arena/browser` and `/bias/*` records, and emits:

  /arena/display, /arena/display_observed     foxglove.CompressedImage (PNG), as stimulus_node
  /viz/arena/{expected_idx, observed_idx, display_rate_hz, lag_frames, cmd_fps, ok, state,
             condition, health}             {"data": …} — the same `.data` paths as the live
                                              std_msgs topics, so one layout serves both
  /arena/stimulus, /arena/health              JSON objects (the live /arena/stimulus + the health values)
  /viz/bias/{fps, fps_from_count, frame_count, drops, rtt_ms, log_queue, reachable, capturing,
             logging, state}                  {"data": …}, as viz_node
  /camera/image                               foxglove.CompressedImage (grayscale PNG) from the run's
                                              uFMF, when one is given or found (see camera_streams)

Time: everything is stamped on the bridge's clock (the records' rx_ms), as live. Observed frames
and their lag are placed by the controller clock mapped to the bridge clock (stimulus_core's
offset). Camera frames are placed by BIAS's frame timestamps mapped to the bridge clock with the
run's getTimestamp replies: offset = median((t_ms + rx_epoch_ms)/2 − value·1000) over replies with
value > 0 (BIAS reads 0 before its first frame).
"""

from __future__ import annotations

import base64
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tools"))
import arena_display as AD  # noqa: E402
import stimulus_core as SC  # noqa: E402
from rig_nodes.bias_health import CountRate, bias_drops  # noqa: E402  (rig-nodes ≥ 0.3.0)

IMAGE_SCHEMA = "foxglove.CompressedImage"


def _ts(ns: int) -> dict:
    return {"sec": ns // 1_000_000_000, "nsec": ns % 1_000_000_000}


def image_msg(t_ns: int, png: bytes, frame_id: str) -> dict:
    return {"timestamp": _ts(t_ns), "frame_id": frame_id, "format": "png", "data": base64.b64encode(png).decode()}


def stimulus_streams(records, patterns, protocols, layout: str = "g6-green", display_hz: float = 15.0, scale: int = 4):
    """records: [(topic, log_ns, obj)] in log-time order (obj = the String record's JSON).
    Yields (topic, t_ns, obj, schema_name_or_None)."""
    tr = SC.StimulusTracker(SC.PatternLibrary(patterns), SC.ProtocolIndex(protocols))
    tr.frame_log = []
    step_ms = 1000.0 / max(1.0, display_hz)
    bias_rate = CountRate()
    last = {"disp": None, "obs_key": None, "obs_ms": -1e18, "stim": None, "health_ms": None}

    def ns(ms: float) -> int:
        return int(round(ms * 1e6))

    def f(topic, ms, v):
        if isinstance(v, bool) or isinstance(v, (int, float, str)):
            return (topic, ns(ms), {"data": v}, None)
        return None

    def render(name, idx, duty):
        pat = tr.patterns.get(name) if name else None
        if pat is None:
            return AD.render_placeholder(scale=scale)
        return AD.render_frame(pat["frames"][int(idx) % pat["num_frames"]], pat["gs"], layout, duty, scale)

    def display_at(ms):
        st = tr.stimulus()
        exp = tr.expected_index(ms)
        key = (st["state"], st.get("pattern"), exp, st.get("duty"))
        if key == last["disp"]:
            return
        last["disp"] = key
        img = render(st.get("pattern"), exp, st.get("duty") or 255) if (st["state"] == "trial" and exp is not None) else AD.render_dark(scale=scale)
        yield ("/arena/display", ns(ms), image_msg(ns(ms), AD.png_bytes(img), "arena_display"), IMAGE_SCHEMA)
        if exp is not None:
            yield f("/viz/arena/expected_idx", ms, exp)

    def stim_out(ms):
        st = tr.stimulus()
        if st != last["stim"]:
            last["stim"] = st
            yield ("/arena/stimulus", ns(ms), st, None)
            yield f("/viz/arena/state", ms, st["state"])
            yield f("/viz/arena/condition", ms, st.get("condition") or "")
            yield f("/viz/arena/cmd_fps", ms, st.get("fps", 0) if st["state"] == "trial" else 0)

    def health_out(ms):
        h = tr.health(ms)
        v = h["values"]
        out = [("/arena/health", ns(ms), {"level": h["level"], "level_name": h["level_name"], "message": h["message"], **v}, None),
               f("/viz/arena/health", ms, f"{h['level_name']}: {h['message']}"), f("/viz/arena/ok", ms, h["level"] == SC.OK),
               f("/viz/arena/display_rate_hz", ms, v["display_rate_hz"]), f("/viz/arena/lag_frames", ms, v["lag_frames"])]
        return [o for o in out if o]

    t_disp = None
    for topic, log_ns, obj in records:
        if not isinstance(obj, dict):
            continue
        if topic == "/arena/browser":
            rx = obj.get("rx_ms")
            if not isinstance(rx, (int, float)):
                rx = log_ns / 1e6
            # display ticks up to this record (only while a pattern plays; one image on each change)
            if t_disp is not None and tr.state == "trial":
                while t_disp < rx:
                    yield from (x for x in display_at(t_disp) if x)
                    t_disp += step_ms
            if last["health_ms"] is not None:
                while last["health_ms"] + 1000.0 <= rx:
                    last["health_ms"] += 1000.0
                    yield from health_out(last["health_ms"])
            tr.feed_record(obj)
            if last["health_ms"] is None and tr.seen_any:
                last["health_ms"] = rx
            yield from (x for x in stim_out(rx) if x)
            if tr.state != "trial" or t_disp is None or t_disp < rx:
                t_disp = rx
                yield from (x for x in display_at(rx) if x)
            if tr.frame_log:
                off = tr.clock_offset_us()
                for t_us, idx, pid, lag in tr.frame_log:
                    t_ms = (t_us + off) / 1000.0 if off is not None else rx
                    o = f("/viz/arena/observed_idx", t_ms, idx)
                    if o:
                        yield o
                    if lag is not None:
                        yield f("/viz/arena/lag_frames", t_ms, lag)
                    okey = (idx, pid, tr.state)
                    if okey != last["obs_key"] and t_ms - last["obs_ms"] >= step_ms:
                        last["obs_key"], last["obs_ms"] = okey, t_ms
                        st = tr.stimulus()
                        img = render(tr.pid_names.get(pid), idx, st.get("duty") or 255) if st["state"] == "trial" else AD.render_dark(scale=scale)
                        yield ("/arena/display_observed", ns(t_ms), image_msg(ns(t_ms), AD.png_bytes(img), "arena_display_observed"), IMAGE_SCHEMA)
                tr.frame_log.clear()
        elif topic == "/bias/status":
            ms = obj.get("t_ms") or obj.get("rx_epoch_ms") or log_ns / 1e6
            reach, cap, logg = bool(obj.get("reachable")), bool(obj.get("capturing")), bool(obj.get("logging"))
            state = "unreachable" if not reach else ("recording" if cap and logg else "preview" if cap else "idle")
            outs = [f("/viz/bias/reachable", ms, reach), f("/viz/bias/capturing", ms, cap), f("/viz/bias/logging", ms, logg),
                    f("/viz/bias/state", ms, state), f("/viz/bias/fps", ms, obj.get("framesPerSec")),
                    f("/viz/bias/frame_count", ms, obj.get("frameCount")), f("/viz/bias/rtt_ms", ms, obj.get("rtt_ms")),
                    f("/viz/bias/log_queue", ms, obj.get("logQueueSize")), f("/viz/bias/drops", ms, bias_drops(obj))]
            if isinstance(obj.get("frameCount"), (int, float)):
                r = bias_rate.add(ms / 1000.0, obj["frameCount"])
                outs.append(f("/viz/bias/fps_from_count", ms, r) if r is not None else None)
            yield from (o for o in outs if o)


def bias_clock_offset_ms(records) -> float | None:
    """bridge-clock ms − BIAS seconds·1000, from the run's getTimestamp replies (median)."""
    offs = []
    for topic, _, obj in records:
        if topic == "/bias/reply" and isinstance(obj, dict) and obj.get("command") == "getTimestamp" and obj.get("ok"):
            v = obj.get("value")
            t0, t1 = obj.get("t_ms"), obj.get("rx_epoch_ms")
            if isinstance(v, (int, float)) and v > 0 and isinstance(t0, (int, float)) and isinstance(t1, (int, float)):
                offs.append((t0 + t1) / 2.0 - v * 1000.0)
    return statistics.median(offs) if offs else None


def recorded_video(records) -> str | None:
    """The file BIAS wrote, from the run's stopRecording reply (bias_node resolves it)."""
    path = None
    for topic, _, obj in records:
        if topic == "/bias/reply" and isinstance(obj, dict) and obj.get("command") == "stopRecording":
            art = obj.get("artifact") or {}
            if art.get("path"):
                path = art["path"]
    return path


def camera_streams(records, ufmf_path, camera_hz: float = 10.0, factor: int = 2):
    """Yield /camera/image messages from the run's uFMF, aligned to the bridge clock. Returns
    (via StopIteration.value) a report dict."""
    from ufmf import UfmfReader, downsample

    off = bias_clock_offset_ms(records)
    report = {"ufmf": str(ufmf_path), "offset_ms": off, "images": 0}
    if off is None:
        report["error"] = "no getTimestamp reply with a non-zero value: cannot place camera frames on the run clock"
        return report
    with UfmfReader(ufmf_path) as u:
        report.update({"frames": u.n_frames, "width": u.width, "height": u.height, "indexed": u.indexed})
        step = 1.0 / max(0.1, camera_hz)
        nxt = None
        for i in range(u.n_frames):
            t = float(u.timestamps[i])
            if nxt is not None and t < nxt:
                continue
            nxt = t + step if nxt is None else max(nxt + step, t)
            ts, img = u.frame(i)
            t_ns = int(round((ts * 1000.0 + off) * 1e6))
            yield ("/camera/image", t_ns, image_msg(t_ns, AD.png_bytes(downsample(img, factor)), "bias_camera"), IMAGE_SCHEMA)
            report["images"] += 1
    return report


def run_streams(records, stimulus: dict | None, camera: dict | None) -> tuple[list, dict]:
    """All derived (topic, t_ns, obj, schema) rows + a report."""
    out, report = [], {}
    if stimulus is not None:
        out.extend(x for x in stimulus_streams(records, **stimulus) if x)
        report["stimulus_messages"] = len(out)
    if camera is not None:
        path = camera.get("ufmf")
        if path == "auto":
            path = recorded_video(records)
            if path and not Path(path).is_file():
                report["camera"] = {"error": f"the run's video is not on this machine: {path}"}
                path = None
        if path:
            gen = camera_streams(records, path, camera.get("hz", 10.0), camera.get("factor", 2))
            try:
                while True:
                    out.append(next(gen))
            except StopIteration as stop:
                report["camera"] = stop.value
        elif "camera" not in report:
            report["camera"] = {"error": "no uFMF given and none recorded by this run"}
    return out, report
