"""Check a .viz.mcap against its run: /viz/arena/index vs /arena/frame idx and /viz/fictrac/heading_deg
vs FicTrac col 17, message by message — values, and time difference on the run's timeline."""
import bisect
import json
import math
import statistics
import struct
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parent.parent)]  # tools/ or scratch layout
from foxglove_json import cdr_string, read_messages  # noqa: E402
from mcap.reader import make_reader  # noqa: E402

ok = True
for orig_dir, viz in zip(sys.argv[1::2], sys.argv[2::2]):
    orig, _ = read_messages(next(Path(orig_dir).glob("*.mcap")))
    fr = [(lt, json.loads(cdr_string(d))) for t, _s, lt, _p, _q, d in orig if t == "/arena/frame"]
    ft = [(lt, json.loads(cdr_string(d))) for t, _s, lt, _p, _q, d in orig if t == "/fictrac/raw"]
    with open(viz, "rb") as f:
        r = make_reader(f)
        st = r.get_summary().statistics
        v = {}
        for _, ch, m in r.iter_messages(log_time_order=False):
            v.setdefault(ch.topic, []).append(m)
    out = [f"{Path(viz).name}: {st.message_count} msgs, {len(st.channel_message_counts)} topics"]

    def check(name, viz_msgs, src, want_of, tol):
        """Each viz message vs the source message nearest in time: value equal, |dt| reported.
        (A viz message whose input viz_node missed simply has no exact partner.)"""
        if not src or not viz_msgs:
            return True
        ts = [lt for lt, _ in src]
        bad, dts = 0, []
        for m in viz_msgs:
            i = bisect.bisect_left(ts, m.log_time)
            j = min((k for k in (i - 1, i) if 0 <= k < len(ts)), key=lambda k: abs(ts[k] - m.log_time))
            dts.append(abs(ts[j] - m.log_time) / 1e6)
            if abs(struct.unpack_from("<d", m.data, 4)[0] - want_of(src[j][1])) > tol:
                bad += 1
        dts.sort()
        out.append(f"{name} {len(viz_msgs)}/{len(src)} value mismatches {bad}; |dt| median {statistics.median(dts):.2f} "
                   f"p99 {dts[int(0.99 * (len(dts) - 1))]:.2f} max {dts[-1]:.2f} ms")
        return bad == 0

    ok &= check("index", v.get("/viz/arena/index", []), fr, lambda o: o["idx"], 0)
    ok &= check("heading", v.get("/viz/fictrac/heading_deg", []), ft,
                lambda o: math.degrees(float(o["raw"].split(",")[17])) % 360.0, 1e-6)
    print("  ".join(out))
sys.exit(0 if ok else 1)
