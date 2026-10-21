#!/usr/bin/env python3
"""test_stimulus.py — the camera + G6 dashboard's pure parts, no ROS graph needed.

    pixi run test-stimulus

  * arena_display: the Python port of js/panel-color.js, pinned to the JS module cell by cell
    (run under the root env's Node; SKIP without it), the renderer (orientation, duty, off LEDs),
    the PNG encoder;
  * stimulus_core: the expected/observed frame, lag, display rate and health on synthetic rows
    (CW → CCW pair, u32 clock wrap, a skipped frame, refusals, an error glyph, staleness) and on
    a REAL trial (tests/fixtures/okey_smoke_violet_cw.jsonl.gz: the 2026-10-14 smoke run's violet
    CW trial on the 2×10 four-color bench arena, 80 fps, ring telemetry);
  * bias_health; tools/ufmf.py on a synthetic BIAS-layout movie (indexed, unindexed, torn);
  * foxglove_json.py --stimulus end to end on a small MCAP bag built from the fixture.
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parent
sys.path.insert(0, str(ROOT / "nodes"))
sys.path.insert(0, str(ROOT / "tools"))

import arena_display as AD  # noqa: E402
import stimulus_core as SC  # noqa: E402
from bias_health import CountRate, bias_drops  # noqa: E402
from ufmf import UfmfReader  # noqa: E402

failures = 0
PAT_DIR = REPO / "protocols" / "g6_color_optomotor_test_patterns"
VIOLET = "G6_2x10_toprow_grat20_violet"
FIXTURE = HERE / "fixtures" / "okey_smoke_violet_cw.jsonl.gz"
FIXTURE_PROTOCOLS = HERE / "fixtures" / "protocols-2026-10-14"


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def skip(name: str, why: str) -> None:
    print(f"SKIP  {name}  ({why})")


def find_node() -> str | None:
    n = shutil.which("node")
    if n:
        return n
    for root in (REPO, *REPO.parents[:3]):
        env = root / ".pixi" / "envs" / "default"
        for cand in ((env / "node.exe", env / "bin" / "node.exe") if os.name == "nt" else (env / "bin" / "node",)):
            if cand.exists():
                return str(cand)
    return None


# ── 1. panel colors: the Python port == js/panel-color.js ─────────────────────
node = find_node()
if node is None:
    skip("panel colors match js/panel-color.js", "no node: run `pixi install` at the repo root")
else:
    js = f"""
const P = require({json.dumps(str(REPO / 'js' / 'panel-color.js'))});
const out = {{flip: P.ROW_PARITY_FLIP, off: P.OFF_CSS, layouts: {{}}, channels: {{}}}};
for (const k of P.layoutKeys()) {{
  const cells = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
    cells.push([P.bankAt(r, c), P.channelAt(k, r, c).id, P.pixelCss(k, r, c, 1), P.pixelCss(k, r, c, 7 / 15)]);
  out.layouts[k] = {{banks: P.getLayout(k).banks, cells}};
}}
for (const [id, ch] of Object.entries(P.CHANNELS)) out.channels[id] = ch.rgb;
console.log(JSON.stringify(out));
"""
    res = subprocess.run([node, "-e", js], capture_output=True, text=True, timeout=30)
    if res.returncode != 0:
        check("js/panel-color.js runs under node", False, res.stderr.strip()[-300:])
    else:
        ref = json.loads(res.stdout)
        check("ROW_PARITY_FLIP equals the JS module's", ref["flip"] == AD.ROW_PARITY_FLIP, f"js {ref['flip']}")
        check("the OFF color equals the JS OFF_CSS", ref["off"].lower() == "#%02x%02x%02x" % AD.OFF_RGB, ref["off"])
        check("same layout keys", sorted(ref["layouts"]) == sorted(AD.LAYOUTS), f"js {sorted(ref['layouts'])}")
        check("same channel colors", all(tuple(ref["channels"][k]) == AD.CHANNEL_RGB.get(k) for k in ref["channels"]),
              json.dumps(ref["channels"]))
        bad = []
        for key, L in ref["layouts"].items():
            if tuple(L["banks"]) != AD.LAYOUTS.get(key):
                bad.append(f"{key} banks")
                continue
            for i, (bank, ch, full, seven) in enumerate(L["cells"]):
                r, c = divmod(i, 4)
                if bank != AD.bank_at(r, c):
                    bad.append(f"{key} bank({r},{c})")
                for value, gs, want in ((15, 16, full), (1, 2, full), (7, 16, seven)):
                    fr = np.zeros((4, 4), dtype=np.uint8)
                    fr[r, c] = value
                    img = AD.render_frame(fr, gs, key, 255, 1)[::-1]  # back to host rows
                    got = "rgb(%d,%d,%d)" % tuple(int(x) for x in img[r, c])
                    if got != want:
                        bad.append(f"{key} ({r},{c}) v{value}: {got} vs js {want}")
        check("every cell of every layout: bank, color at full and at 7/15, GS2 and GS16", not bad, "; ".join(bad[:6]))

# ── 2. the renderer ──────────────────────────────────────────────────────────
fr = np.zeros((40, 200), dtype=np.uint8)
fr[0, 0] = 15           # host row 0 = the BOTTOM, col 0 = left
fr[39, 199] = 15        # the top right
img = AD.render_frame(fr, 16, "four-color", 255, 2)
check("image is (rows·scale, cols·scale, 3)", img.shape == (80, 400, 3), str(img.shape))
check("host row 0 is drawn at the image bottom", tuple(img[79, 0]) == AD.CHANNEL_RGB["green"], f"{tuple(img[79, 0])}")
check("the top-right LED at the image top right (bank T1 blue)", tuple(img[0, 399]) == AD.CHANNEL_RGB["blue"], f"{tuple(img[0, 399])}")
check("an LED at 0 is drawn in the OFF color", tuple(img[40, 200]) == AD.OFF_RGB)
half = AD.render_frame(fr, 16, "four-color", 128, 1)
check("duty scales brightness (128/255)", tuple(half[39, 0]) == tuple(int(np.floor(v * 128 / 255 + 0.5)) for v in AD.CHANNEL_RGB["green"]),
      f"{tuple(half[39, 0])}")
mono = AD.render_frame(fr, 16, "g6-green", 255, 1)
check("mono layout = the legacy green ramp (153, 255, 51)", tuple(mono[39, 0]) == (153, 255, 51), f"{tuple(mono[39, 0])}")
check("dark + placeholder images have the arena's size", AD.render_dark(scale=4).shape == (160, 800, 3)
      and AD.render_placeholder(scale=4).shape == (160, 800, 3))

png = AD.png_bytes(img)
w, h = struct.unpack(">II", png[16:24])
idat = png[png.index(b"IDAT") + 4: png.index(b"IEND") - 8]
raw = zlib.decompress(idat)
rows = np.frombuffer(raw, dtype=np.uint8).reshape(h, 1 + w * 3)
check("PNG: signature, IHDR size, filter bytes 0, pixels round-trip",
      png[:8] == b"\x89PNG\r\n\x1a\n" and (w, h) == (400, 80) and not rows[:, 0].any()
      and np.array_equal(rows[:, 1:].reshape(h, w, 3), img))

pat = SC.PatternLibrary([REPO / "protocols"]).get(VIOLET)
check("the violet pattern is found by name and has 20 frames", bool(pat) and pat["num_frames"] == 20)
if pat:
    lit = AD.render_frame(pat["frames"][0], pat["gs"], "four-color", 255, 1)
    on = (lit != np.array(AD.OFF_RGB, dtype=np.uint8)).any(axis=2)
    colors = {tuple(x) for x in lit[on]}
    check("violet pattern: only violet LEDs, top panel row only", colors == {AD.CHANNEL_RGB["violet"]} and not on[20:].any(),
          f"colors {colors}, bottom lit {on[20:].sum()}")

# ── 3. stimulus_core: synthetic rows ─────────────────────────────────────────
check("trialParams request decode (+80)", SC.parse_trial_params_req("0204005000000000") == (2, 4, 80, 0))
check("trialParams request decode (−80, init 7)", SC.parse_trial_params_req("020400b0ff070000") == (2, 4, -80, 7))
check("wrap_diff", SC.wrap_diff(19, 20) == -1 and SC.wrap_diff(-19, 20) == 1 and SC.wrap_diff(3, 20) == 3)

tmp = Path(tempfile.mkdtemp(prefix="stim-test-"))
(tmp / "pair.yaml").write_text(f"""version: 3
conditions:
  - name: "violet_pair"
    commands:
      - type: "plugin"
        plugin_name: "camera"
        command_name: "getTimestamp"
      - {{type: "controller", command_name: "trialParams", pattern: "{VIOLET}", pattern_ID: 1, duration: 2, mode: 2, frame_index: 0, frame_rate: 80, gain: 0, duty: 128}}
      - {{type: "wait", duration: 2}}
      - {{type: "controller", command_name: "trialParams", pattern: "{VIOLET}", pattern_ID: 1, duration: 2, mode: 2, frame_index: 0, frame_rate: -80, gain: 0, duty: 128}}
      - {{type: "wait", duration: 2}}
""", encoding="utf-8")


def run_trial(tr, t0_us, host0_ms, fps, n_cf, latency_ms=1.0, batch=8, skip_at=None, req=None, pid=4):
    """Controller rows for one mode-2 trial: the cc trialParams at t0, then n_cf frame changes,
    drained in batches whose LAST row is `latency_ms` old when it arrives (as a real drain: the
    newest row of a batch was recorded just before the read)."""
    req = req or ("0204" + "00" + (fps & 0xFFFF).to_bytes(2, "little").hex() + "000000")
    tr.feed({"type": "rows", "rows": [["cc", host0_ms + latency_ms, t0_us % SC.U32, 1, 8, 0, req]]}, host0_ms + latency_ms)
    host_of = []
    rows = []
    for k in range(n_cf):
        t = t0_us + 3000 + round(k * 1e6 / abs(fps))
        idx = (k if fps > 0 else -k) % 20
        if skip_at is not None and k >= skip_at:
            idx = (idx + 3) % 20
        h = host0_ms + (t - t0_us) / 1000.0
        rows.append(["cf", 0, t % SC.U32, 100 + k, idx, pid, 160, 232, 600, 0, 3])
        host_of.append(h)
        if len(rows) == batch or k == n_cf - 1:
            rx = h + latency_ms
            for r in rows:
                r[1] = rx
            tr.feed({"type": "rows", "rows": rows}, rx)
            rows = []
    return host_of


tr = SC.StimulusTracker(SC.PatternLibrary([REPO / "protocols"]), SC.ProtocolIndex([tmp]))
check("never seen → WARN", tr.health(0)["level"] == SC.WARN)
tr.feed({"type": "log", "event": "run_metadata", "protocol_filename": "pair.yaml", "telemetry": "ring-10hz", "run_id": "t1"}, 1000)
tr.feed({"type": "log", "event": "runner", "phase": "sequence-start", "total": 3}, 1000)
tr.feed({"type": "log", "event": "runner", "phase": "step-start", "index": 0, "condition": "violet_pair"}, 1001)
h = tr.health(1500)
check("run open, no telemetry yet → WARN", h["level"] == SC.WARN and "telemetry" in h["message"], h["message"])
tr.feed({"type": "log", "event": "runner", "phase": "trial-running", "params": {"mode": 2, "patternId": 4, "frameRate": 80, "initPos": 0, "duty": 128},
         "durationSec": 2, "condition": "violet_pair", "status": 0, "ok": True}, 2000)
st = tr.stimulus()
check("trial-running → pattern NAME from the protocol (1st trialParams), 20 frames, duty 128",
      st["state"] == "trial" and st["pattern"] == VIOLET and st["n_frames"] == 20 and st["duty"] == 128 and st["pattern_found"], json.dumps(st))
lags = []
T0 = 5_000_000
host = run_trial(tr, T0, 2000, 80, 160)
check("CW: lag 0 on every displayed frame", tr.lag == 0, f"lag {tr.lag}")
check("CW: display rate ≈ 80 Hz", abs(tr.rate_hz - 80) < 1.0, f"{tr.rate_hz}")
e = [tr.expected_index(hh) for hh in host[-20:]]
check("expected index at host time = the controller's frame (via the clock offset)", e == [k % 20 for k in range(140, 160)], f"{e[:6]}")
h = tr.health(host[-1] + 60)
check("CW: health OK, names the pattern, rate and lag", h["level"] == SC.OK and VIOLET in h["message"] and "lag +0" in h["message"], h["message"])
# CCW straight after (no allOff in between: Grace's pair)
tr.feed({"type": "log", "event": "runner", "phase": "trial-running", "params": {"mode": 2, "patternId": 4, "frameRate": -80, "initPos": 0, "duty": 128},
         "durationSec": 2, "condition": "violet_pair", "status": 0, "ok": True}, 4000)
check("CCW: the 2nd trialParams of the step → its pattern name", tr.stimulus()["pattern"] == VIOLET and tr.stimulus()["fps"] == -80)
run_trial(tr, T0 + 2_000_000, 4000, -80, 160)
check("CCW: lag 0 counting down", tr.lag == 0 and abs(tr.rate_hz - 80) < 1.0, f"lag {tr.lag} rate {tr.rate_hz}")
# a frame stream 3 frames ahead of schedule
run_trial(tr, T0 + 4_000_000, 6000, -80, 160, skip_at=100)
h = tr.health(6000 + 2100)
check("frames off schedule → lag −/+3 and WARN", abs(tr.lag) == 3 and h["level"] == SC.WARN and "off schedule" in h["message"], f"{tr.lag} {h['message']}")
# u32 wrap of the controller clock mid-trial
tr2 = SC.StimulusTracker(SC.PatternLibrary([REPO / "protocols"]), SC.ProtocolIndex([tmp]))
tr2.feed({"type": "log", "event": "run_metadata", "protocol_filename": "pair.yaml", "telemetry": "ring-10hz"}, 1000)
tr2.feed({"type": "log", "event": "runner", "phase": "step-start", "condition": "violet_pair"}, 1001)
tr2.feed({"type": "log", "event": "runner", "phase": "trial-running", "params": {"mode": 2, "patternId": 4, "frameRate": 80, "initPos": 0, "duty": 255},
          "condition": "violet_pair", "status": 0, "ok": True}, 2000)
run_trial(tr2, SC.U32 - 1_000_000, 2000, 80, 200)
check("controller clock wraps (u32 µs) mid-trial: lag stays 0, rate 80", tr2.lag == 0 and abs(tr2.rate_hz - 80) < 1.0, f"{tr2.lag} {tr2.rate_hz}")
# routine refusal of a non-display command is NOT an error; a refused trialParams is
tr2.feed({"type": "rows", "rows": [["cc", 4600, 1_700_000, 9, 0x84, 10, ""]]}, 4600)
check("a refused SD/info command (0x84 status 10) is counted, not an ERROR", tr2.health(4600)["level"] != SC.ERROR and tr2.refused_other == 1)
check("stale: no frames for > 2 s while a pattern plays → STALE", tr2.health(2000 + 2600 + 3000)["level"] == SC.STALE,
      tr2.health(7600)["message"])
tr2.feed({"type": "log", "event": "runner", "phase": "command", "op": "allOff", "condition": "dark"}, 8000)
h = tr2.health(8001)
check("allOff → dark, OK (no STALE in the dark)", tr2.state == "dark" and h["level"] == SC.OK and tr2.expected_index(8001) is None, h["message"])
tr2.feed({"type": "rows", "rows": [["cs", 8100, 1_900_000, 10, 3, 2, 0]]}, 8100)
check("an error glyph → ERROR", tr2.health(8101)["level"] == SC.ERROR)
check("…for 10 s, then back to OK", tr2.health(8100 + 10_500)["level"] == SC.OK)
tr2.feed({"type": "rows", "rows": [["cc", 20000, 2_000_000, 11, 8, 3, "0204005000000000"]]}, 20000)
check("a refused trialParams → ERROR", tr2.health(20001)["level"] == SC.ERROR)

# ── 4. stimulus_core on the REAL trial ───────────────────────────────────────
if not FIXTURE.exists():
    check("fixture present", False, str(FIXTURE))
else:
    recs = [json.loads(line) for line in gzip.open(FIXTURE, "rt")]
    tr = SC.StimulusTracker(SC.PatternLibrary([REPO / "protocols"]), SC.ProtocolIndex([FIXTURE_PROTOCOLS]))
    tr.frame_log = []
    lags, levels, names, rate_end = [], set(), set(), None
    for r in recs:
        tr.feed_record(r)
        if tr.state == "trial":
            names.add(tr.stimulus()["pattern"])
            levels.add(tr.health(r["rx_ms"])["level_name"])
            if tr.rate_hz:
                rate_end = tr.rate_hz
        for t, idx, pid, lag in tr.frame_log:
            if pid == 4 and lag is not None:
                lags.append(lag)
        tr.frame_log.clear()
    check("real trial: pattern name resolved from the protocol", names == {VIOLET}, str(names))
    check("real trial: ≥ 790 frames judged, every lag 0", len(lags) >= 790 and set(lags) == {0}, f"{len(lags)} frames, lags {sorted(set(lags))}")
    check("real trial: display rate 80 Hz", rate_end is not None and abs(rate_end - 80) < 1.0, str(rate_end))
    check("real trial: health never ERROR/STALE during the trial", not ({"ERROR", "STALE"} & levels), str(levels))
    check("real trial: dark after the ITI's allOff", tr.state == "dark")

# ── 5. bias_health ───────────────────────────────────────────────────────────
cr = CountRate(2.0)
vals = [cr.add(t / 5.0, 30 * t / 5.0) for t in range(20)]
check("CountRate: 30 fps from a counter polled at 5 Hz", abs(vals[-1] - 30.0) < 1e-6, str(vals[-1]))
check("CountRate: a new recording (counter back to 0) restarts the window",
      cr.add(4.2, 0) is None and abs(cr.add(4.6, 12) - 30.0) < 1e-6)
check("bias_drops: None when BIAS reports no counters", bias_drops({"frameCount": 5}) is None)
check("bias_drops: the sum of the counters it reports", bias_drops({"frameIdGaps": 2, "writerSkipped": 1, "cameraSkipped": 0}) == 3.0)


# ── 6. tools/ufmf.py on a synthetic BIAS-layout movie ────────────────────────
def write_ufmf(path: Path, frames, bg, indexed=True, torn=False) -> None:
    """BIAS's VideoWriter_ufmf layout (version 4, MONO8, index_loc past the chunk id)."""
    H, W = bg.shape
    b = bytearray(b"ufmf" + struct.pack("<IQHHBB", 4, 0, W, H, 0, 5) + b"MONO8")
    kf_locs, kf_ts, locs, ts = [len(b)], [0.0], [], []
    b += bytes([0, 4]) + b"mean" + b"B" + struct.pack("<HHd", W, H, 0.0) + bg.tobytes()
    for t, boxes in frames:
        locs.append(len(b))
        ts.append(t)
        b += bytes([1]) + struct.pack("<dI", t, len(boxes))
        for x, y, px in boxes:
            b += struct.pack("<HHHH", x, y, px.shape[1], px.shape[0]) + px.tobytes()
    if indexed:
        b += bytes([2])
        loc = len(b)

        def arr(dt, a):
            return b"a" + dt + struct.pack("<I", len(a)) + a

        def key(k):
            return struct.pack("<H", len(k)) + k

        b += b"d" + bytes([2])
        b += key(b"frame") + b"d" + bytes([2]) + key(b"loc") + arr(b"q", np.asarray(locs, "<u8").tobytes()) \
            + key(b"timestamp") + arr(b"d", np.asarray(ts, "<f8").tobytes())
        b += key(b"keyframe") + b"d" + bytes([1]) + key(b"mean") + b"d" + bytes([2]) \
            + key(b"loc") + arr(b"q", np.asarray(kf_locs, "<u8").tobytes()) + key(b"timestamp") + arr(b"d", np.asarray(kf_ts, "<f8").tobytes())
        b[8:16] = struct.pack("<Q", loc)
    if torn:
        b = b[:-7]
    path.write_bytes(bytes(b))


bg = np.full((30, 40), 50, dtype=np.uint8)
frames = [(0.01 * i, [(i, 2, np.full((3, 4), 200 + i, dtype=np.uint8))]) for i in range(30)]
for label, kw in (("indexed", {}), ("no index (BIAS killed)", {"indexed": False}), ("torn tail, no index", {"indexed": False, "torn": True})):
    p = tmp / f"m_{label[:4]}.ufmf"
    write_ufmf(p, frames, bg, **kw)
    with UfmfReader(p) as u:
        n_expect = 29 if kw.get("torn") else 30
        t5, f5 = u.frame(5)
        ok = (u.n_frames == n_expect and u.indexed == (not kw.get("indexed") is False) and (u.width, u.height) == (40, 30)
              and abs(t5 - 0.05) < 1e-12 and f5[2:5, 5:9].min() == 205 and f5[0, 0] == 50 and f5[2, 4] == 50)
        check(f"ufmf {label}: frames, timestamps, boxes pasted on the mean background", ok,
              f"n {u.n_frames} indexed {u.indexed} t5 {t5}")

# ── 7. foxglove_json.py --stimulus end to end on a small bag ─────────────────
try:
    from mcap.reader import make_reader
    from mcap.writer import Writer

    import foxglove_json as FJ

    def cdr_string(text: str) -> bytes:
        body = text.encode() + b"\x00"
        data = b"\x00\x01\x00\x00" + struct.pack("<I", len(body)) + body
        return data + b"\x00" * (-len(data) % 4)

    recs = [json.loads(line) for line in gzip.open(FIXTURE, "rt")]
    t0 = recs[0]["rx_ms"]
    movie = tmp / "run_cam_0_v001.ufmf"
    cam_frames = [(0.05 * i, [(0, 0, np.full((2, 2), i % 250, dtype=np.uint8))]) for i in range(int(13 / 0.05))]
    write_ufmf(movie, cam_frames, bg)
    bag = tmp / "run.mcap"
    with open(bag, "wb") as f:
        w = Writer(f)
        w.start()
        sid = w.register_schema("std_msgs/msg/String", "ros2msg", b"string data")
        ch = {t: w.register_channel(t, "cdr", sid) for t in ("/arena/browser", "/bias/status", "/bias/reply")}
        msgs = [("/arena/browser", r["rx_ms"], r) for r in recs]
        for k in range(0, 13 * 5):  # BIAS status at 5 Hz, 25 fps, recording
            ms = t0 + k * 200
            msgs.append(("/bias/status", ms, {"reachable": True, "capturing": True, "logging": True, "frameCount": k * 5,
                                              "framesPerSec": 25.0, "t_ms": ms, "rtt_ms": 0.6, "frameIdGaps": 0 if k < 30 else 2}))
        # BIAS clock = bridge ms − (t0 + 1000): frame ts 0 s is at bridge t0 + 1 s
        for k in range(1, 4):
            ms = t0 + 1000 + k * 3000
            msgs.append(("/bias/reply", ms, {"command": "getTimestamp", "ok": True, "value": k * 3.0, "t_ms": ms - 1, "rx_epoch_ms": ms + 1}))
        msgs.append(("/bias/reply", t0 + 12500, {"command": "stopRecording", "ok": True, "artifact": {"kind": "video", "path": str(movie)}}))
        for topic, ms, obj in sorted(msgs, key=lambda m: m[1]):
            w.add_message(ch[topic], log_time=int(ms * 1e6), publish_time=int(ms * 1e6), data=cdr_string(json.dumps(obj)))
        w.finish()
    out = tmp / "run.foxglove.mcap"
    rep = FJ.convert(bag, out, 9.0, False,
                     {"patterns": [str(REPO / "protocols")], "protocols": [str(FIXTURE_PROTOCOLS)], "layout": "four-color", "display_hz": 10, "scale": 2},
                     {"ufmf": "auto", "hz": 10, "factor": 1})
    got: dict = {}
    schema_of = {}
    with open(out, "rb") as f:
        for sch, chn, m in make_reader(f).iter_messages():
            got.setdefault(chn.topic, []).append((m.log_time, json.loads(m.data)))
            schema_of[chn.topic] = sch.name
    topics = rep["topics"]
    check("replay: /arena/display + _observed as foxglove.CompressedImage",
          schema_of.get("/arena/display") == "foxglove.CompressedImage" and schema_of.get("/arena/display_observed") == "foxglove.CompressedImage"
          and topics.get("/arena/display", 0) >= 90, json.dumps({k: v for k, v in topics.items() if "display" in k}))
    lagv = [o["data"] for _, o in got.get("/viz/arena/lag_frames", [])]
    check("replay: lag samples present, all 0", len(lagv) > 700 and set(lagv) == {0}, f"{len(lagv)} {sorted(set(lagv))[:5]}")
    states = [o["data"] for _, o in got.get("/viz/arena/state", [])]
    check("replay: state transitions dark → trial → dark", "trial" in states and states[-1] == "dark", str(states))
    cam = got.get("/camera/image", [])
    cam_rep = rep.get("dashboard", {}).get("camera", {})
    first_ns = cam[0][0] if cam else None
    check("replay: camera images from the run's uFMF (found via stopRecording), ~10 Hz",
          schema_of.get("/camera/image") == "foxglove.CompressedImage" and 120 <= len(cam) <= 131, f"{len(cam)} {json.dumps(cam_rep)}")
    check("replay: camera frame 0 placed on the bridge clock by the getTimestamp replies",
          first_ns is not None and abs(first_ns / 1e6 - (t0 + 1000)) < 1.0, f"{first_ns and first_ns / 1e6 - t0}")
    fpsc = [o["data"] for _, o in got.get("/viz/bias/fps_from_count", [])]
    drops = [o["data"] for _, o in got.get("/viz/bias/drops", [])]
    check("replay: BIAS fps_from_count ≈ 25 and drops 0 → 2", fpsc and abs(fpsc[-1] - 25.0) < 0.01 and drops[0] == 0 and drops[-1] == 2,
          f"{fpsc[-1:] } {drops[:1]} {drops[-1:]}")
except ImportError as exc:
    skip("foxglove_json --stimulus end to end", f"{exc}")

# ── 8. the layout references only topics something publishes ─────────────────
layout = json.loads((ROOT / "foxglove" / "arena-okey-cokey.json").read_text(encoding="utf-8"))
paths = []
for cfg in layout["configById"].values():
    for k in ("path", "topicPath", "topicToRender"):
        if cfg.get(k):
            paths.append(cfg[k])
    for p in cfg.get("paths", []):
        paths.append(p["value"])
    if cfg.get("imageMode"):
        paths.append(cfg["imageMode"]["imageTopic"])
topics = {p.split(".")[0] for p in paths}
known = {"/camera/image", "/arena/display", "/arena/display_observed", "/arena/stimulus", "/diagnostics", "/bias/reply"} \
    | {f"/viz/arena/{k}" for k in ("expected_idx", "observed_idx", "display_rate_hz", "lag_frames", "cmd_fps", "ok", "state", "condition", "health")} \
    | {f"/viz/bias/{k}" for k in ("fps", "fps_from_count", "frame_count", "drops", "rtt_ms", "log_queue", "reachable", "capturing", "logging", "state")}
check("layout: every panel topic is one the nodes / the replay publish", topics <= known, str(sorted(topics - known)))

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'PASS' if not failures else 'FAIL'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
