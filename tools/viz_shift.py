"""viz_shift.py — put a viz_node replay capture onto the original run's timeline.

    python viz_shift.py <capture bag dir> <original bag dir> <out.viz.mcap>

The capture (viz_capture.py) recorded viz_node's outputs plus the played-back /arena/frame and
/bias/status at REPLAY time. Each played-back message is byte-identical to one in the original
bag, so offset = original log_time − capture log_time for every matched message; the median is
applied to every viz message (log_time and publish_time) and the spread is reported. The two
alignment topics are dropped (the run's own copy carries them). Output: chunked, zstd, indexed,
ros2msg schemas + CDR as recorded — Foxglove decodes it natively, `.data` paths as live.
"""
import json
import statistics
import struct
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parent.parent)]  # tools/ or scratch layout
from foxglove_json import cdr_string, read_messages  # noqa: E402
from mcap.reader import make_reader  # noqa: E402
from mcap.writer import CompressionType, Writer  # noqa: E402

ALIGN = ("/arena/frame", "/bias/status")


def main() -> int:
    cap_dir, orig_dir, dst = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    orig, _ = read_messages(next(orig_dir.glob("*.mcap")))
    when = {}
    for topic, _s, log_t, _p, _q, data in orig:
        if topic in ALIGN:
            when.setdefault((topic, bytes(data)), log_t)
    cap_file = next(cap_dir.glob("*.mcap"))
    with open(cap_file, "rb") as f:
        r = make_reader(f)
        summ = r.get_summary()
        msgs = [(sc, ch, m) for sc, ch, m in r.iter_messages(log_time_order=True)]
    offs = {t: [] for t in ALIGN}  # (capture log_time, offset) per matched played-back message
    for sc, ch, m in msgs:
        if ch.topic in ALIGN and (ch.topic, bytes(m.data)) in when:
            offs[ch.topic].append((m.log_time, when[(ch.topic, bytes(m.data))] - m.log_time))
    anchors = offs["/arena/frame"] or offs["/bias/status"]
    if not anchors:
        sys.exit("no played-back message matched the original bag")
    use = [o for _, o in anchors]
    off = int(statistics.median(use))
    q = statistics.quantiles(use, n=20) if len(use) >= 20 else [min(use), max(use)]
    spread_ms = ((q[0] - off) / 1e6, (q[-1] - off) / 1e6)
    # ros2 bag play's pacing jitters (± several ms on Windows), so one median offset leaves that
    # jitter in the viz times. Each event-driven viz message is published within ~1 ms of the
    # played-back input that triggered it, so take the offset of the NEAREST anchor (within
    # 20 ms); timer-driven ones far from any anchor (markers between frames, diagnostics during
    # gaps) fall back to the median.
    at = [t for t, _ in anchors]
    import bisect

    def offset_for(t: int) -> tuple[int, bool]:
        i = bisect.bisect_left(at, t)
        best = min((j for j in (i - 1, i) if 0 <= j < len(at)), key=lambda j: abs(at[j] - t))
        return (anchors[best][1], True) if abs(at[best] - t) <= 20_000_000 else (off, False)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Exact times where possible: viz_node publishes ONE message per input message on these
    # topics (from that input's callback), in order, so when the counts agree the k-th output
    # gets the ORIGINAL receive time of the k-th input. Values were checked to line up.
    by_input = {"/fictrac/raw": ["heading_deg", "turn_deg", "speed_dps", "fwd_rad", "side_rad", "fwd_dps", "side_dps"],
                "/arena/frame": ["index", "azimuth_deg", "display_deg", "bias_deg"],
                "/bias/status": ["frame_count", "fps", "reachable", "capturing", "logging", "state"],
                "/kinefly/raw": ["left_deg", "right_deg", "lmr_deg", "wbf_hz"]}
    prefix = {"/fictrac/raw": "/viz/fictrac/", "/arena/frame": "/viz/arena/", "/bias/status": "/viz/bias/",
              "/kinefly/raw": "/viz/kinefly/"}
    in_times = {}
    for topic, _s, log_t, _p, _q, _d in orig:
        if topic in by_input:
            in_times.setdefault(topic, []).append(log_t)
    viz_counts = {}
    for _sc, ch, _m in msgs:
        viz_counts[ch.topic] = viz_counts.get(ch.topic, 0) + 1
    exact = {}
    for inp, names in by_input.items():
        for n in names:
            t = prefix[inp] + n
            if t in viz_counts and viz_counts[t] == len(in_times.get(inp, [])):
                exact[t] = in_times[inp]
            elif t in viz_counts and viz_counts[t] == len(in_times.get(inp, [])) - 1:
                exact[t] = in_times[inp][1:]  # rates: published from the second input on
    # Where viz_node MISSED inputs during playback (its /arena/frame subscription keeps 10), the
    # counts differ: align by sequence instead. Walk the played-back frames (captured here, each
    # mapped to its original time) in order and give each /viz/arena/index message the first
    # not-yet-used frame published no later than 5 ms after it whose idx equals its value; the
    # group's other topics (azimuth, bias — same callback, same order) share that mapping.
    played = [(m.log_time, when[(ch.topic, bytes(m.data))], float(json.loads(cdr_string(m.data))["idx"]))
              for _sc, ch, m in msgs if ch.topic == "/arena/frame" and (ch.topic, bytes(m.data)) in when]
    aligned = {}
    group = [prefix["/arena/frame"] + n for n in by_input["/arena/frame"]]
    if played and "/viz/arena/index" in viz_counts and not any(t in exact for t in group):
        p, times = 0, []
        for _sc, ch, m in msgs:
            if ch.topic != "/viz/arena/index":
                continue
            v, lim, j = struct.unpack_from("<d", m.data, 4)[0], m.log_time + 5_000_000, p
            while j < len(played) and played[j][0] <= lim and played[j][2] != v:
                j += 1
            if j < len(played) and played[j][0] <= lim:
                times.append(played[j][1])
                p = j + 1
            else:
                times.append(None)
        for t in group:
            if viz_counts.get(t) == len(times):
                aligned[t] = times
    seen = {}
    counts, anchored, n_aligned = {}, 0, 0
    with open(dst, "wb") as f:
        w = Writer(f, compression=CompressionType.ZSTD)
        w.start(profile="ros2", library="ros2-poc viz_shift.py")
        smap, cmap = {}, {}
        # Register every captured channel up front, including ones with no messages (e.g.
        # /viz/last_error when nothing failed, the Kinefly topics on a run without Kinefly), so
        # the topic list matches the live graph.
        for ch in sorted(summ.channels.values(), key=lambda c: c.id):
            if ch.topic in ALIGN:
                continue
            sc = summ.schemas[ch.schema_id]
            if sc.id not in smap:
                smap[sc.id] = w.register_schema(name=sc.name, encoding=sc.encoding, data=sc.data)
            cmap[ch.id] = w.register_channel(topic=ch.topic, message_encoding=ch.message_encoding,
                                             schema_id=smap[sc.id], metadata=dict(ch.metadata))
        for sc, ch, m in msgs:
            if ch.topic in ALIGN:
                continue
            if sc.id not in smap:
                smap[sc.id] = w.register_schema(name=sc.name, encoding=sc.encoding, data=sc.data)
            if ch.id not in cmap:
                cmap[ch.id] = w.register_channel(topic=ch.topic, message_encoding=ch.message_encoding,
                                                 schema_id=smap[sc.id], metadata=dict(ch.metadata))
            k = seen.get(ch.topic, 0)
            seen[ch.topic] = k + 1
            if ch.topic in exact:
                o = exact[ch.topic][k] - m.log_time
            elif ch.topic in aligned and aligned[ch.topic][k] is not None:
                o = aligned[ch.topic][k] - m.log_time
                n_aligned += 1
            else:
                o, near = offset_for(m.log_time)
                anchored += near
            w.add_message(channel_id=cmap[ch.id], log_time=m.log_time + o, publish_time=m.publish_time + o,
                          sequence=m.sequence, data=m.data)
            counts[ch.topic] = counts.get(ch.topic, 0) + 1
        w.add_metadata("viz_replay", {
            "run": orig_dir.name.removesuffix(".bag"),
            "viz_node": "reiserlab/webDisplayTools PR #258 (branch claude/viz-dashboard-fixes) ros2-poc/nodes/viz_node.py @ 15d95ae, default args",
            "replay": "ros2 bag play at 1x of the original bag's /fictrac/raw /arena/frame /bias/status /bias/reply",
            "median_offset_ns": str(off), "alignment_matches": str(len(use)),
            "replay_jitter_ms_p5_p95": f"{spread_ms[0]:.2f},{spread_ms[1]:.2f}",
            "timing": ("per-input topics (" + ", ".join(sorted(set(exact) | set(aligned))) + "): the original receive "
                       "time of the input message that produced each one (by count, or by sequence + value where "
                       "viz_node missed inputs); the rest (markers, diagnostics, rate, errors): the offset of the "
                       "nearest played-back /arena/frame or /bias/status within 20 ms, else the median"),
            "messages_exact": str(sum(counts.get(t, 0) for t in exact) + n_aligned),
            "messages_total": str(sum(counts.values()))})
        w.finish()
    n_exact = sum(counts.get(t, 0) for t in exact)
    print(json.dumps({"out": dst.name, "bytes": dst.stat().st_size, "matched": len(use),
                      "replay_jitter_ms_p5_p95": [round(x, 2) for x in spread_ms],
                      "exact": f"{n_exact + n_aligned}/{sum(counts.values())}", "of_which_by_sequence": n_aligned,
                      "nearest_anchor": anchored,
                      "timer_or_unmatched_topics": sorted(t for t in counts if t not in exact and t not in aligned)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
