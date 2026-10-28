#!/usr/bin/env python3
"""test_tiff2mcap_runlog.py — the run-log side of tools/tiff_run_to_mcap.py on a synthetic log (no TIFFs).

    pixi run python tests/test_tiff2mcap_runlog.py

load_runlog (trialParams paired with their send times, allOff from the compact `a` rows, connector records),
controller_clock (controller t_us → PC ms from the executed trialParams) and runlog_timeline (the first
displayed frame per step, the allOff after the last step), plus the fallbacks when the log can't support them.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from tiff_run_to_mcap import controller_clock, load_runlog, runlog_timeline  # noqa: E402

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


T0 = 1_792_000_000_000.0          # logging start, PC ms
RATE = 1.00005                    # controller clock runs 50 ppm fast
OFF_US = 7_000_000.0              # controller t_us at PC T0
LAT_MS = 5.0                      # trialParams → first displayed frame


def ctrl_us(pc_ms: float) -> float:
    return OFF_US + (pc_ms - T0) * 1e3 * RATE


def make_log(sends_ok: bool = True, with_cc: bool = True) -> list:
    rows = [{"type": "session", "event": "logging_started", "ms": T0}]
    rows.append(["a", 3, 7, "0100", 0, 11])                                      # pre_blank allOff
    trials = [("violet", 7, 7, 1000.0), ("violet", 255, 7, 5000.0), ("blue", 7, 3, 20000.0), ("blue", 15, 3, 24000.0)]
    for cond_color, duty, pid, t in trials:
        send = T0 + t
        rows.append({"type": "log", "event": "runner", "phase": "trial-running", "condition": f"{cond_color}_d{duty}",
                     "params": {"mode": 2, "patternId": pid, "frameRate": 20, "duty": duty}, "rx_ms": send + 7})
        if sends_ok:
            rows.append({"type": "log", "event": "arena_command", "t": send, "head": "0d 08 02 …"})
        if with_cc:
            rows.append(["cc", send + 4, ctrl_us(send), 1, 8, 0, ""])
            for k in range(3):                                                    # three displayed frames, 50 ms apart
                rows.append(["cf", send + 4, ctrl_us(send + LAT_MS + 50 * k), 2, k, pid, 600, 776, 3000, 0, 3])
    rows.append(["a", 9000, 6, "0100", 0, 9006])                                 # violet allOff (t_off from T0)
    rows.append(["a", 28000, 6, "0100", 0, 28006])                               # blue allOff
    for cond in ("pre_blank", "violet_d255", "blue_d15"):
        rows.append({"type": "log", "event": "runner", "phase": "command", "op": "allOff", "condition": cond, "rx_ms": T0})
    rows.append({"type": "connector", "kind": "command", "ms": 11, "command": "set", "params": {"property": "x", "value": 1}})
    rows.append({"type": "connector", "kind": "reply", "rx_epoch_ms": T0 + 300, "command": "set", "outcome": "ok", "rtt_ms": 289, "value": 1})
    rows.append({"type": "connector", "kind": "status", "ms": 500})              # status polls are not events
    return rows


def write(rows: list) -> Path:
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    for r in rows:
        f.write(json.dumps(r) + "\n")
    f.close()
    return Path(f.name)


# 1. a complete log
log = load_runlog(write(make_log()))
check("4 trials, colors and duties from the condition names", [(t["color"], t["duty"]) for t in log["trials"]]
      == [("violet", 7), ("violet", 255), ("blue", 7), ("blue", 15)])
check("trialParams paired with arena_command send times", log["sends_paired"] and log["trials"][0]["t_cmd_ms"] == T0 + 1000)
check("allOff from the `a` rows (send time = logging start + t_off)", log["all_off"] == [T0 + 3, T0 + 9000, T0 + 28000]
      and log["all_off_source"].startswith("a rows"), str(log["all_off"]))
check("connector: command at start + ms, reply at rx_epoch_ms, status ignored",
      [(c["kind"], c["t_ms"]) for c in log["connector"]] == [("command", T0 + 11), ("reply", T0 + 300)])

to_pc, info = controller_clock(log)
check("controller clock fit recovers the rate", to_pc is not None and abs(info["ppm"] - (1 / RATE - 1) * 1e6) < 0.5, json.dumps(info))
check("controller clock maps back to PC within 1 µs", abs(to_pc(ctrl_us(T0 + 12345.0)) - (T0 + 12345.0)) < 1e-3)

tl = runlog_timeline(log, "violet", to_pc)
check("violet: 2 steps, first displayed frame = send + latency", len(tl["steps"]) == 2
      and abs(tl["steps"][0]["t_disp_ms"] - (T0 + 1000 + LAT_MS)) < 1e-3, str([s["t_disp_ms"] - T0 for s in tl["steps"]]))
check("violet: displayed frames carry their own times and indices", [f[1] for f in tl["steps"][1]["frames"]] == [0, 1, 2]
      and abs(tl["steps"][1]["frames"][2][0] - (T0 + 5000 + LAT_MS + 100)) < 1e-3)
check("violet: allOff = the first allOff after the last step", tl["t_off_ms"] == T0 + 9000)
check("violet: display latency is the median send→frame time", abs(tl["display_latency_ms"] - LAT_MS) < 1e-3)
check("blue frames don't leak into violet steps", all(f[2] == 7 for s in tl["steps"] for f in s["frames"]))
check("a color with no trials → None", runlog_timeline(log, "green", to_pc) is None)

# 2. a duty that disagrees with the condition name is flagged
rows = make_log()
next(r for r in rows if isinstance(r, dict) and r.get("phase") == "trial-running")["params"]["duty"] = 9
check("duty ≠ condition name is flagged", not load_runlog(write(rows))["trials"][0]["duty_matches_condition"])

# 3. no arena_command lines → send times fall back to the runner's receive time, no clock map
log2 = load_runlog(write(make_log(sends_ok=False)))
fn, why = controller_clock(log2)
check("unpaired sends: t_cmd = runner rx_ms", not log2["sends_paired"] and log2["trials"][0]["t_cmd_ms"] == T0 + 1007)
check("unpaired sends: no controller clock map, with a reason", fn is None and "paired False" in why, why)
tl2 = runlog_timeline(log2, "violet", fn)
check("no clock map: t_disp = send time, labelled so", tl2["steps"][0]["t_disp_ms"] == T0 + 1007
      and tl2["steps"][0]["t_disp_source"] == "trialParams send time" and not tl2["steps"][0]["frames"])

# 4. no controller telemetry
log3 = load_runlog(write(make_log(with_cc=False)))
check("no cc rows: no controller clock map", controller_clock(log3)[0] is None)

print(f"\n{'ALL PASS' if not failures else f'{failures} FAILED'}")
sys.exit(1 if failures else 0)
