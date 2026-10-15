"""Check a Foxglove JSON copy against its source bag: indexed, same messages per topic, same
times, same recorded fields, parseable strict JSON, and the layout's paths present."""
import json
import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from foxglove_json import cdr_string, read_messages  # noqa: E402
from mcap.reader import make_reader  # noqa: E402

LAYOUT = ["idx", "hd", "turning_dps", "forward_mms", "bias_deg", "epoch"]


def strict(s):
    return json.loads(s, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))


ok = True
for src_dir, dst in zip(sys.argv[1::2], sys.argv[2::2]):
    src = next(Path(src_dir).glob("*.mcap"))
    orig, torn = read_messages(src)
    with open(dst, "rb") as f:
        r = make_reader(f)
        summ = r.get_summary()
        assert summ is not None and summ.chunk_indexes, "copy is not indexed"
        copy = [(ch.topic, m.log_time, m.publish_time, strict(m.data)) for sc, ch, m in r.iter_messages(log_time_order=False)]
        schemas = {s.name: json.loads(s.data) for s in summ.schemas.values()}
    oc = Counter(t for t, *_ in orig)
    cc = Counter(t for t, *_ in copy)
    # pair by (topic, log_time, publish_time, occurrence) and compare every recorded field
    from collections import defaultdict
    by = defaultdict(list)
    for t, _s, lt, pt, _q, data in orig:
        by[(t, lt, pt)].append(json.loads(cdr_string(data)))
    diffs = 0
    used = Counter()
    for t, lt, pt, obj in copy:
        k = (t, lt, pt)
        o = by[k][used[k]]
        used[k] += 1
        for key, v in o.items():
            if key == "raw" and key not in obj:
                continue
            w = obj.get(key)
            if isinstance(v, float) and not math.isfinite(v):
                v = None
            if w != v:
                diffs += 1
    fr = [o for t, _, _, o in copy if t == "/arena/frame"]
    ft = [o for t, _, _, o in copy if t == "/fictrac/raw"]
    br = [o for t, _, _, o in copy if t == "/arena/browser"]
    miss = {p: sum(1 for o in fr if p not in o) for p in LAYOUT}
    tdps = [o["turning_dps"] for o in fr if o.get("turning_dps") is not None]
    fmms = [o["forward_mms"] for o in fr if o.get("forward_mms") is not None]
    good = oc == cc and diffs == 0 and not any(miss.values())
    ok &= good
    print(f"{'OK ' if good else 'BAD'} {Path(dst).name}: {sum(cc.values())} msgs, counts {'equal' if oc == cc else (oc, cc)}, "
          f"field diffs {diffs}, torn source {bool(torn)}, schemas {len(schemas)}")
    if fr:
        print(f"     /arena/frame layout paths missing {miss}; turning_dps {len(tdps)}/{len(fr)} "
              f"[{min(tdps):.0f}, {max(tdps):.0f}] deg/s; forward_mms [{min(fmms):.1f}, {max(fmms):.1f}]; "
              f"idx [{min(o['idx'] for o in fr)}, {max(o['idx'] for o in fr)}]; epochs {sorted({o.get('epoch') for o in fr})}")
    if ft:
        print(f"     /fictrac/raw cols {sum(1 for o in ft if len(o.get('cols', {})) == 25)}/{len(ft)} with 25 columns, raw kept {sum('raw' in o for o in ft)}")
    if br:
        print(f"     /arena/browser msg parsed {sum('msg' in o for o in br)}/{len(br)}; types {Counter(o.get('msg', {}).get('type') for o in br).most_common(6)}")
sys.exit(0 if ok else 1)
