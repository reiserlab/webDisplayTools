#!/usr/bin/env python3
"""telemetry-report.py — SD-read cost, card-stall clusters, request→presentation latency and
per-trial stimulus quality from a behavior_v2 log that carries controller telemetry rows.

Input: bridge behavior_v2 NDJSON (.jsonl / .jsonl.gz) written by fictrac-bridge/bridge.py (Arena
Studio runs) or by the firmware repo's scripts/sd_stall_test.py (card comparisons) — both carry the
controller ring as compact rows (js/arena-telemetry.js `toRows`):

    ["cc", rx, t_us, seq, cmd, status, "reqhex"]                      controller CMD record
    ["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us
           (, req_age_us, superseded, flags)]                          displayed frame change (v2 extras optional)
    ["cs", rx, t_us, seq, kind, code, arg]                             STATE (4 sd_slow, 7 sd_open, 11 sd_layout,
                                                                       12 sd_slow_ctx, 13 sd_reads, ...)
    {"event":"run_metadata", "firmware": "...", "sd_card": {...}, ...}

Rows are consumed in FILE order (= ring seq order as the drainer delivered them); never sort by `rx`.

What it reports (per file):
  1. reads accounting per pattern — accepted 0x70s, index-changing 0x70s, firmware-counted reads
     (STATE sd_reads, kind 13), displayed frames, reads per command (measures the same-index skip);
  2. SD read cost by index step class (+1 sequential / small forward / backward / jump / first-after-open)
     — the seek-path signature (FAT walk vs contiguous);
  3. card-stall clusters — every sd_slow over --gap-ms grouped when < 5 s apart; per cluster the trial,
     pattern, durations, phases, and the spacing since the previous cluster in accepted commands,
     index changes and seconds (the card's read-count maintenance shows up as a constant count);
  4. request→presentation latency (ring v2 only): FRAME req_age_us percentiles, frames over the
     5 ms target and the 10 ms threshold, superseded fraction, contiguous-path share;
  5. per-trial table with a pass / fail / unknown verdict (same rules as js/trial-quality.js:
     fail = any read or request age over --gap-ms; unknown = coverage gap; else pass).

Usage:
    python scripts/telemetry-report.py soak-logs/arena-log-20260913-014056-656.jsonl
    python scripts/telemetry-report.py --json a.jsonl b.jsonl.gz > report.json
    python scripts/telemetry-report.py --gap-ms 10 --target-ms 5 file.jsonl

Standalone, stdlib only. Exit 0; 2 on bad arguments.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import statistics
import sys
from collections import Counter, defaultdict

STATE_KINDS = {1: "boot", 2: "state_change", 3: "error_glyph", 4: "sd_slow", 5: "ring_overrun", 6: "telemetry",
               7: "sd_open", 8: "wdog_context", 9: "prev_isr_count", 10: "timer_fail", 11: "sd_layout",
               12: "sd_slow_ctx", 13: "sd_reads"}
SD_SLOW_PHASES = ["unknown", "seek", "body", "tail"]
CLUSTER_GAP_S = 5.0
STEP_CLASSES = ("+1", "-1", "+2..9", "-2..-9", "jump>=10", "first-after-open", "other")


def open_text(path: str):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


def _round(v, nd=1):
    return None if v is None else round(v, nd)


def step_class(prev_idx, idx, frame_count):
    if prev_idx is None:
        return "other"
    n = frame_count if frame_count and frame_count > 1 else None
    d = idx - prev_idx
    if n:
        d %= n
        if d > n // 2:
            d -= n
    if d == 1:
        return "+1"
    if d == -1:
        return "-1"
    if 1 < d < 10:
        return "+2..9"
    if -10 < d < -1:
        return "-2..-9"
    if abs(d) >= 10:
        return "jump>=10"
    return "other"


def idx_from_req(req) -> int | None:
    """SET_FRAME_POSITION index from a CMD record's request hex.

    The firmware records the bytes AFTER [len, cmd] ("2d00" → 45). Host-style echoes that
    still carry the len/cmd prefix ("03702d00") are tolerated for older fixtures."""
    if not isinstance(req, str) or len(req) < 4:
        return None
    off = 4 if len(req) >= 8 and req[2:4] == "70" else 0
    try:
        return int(req[off:off + 2], 16) | (int(req[off + 2:off + 4], 16) << 8)
    except ValueError:
        return None


class Trial:
    def __init__(self, index, pattern, rx, t_us):
        self.index = index
        self.pattern = pattern
        self.rx0 = rx
        self.rx_last = rx
        self.t0_us = t_us
        self.cmds70 = 0
        self.index_changes = 0
        self.last_idx = None
        self.frames = 0
        self.reads_fw = None
        self.slow_reads = 0
        self.stalls = []          # (ms, phase)
        self.age_gaps = 0
        self.over_target = 0
        self.max_read_ms = 0.0
        self.max_age_ms = 0.0
        self.superseded = 0
        self.coverage = []
        self.layout = None

    def status(self):
        if self.stalls or self.age_gaps:
            return "fail"
        if self.coverage:
            return "unknown"
        return "pass"

    def row(self):
        return {
            "trial": self.index, "pattern": self.pattern,
            "duration_s": _round((self.rx_last - self.rx0) / 1000.0, 1) if self.rx0 is not None else None,
            "cmds70": self.cmds70, "index_changes": self.index_changes, "reads_fw": self.reads_fw,
            "frames": self.frames, "slow_reads": self.slow_reads, "stalls": len(self.stalls),
            "max_read_ms": _round(self.max_read_ms), "age_gaps": self.age_gaps,
            "max_age_ms": _round(self.max_age_ms), "over_target": self.over_target,
            "superseded": self.superseded, "coverage": sorted(set(self.coverage)),
            "layout": self.layout, "status": self.status(),
        }


def analyze_file(path: str, gap_ms: float = 10.0, target_ms: float = 5.0) -> dict:
    gap_us = gap_ms * 1000.0
    target_us = target_ms * 1000.0
    meta = {"file": os.path.basename(path), "firmware": None, "sd_card": None, "log_format": None,
            "telemetry": None, "protocol": None, "run_id": None}
    trials: list[Trial] = []
    cur: Trial | None = None
    # per-pattern accumulators
    step_sd = defaultdict(lambda: defaultdict(list))   # pattern -> class -> [sd_load_us]
    frame_count = {}                                   # pattern -> max idx + 1 (proxy for frame count)
    per_pattern = defaultdict(lambda: Counter())       # pattern -> counters
    layout_by_pattern = {}
    ages = []
    superseded_frames = 0
    superseded_total = 0
    contiguous_frames = 0
    v2_frames = 0
    stalls = []   # dicts: rx, ms, phase, error, trial, pattern, cmds_global, idx_global, ctx
    slow_all = 0
    cmds_global = 0
    idx_global = 0
    last_seq = None
    first_rx = None
    last_rx = None
    prev_cf_idx = {}   # pattern -> last displayed idx
    pending_first = set()   # patterns whose next cf is the first after open
    malformed = 0
    lines = 0

    with open_text(path) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            lines += 1
            if raw[0] == "{":
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    malformed += 1
                    continue
                ev = obj.get("event")
                if ev == "run_metadata":
                    meta["firmware"] = obj.get("firmware")
                    sd = obj.get("sd_card")
                    meta["sd_card"] = sd.get("label") if isinstance(sd, dict) else sd
                    meta["log_format"] = obj.get("log_format")
                    meta["telemetry"] = obj.get("telemetry")
                    meta["protocol"] = obj.get("protocol") or obj.get("protocol_name")
                    meta["run_id"] = obj.get("run_id") or obj.get("id")
                continue
            if raw[0] != "[" or not raw.startswith('["c'):
                continue
            try:
                arr = json.loads(raw)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if not isinstance(arr, list) or len(arr) < 4:
                malformed += 1
                continue
            tag, rx, t_us, seq = arr[0], arr[1], arr[2], arr[3]
            if isinstance(rx, (int, float)):
                first_rx = rx if first_rx is None else first_rx
                last_rx = rx
                if cur is not None:
                    cur.rx_last = rx
            # seq continuity (coverage)
            if isinstance(seq, int):
                is_boot = tag == "cs" and len(arr) >= 5 and arr[4] == 1
                if last_seq is not None and not is_boot and seq != (last_seq + 1) & 0xFFFFFFFF:
                    if cur is not None:
                        cur.coverage.append("seq_gap")
                last_seq = seq

            if tag == "cs" and len(arr) >= 7:
                kind, code, arg = arr[4], arr[5], arr[6]
                if kind == 7 and code == 0:
                    cur = Trial(len(trials) + 1, arg, rx, t_us)
                    trials.append(cur)
                    pending_first.add(arg)
                    per_pattern[arg]["opens"] += 1
                elif kind == 11:
                    lay = {"contiguous": bool(code & 1), "exfat": bool(code & 2), "sectors_per_cluster": arg,
                           "legacy_seek": bool(code & 4), "no_same_index_skip": bool(code & 8)}   # bits 2/3 = SET_SD_DIAG arm
                    if cur is not None:
                        cur.layout = lay
                        layout_by_pattern[cur.pattern] = lay
                elif kind == 4:
                    ms = arg / 10.0
                    phase = SD_SLOW_PHASES[code & 3] if isinstance(code, int) else "unknown"
                    err = bool(isinstance(code, int) and code & 0x80)
                    slow_all += 1
                    if cur is not None:
                        cur.slow_reads += 1
                        cur.max_read_ms = max(cur.max_read_ms, ms)
                    if ms * 1000.0 > gap_us:
                        st = {"rx": rx, "ms": ms, "phase": phase, "error": err,
                              "trial": cur.index if cur else None, "pattern": cur.pattern if cur else None,
                              "cmds_global": cmds_global, "idx_global": idx_global, "ctx": None}
                        stalls.append(st)
                        if cur is not None:
                            cur.stalls.append((ms, phase))
                elif kind == 12:
                    if stalls and stalls[-1]["ctx"] is None:
                        stalls[-1]["ctx"] = {"card_error_code": code, "irqstat_hi": arg, "driver_saw_error": bool(code)}
                elif kind == 13:
                    shift = (code & 0x7F) if isinstance(code, int) else 0   # bits 0-6 = binary shift; bit 7 = mid-open checkpoint
                    reads = arg << shift
                    if cur is not None:
                        # checkpoints and the closing record are cumulative for the same open: keep the largest,
                        # and count the per-pattern total once per open (replace the previous contribution)
                        prev = cur.reads_fw or 0
                        if reads > prev:
                            per_pattern[cur.pattern]["reads_fw"] += reads - prev
                            cur.reads_fw = reads
                elif kind == 1:
                    if cur is not None:
                        cur.coverage.append("controller_reboot")
                elif kind == 5:
                    if cur is not None:
                        cur.coverage.append("ring_overrun")
            elif tag == "cc" and len(arr) >= 7:
                cmd, status, req = arr[4], arr[5], arr[6]
                if cmd == 0x70 and status == 0:
                    cmds_global += 1
                    idx = idx_from_req(req)
                    if cur is not None:
                        cur.cmds70 += 1
                        per_pattern[cur.pattern]["cmds70"] += 1
                        if idx is not None and idx != cur.last_idx:
                            cur.index_changes += 1
                            per_pattern[cur.pattern]["index_changes"] += 1
                            idx_global += 1
                            cur.last_idx = idx
            elif tag == "cf" and len(arr) >= 8:
                idx, pattern, sd_us, spi_us = arr[4], arr[5], arr[6], arr[7]
                if not isinstance(sd_us, (int, float)):
                    malformed += 1
                    continue
                per_pattern[pattern]["frames"] += 1
                frame_count[pattern] = max(frame_count.get(pattern, 0), idx + 1)
                if cur is not None:
                    cur.frames += 1
                    if cur.last_idx is None:
                        cur.last_idx = idx   # the trial's initial frame: a 0x70 for it is not an index change
                if pattern in pending_first:
                    cls = "first-after-open"
                    pending_first.discard(pattern)
                else:
                    cls = step_class(prev_cf_idx.get(pattern), idx, frame_count.get(pattern))
                step_sd[pattern][cls].append(sd_us)
                prev_cf_idx[pattern] = idx
                if len(arr) >= 11 and isinstance(arr[8], (int, float)):
                    v2_frames += 1
                    age = arr[8]
                    sup = arr[9] if isinstance(arr[9], int) else 0
                    flags = arr[10] if isinstance(arr[10], int) else 0
                    ages.append(age)
                    if sup:
                        superseded_frames += 1
                        superseded_total += sup
                    if flags & 2:
                        contiguous_frames += 1
                    if cur is not None:
                        cur.superseded += sup
                        cur.max_age_ms = max(cur.max_age_ms, age / 1000.0)
                        if age > gap_us:
                            cur.age_gaps += 1
                        elif age > target_us:
                            cur.over_target += 1

    # clusters
    clusters = []
    for st in stalls:
        if clusters and isinstance(st["rx"], (int, float)) and isinstance(clusters[-1][-1]["rx"], (int, float)) \
                and (st["rx"] - clusters[-1][-1]["rx"]) / 1000.0 < CLUSTER_GAP_S:
            clusters[-1].append(st)
        else:
            clusters.append([st])
    cluster_rows = []
    prev = None
    for c in clusters:
        first = c[0]
        row = {
            "t_s": _round((first["rx"] - first_rx) / 1000.0, 1) if first_rx is not None and isinstance(first["rx"], (int, float)) else None,
            "trial": first["trial"], "pattern": first["pattern"], "n": len(c),
            "ms": [_round(x["ms"]) for x in c], "phases": [x["phase"] for x in c],
            "errors": sum(1 for x in c if x["error"]),
            "since_prev_cmds": (first["cmds_global"] - prev["cmds_global"]) if prev else None,
            "since_prev_index_changes": (first["idx_global"] - prev["idx_global"]) if prev else None,
            "since_prev_s": _round((first["rx"] - prev["rx"]) / 1000.0, 1) if prev and isinstance(first["rx"], (int, float)) and isinstance(prev["rx"], (int, float)) else None,
        }
        cluster_rows.append(row)
        prev = first
    spacings_cmd = [r["since_prev_cmds"] for r in cluster_rows if r["since_prev_cmds"]]
    spacings_idx = [r["since_prev_index_changes"] for r in cluster_rows if r["since_prev_index_changes"]]
    spacings_s = [r["since_prev_s"] for r in cluster_rows if r["since_prev_s"]]

    step_table = {}
    for pattern, classes in step_sd.items():
        step_table[pattern] = {}
        for cls in STEP_CLASSES:
            v = classes.get(cls)
            if not v:
                continue
            step_table[pattern][cls] = {"n": len(v), "p50": _round(statistics.median(v), 0),
                                        "p90": pct(v, 0.90), "p99": pct(v, 0.99), "max": max(v)}

    reads_rows = {}
    for pattern, c in per_pattern.items():
        cmds = c["cmds70"]
        reads_rows[pattern] = {
            "opens": c["opens"], "cmds70": cmds, "index_changes": c["index_changes"],
            "reads_fw": c["reads_fw"] or None, "frames": c["frames"],
            "index_changes_per_cmd": _round(c["index_changes"] / cmds, 3) if cmds else None,
            "reads_fw_per_cmd": _round(c["reads_fw"] / cmds, 3) if cmds and c["reads_fw"] else None,
            "layout": layout_by_pattern.get(pattern),
        }

    duration_s = _round((last_rx - first_rx) / 1000.0, 1) if first_rx is not None and last_rx is not None else None
    trial_rows = [t.row() for t in trials]
    counts = Counter(r["status"] for r in trial_rows)
    return {
        "meta": meta, "lines": lines, "malformed": malformed, "duration_s": duration_s,
        "gap_ms": gap_ms, "target_ms": target_ms,
        "reads": reads_rows,
        "step_cost_us": step_table,
        "stalls": {
            "slow_reads_total": slow_all, "over_threshold": len(stalls), "clusters": len(clusters),
            "cluster_rows": cluster_rows,
            "spacing_cmds": {"median": _round(statistics.median(spacings_cmd), 0) if spacings_cmd else None,
                             "min": min(spacings_cmd) if spacings_cmd else None, "max": max(spacings_cmd) if spacings_cmd else None},
            "spacing_index_changes": {"median": _round(statistics.median(spacings_idx), 0) if spacings_idx else None},
            "spacing_s": {"median": _round(statistics.median(spacings_s), 1) if spacings_s else None},
            "duration_hist_ms": dict(sorted(Counter(int(round(s["ms"])) for s in stalls).items())),
            "phase_hist": dict(Counter(s["phase"] for s in stalls)),
            "per_1e5_cmds": _round(len(clusters) * 1e5 / cmds_global, 2) if cmds_global else None,
        },
        "presentation": {
            "v2_frames": v2_frames,
            "req_age_us": {"p50": _round(statistics.median(ages), 0) if ages else None, "p90": pct(ages, 0.9),
                           "p99": pct(ages, 0.99), "max": max(ages) if ages else None,
                           "over_target": sum(1 for a in ages if a > target_us),
                           "over_threshold": sum(1 for a in ages if a > gap_us)},
            "superseded_frames": superseded_frames, "superseded_total": superseded_total,
            "superseded_share": _round(superseded_frames / v2_frames, 3) if v2_frames else None,
            "contiguous_share": _round(contiguous_frames / v2_frames, 3) if v2_frames else None,
        },
        "trials": trial_rows,
        "trial_counts": dict(counts),
        "flagged_trials": [r["trial"] for r in trial_rows if r["status"] == "fail"],
    }


def render_markdown(rep: dict) -> str:
    m = rep["meta"]
    out = [f"# telemetry-report — {m['file']}", ""]
    out.append(f"firmware: `{m['firmware'] or '?'}` · sd_card: `{m['sd_card'] or '? (no 0xCD in this log)'}` · "
               f"log: {m['log_format'] or '?'} · telemetry: {m['telemetry'] or '?'} · duration {rep['duration_s']} s · "
               f"lines {rep['lines']} (malformed {rep['malformed']}) · thresholds: gap {rep['gap_ms']} ms, target {rep['target_ms']} ms")
    out.append("")
    out.append("## Reads accounting (per pattern)")
    out.append("| pattern | opens | accepted 0x70 | index changes | fw reads (kind 13) | frames | idx-changes/cmd | fw reads/cmd | layout |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for p, r in sorted(rep["reads"].items(), key=lambda kv: str(kv[0])):
        lay = r["layout"]
        lay_s = "—" if not lay else ("contiguous" if lay["contiguous"] else "FRAGMENTED") + f", {lay['sectors_per_cluster']} spc" + (", exFAT" if lay["exfat"] else "") + (", LEGACY-SEEK arm" if lay.get("legacy_seek") else "") + (", NO-SKIP arm" if lay.get("no_same_index_skip") else "")
        out.append(f"| {p} | {r['opens']} | {r['cmds70']} | {r['index_changes']} | {r['reads_fw'] if r['reads_fw'] is not None else '—'} | {r['frames']} | {r['index_changes_per_cmd']} | {r['reads_fw_per_cmd'] if r['reads_fw_per_cmd'] is not None else '—'} | {lay_s} |")
    out.append("")
    out.append("## SD read cost by index step (sd_load_us of displayed frames)")
    out.append("| pattern | step | n | p50 | p90 | p99 | max |")
    out.append("|---|---|---|---|---|---|---|")
    for p, classes in sorted(rep["step_cost_us"].items(), key=lambda kv: str(kv[0])):
        for cls in STEP_CLASSES:
            if cls in classes:
                c = classes[cls]
                out.append(f"| {p} | {cls} | {c['n']} | {c['p50']} | {c['p90']} | {c['p99']} | {c['max']} |")
    out.append("")
    s = rep["stalls"]
    out.append(f"## Card stalls (reads > {rep['gap_ms']} ms): {s['over_threshold']} in {s['clusters']} clusters "
               f"· {s['per_1e5_cmds']} clusters per 10⁵ accepted 0x70 · spacing median {s['spacing_cmds']['median']} cmds / "
               f"{s['spacing_index_changes']['median']} index changes / {s['spacing_s']['median']} s · "
               f"durations {s['duration_hist_ms']} · phases {s['phase_hist']}")
    if s["cluster_rows"]:
        out.append("| t (s) | trial | pattern | n | ms | phases | since prev (cmds / idx / s) |")
        out.append("|---|---|---|---|---|---|---|")
        for r in s["cluster_rows"]:
            out.append(f"| {r['t_s']} | {r['trial']} | {r['pattern']} | {r['n']} | {r['ms']} | {','.join(r['phases'])} | "
                       f"{r['since_prev_cmds']} / {r['since_prev_index_changes']} / {r['since_prev_s']} |")
    out.append("")
    pr = rep["presentation"]
    if pr["v2_frames"]:
        a = pr["req_age_us"]
        out.append(f"## Request→presentation (ring v2, {pr['v2_frames']} frames): req_age p50 {a['p50']} µs · p90 {a['p90']} · "
                   f"p99 {a['p99']} · max {a['max']} · over {rep['target_ms']} ms: {a['over_target']} · over {rep['gap_ms']} ms: {a['over_threshold']} · "
                   f"superseded frames {pr['superseded_share']} ({pr['superseded_total']} loads never shown) · contiguous-path share {pr['contiguous_share']}")
    else:
        out.append("## Request→presentation: no ring-v2 FRAME fields in this log (firmware without sd_fastpath)")
    out.append("")
    out.append(f"## Trials: {rep['trial_counts']} · flagged {rep['flagged_trials']}")
    out.append("| trial | pattern | dur s | 0x70 | idx chg | fw reads | frames | slow | max read ms | age gaps | max age ms | >target | superseded | coverage | status |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for t in rep["trials"]:
        out.append(f"| {t['trial']} | {t['pattern']} | {t['duration_s']} | {t['cmds70']} | {t['index_changes']} | "
                   f"{t['reads_fw'] if t['reads_fw'] is not None else '—'} | {t['frames']} | {t['slow_reads']} | {t['max_read_ms']} | "
                   f"{t['age_gaps']} | {t['max_age_ms']} | {t['over_target']} | {t['superseded']} | {','.join(t['coverage']) or '—'} | **{t['status']}** |")
    return "\n".join(out) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="behavior_v2 log files (.jsonl / .jsonl.gz)")
    ap.add_argument("--json", action="store_true", help="machine-readable JSON (list, one object per file)")
    ap.add_argument("--gap-ms", type=float, default=10.0, help="fail threshold for a read / request age (default 10)")
    ap.add_argument("--target-ms", type=float, default=5.0, help="target freeze reported as 'over target' (default 5)")
    args = ap.parse_args(argv)
    if args.gap_ms <= 0 or args.target_ms <= 0:
        print("thresholds must be positive", file=sys.stderr)
        return 2
    reports = []
    for p in args.paths:
        if not os.path.isfile(p):
            print(f"not a file: {p}", file=sys.stderr)
            return 2
        reports.append(analyze_file(p, args.gap_ms, args.target_ms))
    if args.json:
        json.dump(reports, sys.stdout, indent=1)
        sys.stdout.write("\n")
    else:
        for r in reports:
            sys.stdout.write(render_markdown(r))
            sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
