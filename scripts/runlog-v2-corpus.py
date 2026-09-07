#!/usr/bin/env python3
"""runlog-v2-corpus.py — the behavior_v2 corpus gate (runlog-behavior-v2-plan.md Part 1 §4).

For EVERY run log under a course-repo clone (default: the local cshl-2026-course
checkout), convert v1 → v2 → v1 with the bridge's strict converter and assert
canonical-JSON identity line by line; record v1 / v1.gz / v2 / v2.gz sizes; and fail
on any line whose (type, event) → key set is not in the known v1 inventory (the
older July logs, legacy `_a`/`_b` protocols and `full`-level logs are exactly the
variants a handful of hand-picked samples would miss). Prints a Markdown report
(summary + per-rig + the largest files + the full per-file table) for the PR
description. Exit status 1 on any failure.

Not part of `pixi run test` (needs the clone). Run:

    pixi run python scripts/runlog-v2-corpus.py [ROOT] [--out report.md] [--workers 4]

ROOT may be the clone itself or any directory tree containing *.jsonl / *.jsonl.gz.
"""
from __future__ import annotations

import argparse
import gzip
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fictrac-bridge"))
import bridge  # noqa: E402

DEFAULT_ROOT = os.path.expanduser("~/Documents/GitHub/cshl-2026-course")
GZIP_LEVEL = 6  # ≈ what the browser's CompressionStream('gzip') produces (Part 2)

# Known v1 line shapes: (type, event) → every key ever observed for that shape
# (2026-09-06 inventory of 164 logs). A line with a key OUTSIDE this set is a new
# producer variant → the run FAILS so the converter/readers get looked at before
# anything is silently passed through. (Pass-through would still be lossless; the
# point is to notice.)
KNOWN_SHAPES = {
    ("session", "logging_started"): {"type", "event", "file", "ms"},
    ("session", "logging_stopped"): {"type", "event", "ms"},
    ("session", "bridge_start"): {"type", "event", "file", "ms"},
    ("log_control", None): {"type", "enabled", "level", "dir", "rx_ms"},
    ("frame_schema", None): {"type", "level", "cols"},
    ("config", None): {"type", "fictrac_port", "gain", "offset", "frames", "dir", "rx_ms"},
    ("fictrac_frame", None): {"type", "seq", "index", "t", "fictrac"},
    ("hello", None): {"type", "client", "v", "dir", "rx_ms"},
    ("log", "arena_command"): set(bridge.ARENA_COMMAND_KEYS),
    ("log", "run_metadata"): {
        "type", "event", "rig_id", "run_id", "experimenter", "genotype", "age", "sex", "fly_number",
        "notes", "protocol_filename", "protocol_sha256", "arena_config", "rig", "firmware",
        "controller_id", "timestamp_start", "tool_version", "dir", "rx_ms",
    },
    ("log", "runner"): {
        "type", "event", "phase", "index", "total", "condition", "op", "value", "ledPercent", "on",
        "durationSec", "params", "ledActivation", "status", "ok", "reason", "error", "dir", "rx_ms",
    },
}


def shape_of(o):
    if isinstance(o, list):
        return ("ARRAY", len(o))
    return (o.get("type"), o.get("event"))


def gz_len(data: bytes) -> int:
    return len(gzip.compress(data, compresslevel=GZIP_LEVEL, mtime=0))


def process(path: str) -> dict:
    t = time.time()
    r = {"path": path, "ok": True, "errors": [], "unknown_shapes": []}
    try:
        raw = open(path, "rb").read()
        if path.endswith(".gz"):
            raw = gzip.decompress(raw)
        objs = bridge.read_jsonl(path)
        r["fmt"] = bridge.detect_format(objs)
        r["lines"] = len(objs)
        # ── known-shape gate ────────────────────────────────────────────────
        seen = set()
        n_arena = n_frames = 0
        for o in objs:
            sh = shape_of(o)
            if sh == ("ARRAY", 7) and not isinstance(o[0], str):
                n_frames += 1
                continue
            if sh == ("log", "arena_command"):
                n_arena += 1
            if isinstance(o, list):
                r["unknown_shapes"].append(("ARRAY", len(o), str(o)[:60]))
                continue
            allowed = KNOWN_SHAPES.get(sh)
            extra = set(o) - allowed if allowed is not None else set(o)
            if allowed is None or extra:
                key = (sh, tuple(sorted(extra)))
                if key not in seen:
                    seen.add(key)
                    r["unknown_shapes"].append((sh, sorted(extra)))
        r["n_arena"], r["n_frames"], r["n_other"] = n_arena, n_frames, len(objs) - n_arena - n_frames
        # ── round trip ──────────────────────────────────────────────────────
        if r["fmt"] == "behavior_v2":
            v2, back = objs, bridge.convert_v2_to_v1(objs)
            v2 = bridge.convert_v1_to_v2(back, strict=True)
            cmp_a, cmp_b = objs, v2
        else:
            v2 = bridge.convert_v1_to_v2(objs, strict=True)
            back = bridge.convert_v2_to_v1(v2)
            cmp_a, cmp_b = objs, back
        if len(cmp_a) != len(cmp_b):
            r["errors"].append(f"line count {len(cmp_a)} → {len(cmp_b)}")
        else:
            for i, (a, b) in enumerate(zip(cmp_a, cmp_b)):
                if bridge.canonical_json(a) != bridge.canonical_json(b):
                    r["errors"].append(f"line {i + 1} differs: {bridge.canonical_json(a)[:80]} vs {bridge.canonical_json(b)[:80]}")
                    if len(r["errors"]) > 5:
                        break
        v2_bytes = bridge.dumps_jsonl(v2).encode("utf-8")
        r["v1"] = len(raw)
        r["v1_compact"] = len(bridge.dumps_jsonl(objs).encode("utf-8"))
        r["v1_gz"] = gz_len(raw)
        r["v2"] = len(v2_bytes)
        r["v2_gz"] = gz_len(v2_bytes)
        r["n_a"] = sum(1 for o in v2 if bridge.is_arena_array(o))
        if r["n_a"] != n_arena:
            r["errors"].append(f"{n_arena - r['n_a']} arena_command lines were not compacted (verbatim)")
    except Exception as exc:  # noqa: BLE001 — report, don't die mid-corpus
        r["errors"].append(f"{type(exc).__name__}: {exc}")
    if r["unknown_shapes"] or r["errors"]:
        r["ok"] = False
    r["secs"] = time.time() - t
    return r


def mb(n: float) -> str:
    return f"{n / 1e6:.1f}"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("root", nargs="?", default=DEFAULT_ROOT)
    p.add_argument("--out", default=None, help="write the Markdown report here (default: stdout)")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--top", type=int, default=12, help="how many largest files to list in the summary")
    args = p.parse_args(argv)

    files = sorted(
        os.path.join(d, f)
        for d, _, fs in os.walk(args.root)
        for f in fs
        if (f.endswith(".jsonl") or f.endswith(".jsonl.gz")) and "/.git/" not in d
    )
    if not files:
        print(f"no run logs under {args.root}", file=sys.stderr)
        return 2
    print(f"[corpus] {len(files)} files under {args.root}", file=sys.stderr)
    t = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        results = list(ex.map(process, files, chunksize=1))
    for r in results:
        print(f"[corpus] {'ok  ' if r['ok'] else 'FAIL'} {os.path.relpath(r['path'], args.root)} ({r['secs']:.1f}s)", file=sys.stderr)
    elapsed = time.time() - t

    ok = [r for r in results if r["ok"]]
    bad = [r for r in results if not r["ok"]]
    sized = [r for r in results if "v2_gz" in r]
    tot = {k: sum(r[k] for r in sized) for k in ("v1", "v1_compact", "v1_gz", "v2", "v2_gz", "lines", "n_arena", "n_frames", "n_other")}

    out = []
    w = out.append
    w(f"## behavior_v2 corpus gate — {len(files)} run logs under `{args.root}`")
    w("")
    w(f"Round trip v1 → v2 → v1 (strict converter, canonical-JSON identity per line): **{len(ok)} / {len(results)} files pass**"
      + (f", **{len(bad)} FAIL**" if bad else "") + f". Formats: "
      + ", ".join(f"{n} {f}" for f, n in sorted(((f, sum(1 for r in results if r.get('fmt') == f)) for f in {r.get('fmt') for r in results}), key=lambda x: -x[1]))
      + f". Wall time {elapsed:.0f} s ({args.workers} workers).")
    w("")
    w("| | lines | arena echoes | frames | other | v1 on disk | v1.gz | v2 | v2.gz | v2/v1 | v2.gz/v1 |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    w(f"| **total** | {tot['lines']:,} | {tot['n_arena']:,} | {tot['n_frames']:,} | {tot['n_other']:,} | {mb(tot['v1'])} MB | {mb(tot['v1_gz'])} MB | {mb(tot['v2'])} MB | {mb(tot['v2_gz'])} MB | {tot['v2'] / tot['v1']:.2f} | {tot['v2_gz'] / tot['v1']:.3f} |")
    w("")
    w(f"gzip level {GZIP_LEVEL} (≈ the browser's CompressionStream). `v1 on disk` counts the July logs' non-compact whitespace; compact v1 would be {mb(tot['v1_compact'])} MB.")
    w("")
    # per-rig
    rigs = {}
    for r in sized:
        rig = os.path.relpath(r["path"], args.root).split(os.sep)
        rig = rig[1] if len(rig) > 2 else rig[0]
        rigs.setdefault(rig, []).append(r)
    w("### Per rig")
    w("")
    w("| rig | files | pass | v1 on disk | v2 | v2.gz | v2/v1 | v2.gz/v1 |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|")
    for rig, rs in sorted(rigs.items()):
        s = {k: sum(r[k] for r in rs) for k in ("v1", "v2", "v2_gz")}
        w(f"| {rig} | {len(rs)} | {sum(1 for r in rs if r['ok'])} | {mb(s['v1'])} MB | {mb(s['v2'])} MB | {mb(s['v2_gz'])} MB | {s['v2'] / s['v1']:.2f} | {s['v2_gz'] / s['v1']:.3f} |")
    w("")
    w(f"### Largest {args.top} files")
    w("")
    w("| file | lines | arena | v1 on disk | v1.gz | v2 | v2.gz | v2/v1 |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|")
    for r in sorted(sized, key=lambda r: -r["v1"])[: args.top]:
        w(f"| {os.path.relpath(r['path'], args.root)} | {r['lines']:,} | {r['n_arena']:,} | {mb(r['v1'])} | {mb(r['v1_gz'])} | {mb(r['v2'])} | {mb(r['v2_gz'])} | {r['v2'] / r['v1']:.2f} |")
    w("")
    if bad:
        w("### FAILURES")
        w("")
        for r in bad:
            w(f"- `{os.path.relpath(r['path'], args.root)}`")
            for e in r["errors"]:
                w(f"  - {e}")
            for sh in r["unknown_shapes"]:
                w(f"  - unknown line shape: {sh}")
        w("")
    w("<details><summary>All files (MB)</summary>")
    w("")
    w("| file | fmt | ok | lines | arena | frames | v1 | v1.gz | v2 | v2.gz | v2/v1 |")
    w("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in results:
        rel = os.path.relpath(r["path"], args.root)
        if "v2_gz" not in r:
            w(f"| {rel} | {r.get('fmt', '?')} | ✗ | | | | | | | | |")
            continue
        w(f"| {rel} | {r['fmt']} | {'✓' if r['ok'] else '✗'} | {r['lines']:,} | {r['n_arena']:,} | {r['n_frames']:,} | {mb(r['v1'])} | {mb(r['v1_gz'])} | {mb(r['v2'])} | {mb(r['v2_gz'])} | {r['v2'] / r['v1']:.2f} |")
    w("")
    w("</details>")
    report = "\n".join(out) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(report)
        print(f"[corpus] report → {args.out}", file=sys.stderr)
    else:
        print(report)
    print(f"[corpus] {len(ok)} / {len(results)} pass", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
