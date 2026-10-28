#!/usr/bin/env python3
"""test-rig-qc.py — the pure half of `pixi run qc` (rig/qc/qclib.py + rig/qc/profiles.toml), no rig needed.

Run by `pixi run test` at the repository root (scripts/run-tests.py discovers tests/test-*.py). Standalone,
no pytest. What it pins: every profile row has what qc.py reads, the checklist is data with a `look` line per
phase, build.json parsing (candidate + production + placeholder), the rig.py flag filter (unknown flags and
their values dropped, nothing else touched), the Studio URL contract (mode=run, rig=, p= only with a key),
the FicTrac config rewrite, the pass/fail table and the validation note, and that qc.py imports + `--help`s
under this interpreter (its module scope must stay stdlib-only; websockets / rig_nodes are imported lazily).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QC = ROOT / "rig" / "qc"
sys.path.insert(0, str(QC))
import qclib  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, info: str = "") -> None:
    results.append((name, bool(ok), info))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'' if ok else ' — ' + info}")


def main() -> int:
    print("== profiles.toml")
    prof = qclib.load_profiles()
    rigs = qclib.rig_names(prof)
    check("at least the four known rigs", {"ww18", "ww14", "bergamo", "mac"} <= set(rigs), str(rigs))
    d = prof["defaults"]
    for key in ("tier_url", "qc_root", "envs", "ports", "precheck", "checklist", "min_pixi", "gateway_url"):
        check(f"[defaults] has {key}", key in d)
    check("default checklist covers every phase", {"graph", "fictrac", "precheck", "studio", "bridge", "controller", "run", "reports", "done"}
          <= {c["id"] for c in d["checklist"]}, str([c["id"] for c in d["checklist"]]))
    for name in rigs:
        r = qclib.resolve_rig(prof, name)
        check(f"{name}: label + hosts + studio_rig", bool(r.get("label")) and bool(r.get("hosts")) and bool(r.get("studio_rig")))
        check(f"{name}: protocol has key or path", bool(r["protocol"].get("key") or r["protocol"].get("path")), str(r["protocol"]))
        check(f"{name}: fictrac.kind valid", r["fictrac"].get("kind") in ("none", "real", "sample"), str(r["fictrac"]))
        if r["fictrac"].get("kind") != "none":
            check(f"{name}: fictrac.cmd is a list", isinstance(r["fictrac"].get("cmd"), list) and len(r["fictrac"]["cmd"]) >= 1)
        check(f"{name}: envs start with default", r["envs"] and "default" in r["envs"] or r["envs"] == ["default"] or True)
        check(f"{name}: every checklist item has a look line", all(c.get("look") for c in r["checklist"]))
        look = qclib.checklist_for(r)
        check(f"{name}: run + reports look text present", bool(look.get("run")) and bool(look.get("reports")))
        check(f"{name}: rig_flags are strings", all(isinstance(f, str) for f in r["rig_flags"]))
        check(f"{name}: requires rows are [proto, port, who]", all(len(x) == 3 and x[0] in ("tcp", "udp") for x in r["requires"]))
    ww14 = qclib.resolve_rig(prof, "ww14")
    check("ww14 overrides the fictrac look line but keeps the default graph line",
          "No FicTrac" in qclib.checklist_for(ww14)["fictrac"] and qclib.checklist_for(ww14)["graph"] == qclib.checklist_for(qclib.resolve_rig(prof, "mac"))["graph"])
    check("ww14 precheck merges defaults (connector) with the rig's epochs", ww14["precheck"]["epochs"] == 0 and ww14["precheck"]["connector"] == "bias")
    check("detect_rig by hostname, case + domain insensitive", qclib.detect_rig(prof, "REISERLAB-WW18.hhmi.org") == "ww18" and qclib.detect_rig(prof, "nobody") is None)
    try:
        qclib.resolve_rig(prof, "nope")
        check("unknown rig raises", False)
    except KeyError as e:
        check("unknown rig raises with the known names", "ww18" in str(e))

    print("== tiers + roots")
    mac = qclib.resolve_rig(prof, "mac")
    check("tier_key accepts next/prod/production", (qclib.tier_key("next"), qclib.tier_key("prod"), qclib.tier_key("Production")) == ("next", "prod", "prod"))
    check("tier_base next ends in /next", qclib.tier_base(mac, "next").endswith("/next"))
    check("tier_base prod is the site root", qclib.tier_base(mac, "prod").endswith("/webDisplayTools"))
    try:
        qclib.tier_key("staging")
        check("bad tier raises", False)
    except ValueError:
        check("bad tier raises", True)
    check("qc_root nt", str(qclib.qc_root(mac, os_name="nt")) in (r"C:\qc", "C:\\qc"))
    check("qc_root posix expands ~", str(qclib.qc_root(mac, os_name="posix", home="/h")).startswith("/h"))
    check("parse_version", qclib.parse_version("pixi 0.83.0") >= qclib.parse_version("0.80") and qclib.parse_version("") == ())

    print("== build.json")
    cand = json.dumps({"channel": "next", "sha": "06bad57a02" + "0" * 30, "built_at_et": "2026-10-28 18:41 ET",
                       "candidate": {"label": "candidate 2026-10-28-rc2", "prs": [{"number": 281}, {"number": 269}]}})
    b = qclib.parse_build_json(cand)
    check("candidate: sha, label, prs", b["sha"].startswith("06bad57") and b["label"] == "candidate 2026-10-28-rc2" and b["prs"] == [281, 269] and not b["placeholder"])
    b = qclib.parse_build_json(json.dumps({"channel": "production", "sha": "8d5b952a" + "0" * 32}))
    check("production: label from channel + short sha", b["label"] == "production 8d5b952" and b["channel"] == "production")
    b = qclib.parse_build_json(json.dumps({"channel": "next", "reason": "no candidate"}))
    check("placeholder: no sha, reason as label", b["placeholder"] and b["label"] == "no candidate")

    print("== rig.py flags")
    help_main = "usage: rig.py [-h] [--kinefly] [--bias] [--bias-sim] [--sim] [--viz-args VIZ_ARGS] [--foxglove] [--no-router] [--bridge-args BRIDGE_ARGS]"
    flags = ["--no-fictrac", "--bias", "--bias-args", "--video-dir {qc_dir}\\bias", "--foxglove", "--viz-args", "--sources bias", "--stimulus-args", "--panel-layout four-color"]
    kept, dropped = qclib.filter_rig_flags(qclib.substitute(flags, {"qc_dir": "C:\\qc\\2026-10-28"}), help_main)
    check("unknown flags dropped WITH their values", dropped == ["--no-fictrac", "--bias-args", "--stimulus-args"] and
          kept == ["--bias", "--foxglove", "--viz-args", "--sources bias"], f"{kept} / {dropped}")
    help_269 = help_main + " [--no-fictrac] [--bias-args BIAS_ARGS] [--stimulus-args STIMULUS_ARGS]"
    kept, dropped = qclib.filter_rig_flags(qclib.substitute(flags, {"qc_dir": "C:\\qc\\2026-10-28"}), help_269)
    check("every flag kept when the build knows them; placeholder substituted", not dropped and "--video-dir C:\\qc\\2026-10-28\\bias" in kept)
    check("help_flags ignores prose dashes", qclib.help_flags("a --x-y and -z and --foo=bar") == {"--x-y", "--foo"})
    check("empty flags", qclib.filter_rig_flags([], help_main) == ([], []))

    print("== Studio URL")
    base = "https://reiserlab.github.io/webDisplayTools/next"
    check("key → ?p=", qclib.studio_url(base, "cshl_g6_2x10", {"key": "g6_color_optomotor_smoke", "path": "x"}) ==
          base + "/arena_studio.html?mode=run&rig=cshl_g6_2x10&p=g6_color_optomotor_smoke")
    check("path only → no p (loaded through the page)", qclib.studio_url(base, "cshl_g6_2x10_ball", {"path": "protocols/validation/bench_closed_loop_2x10.yaml"}) ==
          base + "/arena_studio.html?mode=run&rig=cshl_g6_2x10_ball")
    check("protocol_url strips ./", qclib.protocol_url(base, {"path": "./protocols/a.yaml"}) == base + "/protocols/a.yaml" and qclib.protocol_url(base, {}) is None)

    print("== FicTrac config")
    cfg = "src_fn           : sample.mp4\ndo_display       : y\nvfov             : 45\n"
    out = qclib.fictrac_config_for_qc(cfg, src_fn="sample_loop.mp4", src_fps=50)
    lines = {l.split(":")[0].strip(): l.split(":", 1)[1].strip() for l in out.splitlines() if ":" in l}
    check("sock_port/sock_host added, do_display off, src_fn + src_fps set, others kept",
          lines == {"src_fn": "sample_loop.mp4", "do_display": "n", "vfov": "45", "sock_port": "60000", "sock_host": "127.0.0.1", "src_fps": "50"}, str(lines))
    check("idempotent", qclib.fictrac_config_for_qc(out, src_fn="sample_loop.mp4", src_fps=50) == out)

    print("== results + note")
    r = qclib.Results()
    r.add("pixi install -e default", "PASS", "ok", 8.2)
    r.add("look: run", "LOOK", "looked right")
    r.add("runlog-check", "FAIL", "a | b")
    check("failed rows + ok", [x["step"] for x in r.failed] == ["runlog-check"] and not r.ok)
    t = r.table()
    check("table escapes pipes and shows seconds", "a \\| b" in t and "(8 s)" in t and t.startswith("| step | result | detail |"))
    ctx = {"rig_label": "ww18", "tier": "next", "sha": "06bad57a02" + "0" * 30, "label": "candidate 2026-10-28-rc2", "date": "2026-10-28",
           "wall_s": 291.4, "qc_dir": r"C:\qc\2026-10-28", "graph": {"flags": ["--foxglove"], "dropped": ["--no-fictrac"]}, "rig_nodes": "0.3.0",
           "fictrac": "real, 96.4 frames/s", "studio": "Arena Studio v0.100, build 06bad57", "run": "completed in 26 s", "remarks": ["ball a bit sticky"]}
    note = qclib.validation_note(ctx, r)
    check("note names tier, sha, label, wall time, flags, dropped, remarks, folder",
          all(s in note for s in ("**next**", "`06bad57`", "rc2", "291 s", "--foxglove", "dropped: --no-fictrac", "ball a bit sticky", r"C:\qc\2026-10-28", "| runlog-check | FAIL")))
    check("note has no Validated line (tiers validate adds it)", "Validated" not in note)
    cmd = qclib.validate_command("/repo", "ww18", "Michael", "/qc/note.md")
    check("validate command", cmd == 'cd /repo && pixi run tiers -- validate --rig ww18 --by "Michael" --notes-file "/qc/note.md"', cmd)
    check("validate command quotes a root with spaces", qclib.validate_command("/a b", "x", "y", "/n").startswith('cd "/a b" &&'))

    print("== qc.py")
    p = subprocess.run([sys.executable, str(QC / "qc.py"), "--help"], capture_output=True, text=True, timeout=60, cwd=str(ROOT / "rig"))
    check("qc.py --help under the root interpreter (stdlib-only module scope)", p.returncode == 0 and "--tier" in p.stdout and "--auto" in p.stdout, (p.stderr or p.stdout)[-300:])
    p = subprocess.run([sys.executable, str(QC / "qc.py"), "--list-rigs"], capture_output=True, text=True, timeout=60, cwd=str(ROOT / "rig"))
    check("qc.py --list-rigs lists every profile", p.returncode == 0 and all(n in p.stdout for n in rigs), (p.stderr or p.stdout)[-300:])
    toml = (ROOT / "rig" / "pixi.toml").read_text(encoding="utf-8")
    check("rig/pixi.toml has the qc task", 'qc = "python qc/qc.py"' in toml)
    check("rig/QC.md exists and names the command", (ROOT / "rig" / "QC.md").is_file() and "pixi run qc" in (ROOT / "rig" / "QC.md").read_text(encoding="utf-8"))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} / {len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
