"""Quick look at a g6_2p_color_led_sweep run: per duty step, the mean image brightness per channel.

Reads ScanImage TIFFs with a minimal stdlib+numpy reader (uncompressed classic or BigTIFF, as
ScanImage writes them; no tifffile needed), takes each frame's absolute time from the frame header
(`epoch` = acquisition start, PC local time, + `frameTimestamps_sec`), and lines the frames up with
the duty steps in the converted run log (`arena_command` 0x08 trialParams times, same PC clock).

    python tools/led_sweep_quicklook.py <run.jsonl> <tiff_dir> <counter> [--utc-offset-h -4]

Output per color: baseline (frames before the first step), then per duty step the mean of each
channel minus baseline, and the per-frame noise (std over the step's frames) → a crude SNR.
A quick look only: whole-field means, no ROI, no motion correction.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

COLORS = ("violet", "blue", "green", "yellow")
DUTIES = (7, 15, 31, 63, 127, 255)


def read_tiff_pages(path: Path):
    """Yield (description, ndarray) per page. Uncompressed, single-sample, strips."""
    with open(path, "rb") as f:
        data = memoryview(f.read())
    bo = {b"II": "<", b"MM": ">"}[bytes(data[:2])]
    magic = struct.unpack_from(bo + "H", data, 2)[0]
    big = magic == 43
    if big:
        off = struct.unpack_from(bo + "Q", data, 8)[0]
        ent_fmt, cnt_fmt, ent_size, next_fmt = "HHQQ", "Q", 20, "Q"
    else:
        off = struct.unpack_from(bo + "I", data, 4)[0]
        ent_fmt, cnt_fmt, ent_size, next_fmt = "HHII", "H", 12, "I"
    tsz = {1: 1, 2: 1, 3: 2, 4: 4, 16: 8}
    while off:
        n = struct.unpack_from(bo + cnt_fmt, data, off)[0]
        p = off + struct.calcsize(cnt_fmt)
        tags = {}
        for i in range(n):
            tag, typ, count, val = struct.unpack_from(bo + ent_fmt, data, p + i * ent_size)
            size = tsz.get(typ, 1) * count
            inline = size <= (8 if big else 4)
            # value field follows tag (2) + type (2) + count (4 classic / 8 BigTIFF)
            vo = p + i * ent_size + 4 + (8 if big else 4) if inline else val
            if typ == 2:
                tags[tag] = bytes(data[vo:vo + count]).rstrip(b"\0").decode("latin-1")
            elif typ in (3, 4, 16):
                f = {3: "H", 4: "I", 16: "Q"}[typ]
                tags[tag] = struct.unpack_from(bo + f * count, data, vo)
        w, h = tags[256][0], tags[257][0]
        bits = tags.get(258, (16,))[0]
        fmt = tags.get(339, (1,))[0]  # 1 uint, 2 int
        dtype = np.dtype(bo + {(16, 2): "i2", (16, 1): "u2", (8, 1): "u1", (32, 2): "i4"}[(bits, fmt)])
        offs, cnts = tags[273], tags[279]
        buf = b"".join(bytes(data[o:o + c]) for o, c in zip(offs, cnts))
        yield tags.get(270, ""), np.frombuffer(buf, dtype=dtype, count=w * h).reshape(h, w)
        off = struct.unpack_from(bo + next_fmt, data, p + n * ent_size)[0]


def frame_series(path: Path, utc_offset_h: float):
    """Per page: (abs_epoch_ms, channel_index_within_frame, mean)."""
    out = []
    per_frame = {}
    for desc, img in read_tiff_pages(path):
        ts = re.search(r"frameTimestamps_sec\s*=\s*([-\d.eE+]+)", desc)
        ep = re.search(r"epoch\s*=\s*\[([^\]]+)\]", desc)
        fn = re.search(r"frameNumbers\s*=\s*(\d+)", desc)
        if not (ts and ep):
            continue
        y, mo, d, hh, mi, ss = [float(x) for x in ep.group(1).split()]
        t0 = dt.datetime(int(y), int(mo), int(d), int(hh), int(mi), tzinfo=dt.timezone(dt.timedelta(hours=utc_offset_h)))
        abs_ms = (t0.timestamp() + ss + float(ts.group(1))) * 1000.0
        k = int(fn.group(1)) if fn else len(out)
        ch = per_frame.get(k, 0)
        per_frame[k] = ch + 1
        out.append((abs_ms, ch, float(img.mean())))
    return out


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("runlog")
    a.add_argument("tiff_dir")
    a.add_argument("counter", type=int)
    a.add_argument("--utc-offset-h", type=float, default=-4.0, help="PC local time vs UTC (EDT = -4)")
    a.add_argument("--settle-s", type=float, default=0.3, help="skip this long after each step change")
    args = a.parse_args(argv)

    rows = [json.loads(l) for l in open(args.runlog, encoding="utf-8") if l.strip().startswith("{")]
    tp = [r["t"] for r in rows if r.get("event") == "arena_command" and str(r.get("head", "")).split(" ")[1:2] == ["08"]]
    offs = [r["t"] for r in rows if r.get("event") == "arena_command" and str(r.get("head", "")).split(" ")[1:2] == ["00"]]
    if len(tp) != 24:
        print(f"expected 24 trialParams, found {len(tp)}")
    for c, color in enumerate(COLORS):
        tif = Path(args.tiff_dir) / f"{color}_sweep_{args.counter:05d}.tif"
        s = frame_series(tif, args.utc_offset_h)
        if not s:
            print(f"{color}: no frame headers parsed in {tif}")
            continue
        t = np.array([x[0] for x in s]); ch = np.array([x[1] for x in s]); m = np.array([x[2] for x in s])
        steps = tp[c * 6:(c + 1) * 6]
        step_len = float(np.median(np.diff(steps))) if len(steps) > 1 else 3000.0
        end = steps[-1] + step_len
        nch = int(ch.max()) + 1
        print(f"\n{color}: {tif.name}  {len(s)} pages, {nch} channel(s), frames {(t.min() - steps[0]) / 1000:+.2f} → "
              f"{(t.max() - end) / 1000:+.2f} s vs stimulus start/end (step {step_len / 1000:.2f} s)")
        for k in range(nch):
            sel = ch == k
            base_sel = sel & (t < steps[0] - 100)
            base = m[base_sel].mean() if base_sel.any() else float("nan")
            line = [f"  ch{k + 1}: baseline {base:8.2f} (n={int(base_sel.sum())})"]
            for j, t_on in enumerate(steps):
                t_off = steps[j + 1] if j + 1 < len(steps) else end
                w = sel & (t >= t_on + args.settle_s * 1000) & (t < t_off - 100)
                if not w.any():
                    line.append(f"d{DUTIES[j]}: —")
                    continue
                d = m[w] - base
                line.append(f"d{DUTIES[j]}: {d.mean():+7.2f} (sd {m[w].std():.2f}, n={int(w.sum())})")
            print("  ".join(line[:1]))
            for x in line[1:]:
                print("      " + x)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
