#!/usr/bin/env python3
"""tiff_run_to_mcap.py — an after-the-fact Foxglove MCAP for a 2P color-sweep run (ScanImage TIFFs + arena patterns).

    pixi run tiff2mcap -- --tiff-dir <dir> --counter 3 --pat-dir ../protocols/g6_2p_color_led_sweep_patterns \\
        --out oct16_color_sweep.mcap --layout-out foxglove-oct16.json [--runlog arena-log-….jsonl]

Pure Python (numpy + the `mcap` package; no ROS process). What goes in, and what each topic IS:

  /scanimage/preview/ch<id>   foxglove.CompressedImage (PNG)   OBSERVED   each frame downsampled 2×2, one fixed
                                                                           int16→8-bit window per channel (recorded)
  /scanimage/frame_ref        JSON                              OBSERVED   frame number, channel ids, TIFF path + pages,
                                                                           frameTimestamps_sec, epoch, DO1 pulses in the frame
  /scanimage/qc               JSON                              DERIVED    whole-field mean per channel, minus the pre-stimulus
                                                                           baseline of that file
  /arena/stimulus             JSON                              COMMANDED (--runlog: each trialParams at its logged send
                                                                           time) or RECONSTRUCTED (first DO1 pulse + nominal step
                                                                           lengths): color, duty, pattern, fps, step
  /arena/display              foxglove.CompressedImage (PNG)    OBSERVED (--runlog with controller telemetry: every frame
                                                                           the controller reports displaying, at its own time) or
                                                                           RECONSTRUCTED (.pat × duty × LED color at the protocol's
                                                                           fps, frame 0 at each step)
  /arena/scene                foxglove.SceneUpdate              DERIVED from /arena/display: 20 panel cubes on the arena
                                                                           cylinder, colored by LED color × lit fraction × duty
  /run/events                 JSON                              acquisition start/end per color (TIFF), step edges, allOff,
                                                                           and with --runlog every ScanImage connector command + reply
  /run/provenance             JSON (one message)                           how every topic was made, the clock used, the gaps

Clock without a run log: TIFF `epoch` (PC local time) + `frameTimestamps_sec`, converted with
--utc-offset-h (EDT = -4). The stimulus timeline is placed on that clock through the DO1 pulses ScanImage
stamped into the frames (aux trigger 0): the first pulse is the first trialParams, and the step edges are
the protocol's nominal lengths (labelled RECONSTRUCTED).

Clock with --runlog: the run log's PC clock (Unix epoch). The ScanImage `epoch` field is NOT used for
placement: on 2026-10-16 it ran 0.53–0.67 s ahead of the first frame (different per grab; on the epoch
clock the first DO1 pulse lands before the trialParams that caused it). Intervals inside a TIFF are exact
(DO1 span = the logged trialParams→allOff time within 1–3 ms), so each TIFF is anchored by one point: its
first DO1 pulse = the controller's first displayed frame after that color's first trialParams (controller
time mapped to the PC clock by a linear fit of the trialParams it executed against their logged send
times; without controller telemetry, the trialParams send time). The per-file correction to the epoch
clock is in /run/provenance. The pixels are what ScanImage recorded; nothing here proves the light that
reached the detectors — the qc trace does.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "tools"))  # led_sweep_quicklook.read_tiff_pages (stdlib TIFF reader)
from patfile import read_pat  # noqa: E402

try:
    from led_sweep_quicklook import read_tiff_pages  # noqa: E402
except ImportError:  # the quicklook lives at the repo root tools/
    read_tiff_pages = None

COLORS = ("violet", "blue", "green", "yellow")
LED_RGB = {"violet": (150, 0, 255), "blue": (0, 90, 255), "green": (0, 255, 70), "yellow": (255, 170, 0)}
LED_NM = {"violet": 405, "blue": 470, "green": 525, "yellow": 590}
DUTIES = (7, 15, 31, 63, 127, 255)
PANEL = 20


# ── TIFF ─────────────────────────────────────────────────────────────────────
def tiff_si_header(path: Path) -> str:
    """ScanImage's `SI.*` header = TIFF tag 305 (Software) of the first IFD."""
    with open(path, "rb") as f:
        data = f.read(2_000_000)
    bo = "<" if data[:2] == b"II" else ">"
    big = struct.unpack_from(bo + "H", data, 2)[0] == 43
    if big:
        off = struct.unpack_from(bo + "Q", data, 8)[0]
        n = struct.unpack_from(bo + "Q", data, off)[0]
        pos, ent, fmt = off + 8, 20, "HHQQ"
    else:
        off = struct.unpack_from(bo + "I", data, 4)[0]
        n = struct.unpack_from(bo + "H", data, off)[0]
        pos, ent, fmt = off + 2, 12, "HHII"
    for i in range(n):
        tag, typ, count, val = struct.unpack_from(bo + fmt, data, pos + i * ent)
        if tag == 305:
            return data[val:val + count].decode("latin1", "replace")
    return ""


def si_value(header: str, key: str):
    m = re.search(re.escape(key) + r"\s*=\s*([^\n]*)", header)
    if not m:
        return None
    v = m.group(1).strip()
    if v.startswith("[") and v.endswith("]"):
        return [float(x) for x in v[1:-1].replace(";", " ").split()]
    try:
        return float(v)
    except ValueError:
        return v.strip("'")


def frame_fields(desc: str) -> dict:
    out = {}
    for key in ("frameNumbers", "frameTimestamps_sec", "acqTriggerTimestamps_sec", "endOfAcquisition"):
        m = re.search(re.escape(key) + r"\s*=\s*([-\d.]+)", desc)
        out[key] = float(m.group(1)) if m else None
    m = re.search(r"epoch\s*=\s*\[([^\]]*)\]", desc)
    out["epoch"] = [float(x) for x in re.split(r"[\s,;]+", m.group(1).strip()) if x] if m else None
    m = re.search(r"auxTrigger0\s*=\s*\[([^\]]*)\]", desc)
    out["aux0"] = [float(x) for x in re.split(r"[\s,;]+", m.group(1).strip()) if x] if m and m.group(1).strip() else []
    return out


def epoch_ns(epoch: list, utc_offset_h: float) -> int:
    y, mo, d, h, mi, s = epoch
    sec = int(s)
    frac = s - sec
    t = dt.datetime(int(y), int(mo), int(d), int(h), int(mi), sec, tzinfo=dt.timezone(dt.timedelta(hours=utc_offset_h)))
    return int(t.timestamp() * 1e9) + int(round(frac * 1e9))


# ── PNG (pure Python) ────────────────────────────────────────────────────────
def png_bytes(img: np.ndarray) -> bytes:
    """8-bit grayscale (H,W) or RGB (H,W,3) → PNG."""
    if img.ndim == 2:
        color_type, row = 0, img
    else:
        color_type, row = 2, img
    h, w = img.shape[:2]
    raw = b"".join(b"\x00" + np.ascontiguousarray(row[i]).astype(np.uint8).tobytes() for i in range(h))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


# ── schemas (Foxglove well-known types, JSON encoding) ───────────────────────
def _ts():
    return {"type": "object", "properties": {"sec": {"type": "integer"}, "nsec": {"type": "integer"}}}


def _vec3():
    return {"type": "object", "properties": {k: {"type": "number"} for k in "xyz"}}


def _color():
    return {"type": "object", "properties": {k: {"type": "number"} for k in "rgba"}}


def _pose():
    return {"type": "object", "properties": {"position": _vec3(), "orientation": {"type": "object", "properties": {k: {"type": "number"} for k in "xyzw"}}}}


SCHEMA_IMAGE = {"title": "foxglove.CompressedImage", "type": "object", "properties": {
    "timestamp": _ts(), "frame_id": {"type": "string"},
    "data": {"type": "string", "contentEncoding": "base64"}, "format": {"type": "string"}}}
SCHEMA_SCENE = {"title": "foxglove.SceneUpdate", "type": "object", "properties": {
    "deletions": {"type": "array", "items": {"type": "object", "properties": {"timestamp": _ts(), "type": {"type": "integer"}, "id": {"type": "string"}}}},
    "entities": {"type": "array", "items": {"type": "object", "properties": {
        "timestamp": _ts(), "frame_id": {"type": "string"}, "id": {"type": "string"}, "lifetime": _ts(),
        "frame_locked": {"type": "boolean"},
        "metadata": {"type": "array", "items": {"type": "object", "properties": {"key": {"type": "string"}, "value": {"type": "string"}}}},
        "cubes": {"type": "array", "items": {"type": "object", "properties": {"pose": _pose(), "size": _vec3(), "color": _color()}}},
        "spheres": {"type": "array", "items": {"type": "object", "properties": {"pose": _pose(), "size": _vec3(), "color": _color()}}},
        "cylinders": {"type": "array", "items": {"type": "object", "properties": {"pose": _pose(), "size": _vec3(), "bottom_scale": {"type": "number"}, "top_scale": {"type": "number"}, "color": _color()}}},
        "texts": {"type": "array", "items": {"type": "object", "properties": {"pose": _pose(), "billboard": {"type": "boolean"}, "font_size": {"type": "number"}, "scale_invariant": {"type": "boolean"}, "color": _color(), "text": {"type": "string"}}}}}}}}}


def json_schema(name: str, props: dict) -> dict:
    return {"title": name, "type": "object", "properties": props}


def ts(ns: int) -> dict:
    return {"sec": ns // 1_000_000_000, "nsec": ns % 1_000_000_000}


# ── the run ──────────────────────────────────────────────────────────────────
def load_color(tiff_dir: Path, color: str, counter: int, utc_offset_h: float, preview_size: int) -> dict:
    path = tiff_dir / f"{color}_sweep_{counter:05d}.tif"
    if not path.exists():
        raise SystemExit(f"missing {path}")
    header = tiff_si_header(path)
    chans = [int(c) for c in (si_value(header, "SI.hChannels.channelSave") or [])] or None
    frame_rate = si_value(header, "SI.hRoiManager.scanFrameRate")
    avg = si_value(header, "SI.hScan2D.logAverageFactor")
    pages = list(read_tiff_pages(path))
    n_ch = len(chans) if chans else (2 if len(pages) % 2 == 0 else 1)
    chans = chans or list(range(1, n_ch + 1))
    frames = []
    for i in range(0, len(pages), n_ch):
        desc, _ = pages[i]
        ff = frame_fields(desc)
        imgs = {chans[k]: pages[i + k][1] for k in range(n_ch)}
        frames.append({"fields": ff, "imgs": imgs, "pages": list(range(i, i + n_ch))})
    ep = frames[0]["fields"]["epoch"]
    t0_ns = epoch_ns(ep, utc_offset_h)
    for fr in frames:
        fr["t_ns"] = t0_ns + int(round(fr["fields"]["frameTimestamps_sec"] * 1e9))
    pulses = sorted(p for fr in frames for p in fr["fields"]["aux0"])
    return {"color": color, "path": path, "header": header, "chans": chans, "frame_rate": frame_rate, "avg": avg,
            "frames": frames, "t0_ns": t0_ns, "epoch": ep, "aux0": pulses,
            "channels_source": "SI.hChannels.channelSave (TIFF tag 305)" if si_value(header, "SI.hChannels.channelSave") else "ASSUMED page order"}


def step_edges(run: dict, durations: list[float]) -> list[dict]:
    """RECONSTRUCTED: the first DO1 pulse is the first trialParams; steps follow at the given lengths."""
    if not run["aux0"]:
        return []
    t = run["aux0"][0]
    edges = []
    for k, (duty, dur) in enumerate(zip(DUTIES, durations)):
        edges.append({"step": k, "duty": duty, "t_start_s": t, "t_end_s": t + dur})
        t += dur
    return edges


# ── run log (Studio → bridge .jsonl, behavior_v2) ────────────────────────────
COND_RE = re.compile(r"^(" + "|".join(COLORS) + r")_d(\d+)$")


def load_runlog(path: Path) -> dict:
    """The parts of a run log this tool uses. Times are PC epoch ms.

    trials:   one per trialParams, in order: condition, color, duty, pattern_id, fps, t_cmd_ms (the
              arena_command send time; the runner's trial-running receive time if those don't pair up)
    all_off:  allOff send times (compact `a` rows "01 00", t_off from logging start)
    connector: ScanImage connector commands (logging start + ms) and replies (rx_epoch_ms)
    cc8:      controller-clock t_us of each trialParams the controller executed (`cc` rows, cmd 8)
    cf:       the controller's displayed-frame records (t_us, frame idx, pattern id)
    """
    rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    objs = [o for o in rows if isinstance(o, dict)]
    t0 = next((o["ms"] for o in objs if o.get("event") == "logging_started"), None)
    running = [o for o in objs if o.get("event") == "runner" and o.get("phase") == "trial-running"]
    sends = [o["t"] for o in objs if o.get("event") == "arena_command" and str(o.get("head", "")).startswith("0d 08")]
    paired = len(sends) == len(running)
    trials = []
    for i, o in enumerate(running):
        m = COND_RE.match(str(o.get("condition", "")))
        p = o.get("params", {})
        trials.append({"condition": o.get("condition"), "color": m.group(1) if m else None,
                       "duty": int(p.get("duty", m.group(2) if m else 0)), "pattern_id": p.get("patternId"),
                       "fps": p.get("frameRate"), "t_cmd_ms": float(sends[i] if paired else o["rx_ms"]),
                       "duty_matches_condition": bool(m) and int(m.group(2)) == int(p.get("duty", -1))})
    a_off = [float(t0 + a[1]) for a in rows if isinstance(a, list) and a[0] == "a" and a[3] == "0100"] if t0 is not None else []
    runner_off = [float(o["rx_ms"]) for o in objs if o.get("event") == "runner" and o.get("op") == "allOff"]
    all_off = a_off if len(a_off) == len(runner_off) else runner_off
    connector = []
    for o in objs:
        if o.get("type") != "connector" or o.get("kind") not in ("command", "reply"):
            continue
        if o["kind"] == "command" and t0 is not None:
            connector.append({"t_ms": float(t0 + o["ms"]), "kind": "command", "command": o.get("command"),
                              "detail": json.dumps(o.get("params", {}), separators=(",", ":"))})
        elif o["kind"] == "reply":
            v = o.get("value")
            connector.append({"t_ms": float(o.get("rx_epoch_ms") or o.get("t_ms")), "kind": "reply", "command": o.get("command"),
                              "detail": f"{o.get('outcome')} rtt {o.get('rtt_ms', 0):.0f} ms "
                                        + json.dumps(v, separators=(",", ":"))[:200]})
    cc8 = [float(a[2]) for a in rows if isinstance(a, list) and a[0] == "cc" and a[4] == 8]
    cf = [(float(a[2]), int(a[4]), int(a[5])) for a in rows if isinstance(a, list) and a[0] == "cf"]
    return {"path": str(path), "t0_ms": t0, "trials": trials, "sends_paired": paired, "all_off": sorted(all_off),
            "all_off_source": "a rows (send)" if all_off is a_off else "runner rx_ms", "connector": sorted(connector, key=lambda c: c["t_ms"]),
            "cc8": cc8, "cf": cf}


def controller_clock(log: dict):
    """Linear map controller t_us → PC ms from the trialParams the controller executed vs their send times.
    Returns (fn, info) or (None, reason) when the telemetry can't support it."""
    cc8, sends = log["cc8"], [t["t_cmd_ms"] for t in log["trials"]]
    if not log["sends_paired"] or len(cc8) != len(sends) or len(cc8) < 2:
        return None, f"no controller clock map (cc trialParams {len(cc8)}, logged sends {len(sends)}, paired {log['sends_paired']})"
    x = np.array(cc8) / 1e3
    y = np.array(sends)
    k, b = np.polyfit(x - x[0], y, 1)
    res = y - (k * (x - x[0]) + b)
    fn = lambda t_us: k * (t_us / 1e3 - x[0]) + b  # noqa: E731
    return fn, {"rate": float(k), "ppm": float((k - 1) * 1e6), "residual_sd_ms": float(res.std()), "max_abs_residual_ms": float(abs(res).max()),
                "note": "fit of send time (PC) vs controller execution time; residual includes USB/host latency jitter"}


def runlog_timeline(log: dict, color: str, to_pc) -> dict | None:
    """One color's logged steps. t_disp_ms = the controller's first displayed frame after the trialParams
    (PC clock) when the telemetry allows, else the send time. t_off_ms = the first allOff after the last step."""
    steps = [t for t in log["trials"] if t["color"] == color]
    if not steps:
        return None
    cf = log["cf"]
    cc_by_trial = dict(zip(range(len(log["trials"])), log["cc8"])) if to_pc else {}
    out = []
    for s in steps:
        i = log["trials"].index(s)
        t_disp, frames = None, []
        if to_pc and i in cc_by_trial:
            t_exec = cc_by_trial[i]
            t_next = cc_by_trial.get(i + 1, float("inf"))
            frames = [(to_pc(t_us), idx, pid) for t_us, idx, pid in cf if t_exec <= t_us < t_next and pid == s["pattern_id"]]
            if frames:
                t_disp = frames[0][0]
        out.append({**s, "step": len(out), "t_disp_ms": t_disp if t_disp is not None else s["t_cmd_ms"],
                    "t_disp_source": "controller first displayed frame" if t_disp is not None else "trialParams send time",
                    "frames": frames})
    last = out[-1]["t_cmd_ms"]
    t_off = next((t for t in log["all_off"] if t > last), None)
    lat = [s["t_disp_ms"] - s["t_cmd_ms"] for s in out]
    return {"steps": out, "t_off_ms": t_off, "display_latency_ms": float(np.median(lat))}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiff-dir", required=True)
    ap.add_argument("--counter", type=int, required=True, help="TIFF series counter (…_00003.tif → 3)")
    ap.add_argument("--pat-dir", required=True, help="folder with G6_2x10_toprow_grat20_<color>_gs16.pat")
    ap.add_argument("--out", required=True)
    ap.add_argument("--layout-out", default=None)
    ap.add_argument("--runlog", default=None, help="the run's .jsonl (optional): logged step times, the PC clock "
                    "(each TIFF anchored by its first DO1 pulse), displayed frames from controller telemetry, ScanImage commands")
    ap.add_argument("--utc-offset-h", type=float, default=-4.0, help="TIFF epoch is PC local time (EDT = -4)")
    ap.add_argument("--fps", type=float, default=20.0, help="pattern frame rate in the protocol")
    ap.add_argument("--step-s", type=float, default=4.0, help="nominal step length when no run log (the day's host-timed steps)")
    ap.add_argument("--step-durations", default='{"yellow": [4, 4, 4, 4, 3, 4]}',
                    help="JSON per-color override of the six step lengths (default: the day's one unthrottled yellow d127 step)")
    ap.add_argument("--preview-size", type=int, default=128)
    ap.add_argument("--display-scale", type=int, default=4, help="nearest-neighbour upscale of the 200×40 display image")
    ap.add_argument("--scene-hz", type=float, default=5.0)
    a = ap.parse_args(argv)
    if read_tiff_pages is None:
        raise SystemExit("needs tools/led_sweep_quicklook.py (repo root) for read_tiff_pages")

    from mcap.writer import Writer, CompressionType

    tiff_dir, pat_dir, out = Path(a.tiff_dir), Path(a.pat_dir), Path(a.out)
    overrides = json.loads(a.step_durations)
    runs = [load_color(tiff_dir, c, a.counter, a.utc_offset_h, a.preview_size) for c in COLORS]

    # with a run log: put every TIFF on the run log's PC clock, anchored by its first DO1 pulse
    log, to_pc, clock_info, timelines = None, None, None, {}
    if a.runlog:
        log = load_runlog(Path(a.runlog))
        to_pc, clock_info = controller_clock(log)
        for run in runs:
            tl = runlog_timeline(log, run["color"], to_pc)
            if not tl or not run["aux0"]:
                continue
            anchor_ms = tl["steps"][0]["t_disp_ms"]
            epoch_ns_first_do1 = run["t0_ns"] + int(round(run["aux0"][0] * 1e9))
            shift_ns = int(round(anchor_ms * 1e6)) - epoch_ns_first_do1
            run["t0_ns"] += shift_ns
            for fr in run["frames"]:
                fr["t_ns"] += shift_ns
            # end check: last DO1 pulse (+ one 300 Hz period) vs the logged allOff + display latency
            end_ms = anchor_ms + (run["aux0"][-1] - run["aux0"][0] + 1 / 300) * 1e3
            tl.update(anchor_ms=anchor_ms, epoch_correction_ms=shift_ns / 1e6,
                      end_check_ms=(end_ms - (tl["t_off_ms"] + tl["display_latency_ms"])) if tl["t_off_ms"] else None)
            timelines[run["color"]] = tl
    runs.sort(key=lambda r: r["t0_ns"])
    pats = {c: read_pat(pat_dir / f"G6_2x10_toprow_grat20_{c}_gs16.pat") for c in COLORS}

    # fixed display mapping per channel from the FIRST file (so colors are comparable)
    window = {}
    for ch in runs[0]["chans"]:
        stack = np.stack([fr["imgs"][ch] for fr in runs[0]["frames"][::8]])
        lo, hi = np.percentile(stack, 0.5), np.percentile(stack, 99.8)
        window[ch] = (float(lo), float(max(hi, lo + 1)))

    def to8(img, ch):
        lo, hi = window[ch]
        x = (img.astype(np.float32) - lo) / (hi - lo)
        return (np.clip(x, 0, 1) * 255).astype(np.uint8)

    def downsample(img):
        h, w = img.shape
        f = max(1, h // a.preview_size)
        return img[: h - h % f, : w - w % f].reshape(h // f, f, w // f, f).mean(axis=(1, 3))

    def stimulus_source(color):
        if color in timelines:
            return "commanded (run log trialParams, logged send time)"
        return "reconstructed (first DO1 pulse + nominal step lengths)"

    gaps = []
    with open(out, "wb") as fh:
        w = Writer(fh, compression=CompressionType.ZSTD)
        w.start(profile="", library="tiff_run_to_mcap.py (webDisplayTools rig)")
        sch_img = w.register_schema("foxglove.CompressedImage", "jsonschema", json.dumps(SCHEMA_IMAGE).encode())
        sch_scene = w.register_schema("foxglove.SceneUpdate", "jsonschema", json.dumps(SCHEMA_SCENE).encode())
        sch_ref = w.register_schema("scanimage.FrameRef", "jsonschema", json.dumps(json_schema("scanimage.FrameRef", {
            "color": {"type": "string"}, "frame": {"type": "integer"}, "t_acq_s": {"type": "number"}, "tiff": {"type": "string"},
            "pages": {"type": "array", "items": {"type": "integer"}}, "channels": {"type": "array", "items": {"type": "integer"}},
            "do1_pulses_in_frame": {"type": "integer"}, "source": {"type": "string"}})).encode())
        sch_qc = w.register_schema("scanimage.QC", "jsonschema", json.dumps(json_schema("scanimage.QC", {
            "color": {"type": "string"}, "frame": {"type": "integer"}, "duty": {"type": "integer"}, "step": {"type": "integer"},
            **{f"mean_ch{ch}": {"type": "number"} for ch in runs[0]["chans"]},
            **{f"dmean_ch{ch}": {"type": "number"} for ch in runs[0]["chans"]}, "source": {"type": "string"}})).encode())
        sch_stim = w.register_schema("arena.Stimulus", "jsonschema", json.dumps(json_schema("arena.Stimulus", {
            "color": {"type": "string"}, "wavelength_nm": {"type": "integer"}, "duty": {"type": "integer"}, "step": {"type": "integer"},
            "on": {"type": "boolean"}, "pattern": {"type": "string"}, "fps": {"type": "number"}, "t_rel_s": {"type": "number"},
            "source": {"type": "string"}})).encode())
        sch_ev = w.register_schema("run.Event", "jsonschema", json.dumps(json_schema("run.Event", {
            "event": {"type": "string"}, "color": {"type": "string"}, "detail": {"type": "string"}, "source": {"type": "string"}})).encode())
        sch_prov = w.register_schema("run.Provenance", "jsonschema", b'{"type":"object"}')
        ch_prev = {ch: w.register_channel(f"/scanimage/preview/ch{ch}", "json", sch_img) for ch in runs[0]["chans"]}
        ch_ref = w.register_channel("/scanimage/frame_ref", "json", sch_ref)
        ch_qc = w.register_channel("/scanimage/qc", "json", sch_qc)
        ch_stim = w.register_channel("/arena/stimulus", "json", sch_stim)
        ch_disp = w.register_channel("/arena/display", "json", sch_img)
        ch_scene = w.register_channel("/arena/scene", "json", sch_scene)
        ch_ev = w.register_channel("/run/events", "json", sch_ev)
        ch_prov = w.register_channel("/run/provenance", "json", sch_prov)

        def put(chan, t_ns, obj):
            w.add_message(chan, log_time=t_ns, publish_time=t_ns, data=json.dumps(obj, separators=(",", ":")).encode())

        def img_msg(t_ns, png, frame_id):
            return {"timestamp": ts(t_ns), "frame_id": frame_id, "format": "png", "data": base64.b64encode(png).decode()}

        def scene(t_ns, color, frame, duty, on):
            rgb = LED_RGB[color]
            cubes = []
            pat = pats[color]
            n_cols, n_rows = pat["cols"], pat["rows"]
            R = 1.0
            for r in range(n_rows):
                for c in range(n_cols):
                    lit = float(frame[r * PANEL:(r + 1) * PANEL, c * PANEL:(c + 1) * PANEL].mean()) / 15.0 if (on and frame is not None) else 0.0
                    level = lit * (duty / 255.0) if on else 0.0
                    az = 2 * np.pi * (c + 0.5) / n_cols
                    cubes.append({"pose": {"position": {"x": R * np.cos(az), "y": R * np.sin(az), "z": 0.3 + 0.62 * r},
                                           "orientation": {"x": 0, "y": 0, "z": float(np.sin((az + np.pi / 2) / 2)), "w": float(np.cos((az + np.pi / 2) / 2))}},
                                  "size": {"x": 0.58, "y": 0.06, "z": 0.58},
                                  "color": {"r": 0.12 + rgb[0] / 255 * level * 0.88, "g": 0.12 + rgb[1] / 255 * level * 0.88, "b": 0.12 + rgb[2] / 255 * level * 0.88, "a": 0.95}})
            return {"deletions": [], "entities": [{
                "timestamp": ts(t_ns), "frame_id": "arena", "id": "panels", "lifetime": ts(0), "frame_locked": False,
                "metadata": [{"key": "source", "value": "reconstructed"}, {"key": "color", "value": color}, {"key": "duty", "value": str(duty)}],
                "cubes": cubes,
                "spheres": [{"pose": {"position": {"x": 0, "y": 0, "z": 0.6}, "orientation": {"x": 0, "y": 0, "z": 0, "w": 1}},
                             "size": {"x": 0.12, "y": 0.12, "z": 0.12}, "color": {"r": 1, "g": 1, "b": 1, "a": 1}}],
                "cylinders": [], "texts": [{"pose": {"position": {"x": 0, "y": 0, "z": 1.35}, "orientation": {"x": 0, "y": 0, "z": 0, "w": 1}},
                                            "billboard": True, "font_size": 0.12, "scale_invariant": False, "color": {"r": 0.9, "g": 0.93, "b": 0.95, "a": 1},
                                            "text": f"{color} {LED_NM[color]} nm · duty {duty}" if on else "arena dark"}]}]}

        def display_png(color, frame, duty):
            rgb = np.array(LED_RGB[color], dtype=np.float32)
            img = (frame[::-1, :].astype(np.float32) / 15.0)[:, :, None] * (duty / 255.0) * rgb  # row 0 (bottom) → image bottom
            img = np.clip(img, 0, 255).astype(np.uint8)
            s = a.display_scale
            return png_bytes(np.repeat(np.repeat(img, s, axis=0), s, axis=1))

        recon_display = f"reconstructed: .pat frame × duty/255 × LED color, fps {a.fps}, frame index restarts at 0 at each step"
        prov = {"source_files": {},
                "clock": ("run log PC clock (Unix epoch); each TIFF anchored by its first DO1 pulse = the controller's first "
                          "displayed frame after the color's first trialParams; the ScanImage epoch field is not used for placement")
                         if timelines else f"TIFF epoch (PC local, UTC{a.utc_offset_h:+.0f}) + frameTimestamps_sec",
                "stimulus_source": {c: stimulus_source(c) for c in COLORS},
                "display_source": {c: ("observed: the controller's displayed-frame records (cf rows), controller clock → PC"
                                       if c in timelines and timelines[c]["steps"][0]["frames"] else recon_display) for c in COLORS},
                "scene_source": "derived from /arena/display: panel cubes colored by LED color × lit fraction × duty",
                "preview_mapping": {f"ch{ch}": {"lo": window[ch][0], "hi": window[ch][1], "downsample": "2x2 mean"} for ch in window},
                "step_lengths_s": {}, "gaps": []}
        if log is not None:
            prov["runlog"] = {"path": log["path"], "trials": len(log["trials"]), "trialParams_send_times_paired": log["sends_paired"],
                              "all_off_source": log["all_off_source"], "connector_records": len(log["connector"]),
                              "controller_frames": len(log["cf"]), "controller_clock": clock_info,
                              "duty_mismatches": [t["condition"] for t in log["trials"] if not t["duty_matches_condition"]]}
            prov["anchors"] = {c: {"first_do1_pc_ms": tl["anchor_ms"], "epoch_correction_ms": tl["epoch_correction_ms"],
                                   "display_latency_ms": tl["display_latency_ms"], "end_check_ms": tl["end_check_ms"],
                                   "t_disp_source": tl["steps"][0]["t_disp_source"]} for c, tl in timelines.items()}
            for c in COLORS:
                if c not in timelines:
                    prov["gaps"].append({"color": c, "where": "run log given but no trialParams or DO1 for this color — reconstructed"})
        counts = {}
        for run in runs:
            color = run["color"]
            tl = timelines.get(color)
            if tl:
                # logged steps in TIFF-relative seconds: the light changes at the displayed time (qc windows);
                # the stimulus marker sits at the commanded send time
                f0, anchor = run["aux0"][0], tl["anchor_ms"]
                rel = lambda t_ms: f0 + (t_ms - anchor) / 1e3  # noqa: E731
                st = tl["steps"]
                t_last = (tl["t_off_ms"] + tl["display_latency_ms"]) if tl["t_off_ms"] else st[-1]["t_disp_ms"] + a.step_s * 1e3
                bounds = [s["t_disp_ms"] for s in st] + [t_last]
                edges = [{"step": k, "duty": s["duty"], "pattern_id": s["pattern_id"], "fps": s["fps"] or a.fps,
                          "t_start_s": rel(bounds[k]), "t_end_s": rel(bounds[k + 1]), "t_cmd_s": rel(s["t_cmd_ms"]), "frames": s["frames"]}
                         for k, s in enumerate(st)]
                dur = [round((bounds[k + 1] - bounds[k]) / 1e3, 4) for k in range(len(st))]
            else:
                dur = overrides.get(color) or [a.step_s] * len(DUTIES)
                edges = step_edges(run, dur)
            prov["step_lengths_s"][color] = dur
            prov["source_files"][color] = {"tiff": str(run["path"]), "frames": len(run["frames"]), "channels": run["chans"],
                                           "channels_source": run["channels_source"], "scanFrameRate": run["frame_rate"],
                                           "logAverageFactor": run["avg"], "epoch_local": run["epoch"],
                                           "do1_pulses": len(run["aux0"]), "first_do1_s": run["aux0"][0] if run["aux0"] else None,
                                           "last_do1_s": run["aux0"][-1] if run["aux0"] else None}
            t0 = run["t0_ns"]
            put(ch_ev, t0, {"event": "acquisition_start", "color": color, "detail": f"{run['path'].name}, {len(run['frames'])} frames @ {run['frame_rate']:.2f} Hz",
                            "source": "observed (TIFF, anchored to the run log by DO1)" if tl else "observed (TIFF epoch)"})
            # baseline = frames before the first DO1 pulse
            first_do1 = run["aux0"][0] if run["aux0"] else None
            base = {ch: float(np.mean([fr["imgs"][ch].mean() for fr in run["frames"] if first_do1 is None or fr["fields"]["frameTimestamps_sec"] < first_do1] or [0.0])) for ch in run["chans"]}
            # frame-number continuity (observed)
            nums = [int(fr["fields"]["frameNumbers"]) for fr in run["frames"]]
            if any(b - a_ != 1 for a_, b in zip(nums, nums[1:])):
                prov["gaps"].append({"color": color, "where": "TIFF frameNumbers not consecutive"})
            # observed frames
            for fr in run["frames"]:
                t_ns = fr["t_ns"]
                t_rel = fr["fields"]["frameTimestamps_sec"]
                step = next((e for e in edges if e["t_start_s"] <= t_rel < e["t_end_s"]), None)
                for ch in run["chans"]:
                    put(ch_prev[ch], t_ns, img_msg(t_ns, png_bytes(downsample(to8(fr["imgs"][ch], ch)).astype(np.uint8)), f"scanimage_ch{ch}"))
                put(ch_ref, t_ns, {"color": color, "frame": int(fr["fields"]["frameNumbers"]), "t_acq_s": t_rel, "tiff": run["path"].name,
                                   "pages": fr["pages"], "channels": run["chans"], "do1_pulses_in_frame": len(fr["fields"]["aux0"]), "source": "observed"})
                qc = {"color": color, "frame": int(fr["fields"]["frameNumbers"]), "duty": step["duty"] if step else 0, "step": step["step"] if step else -1, "source": "derived from observed pixels"}
                for ch in run["chans"]:
                    m = float(fr["imgs"][ch].mean())
                    qc[f"mean_ch{ch}"] = m
                    qc[f"dmean_ch{ch}"] = m - base[ch]
                put(ch_qc, t_ns, qc)
            counts[color] = len(run["frames"])
            # stimulus (commanded or reconstructed) + display (observed or reconstructed) + scene
            pat = pats[color]
            src = stimulus_source(color)
            if not edges:
                prov["gaps"].append({"color": color, "where": "no DO1 pulses in the TIFF — no stimulus timeline"})
            scene_every = max(1, int(round(a.fps / a.scene_hz))) if a.scene_hz > 0 else 0
            for e in edges:
                ts_ns = t0 + int(e["t_start_s"] * 1e9)
                tc_ns = t0 + int(e.get("t_cmd_s", e["t_start_s"]) * 1e9)
                put(ch_stim, tc_ns, {"color": color, "wavelength_nm": LED_NM[color], "duty": e["duty"], "step": e["step"], "on": True,
                                     "pattern": f"G6_2x10_toprow_grat20_{color}_gs16", "fps": e.get("fps", a.fps),
                                     "t_rel_s": e.get("t_cmd_s", e["t_start_s"]), "source": src})
                put(ch_ev, tc_ns, {"event": "step_start", "color": color, "detail": f"duty {e['duty']} (step {e['step']})", "source": src})
                if e.get("frames"):
                    # OBSERVED: each frame the controller reports displaying, at its own (PC-mapped) time
                    put(ch_ev, ts_ns, {"event": "display_start", "color": color,
                                       "detail": f"duty {e['duty']}: first displayed frame {(ts_ns - tc_ns) / 1e6:.1f} ms after the command",
                                       "source": "observed (controller frame records)"})
                    for k, (t_ms, idx, _pid) in enumerate(e["frames"]):
                        t_ns = int(round(t_ms * 1e6))
                        frame = pat["frames"][idx % pat["num_frames"]]
                        put(ch_disp, t_ns, img_msg(t_ns, display_png(color, frame, e["duty"]), "arena_display"))
                        if scene_every and k % scene_every == 0:
                            put(ch_scene, t_ns, scene(t_ns, color, frame, e["duty"], True))
                else:
                    n_disp = int((e["t_end_s"] - e["t_start_s"]) * a.fps)
                    for k in range(n_disp):
                        t_ns = ts_ns + int(k / a.fps * 1e9)
                        frame = pat["frames"][k % pat["num_frames"]]
                        put(ch_disp, t_ns, img_msg(t_ns, display_png(color, frame, e["duty"]), "arena_display"))
                        if scene_every and k % scene_every == 0:
                            put(ch_scene, t_ns, scene(t_ns, color, frame, e["duty"], True))
            if edges:
                if tl and tl["t_off_ms"]:
                    t_off = int(round(tl["t_off_ms"] * 1e6))
                    off_src = "commanded (run log allOff send time)"
                    off_detail = f"last DO1 pulse at {run['aux0'][-1]:.3f} s; DO1 end − (allOff + latency) = {tl['end_check_ms']:+.1f} ms"
                else:
                    t_off = t0 + int(edges[-1]["t_end_s"] * 1e9)
                    off_src = "observed (DO1) / " + src
                    off_detail = f"last DO1 pulse at {run['aux0'][-1]:.3f} s"
                put(ch_stim, t_off, {"color": color, "wavelength_nm": LED_NM[color], "duty": 0, "step": -1, "on": False,
                                     "pattern": "", "fps": a.fps, "t_rel_s": (t_off - t0) / 1e9, "source": off_src})
                put(ch_ev, t_off, {"event": "allOff", "color": color, "detail": off_detail, "source": off_src})
                put(ch_scene, t_off, scene(t_off, color, None, 0, False))
                put(ch_disp, t_off, img_msg(t_off, display_png(color, np.zeros_like(pat["frames"][0]), 0), "arena_display"))
            t_end = run["frames"][-1]["t_ns"]
            put(ch_ev, t_end, {"event": "acquisition_end", "color": color, "detail": f"{len(run['frames'])} frames", "source": "observed (TIFF)"})
        if log is not None and timelines:
            for c in log["connector"]:
                put(ch_ev, int(round(c["t_ms"] * 1e6)), {"event": f"scanimage_{c['kind']}", "color": "", "detail": f"{c['command']} {c['detail']}",
                                                          "source": "commanded (run log)" if c["kind"] == "command" else "observed (run log reply)"})
        prov["frames_per_color"] = counts
        put(ch_prov, runs[0]["t0_ns"], prov)
        w.add_metadata("provenance", {k: json.dumps(v) for k, v in prov.items()})
        w.finish()

    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
    print(json.dumps({"frames_per_color": counts, "preview_mapping": prov["preview_mapping"], "step_lengths_s": prov["step_lengths_s"],
                      "do1": {c: (prov["source_files"][c]["first_do1_s"], prov["source_files"][c]["last_do1_s"], prov["source_files"][c]["do1_pulses"]) for c in prov["source_files"]},
                      "anchors": prov.get("anchors"), "controller_clock": clock_info, "gaps": prov["gaps"]}, indent=1))

    if a.layout_out:
        chans = runs[0]["chans"]
        cfg = {
            f"Image!ch{ch}": {"imageMode": {"imageTopic": f"/scanimage/preview/ch{ch}"}, "foxglovePanelTitle": f"ScanImage ch{ch} (observed, {a.preview_size}px preview)"} for ch in chans}
        cfg.update({
            "Image!display": {"imageMode": {"imageTopic": "/arena/display"},
                              "foxglovePanelTitle": "Arena display (controller-reported frames × .pat × duty)" if any(
                                  t["steps"][0]["frames"] for t in timelines.values()) else "Arena display (RECONSTRUCTED from .pat × duty)"},
            "3D!arena": {"cameraState": {"perspective": True, "distance": 4.2, "phi": 55, "thetaOffset": 40, "targetOffset": [0, 0, 0.6], "target": [0, 0, 0], "targetOrientation": [0, 0, 0, 1], "fovy": 45, "near": 0.01, "far": 100},
                         "followTf": "arena", "scene": {"enableStats": False, "backgroundColor": "#0f1419"}, "topics": {"/arena/scene": {"visible": True}},
                         "foxglovePanelTitle": "Arena (RECONSTRUCTED panel states)"},
            "Plot!qc": {"title": "Whole-field mean minus pre-stimulus baseline (observed) + commanded duty", "showLegend": True, "legendDisplay": "floating", "xAxisVal": "timestamp",
                        "paths": [{"value": f"/scanimage/qc.dmean_ch{ch}", "enabled": True, "timestampMethod": "receiveTime", "label": f"ch{ch} Δmean (ADU)"} for ch in chans]
                        + [{"value": "/arena/stimulus.duty", "enabled": True, "timestampMethod": "receiveTime", "label": "duty (0–255)"}]},
            "StateTransitions!color": {"paths": [{"value": "/arena/stimulus.color", "timestampMethod": "receiveTime", "label": "LED color"}], "isSynced": True},
            "RawMessages!events": {"topicPath": "/run/events", "diffEnabled": False, "diffMethod": "custom", "diffTopicPath": "", "showFullMessageForDiff": False, "expansion": "all"},
            "RawMessages!prov": {"topicPath": "/run/provenance", "expansion": "all", "diffEnabled": False, "diffMethod": "custom", "diffTopicPath": "", "showFullMessageForDiff": False},
        })
        img_ids = [f"Image!ch{ch}" for ch in chans]
        layout = {"configById": cfg, "globalVariables": {}, "userNodes": {}, "playbackConfig": {"speed": 1.0},
                  "layout": {"direction": "row", "splitPercentage": 58,
                             "first": {"direction": "column", "splitPercentage": 55,
                                       "first": {"direction": "row", "splitPercentage": 50, "first": img_ids[0], "second": img_ids[1] if len(img_ids) > 1 else "Image!display"},
                                       "second": {"direction": "row", "splitPercentage": 50, "first": "Image!display", "second": "3D!arena"}},
                             "second": {"direction": "column", "splitPercentage": 45, "first": "Plot!qc",
                                        "second": {"direction": "column", "splitPercentage": 25, "first": "StateTransitions!color",
                                                   "second": {"direction": "row", "splitPercentage": 55, "first": "RawMessages!events", "second": "RawMessages!prov"}}}}}
        Path(a.layout_out).write_text(json.dumps(layout, indent=2), encoding="utf-8")
        print(f"wrote layout {a.layout_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
