#!/usr/bin/env python3
"""sbd_place_learning_flow.py — flow control between two protocols, for SBD visual place learning.

The problem: 1/3 to 1/2 of flies have an innate preference for the part of the panorama that the
training protocol makes safe, so "learning" cannot be told from preference. The rule: measure the
fly's preference in the pre-probe, then train with the safe zone on the seam the fly preferred LEAST.

    stage 1   optomotor + pre-probe (uniform heat)                 -> a run, a bag
    decide    time spent with each seam in front, in the pre-probe  -> the least-preferred seam
    stage 2   training bouts + probe, safe zone on that seam        -> a run, a bag

Both stages are made from ONE base protocol (the lab's sbd place-learning YAML): stage 1 keeps the
experiment list up to the pre-probe; stage 2 keeps the rest and gets four variables rewritten
(start_frame_plus / start_frame_minus / heat_ramp_in / heat_ramp_out). The generated YAML carries the
decision in its header, and the gateway records the YAML text it was sent, so the bag says what ran and why.

    python sbd_place_learning_flow.py analyze RUNLOG.jsonl.gz|BAG ...   # the rule on existing runs
    python sbd_place_learning_flow.py make BASE.yaml --seam stripes_diagonal --out-dir DIR
    python sbd_place_learning_flow.py run BASE.yaml [--experiment] [--genotype G ...]   # on the rig

`run` needs Arena Studio in remote-control mode and the gateway; it starts the runs over ROS 2
(nodes/studio_remote.py), so run it from the rig's pixi environment: `pixi run python examples/...`.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import tempfile
from pathlib import Path

N_FRAMES = 200            # p3_sbd_placelearning: 200 frames, 1.8 degrees per frame
ZONE_FRAMES = 50          # the safe zone is 90 degrees wide
RAMP_FRAMES = 8           # 15-degree heat ramps outside both zone edges
START_OFFSET_FRAMES = 50  # closed-loop trials start 90 degrees outside the nearest zone edge
PREPROBE = "preprobe"

# The frame that puts each seam straight ahead. 183 is the base protocol's own `seam_front_frame`
# (bars | stripes); the pattern has three 120-degree sections, so the other two seams are 66.7 frames
# apart. Order = tie-break order: the standard zone wins a tie.
SEAM_FRONT_FRAME = {"bars_stripes": 183, "stripes_diagonal": 116, "diagonal_bars": 50}

HERE = Path(__file__).resolve().parent


def _load(name: str, candidates: list[Path]):
    for p in candidates:
        if p.is_file():
            spec = importlib.util.spec_from_file_location(name, p)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            return mod
    raise SystemExit(f"cannot find {name}: looked in {[str(p) for p in candidates]}")


def _repo_file(*parts: str) -> list[Path]:
    """The same relative path under each parent directory (the script may sit anywhere in the repo)."""
    return [d.joinpath(*parts) for d in [HERE, *HERE.parents]]


# ── the rule ─────────────────────────────────────────────────────────────────────────────────
def zone(seam: str) -> dict:
    """Frames of the safe zone and what the base protocol derives from it, for one seam."""
    c = SEAM_FRONT_FRAME[seam]
    start, end = (c - ZONE_FRAMES // 2) % N_FRAMES, (c + ZONE_FRAMES // 2 - 1) % N_FRAMES
    return {
        "seam": seam, "seam_front_frame": c, "zone_start": start, "zone_end": end,
        "heat_ramp_in": [(end + 1) % N_FRAMES, (end + 1 + RAMP_FRAMES) % N_FRAMES],
        "heat_ramp_out": [(start - RAMP_FRAMES) % N_FRAMES, start],
        "start_frame_plus": (end + START_OFFSET_FRAMES) % N_FRAMES,
        "start_frame_minus": (start - START_OFFSET_FRAMES) % N_FRAMES,
    }


def occupancy(indices: list[int]) -> dict[str, float]:
    """Fraction of frames with each seam within +/- 45 degrees of straight ahead."""
    out = {}
    for seam in SEAM_FRONT_FRAME:
        start = zone(seam)["zone_start"]
        inside = sum(1 for i in indices if (i - start) % N_FRAMES < ZONE_FRAMES)
        out[seam] = inside / len(indices) if indices else float("nan")
    return out


def choose(occ: dict[str, float]) -> str:
    """The least-preferred seam; a tie goes to the first in SEAM_FRONT_FRAME (the standard zone)."""
    return min(SEAM_FRONT_FRAME, key=lambda s: (occ[s], list(SEAM_FRONT_FRAME).index(s)))


def preprobe_indices(path: str) -> tuple[list[int], dict]:
    """Displayed frame index of every closed-loop sample in the pre-probe of a run log or a bag."""
    report = _load("closed_loop_report", _repo_file("scripts", "closed-loop-report.py"))
    p = Path(path)
    if p.is_dir() or p.suffix == ".mcap":  # a bag: derive the run log from it first
        conv = _load("mcap_convert", _repo_file("rig", "nodes", "mcap_convert.py") + _repo_file("nodes", "mcap_convert.py"))
        text, _ = conv.convert_bag(p)
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as fh:
            fh.write(text)
            path = fh.name
    log = report.parse_log(path)
    epochs = [e for e in report.find_epochs(log) if e.get("condition") == PREPROBE]
    if not epochs:
        return [], {"error": f"no closed-loop epoch named '{PREPROBE}' in this run"}
    ep = epochs[0]
    idx = [r[2] for r in log["rows"] if ep["start_ms"] <= r[0] <= ep["end_ms"]]
    return idx, {"samples": len(idx), "seconds": round((ep["end_ms"] - ep["start_ms"]) / 1000.0, 1),
                 "frames_visited": len(set(idx))}


def decide(path: str) -> dict:
    idx, info = preprobe_indices(path)
    if not idx:
        return {"run": str(path), **info}
    occ = occupancy(idx)
    return {"run": str(path), **info, "occupancy": {k: round(v, 3) for k, v in occ.items()},
            "chosen": choose(occ), "most_preferred": max(occ, key=occ.get)}


# ── the two protocols ────────────────────────────────────────────────────────────────────────
def _sub_once(text: str, pattern: str, repl: str, what: str) -> str:
    out, n = re.subn(pattern, repl, text, flags=re.M)
    if n != 1:
        raise SystemExit(f"base protocol: expected exactly one `{what}`, found {n} (is this the sbd place-learning protocol?)")
    return out


def _experiment_block(text: str) -> tuple[int, int, list[str]]:
    m = re.search(r"^experiment:\n(.*?)(?=^conditions:)", text, flags=re.M | re.S)
    if not m:
        raise SystemExit("base protocol: no `experiment:` block before `conditions:`")
    return m.start(1), m.end(1), m.group(1).splitlines(keepends=True)


def make_stage(base: str, stage: int, seam: str | None = None, decision: dict | None = None) -> str:
    """Stage 1 (optomotor + pre-probe) or stage 2 (training + probe on `seam`) from the base protocol text."""
    a, b, lines = _experiment_block(base)
    cut = next((i for i, ln in enumerate(lines) if re.match(rf'\s*-\s*"{PREPROBE}"\s*$', ln)), None)
    if cut is None:
        raise SystemExit(f"base protocol: the experiment list has no \"{PREPROBE}\" entry")
    blank_after = cut + 1 < len(lines) and re.match(r'\s*-\s*"blank"\s*$', lines[cut + 1])
    split = cut + (2 if blank_after else 1)  # the pre-probe's dark gap stays with stage 1
    if stage == 1:
        body = "".join(lines[:split]) + '  - "shutdown"\n\n'
        head = ["FLOW CONTROL stage 1 of 2: optomotor + pre-probe. Stage 2 is chosen from this run's pre-probe."]
        text = base[:a] + body + base[b:]
    else:
        z = zone(seam)
        body = '  - "led_off"\n' + "".join(lines[split:])
        text = base[:a] + body + base[b:]
        text = _sub_once(text, r"^(\s*seam_front_frame: &seam_front_frame )\d+", rf"\g<1>{z['seam_front_frame']}", "seam_front_frame")
        text = _sub_once(text, r"^(\s*start_frame_plus: &start_frame_plus )\d+", rf"\g<1>{z['start_frame_plus']}", "start_frame_plus")
        text = _sub_once(text, r"^(\s*start_frame_minus: &start_frame_minus )\d+", rf"\g<1>{z['start_frame_minus']}", "start_frame_minus")
        for key in ("heat_ramp_in", "heat_ramp_out"):
            lo, hi = z[key]
            text = _sub_once(text, rf"^(\s*{key}:\n(?:\s*#.*\n)*\s*&{key}\n\s*- )\d+(\n\s*- )\d+", rf"\g<1>{lo}\g<2>{hi}", key)
        head = [f"FLOW CONTROL stage 2 of 2: training + probe, safe zone on the {seam} seam.",
                f"Safe zone frames {z['zone_start']}..{z['zone_end']} (seam in front at frame {z['seam_front_frame']}); "
                f"heat ramps {z['heat_ramp_in']} / {z['heat_ramp_out']}; starts {z['start_frame_plus']} (+) / {z['start_frame_minus']} (-).",
                "The frame numbers in the comments below describe the base protocol, not this run."]
        if decision:
            head.append("Decision: " + json.dumps({k: decision[k] for k in ("occupancy", "chosen", "samples", "seconds", "run") if k in decision}))
    first = "version: 3\n"
    if not text.startswith(first):
        raise SystemExit("base protocol: the first line must be `version: 3`")
    return first + "\n" + "".join(f"# {ln}\n" for ln in head) + text[len(first):]


# ── commands ─────────────────────────────────────────────────────────────────────────────────
def cmd_analyze(a) -> int:
    rows = [decide(p) for p in a.runs]
    if a.json:
        print(json.dumps(rows, indent=1))
        return 0
    seams = list(SEAM_FRONT_FRAME)
    print("| run | s | frames visited | " + " | ".join(seams) + " | most preferred | train on |")
    print("|---|---|---|" + "---|" * len(seams) + "---|---|")
    for r in rows:
        name = Path(r["run"]).name[:60]
        if "occupancy" not in r:
            print(f"| {name} | | | " + " | " * len(seams) + f" | {r.get('error', '')} |")
            continue
        print(f"| {name} | {r['seconds']} | {r['frames_visited']} | " + " | ".join(f"{r['occupancy'][s]:.2f}" for s in seams)
              + f" | {r['most_preferred']} | {r['chosen']} |")
    return 0


def cmd_make(a) -> int:
    base = Path(a.base).read_text(encoding="utf-8")
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(a.base).stem
    (out / f"{stem}__stage1.yaml").write_text(make_stage(base, 1), encoding="utf-8")
    for seam in ([a.seam] if a.seam else SEAM_FRONT_FRAME):
        (out / f"{stem}__stage2_{seam}.yaml").write_text(make_stage(base, 2, seam), encoding="utf-8")
    print("\n".join(str(p) for p in sorted(out.glob(f"{stem}__stage*.yaml"))))
    return 0


def cmd_run(a) -> int:
    remote_mod = _load("studio_remote", _repo_file("rig", "nodes", "studio_remote.py") + _repo_file("nodes", "studio_remote.py"))
    # The request goes over the ROS graph (/arena/run_request, /arena/run_status); --ws uses the gateway's WebSocket.
    remote = remote_mod.StudioRemote(transport="ws", url=a.ws) if a.ws else remote_mod.StudioRemote(client="sbd_place_learning_flow")
    base = Path(a.base).read_text(encoding="utf-8")
    stem = Path(a.base).stem
    intent = "experiment" if a.experiment else "test"
    meta = {k: v for k, v in (("experimenter", a.experimenter), ("genotype", a.genotype), ("age", a.age),
                              ("sex", a.sex), ("fly_number", a.fly_number), ("notes", a.notes)) if v}
    say = lambda s: print(f"[flow] {s}", file=sys.stderr, flush=True)

    say("stage 1: optomotor + pre-probe")
    r1 = remote.run(make_stage(base, 1), name=f"{stem}__stage1.yaml", intent=intent, metadata=meta)
    if r1.get("state") != "done":
        say(f"stage 1 ended '{r1.get('state')}' ({r1.get('detail', '')}); not starting stage 2")
        return 1
    if not r1.get("bag"):
        say("stage 1 finished but the gateway reported no bag; cannot decide")
        return 1
    d = decide(r1["bag"])
    if "chosen" not in d:
        say(f"no decision: {d.get('error')}")
        return 1
    say(f"pre-probe: {d['samples']} samples over {d['seconds']} s; occupancy {d['occupancy']}")
    say(f"stage 2: training with the safe zone on the least-preferred seam: {d['chosen']}")
    r2 = remote.run(make_stage(base, 2, d["chosen"], d), name=f"{stem}__stage2_{d['chosen']}.yaml", intent=intent, metadata=meta)
    say(f"stage 2 ended '{r2.get('state')}'")
    print(json.dumps({"decision": d, "stage1": {k: r1.get(k) for k in ("state", "bag")},
                      "stage2": {k: r2.get(k) for k in ("state", "bag", "detail")}}, indent=1))
    return 0 if r2.get("state") == "done" else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("analyze", help="apply the rule to existing run logs or bags")
    p.add_argument("runs", nargs="+")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_analyze)
    p = sub.add_parser("make", help="write the stage protocols without running anything")
    p.add_argument("base")
    p.add_argument("--seam", choices=list(SEAM_FRONT_FRAME))
    p.add_argument("--out-dir", required=True)
    p.set_defaults(fn=cmd_make)
    p = sub.add_parser("run", help="stage 1, decide, stage 2 (Arena Studio in remote-control mode)")
    p.add_argument("base")
    p.add_argument("--ws", nargs="?", const="ws://localhost:8765", default=None, metavar="URL",
                   help="use the gateway's WebSocket instead of ROS 2 (default URL ws://localhost:8765)")
    p.add_argument("--experiment", action="store_true", help="recorded experiment runs (default: test runs)")
    for k in ("experimenter", "genotype", "age", "sex", "fly-number", "notes"):
        p.add_argument(f"--{k}")
    p.set_defaults(fn=cmd_run)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
