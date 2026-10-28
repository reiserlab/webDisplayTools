"""qclib.py — the pure, stdlib-only half of `pixi run qc` (rig/qc/qc.py): profile table, build.json,
flag filtering, URL building, FicTrac config rewriting, the pass/fail table and the validation note.

Everything here is testable without a rig (tests/test-rig-qc.py at the repository root runs it under
the root pixi environment on every CI platform). No subprocesses, no sockets, no ROS.
"""

from __future__ import annotations

import copy
import json
import os
import re
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROFILES = HERE / "profiles.toml"
TIERS = {"next": "next", "production": "prod", "prod": "prod"}


# ── profiles ─────────────────────────────────────────────────────────────────


def load_profiles(path: Path | str = PROFILES) -> dict:
    with open(path, "rb") as fh:
        data = tomllib.load(fh)
    if "defaults" not in data or "rigs" not in data or not data["rigs"]:
        raise ValueError(f"{path}: needs a [defaults] table and at least one [rigs.<name>]")
    return data


def rig_names(profiles: dict) -> list[str]:
    return sorted(profiles["rigs"])


def detect_rig(profiles: dict, hostname: str) -> str | None:
    """The rig whose `hosts` list names this machine (case-insensitive, domain stripped)."""
    short = (hostname or "").split(".")[0].strip().lower()
    if not short:
        return None
    for name, rig in profiles["rigs"].items():
        if short in [str(h).split(".")[0].lower() for h in rig.get("hosts", [])]:
            return name
    return None


def _merge_checklist(base: list, over: list) -> list:
    out = [dict(x) for x in base]
    for item in over or []:
        for i, b in enumerate(out):
            if b.get("id") == item.get("id"):
                out[i] = dict(item)
                break
        else:
            out.append(dict(item))
    return out


def resolve_rig(profiles: dict, name: str) -> dict:
    """The rig's table with every missing key filled from [defaults]; `checklist` merged by id."""
    if name not in profiles["rigs"]:
        raise KeyError(f"unknown rig {name!r}; known: {', '.join(rig_names(profiles))}")
    d = copy.deepcopy(profiles["defaults"])
    r = copy.deepcopy(profiles["rigs"][name])
    out = dict(d)
    for k, v in r.items():
        if k == "checklist":
            continue
        if isinstance(v, dict) and isinstance(d.get(k), dict):
            m = dict(d[k])
            m.update(v)
            out[k] = m
        else:
            out[k] = v
    out["checklist"] = _merge_checklist(d.get("checklist", []), r.get("checklist", []))
    out["name"] = name
    out.setdefault("rig_flags", [])
    out.setdefault("requires", [])
    out.setdefault("fictrac", {"kind": "none"})
    out.setdefault("protocol", {})
    out.setdefault("reports", {"closed_loop": False, "holds": []})
    out.setdefault("foxglove", {})
    return out


def checklist_for(rig: dict) -> dict:
    return {str(item["id"]): str(item.get("look", "")) for item in rig.get("checklist", [])}


def tier_key(tier: str) -> str:
    t = (tier or "").strip().lower()
    if t not in TIERS:
        raise ValueError(f"tier must be next or prod, not {tier!r}")
    return TIERS[t]


def tier_base(rig: dict, tier: str) -> str:
    return rig["tier_url"][tier_key(tier)].rstrip("/")


def qc_root(rig: dict, os_name: str = os.name, home: str | None = None) -> Path:
    raw = rig["qc_root"]["nt" if os_name == "nt" else "posix"]
    p = Path(os.path.expanduser(raw) if home is None else raw.replace("~", home))
    return p


def parse_version(s: str) -> tuple:
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", s or "")
    if not m:
        return ()
    return tuple(int(x or 0) for x in m.groups())


# ── the tier's build ─────────────────────────────────────────────────────────


def parse_build_json(text: str) -> dict:
    """`build.json` of a tier → {sha, channel, label, placeholder}. A Next placeholder has no sha."""
    b = json.loads(text)
    sha = str(b.get("sha") or "")
    cand = b.get("candidate") or {}
    if cand.get("label"):
        label = str(cand["label"])
    elif sha:
        label = f"{b.get('channel', '?')} {sha[:7]}"
    else:
        label = str(b.get("reason") or "placeholder")
    return {
        "sha": sha,
        "channel": str(b.get("channel") or ""),
        "label": label,
        "built_at": str(b.get("built_at_et") or b.get("built_at") or ""),
        "prs": [p.get("number") for p in cand.get("prs", []) if isinstance(p, dict)],
        "placeholder": not bool(sha),
    }


# ── rig.py flags ─────────────────────────────────────────────────────────────


def help_flags(help_text: str) -> set[str]:
    """Every `--flag` an argparse --help text advertises."""
    return set(help_spec(help_text))


def help_spec(help_text: str) -> dict[str, bool]:
    """`--flag` → takes a value? (argparse prints `[--viz-args VIZ_ARGS]` for a valued option)."""
    spec: dict[str, bool] = {}
    for flag, metavar in re.findall(r"(?<![\w-])(--[a-z][a-z0-9-]*)(?:[ =]([A-Z][A-Z0-9_]*))?", help_text or ""):
        spec[flag] = spec.get(flag, False) or bool(metavar)
    return spec


def _looks_like_value(tok: str, known: dict[str, bool]) -> bool:
    """A profile flag's value: anything that is not a flag — `C:\\qc\\x`, or a quoted-style pass-through such
    as `--sources bias` (the whole `--viz-args` value is ONE token, and it starts with `--`)."""
    return (not tok.startswith("--")) or (" " in tok) or (tok.split("=")[0] not in known and " " in tok)


def filter_rig_flags(flags: list[str], help_text: str) -> tuple[list[str], list[str]]:
    """Drop the flags (and their values) the candidate's rig.py does not know.

    Returns (kept, dropped). A known flag that takes a value (per --help) keeps the next token verbatim.
    An unknown flag is dropped together with the next token when that token is a value (it does not
    start with `--`, or it is a pass-through like `--video-dir C:\\qc` with a space inside)."""
    known = help_spec(help_text)
    kept, dropped = [], []
    i = 0
    while i < len(flags):
        tok = str(flags[i])
        nxt = str(flags[i + 1]) if i + 1 < len(flags) else None
        name = tok.split("=")[0]
        if tok.startswith("--") and name not in known:
            dropped.append(tok)
            i += 2 if (nxt is not None and _looks_like_value(nxt, known)) else 1
            continue
        kept.append(tok)
        if tok.startswith("--") and known.get(name) and nxt is not None and "=" not in tok:
            kept.append(nxt)
            i += 2
        else:
            i += 1
    return kept, dropped


def substitute(flags: list[str], subs: dict) -> list[str]:
    """`{qc_dir}`-style placeholders in flag values."""
    out = []
    for f in flags:
        s = str(f)
        for k, v in subs.items():
            s = s.replace("{" + k + "}", str(v))
        out.append(s)
    return out


# ── Studio URL ───────────────────────────────────────────────────────────────


def studio_url(base: str, studio_rig: str, protocol: dict | None) -> str:
    """`arena_studio.html?mode=run&rig=…[&p=<key>]` — a protocol that has a registry key loads by
    URL; one that only has a path is loaded through the page (Studio.loadProtocol) by qc.py."""
    q = f"mode=run&rig={studio_rig}"
    if protocol and protocol.get("key"):
        q += f"&p={protocol['key']}"
    return f"{base}/arena_studio.html?{q}"


def protocol_url(base: str, protocol: dict) -> str | None:
    p = (protocol or {}).get("path")
    return f"{base}/{p.lstrip('./')}" if p else None


# ── FicTrac sample config (Mac dry run) ──────────────────────────────────────


def fictrac_config_for_qc(text: str, sock_port: int = 60000, sock_host: str = "127.0.0.1",
                          src_fn: str | None = None, display: bool = False, src_fps: float | None = None) -> str:
    """Rewrite a FicTrac config: UDP output to the gateway's adapter, optional src_fn, no window, and
    `src_fps` so a VIDEO source is paced (FicTrac plays a file as fast as it can otherwise — 600 fps)."""
    keys = {"sock_port": str(sock_port), "sock_host": sock_host, "do_display": "y" if display else "n"}
    if src_fn:
        keys["src_fn"] = src_fn
    if src_fps:
        keys["src_fps"] = f"{src_fps:g}"
    lines, seen = [], set()
    for line in text.splitlines():
        m = re.match(r"^\s*([A-Za-z_0-9]+)\s*:", line)
        if m and m.group(1) in keys:
            lines.append(f"{m.group(1):<16} : {keys[m.group(1)]}")
            seen.add(m.group(1))
        else:
            lines.append(line)
    for k, v in keys.items():
        if k not in seen:
            lines.append(f"{k:<16} : {v}")
    return "\n".join(lines) + "\n"


# ── results ──────────────────────────────────────────────────────────────────


class Results:
    """Ordered pass/fail rows; `verdict` is PASS / FAIL / SKIP / LOOK (Michael's eyes)."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, step: str, verdict: str, detail: str = "", seconds: float | None = None) -> None:
        self.rows.append({"step": step, "verdict": verdict, "detail": detail, "seconds": seconds})

    @property
    def failed(self) -> list[dict]:
        return [r for r in self.rows if r["verdict"] == "FAIL"]

    @property
    def ok(self) -> bool:
        return not self.failed

    def table(self) -> str:
        out = ["| step | result | detail |", "|---|---|---|"]
        for r in self.rows:
            t = f" ({r['seconds']:.0f} s)" if r.get("seconds") else ""
            out.append(f"| {r['step']}{t} | {r['verdict']} | {_cell(r['detail'])} |")
        return "\n".join(out)


def _cell(s: str) -> str:
    return str(s or "").replace("|", "\\|").replace("\n", " ")


def validation_note(ctx: dict, results: Results) -> str:
    """The note `pixi run tiers -- validate --notes-file` posts (it prefixes the Validated line)."""
    lines = [
        f"Five-minute QC (`pixi run qc`) on **{ctx['rig_label']}** — tier **{ctx['tier']}**, build "
        f"`{ctx['sha'][:7]}` ({ctx['label']}), {ctx['date']}, {ctx['wall_s']:.0f} s wall.",
        "",
    ]
    graph = ctx.get("graph") or {}
    if graph:
        lines.append(f"Graph: `pixi run rig -- {' '.join(graph.get('flags', []))}`".rstrip() +
                     (f" (dropped: {' '.join(graph['dropped'])})" if graph.get("dropped") else "") +
                     f"; rig_nodes {ctx.get('rig_nodes', '?')}; FicTrac: {ctx.get('fictrac', 'none')}.")
    if ctx.get("studio"):
        lines.append(f"Studio: {ctx['studio']}.")
    if ctx.get("run"):
        lines.append(f"Run: {ctx['run']}.")
    lines += ["", results.table(), ""]
    if ctx.get("remarks"):
        lines.append("Remarks: " + "; ".join(ctx["remarks"]))
    lines.append(f"Artifacts: `{ctx['qc_dir']}`")
    return "\n".join(lines) + "\n"


def validate_command(repo_root: str, rig: str, by: str, notes_file: str) -> str:
    root = str(repo_root)
    q = '"' if " " in root else ""
    return f"cd {q}{root}{q} && pixi run tiers -- validate --rig {rig} --by \"{by}\" --notes-file \"{notes_file}\""
