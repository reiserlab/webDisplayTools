#!/usr/bin/env python3
"""qc.py — the five-minute release validation of a webDisplayTools tier, run on a rig PC.

    pixi run qc -- --tier next                 # the live candidate on /next/, rig detected from the hostname
    pixi run qc -- --tier prod --rig ww18      # what Production serves, on ww18's profile
    pixi run qc -- --tier next --rig ww14 --auto   # no Enter prompts (a Claude session drives it)
    pixi run qc -- --list-rigs

One command replaces the hour of hand-driven QC (docs/development/handover-qc-windows-2026-10-26.md):

  1. preflight    rig profile (rig/qc/profiles.toml), ports 7447/8765/60000 free, the rig's services up
  2. candidate    the tier's build.json → SHA; a scratch git worktree of exactly that commit
  3. install      `pixi install --locked` in the worktree (its own environment; the rig's checkout and
                  .pixi are never touched), plus `typed` / `viz` where the rig uses them
  4. graph        the candidate's `pixi run rig` with the rig's flags (unknown flags dropped with a warning),
                  bags + run logs in the dated QC folder; Foxglove opened on the rig's layout
  5. fictrac      the rig's FicTrac (started if needed), frames counted at the gateway; simulator fallback
  6. pre-check    rig/tests/studio_emulator.py speaks the Studio's exact conversation — a broken
                  candidate fails HERE, before anyone looks at a browser
  7. browser      Chrome (a QC profile, no course token) on the tier's arena_studio.html, driven over the
                  DevTools protocol: build SHA + footer checked, protocol loaded, bridge connected,
                  then the ONE human click (Web Serial port picker), then the run (Run experiment)
  8. reports      `pixi run export` (closes the bag), runlog-check, closed-loop-report, bench-check
  9. teardown     everything stopped, ports free, pass/fail table + a ready-to-paste validation note

Interactive by default: a LOOK line per step says what to confirm, Enter moves on (anything typed is
kept as a remark). `--auto` never reads stdin — each step advances when its automated check holds —
for a Claude Code session driving the rig while Michael confirms in chat.

Artifacts: <qc-root>/<YYYY-MM-DD>/ (qc.log, graph.log, runlogs/, exports/, reports/, summary.md,
validation-note.md); the worktree at <qc-root>/wt/<sha7>; the Chrome profile at <qc-root>/chrome-profile.
Exit 0 when every automated check passed.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RIG_DIR = HERE.parent
REPO = RIG_DIR.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "scripts" / "studio-smoke"))

import qclib  # noqa: E402

CDP_PORT = 9333
RUN_POLL_S = 0.5


class QCError(Exception):
    pass


# ── logging ──────────────────────────────────────────────────────────────────


class Log:
    def __init__(self, path: Path) -> None:
        self.fh = open(path, "a", encoding="utf-8")
        self.t0 = time.monotonic()

    def _w(self, line: str) -> None:
        stamp = f"{time.monotonic() - self.t0:6.1f}s"
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
        self.fh.write(f"[{stamp}] {line}\n")
        self.fh.flush()

    def info(self, msg: str) -> None:
        self._w("   " + msg)

    def warn(self, msg: str) -> None:
        self._w("   WARN " + msg)

    def step(self, n: int, total: int, title: str) -> None:
        self._w("")
        self._w(f"[{n}/{total}] {title}")

    def look(self, text: str) -> None:
        self._w("")
        self._w("   LOOK > " + text)

    def click(self, text: str) -> None:
        self._w("")
        self._w("   CLICK > " + text)

    def result(self, verdict: str, step: str, detail: str = "") -> None:
        self._w(f"   [{verdict}] {step}" + (f" — {detail}" if detail else ""))


# ── small helpers ────────────────────────────────────────────────────────────


def run(argv: list[str], cwd: Path | str | None = None, env: dict | None = None, timeout: float = 600,
        check: bool = False) -> subprocess.CompletedProcess:
    p = subprocess.run([str(a) for a in argv], cwd=str(cwd) if cwd else None, env=env, capture_output=True,
                       text=True, timeout=timeout, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        raise QCError(f"`{' '.join(str(a) for a in argv[:4])}…` failed ({p.returncode}): "
                      f"{(p.stderr or p.stdout).strip()[-800:]}")
    return p


def http_get(url: str, timeout: float = 20) -> str:
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "Pragma": "no-cache",
                                               "User-Agent": "webDisplayTools-qc"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def process_running(name: str) -> bool:
    if not name:
        return False
    try:
        if os.name == "nt":
            p = run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH", "/FO", "CSV"], timeout=20)
            return name.lower() in p.stdout.lower()
        p = run(["pgrep", "-x", name], timeout=10)
        return p.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def open_url(url: str) -> bool:
    try:
        if os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
            return True
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        return subprocess.run([opener, url], capture_output=True, timeout=20).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def newest_bag(runlogs: Path) -> Path | None:
    bags = sorted(runlogs.glob("*.bag"), key=lambda p: p.stat().st_mtime) if runlogs.is_dir() else []
    return bags[-1] if bags else None


class Proc:
    """A child in its own process group whose output goes to a file (+ chosen lines echoed)."""

    def __init__(self, name: str, argv: list[str], log_path: Path, cwd: Path | None = None, env: dict | None = None,
                 echo: "callable | None" = None) -> None:
        from rig_nodes.supervise import popen_group  # type: ignore[import-not-found]

        self.name = name
        self.log_path = log_path
        self.fh = open(log_path, "a", encoding="utf-8")
        self.p = popen_group([str(a) for a in argv], cwd=str(cwd) if cwd else None, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
        self.echo = echo
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.p.stdout
        for line in self.p.stdout:
            self.fh.write(line)
            self.fh.flush()
            if self.echo:
                try:
                    self.echo(line.rstrip("\n"))
                except Exception:  # noqa: BLE001
                    pass

    def alive(self) -> bool:
        return self.p.poll() is None

    def stop(self, grace_s: float = 10.0) -> None:
        from rig_nodes.supervise import SIGKILL, signal_group  # type: ignore[import-not-found]

        if not self.alive():
            return
        try:
            signal_group(self.p, signal.SIGINT)
            self.p.wait(grace_s)
        except subprocess.TimeoutExpired:
            signal_group(self.p, signal.SIGTERM)
            try:
                self.p.wait(5)
            except subprocess.TimeoutExpired:
                signal_group(self.p, SIGKILL)
        except (ProcessLookupError, OSError, ValueError):
            pass
        self.fh.flush()

    def tail(self, n: int = 12) -> str:
        try:
            return "\n".join(self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
        except OSError:
            return ""


# ── gateway probes (websockets) ──────────────────────────────────────────────


async def _probe(url: str, seconds: float) -> dict:
    from websockets.asyncio.client import connect

    out: dict = {"hello_ack": None, "frames": 0, "seconds": seconds}
    async with connect(url, max_size=16 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "hello", "client": "webDisplayTools", "v": 1}))
        end = asyncio.get_running_loop().time() + seconds
        while True:
            remaining = end - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), remaining)
            except asyncio.TimeoutError:
                break
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if m.get("type") == "hello_ack":
                out["hello_ack"] = {k: v for k, v in m.items() if k != "type"}
            elif m.get("type") == "frame":
                out["frames"] += 1
    out["rate_hz"] = round(out["frames"] / seconds, 1) if seconds else 0
    return out


def probe_gateway(url: str, seconds: float) -> dict:
    return asyncio.run(_probe(url, seconds))


# ── the QC run ───────────────────────────────────────────────────────────────


class QC:
    TOTAL = 9

    def __init__(self, a: argparse.Namespace) -> None:
        self.a = a
        self.profiles = qclib.load_profiles()
        name = a.rig or qclib.detect_rig(self.profiles, socket.gethostname())
        if not name:
            raise QCError(f"this host ({socket.gethostname()}) is not in rig/qc/profiles.toml — pass --rig "
                          f"({', '.join(qclib.rig_names(self.profiles))}) or add a row")
        self.rig = qclib.resolve_rig(self.profiles, name)
        self.tier = qclib.tier_key(a.tier)
        self.base = qclib.tier_base(self.rig, self.tier)
        self.root = Path(a.qc_root).expanduser() if a.qc_root else qclib.qc_root(self.rig)
        self.date = dt.date.today().isoformat()
        self.qc_dir = self.root / self.date
        for sub in ("runlogs", "exports", "reports", "bias"):
            (self.qc_dir / sub).mkdir(parents=True, exist_ok=True)
        self.log = Log(self.qc_dir / "qc.log")
        self.results = qclib.Results()
        self.look_text = qclib.checklist_for(self.rig)
        self.remarks: list[str] = []
        self.t_start = time.monotonic()
        self.procs: dict[str, Proc] = {}
        self.chrome: subprocess.Popen | None = None
        self.page = None
        self.ctx: dict = {"rig_label": self.rig.get("label", name), "tier": self.tier, "date": self.date,
                          "qc_dir": str(self.qc_dir), "sha": "", "label": ""}
        self.sha = ""
        self.wt: Path | None = None
        self.env: dict | None = None
        self.py: str = sys.executable
        self.manifest: Path | None = None
        self.kept_flags: list[str] = []
        self.fictrac_mode = "none"
        self.export_path: Path | None = None
        self.studio_ran = False
        self.run_summary: dict | None = None
        self.channel = "next" if self.tier == "next" else "production"

    # ── prompts ──
    def pause(self, prompt: str = "Enter = looks right (type a remark to keep it)") -> str:
        if self.a.auto:
            return ""
        try:
            s = input(f"   {prompt}: ").strip()
        except EOFError:
            sys.stdout.write("\n")
            return ""
        if s:
            self.remarks.append(s)
            self.log.fh.write(f"   remark: {s}\n")
        return s

    def look(self, step_id: str, extra: str = "") -> None:
        text = self.look_text.get(step_id, "")
        if not text and not extra:
            return
        self.log.look((text + (" " + extra if extra else "")).strip())
        remark = self.pause()
        self.results.add(f"look: {step_id}", "LOOK", remark or ("confirm in chat" if self.a.auto else "looked right"))

    def record(self, step: str, ok: bool, detail: str = "", seconds: float | None = None, fatal: bool = False) -> bool:
        v = "PASS" if ok else "FAIL"
        self.results.add(step, v, detail, seconds)
        self.log.result(v, step, detail)
        if not ok and fatal:
            raise QCError(f"{step}: {detail}")
        return ok

    def skip(self, step: str, why: str) -> None:
        self.results.add(step, "SKIP", why)
        self.log.result("SKIP", step, why)

    # ── 1 preflight ──
    def preflight(self) -> None:
        from rig_nodes.supervise import preflight  # type: ignore[import-not-found]

        self.log.step(1, self.TOTAL, f"preflight — rig {self.rig['name']} ({self.rig.get('label', '')}), tier {self.tier}")
        self.log.info(f"QC folder: {self.qc_dir}")
        pv = run(["pixi", "--version"], timeout=30).stdout.strip()
        ok = qclib.parse_version(pv) >= qclib.parse_version(self.rig["min_pixi"])
        self.record("pixi >= " + self.rig["min_pixi"], ok, pv or "pixi not found", fatal=True)
        self.record("git available", shutil.which("git") is not None, shutil.which("git") or "git not on PATH", fatal=True)
        ports = [tuple(p) for p in self.rig["ports"]]
        if "--foxglove" in self.rig.get("rig_flags", []) and not self.a.no_foxglove:
            ports.append(("tcp", int(self.rig["foxglove_port"]), "another foxglove_bridge"))
        taken = preflight(ports)
        self.record("ports free (7447/8765/60000…)", not taken, "\n".join(taken) if taken else "nothing bound", fatal=True)
        missing = []
        from rig_nodes.supervise import port_in_use  # type: ignore[import-not-found]

        for proto, port, who in self.rig.get("requires", []):
            if not port_in_use(proto, int(port)):
                missing.append(f"{proto} {port}: {who}")
        if missing and not self.a.skip_requires:
            self.record("required services up", False, "; ".join(missing), fatal=True)
        elif missing:
            self.record("required services up", True, "SKIPPED (--skip-requires): " + "; ".join(missing))
        else:
            self.record("required services up", True, "none required" if not self.rig.get("requires") else "all answering")
        if not self.a.no_browser:
            try:
                import cdp  # type: ignore[import-not-found]

                chrome = cdp.find_chrome(self.a.chrome)
                self.record("Chrome/Edge found", True, chrome)
            except SystemExit as e:
                self.record("Chrome/Edge found", False, str(e))
                self.a.no_browser = True

    # ── 2 candidate ──
    def candidate(self) -> None:
        self.log.step(2, self.TOTAL, f"candidate — {self.base}/build.json")
        info = None
        try:
            info = qclib.parse_build_json(http_get(self.base + "/build.json"))
        except Exception as e:  # noqa: BLE001
            if not self.a.sha:
                raise QCError(f"cannot read {self.base}/build.json: {e}") from e
            self.log.warn(f"build.json unreadable ({e}); using --sha")
        sha = (self.a.sha or (info or {}).get("sha") or "").lower()
        if info and info["placeholder"] and not self.a.sha:
            raise QCError(f"{self.tier} is a placeholder ({info['label']}) — nothing to validate (or pass --sha)")
        if info and self.a.sha and info["sha"] and not info["sha"].startswith(self.a.sha.lower()):
            self.log.warn(f"--sha {self.a.sha} differs from the tier's build {info['sha'][:7]} — validating what you asked for")
        if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
            raise QCError(f"no usable SHA ({sha!r})")
        label = (info or {}).get("label") or sha[:7]
        self.log.info(f"build: {label}  sha {sha[:10]}  built {(info or {}).get('built_at', '?')}"
                      + (f"  PRs {(info or {}).get('prs')}" if (info or {}).get("prs") else ""))
        # fetch + scratch worktree
        run(["git", "-C", REPO, "worktree", "prune"], timeout=60)
        if run(["git", "-C", REPO, "cat-file", "-e", f"{sha}^{{commit}}"], timeout=30).returncode != 0:
            f = run(["git", "-C", REPO, "fetch", "--quiet", "origin", sha], timeout=300)
            if f.returncode != 0:
                run(["git", "-C", REPO, "fetch", "--quiet", "origin"], timeout=300)
            if run(["git", "-C", REPO, "cat-file", "-e", f"{sha}^{{commit}}"], timeout=30).returncode != 0:
                raise QCError(f"commit {sha[:10]} not found on origin after fetch")
        full = run(["git", "-C", REPO, "rev-parse", f"{sha}^{{commit}}"], timeout=30, check=True).stdout.strip()
        self.sha = full
        self.ctx.update({"sha": full, "label": label})
        wt = self.root / "wt" / full[:7]
        if wt.exists():
            head = run(["git", "-C", wt, "rev-parse", "HEAD"], timeout=30).stdout.strip()
            if head != full:
                run(["git", "-C", wt, "checkout", "--quiet", "--detach", full], timeout=120, check=True)
            self.log.info(f"worktree reused: {wt}")
        else:
            wt.parent.mkdir(parents=True, exist_ok=True)
            run(["git", "-C", REPO, "worktree", "add", "--detach", wt, full], timeout=300, check=True)
            self.log.info(f"worktree created: {wt}")
        dirty = run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"], timeout=60).stdout.strip()
        self.record("scratch worktree at the candidate SHA", not dirty, f"{wt} @ {full[:7]}" + (f"; DIRTY: {dirty[:200]}" if dirty else ""), fatal=True)
        self.wt = wt
        self.manifest = wt / "rig" / "pixi.toml"
        if not self.manifest.is_file():
            raise QCError(f"{self.manifest} missing — this build has no rig/ workspace")

    # ── 3 install ──
    def install(self) -> None:
        assert self.wt and self.manifest
        self.log.step(3, self.TOTAL, "install — the candidate's own pixi environment(s), `--locked`")
        envs = list(dict.fromkeys(["default", *self.rig["envs"]]))
        if self.a.no_foxglove and "viz" in envs:
            envs.remove("viz")
        for env in envs:
            if self.a.skip_install:
                self.skip(f"pixi install -e {env}", "--skip-install")
                continue
            t0 = time.monotonic()
            p = run(["pixi", "install", "--locked", "--manifest-path", self.manifest, "-e", env], cwd=self.wt / "rig", timeout=3600)
            msg = [line.strip() for line in (p.stderr or p.stdout).strip().splitlines() if line.strip()]
            errs = [line for line in msg if "Error" in line or "×" in line or "requires-pixi" in line]
            tail = " | ".join((errs or msg)[-3:])
            self.record(f"pixi install -e {env}", p.returncode == 0, tail[-300:], time.monotonic() - t0, fatal=True)
        probe = run(["pixi", "run", "--manifest-path", self.manifest, "--locked", "-e", "default", "python", "-c",
                     "import os,sys,json;print(json.dumps({'exe':sys.executable,'env':dict(os.environ)}))"],
                    cwd=self.wt / "rig", timeout=300, check=True)
        try:
            d = json.loads(probe.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError) as e:
            raise QCError(f"could not read the environment: {probe.stdout[-300:]} {probe.stderr[-300:]}") from e
        self.py, self.env = d["exe"], d["env"]
        ver = "?"
        lst = run(["pixi", "list", "--manifest-path", self.manifest, "--locked", "--json"], cwd=self.wt / "rig", timeout=300)
        try:
            for pkg in json.loads(lst.stdout):
                if pkg.get("name") == "rig_nodes":
                    ver = pkg.get("version", "?")
        except ValueError:
            pass
        self.ctx["rig_nodes"] = ver
        self.record("environment usable", True, f"python {self.py}; rig_nodes {ver}")

    # ── 4 graph ──
    def graph(self) -> None:
        assert self.wt and self.env
        from rig_nodes.supervise import wait_port  # type: ignore[import-not-found]

        self.log.step(4, self.TOTAL, "graph — the candidate's `pixi run rig` with this rig's flags")
        rig_py = self.wt / "rig" / "nodes" / "rig.py"
        helptext = run([self.py, rig_py, "--help"], cwd=self.wt / "rig", env=self.env, timeout=120).stdout
        flags = qclib.substitute(list(self.rig["rig_flags"]), {"qc_dir": str(self.qc_dir)})
        if self.a.no_foxglove and "--foxglove" in flags:
            flags.remove("--foxglove")
        kept, dropped = qclib.filter_rig_flags(flags, helptext)
        if dropped:
            self.log.warn(f"flags this build's rig.py does not know, dropped: {' '.join(dropped)}")
        kept += ["--bridge-args", f"--log-dir {self.qc_dir / 'runlogs'}"]
        self.kept_flags = kept
        self.ctx["graph"] = {"flags": kept, "dropped": dropped}
        self.log.info("pixi run rig -- " + " ".join(kept))
        echo = lambda line: self.log.info("  " + line) if ("[rig]" in line or "Traceback" in line or "Error" in line) else None  # noqa: E731
        self.procs["graph"] = Proc("graph", [self.py, rig_py, *kept], self.qc_dir / "graph.log", cwd=self.wt / "rig", env=self.env, echo=echo)
        t0 = time.monotonic()
        up = wait_port("127.0.0.1", 7447, 60) and wait_port("127.0.0.1", 8765, 60)
        if not self.procs["graph"].alive():
            up = False
        self.record("router :7447 + gateway :8765 up", up, f"{time.monotonic() - t0:.1f} s" if up else self.procs["graph"].tail(), fatal=True)
        time.sleep(1.0)
        if "--foxglove" in kept:
            fport = int(self.rig["foxglove_port"])
            if wait_port("127.0.0.1", fport, 45):
                layout = self.rig.get("foxglove", {}).get("layout")
                url = f"foxglove://open?ds=foxglove-websocket&ds.url=ws://localhost:{fport}"
                opened = open_url(url)
                self.record("foxglove_bridge :8766 up", True, "Foxglove opened on it" if opened else "open Foxglove → Open connection → ws://localhost:8766")
                if layout:
                    self.log.info(f"Foxglove layout (Layout → Import from file, once): {self.wt / 'rig' / layout}")
            else:
                self.record("foxglove_bridge :8766 up", False, "not listening within 45 s (viz environment installed? graph.log has the note)")
        self.look("graph")

    # ── 5 fictrac ──
    def fictrac(self) -> None:
        assert self.wt and self.env
        ft = self.rig.get("fictrac", {"kind": "none"})
        kind = ft.get("kind", "none")
        self.log.step(5, self.TOTAL, f"fictrac — {kind}")
        url = self.rig["gateway_url"]
        if kind == "none":
            pr = probe_gateway(url, 2.0)
            ack = pr.get("hello_ack") or {}
            self.record("gateway hello_ack", bool(ack), f"bridge {str(ack.get('bridge', ''))[:40]}; connectors {ack.get('connectors')}", fatal=True)
            self.ctx["fictrac"] = "none (this rig has no FicTrac)"
            self.fictrac_mode = "none"
            self.look("fictrac")
            return
        started = False
        if process_running(ft.get("process", "")):
            self.log.info(f"{ft.get('process')} is already running — using it")
            self.fictrac_mode = f"{kind} (already running)"
        else:
            argv, cwd = self._fictrac_argv(ft)
            self.log.info("starting FicTrac: " + " ".join(str(a) for a in argv) + f"  (cwd {cwd})")
            self.procs["fictrac"] = Proc("fictrac", argv, self.qc_dir / "fictrac.log", cwd=cwd)
            started = True
            self.fictrac_mode = kind
        secs = float(self.rig["frames_probe_s"])
        time.sleep(3.0)
        pr = probe_gateway(url, secs)
        ack = pr.get("hello_ack") or {}
        self.record("gateway hello_ack", bool(ack), f"bridge {str(ack.get('bridge', ''))[:40]}", fatal=True)
        rate = pr["rate_hz"]
        if rate <= 0 and ft.get("fallback") == "sim":
            self.log.warn(f"no FicTrac frames in {secs:.0f} s" + (f" — FicTrac log tail:\n{self.procs['fictrac'].tail(6)}" if started else ""))
            if started:
                self.procs.pop("fictrac").stop()
            self.log.info("starting the FicTrac simulator instead (--proto udp --rate 50)")
            self.procs["sim"] = Proc("sim", [self.py, "-m", "rig_nodes.sims.fictrac_sim", "--proto", "udp", "--rate", "50"],
                                     self.qc_dir / "sim.log", cwd=self.wt / "rig", env=self.env)
            time.sleep(2.0)
            rate = probe_gateway(url, 3.0)["rate_hz"]
            self.fictrac_mode = "SIM (FicTrac gave no frames)"
        self.ctx["fictrac"] = f"{self.fictrac_mode}, {rate} frames/s at the gateway"
        self.record("FicTrac frames at the gateway", rate > 0, f"{rate} frames/s ({self.fictrac_mode})", fatal=True)
        self.look("fictrac", f"[{rate} frames/s]")

    def _fictrac_argv(self, ft: dict) -> tuple[list[str], Path]:
        cmd = [os.path.expanduser(str(c)) for c in ft.get("cmd", [])]
        if not cmd:
            raise QCError("fictrac.cmd is empty in the profile")
        if ft.get("kind") == "sample":
            src = Path(os.path.expanduser(ft["sample_dir"]))
            dst = self.root / "fictrac-sample"
            if not (dst / "config.txt").exists():
                shutil.copytree(src, dst, dirs_exist_ok=True)
            cfg = (dst / "config.txt").read_text(encoding="utf-8", errors="replace")
            video = re.search(r"^\s*src_fn\s*:\s*(\S+)", cfg, re.M)
            src_fn = video.group(1) if video else "sample.mp4"
            loop_s = int(ft.get("loop_s", 0) or 0)
            looped = dst / "sample_loop.mp4"
            if loop_s and shutil.which("ffmpeg") and not looped.exists():
                n = max(1, loop_s // 10)
                r = run(["ffmpeg", "-y", "-loglevel", "error", "-stream_loop", str(n), "-i", dst / src_fn, "-c", "copy", looped], timeout=300)
                if r.returncode != 0:
                    self.log.warn("ffmpeg loop failed: " + r.stderr[-200:])
            if looped.exists():
                src_fn = looped.name
            (dst / "config.qc.txt").write_text(qclib.fictrac_config_for_qc(cfg, src_fn=src_fn, display=False, src_fps=float(ft.get("fps", 0) or 0) or None), encoding="utf-8")
            return [cmd[0], "config.qc.txt"], dst
        cwd = Path(os.path.expanduser(str(ft.get("cwd") or Path(cmd[-1]).parent)))
        if os.name == "nt" and cmd[0].lower().endswith((".bat", ".cmd")):
            cmd = ["cmd.exe", "/c", *cmd]
        return cmd, cwd

    # ── 6 pre-check ──
    def precheck(self) -> None:
        assert self.wt and self.env
        pc = self.rig["precheck"]
        self.log.step(6, self.TOTAL, "pre-check — the Studio's exact bridge conversation, no browser (studio_emulator.py)")
        emu = RIG_DIR / "tests" / "studio_emulator.py"
        out, rep = self.qc_dir / "exports" / "precheck.jsonl", self.qc_dir / "reports" / "precheck.json"
        argv = [self.py, emu, "--url", self.rig["gateway_url"], "--epochs", str(pc.get("epochs", 1)), "--epoch-s", str(pc.get("epoch_s", 4)),
                "--iti-s", "0", "--min-frames", str(pc.get("min_frames", 0)), "--rig-id", f"{self.rig['name']}-qc", "--out", out, "--report", rep]
        if pc.get("connector") == "bias":
            argv += ["--connector-cmds", "--connector-video", str(self.qc_dir / "bias" / "precheck.ufmf")]
        t0 = time.monotonic()
        p = run(argv, cwd=self.wt / "rig", env=self.env, timeout=300)
        (self.qc_dir / "reports" / "precheck.txt").write_text(p.stderr + p.stdout, encoding="utf-8")
        fails = [line.strip() for line in p.stderr.splitlines() if line.strip().startswith("FAIL")]
        self.record("pre-check: emulator assertions", p.returncode == 0, ("all PASS; " + (p.stderr.strip().splitlines() or [""])[-1][:120]) if p.returncode == 0 else "; ".join(fails)[:400] or p.stderr[-300:],
                    time.monotonic() - t0, fatal=True)
        if out.exists():
            self.export_path = out  # the emulator's run is the fallback subject for the reports
        self.look("precheck")

    # ── 7 browser ──
    def browser(self) -> None:
        self.log.step(7, self.TOTAL, "browser — the tier's Studio in Chrome (QC profile), driven over DevTools")
        if self.a.no_browser:
            self.skip("Studio in Chrome", "--no-browser")
            return
        import cdp  # type: ignore[import-not-found]

        chrome = cdp.find_chrome(self.a.chrome)
        profile = self.root / "chrome-profile"
        profile.mkdir(parents=True, exist_ok=True)
        url = qclib.studio_url(self.base, self.rig["studio_rig"], self.rig.get("protocol"))
        self.log.info(url)
        # A never-used profile has not allowed "local network access" for the Pages origin, and Chrome
        # (≥ 142) then HOLDS a ws://localhost connection on a permission prompt — the bridge stays
        # "connecting…" until someone clicks Allow (verified 2026-10-28 on Chrome 155: a DevTools
        # Browser.grantPermissions does not unblock it; this feature flag does, and it is the flag the
        # Foxglove desktop app itself runs with). The rig's everyday Chrome asked once and remembers.
        flags = [] if self.a.lna_prompt else ["--disable-features=LocalNetworkAccessChecks"]
        self.chrome = subprocess.Popen([chrome, f"--user-data-dir={profile}", f"--remote-debugging-port={CDP_PORT}", "--no-first-run",
                                        "--no-default-browser-check", *flags, "--new-window", "about:blank"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            asyncio.run(self._drive(url))
        except QCError:
            raise
        except Exception as e:  # noqa: BLE001 — DevTools unavailable: fall back to the hand-driven steps
            self.log.warn(f"DevTools drive failed ({str(e)[:200]}); falling back to manual steps")
            self.record("Studio driven over DevTools", False, str(e)[:200])
            self._manual_browser(chrome, profile, url)

    async def _drive(self, url: str) -> None:
        import cdp  # type: ignore[import-not-found]
        import websockets

        ws_url = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=1) as r:
                    pages = [t for t in json.load(r) if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.2)
        if not ws_url:
            raise RuntimeError("Chrome did not expose DevTools on :%d" % CDP_PORT)
        ws = await websockets.connect(ws_url, max_size=64 * 1024 * 1024)
        p = cdp.Page(ws)
        await p.start()
        self.page = p
        try:
            await self._drive_page(p, url)
        finally:
            p.task.cancel()
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    async def _drive_page(self, p, url: str) -> None:
        # Per-browser settings the QC needs before the page's first script runs: the telemetry ring on
        # (runlog-check needs the controller rows), and the one-time NEXT acknowledgement.
        await p.send("Page.addScriptToEvaluateOnNewDocument", {"source":
            "try{localStorage.setItem('studio_telemetry','on');sessionStorage.setItem('studio_next_ack','1');}catch(e){}"})
        await p.goto(url, settle=3.0)
        build = await p.js("(()=>{const m=document.querySelector('meta[name=\"wdt-build\"]');if(!m)return null;try{return JSON.parse(m.content)}catch(e){return {raw:m.content}}})()")
        got = str((build or {}).get("sha") or "")
        if got and not got.startswith(self.sha[:7]):
            self.log.warn(f"page build {got[:7]} ≠ candidate {self.sha[:7]} — reloading without cache once")
            await p.send("Page.reload", {"ignoreCache": True})
            await asyncio.sleep(4.0)
            build = await p.js("(()=>{const m=document.querySelector('meta[name=\"wdt-build\"]');if(!m)return null;try{return JSON.parse(m.content)}catch(e){return {raw:m.content}}})()")
            got = str((build or {}).get("sha") or "")
        footer = (await p.js("(document.querySelector('#footer .foot-left')||{}).textContent||''") or "").strip()
        self.record("page build SHA = candidate", bool(got) and got.startswith(self.sha[:7]), f"meta {got[:7] or 'missing'}; channel {(build or {}).get('channel')}; footer: {footer[:60]}")
        self.ctx["studio"] = f"{footer[:48]}, build {got[:7]}"
        # the protocol
        proto = self.rig.get("protocol") or {}
        if proto.get("key"):
            for _ in range(40):
                if await p.js("!!(window.Studio && Studio.currentDoc)"):
                    break
                await asyncio.sleep(0.25)
        elif proto.get("path"):
            text = http_get(qclib.protocol_url(self.base, proto))
            ok = await p.js("Studio.loadProtocol(%s, %s, 'committed', {landIn:'run'})" % (json.dumps(text), json.dumps(Path(proto["path"]).name)))
            if not ok:
                self.log.warn("Studio.loadProtocol returned false (banner on the page says why)")
        doc = await p.js("Studio.currentDoc?{filename:Studio.currentDoc.filename,rig:(Studio.currentDoc.rig||{}).name}:null")
        self.record("protocol loaded in the Run view", bool(doc), json.dumps(doc) if doc else "no document")
        api = await p.js("['runOnce','loadProtocol'].every(k=>typeof Studio[k]==='function')&&!!Studio.session&&!!Studio.session.bridge&&typeof Studio.session.bridge.connect==='function'")
        self.record("Studio page API the QC drives (runOnce, loadProtocol, session.bridge)", bool(api), "present" if api else "missing — the page changed; update qc.py")
        errs = [e for e in p.errors if "favicon.ico" not in e]  # the site has no favicon; a 404 there is not a page error
        self.record("no console errors on load", not errs, "; ".join(errs)[:300] or "clean")
        self.look("studio")
        # the bridge
        await p.js("(()=>{const b=Studio.session.bridge;if(b.setLogLevel)b.setLogLevel('behavior_v2');if(!b.connected)b.connect('ws://localhost:8765');return true})()")
        connected = False
        for _ in range(40):
            if await p.js("!!(Studio.session.bridge&&Studio.session.bridge.connected)"):
                connected = True
                break
            await asyncio.sleep(0.25)
        rate = 0
        if connected and self.fictrac_mode != "none":
            for _ in range(32):
                rate = await p.js("(Studio.session.bridge.stats||{}).rateHz||0")
                if rate and rate > 0:
                    break
                await asyncio.sleep(0.25)
        self.record("Studio ↔ gateway connected", connected, f"ws://localhost:8765; {rate} frames/s in the page" if connected else "bridge.connected stayed false")
        self.look("bridge", f"[{rate} frames/s]")
        if not self.rig.get("controller", True):
            self.skip("controller connect + run", "this profile has no controller")
            self.look("run")
            return
        # the one human click
        self.log.click("In the Studio: Connect → pick the controller (G6_Arena / USB Serial) in the port picker. "
                       f"Waiting up to {int(self.rig['connect_timeout_s'])} s.")
        t0 = time.monotonic()
        while time.monotonic() - t0 < float(self.rig["connect_timeout_s"]):
            if await p.js("!!(Studio.session&&Studio.session.connected)"):
                break
            if int(time.monotonic() - t0) % 30 == 0:
                self.log.info("… still waiting for the port picker")
            await asyncio.sleep(1.0)
        conn = await p.js("!!(Studio.session&&Studio.session.connected)")
        self.record("controller connected (your click)", bool(conn), f"after {time.monotonic() - t0:.0f} s" if conn else "timed out", fatal=True)
        await asyncio.sleep(4.0)  # firmware label, panel inventory, SD listing
        fw = await p.js("Studio.firmware||null")
        panels = await p.js("({status:Studio.panelsStatus||null,n:(Studio.panels&&Studio.panels.length)||0})")
        self.record("firmware label + panel inventory", bool(fw), f"firmware {fw}; panels {panels}")
        self.ctx["controller"] = f"firmware {fw}, panels {panels}"
        self.look("controller")
        # the run
        self.log.look(self.look_text.get("run", "Watch the arena while the protocol runs.") + f" (~{proto.get('duration_s', '?')} s)")
        await p.js("window.__qc={done:false};Studio.runOnce(true).then(s=>{window.__qc={done:true,summary:s===null?null:(s||{})}}).catch(e=>{window.__qc={done:true,error:String(e)}});true")
        t0 = time.monotonic()
        last_step = ""
        state = {"done": False}
        while time.monotonic() - t0 < float(self.rig["run_timeout_s"]):
            state = await p.js("window.__qc") or {"done": False}
            if state.get("done"):
                break
            step = await p.js("((document.getElementById('rpStep')||{}).textContent||'')+' '+((document.getElementById('runInlineTxt')||{}).textContent||'')")
            if step and step != last_step:
                self.log.info(f"  {step.strip()}")
                last_step = step
            await asyncio.sleep(RUN_POLL_S)
        if not state.get("done"):
            self.studio_ran = True
            self.record("Studio run", False, f"still running after {self.rig['run_timeout_s']} s — STOP it in the Studio")
            return
        s = state.get("summary")
        if s is None and not state.get("error"):
            # nothing started, so the reports below judge the pre-check's log, not a Studio run
            self.record("Studio run", False, "runOnce returned null — the run could not start (controller-settings assertion or a `requires:` gate; see the page banner)")
            return
        self.studio_ran = True
        if state.get("error"):
            self.record("Studio run", False, str(state["error"])[:300])
            return
        ok = bool(s.get("completed")) and not s.get("fault") and not s.get("bridgeLost") and not s.get("aborted")
        outcome = "completed" if ok else (s.get("fault") and f"fault {s.get('fault')}") or (s.get("bridgeLost") and "BRIDGE_LOST") or (s.get("aborted") and "aborted") or "incomplete"
        self.run_summary = s
        self.ctx["run"] = f"{outcome} in {time.monotonic() - t0:.0f} s"
        self.record("Studio run (Run experiment)", ok, f"{outcome}; steps {s.get('steps', s.get('completedSteps', '?'))}", time.monotonic() - t0)
        self.results.add("look: run", "LOOK", self.pause() or ("confirm in chat" if self.a.auto else "looked right"))

    def _manual_browser(self, chrome: str, profile: Path, url: str) -> None:
        if self.chrome and self.chrome.poll() is None:
            self.chrome.terminate()
        self.chrome = subprocess.Popen([chrome, f"--user-data-dir={profile}", "--no-first-run", "--new-window", url],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        proto = self.rig.get("protocol") or {}
        self.log.click("Hand-driven Studio steps: (1) check the footer version and the build badge; "
                       + (f"(2) Protocol ▾ → Open… {proto.get('path')}; " if not proto.get("key") else "(2) the protocol is in the URL; ")
                       + "(3) Run view → bridge Connect (ws://localhost:8765); (4) Connect → pick the controller; (5) ▶ Run experiment (confirm the NEXT dialog).")
        self.look("studio")
        self.look("bridge")
        if not self.rig.get("controller", True):
            self.skip("controller connect + run", "this profile has no controller")
            return
        self.look("controller")
        self.log.look(self.look_text.get("run", "Watch the arena while the protocol runs."))
        before = newest_bag(self.qc_dir / "runlogs")
        if self.a.auto:
            t0 = time.monotonic()
            while time.monotonic() - t0 < float(self.rig["run_timeout_s"]) + float(self.rig["connect_timeout_s"]):
                b = newest_bag(self.qc_dir / "runlogs")
                if b and b != before and (b / "metadata.yaml").exists():
                    break
                time.sleep(2.0)
        else:
            self.pause("Enter when the run has finished")
        self.studio_ran = True
        self.record("Studio run (hand-driven)", True, "judged by the reports below")

    # ── 8 reports ──
    def reports(self) -> None:
        assert self.wt and self.env
        self.log.step(8, self.TOTAL, "reports — export (closes the bag), runlog-check, closed-loop-report, bench-check")
        exp_dir = self.qc_dir / "exports"
        tmp = exp_dir / "run.jsonl"
        p = run([self.py, self.wt / "rig" / "nodes" / "export_log.py", "--url", self.rig["gateway_url"], "--json", "--out", tmp], cwd=self.wt / "rig", env=self.env, timeout=180)
        name = None
        try:
            name = json.loads(p.stdout.strip().splitlines()[-1]).get("name")
        except (ValueError, IndexError):
            pass
        if p.returncode == 0 and tmp.exists():
            final = exp_dir / (name or f"arena-log-{self.date}.jsonl")
            if final != tmp:
                if final.exists():
                    final.unlink()
                tmp.rename(final)
            if self.studio_ran:
                self.export_path = final
            identical = "identical_to_live" in (self.procs["graph"].tail(400) if "graph" in self.procs else "")
            self.record("pixi run export", True, f"{final.name}" + ("; converted == live" if identical else ""))
        else:
            self.record("pixi run export", False, (p.stderr or p.stdout).strip()[-300:])
        bag = newest_bag(self.qc_dir / "runlogs")
        self.record("bag closed + indexed (metadata.yaml)", bool(bag and (bag / "metadata.yaml").exists()), str(bag) if bag else "no bag in runlogs/")
        log = self.export_path
        if not log or not log.exists():
            self.record("run log for the reports", False, "no export to judge")
            return
        self.log.info(f"judging {log}")
        scripts = self.wt / "scripts"
        rep_dir = self.qc_dir / "reports"
        r = run([self.py, scripts / "runlog-check.py", log], env=self.env, timeout=300)
        (rep_dir / "runlog-check.txt").write_text(r.stdout + r.stderr, encoding="utf-8")
        tail = [line for line in r.stdout.splitlines() if line.strip()][-3:]
        if self.rig.get("controller", True):
            self.record("runlog-check", r.returncode == 0, " | ".join(tail)[-300:])
        else:
            self.results.add("runlog-check", "PASS" if r.returncode == 0 else "SKIP", ("no controller on this rig; " + " | ".join(tail))[-300:])
            self.log.result(self.results.rows[-1]["verdict"], "runlog-check", self.results.rows[-1]["detail"])
        epochs_json: list = []  # closed-loop-report epochs, for the hold verdict below
        if self.rig["reports"].get("closed_loop"):
            r = run([self.py, scripts / "closed-loop-report.py", "--json", log], env=self.env, timeout=300)
            (rep_dir / "closed-loop-report.json").write_text(r.stdout, encoding="utf-8")
            md = run([self.py, scripts / "closed-loop-report.py", log], env=self.env, timeout=300)
            (rep_dir / "closed-loop-report.md").write_text(md.stdout + md.stderr, encoding="utf-8")
            try:
                rep = json.loads(r.stdout)
                epochs = rep.get("epochs", []) if isinstance(rep, dict) else []
                mism = [e.get("idx_mismatch_fraction") for e in epochs if "idx_mismatch_fraction" in e]
                ok = bool(epochs) and all(m is not None and m <= 0.01 for m in mism)
                epochs_json = epochs
                self.record("closed-loop-report: idx mismatch ≤ 1 %", ok, f"{len(epochs)} epoch(s), mismatch {mism}")
                # THE start-frame check that works with a live fly on the ball: each epoch's first
                # post-tare index is its trialParams frame_index (25 / 75 in bench_closed_loop_2x10).
                # A whole-epoch "hold" cannot pass while FicTrac is live (the ball may always move).
                sf = [e for e in epochs if isinstance(e, dict) and e.get("start_frame") is not None]
                if sf:
                    opened = [e.get("opens_on_start_frame") for e in sf]
                    det = ", ".join(f"{e.get('condition')} {e.get('first_idx_after_tare')}→{e.get('start_frame')}" for e in sf)
                    self.record("epochs open on their start frame", all(o is True for o in opened), det)
            except ValueError:
                self.record("closed-loop-report", False, (r.stderr or r.stdout)[-300:])
        holds = self.rig["reports"].get("holds") or []
        if self.studio_ran:
            # holds (whole-epoch "display stays on frame N") only for a bare / blocked ball; the live-rig
            # profiles leave it empty and bench-check still judges completion, arena acks, channel, build.
            argv = [self.py, scripts / "bench-check.py", log, "--channel", self.channel, "--build", self.sha[:7]]
            for h in holds:
                argv += ["--hold", h]
            r = run(argv, env=self.env, timeout=300)
            (rep_dir / "bench-check.txt").write_text(r.stdout + r.stderr, encoding="utf-8")
            # A fly on the ball turns the hold checks into SKIP (qclib.hold_verdict), never into a FAIL
            # of the candidate: the closed-loop report above is the tracking evidence then.
            verdict, detail = qclib.hold_verdict(r.returncode, r.stdout, epochs_json)
            label = "bench-check (holds, channel, build)" if holds else "bench-check (completion, arena acks, channel, build)"
            self.results.add(label, verdict, detail)
            self.log.result(verdict, label, detail)
        self.look("reports")

    # ── 9 teardown ──
    def teardown(self) -> None:
        from rig_nodes.supervise import port_in_use  # type: ignore[import-not-found]

        self.log.step(9, self.TOTAL, "teardown")
        for name in ("sim", "fictrac", "graph"):
            pr = self.procs.pop(name, None)
            if pr:
                pr.stop(grace_s=15.0 if name == "graph" else 8.0)
                self.log.info(f"{name} stopped")
        if self.chrome and self.chrome.poll() is None and not self.a.keep_browser:
            self.chrome.terminate()
            try:
                self.chrome.wait(5)
            except subprocess.TimeoutExpired:
                self.chrome.kill()
            self.log.info("Chrome (QC profile) closed")
        busy = []
        for _ in range(15):
            busy = [f"{pr} {port}" for pr, port, _w in self.rig["ports"] if port_in_use(pr, int(port))]
            if not busy:
                break
            time.sleep(1.0)
        self.record("ports free again", not busy, ", ".join(busy) if busy else "7447/8765/60000 free")
        if self.a.rm_worktree and self.wt:
            run(["git", "-C", REPO, "worktree", "remove", "--force", self.wt], timeout=120)
            self.log.info(f"worktree removed: {self.wt}")

    # ── summary ──
    def summary(self) -> int:
        if self.results.ok:
            self.look("done", f"[{self.qc_dir}]")
        wall = time.monotonic() - self.t_start
        self.ctx["wall_s"] = wall
        self.ctx["remarks"] = self.remarks
        table = self.results.table()
        note = qclib.validation_note(self.ctx, self.results)
        (self.qc_dir / "summary.md").write_text(f"# QC {self.date} — {self.rig['name']} — {self.tier} {self.sha[:7]}\n\n{table}\n", encoding="utf-8")
        note_path = self.qc_dir / "validation-note.md"
        note_path.write_text(note, encoding="utf-8")
        by = self.a.by or run(["git", "config", "user.name"], timeout=10).stdout.strip() or "Michael"
        self.log._w("")
        self.log._w(table)
        self.log._w("")
        verdict = "PASS" if self.results.ok else f"FAIL ({len(self.results.failed)} failed)"
        self.log._w(f"QC {verdict} — {wall:.0f} s wall — {self.rig['name']} — {self.tier} {self.sha[:7] or '?'}")
        self.log._w(f"artifacts: {self.qc_dir}")
        if self.sha and self.tier == "next":
            self.log._w("validation note: " + str(note_path))
            self.log._w("to post it (from the rig's webDisplayTools checkout):")
            self.log._w("  " + qclib.validate_command(str(REPO), self.rig["name"], by, str(note_path)))
        return 0 if self.results.ok else 1

    def main(self) -> int:
        try:
            self.preflight()
            self.candidate()
            self.install()
            self.graph()
            self.fictrac()
            self.precheck()
            self.browser()
            self.reports()
        except QCError as e:
            self.log._w("")
            self.log._w(f"   STOP: {e}")
            if not any(r["verdict"] == "FAIL" for r in self.results.rows):
                self.results.add("qc", "FAIL", str(e)[:300])
        except KeyboardInterrupt:
            self.log._w("   interrupted")
            self.results.add("qc", "FAIL", "interrupted (Ctrl-C)")
        finally:
            try:
                self.teardown()
            except Exception as e:  # noqa: BLE001
                self.log.warn(f"teardown: {e}")
        return self.summary()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tier", default="next", help="next (the candidate on /next/) or prod (what Production serves)")
    ap.add_argument("--rig", help="profile name in rig/qc/profiles.toml (default: detected from the hostname)")
    ap.add_argument("--sha", help="validate this commit instead of the tier's build.json (placeholder, or a build not deployed yet)")
    ap.add_argument("--auto", action="store_true", help="never wait for Enter: each step advances when its automated check holds")
    ap.add_argument("--by", help="who validates (the `--by` of `pixi run tiers -- validate`); default: git user.name")
    ap.add_argument("--qc-root", help=r"artifacts root (default C:\qc on Windows, ~/qc elsewhere)")
    ap.add_argument("--no-browser", action="store_true", help="stop after the pre-check and the reports; no Chrome")
    ap.add_argument("--no-foxglove", action="store_true", help="do not start foxglove_bridge / open Foxglove (skips the viz environment)")
    ap.add_argument("--skip-install", action="store_true", help="assume the worktree's environments are installed")
    ap.add_argument("--skip-requires", action="store_true", help="go on when a required service (BIAS, ScanImage) is not answering")
    ap.add_argument("--keep-browser", action="store_true", help="leave the QC Chrome window open at the end")
    ap.add_argument("--rm-worktree", action="store_true", help="remove the scratch worktree (and its environments) at the end")
    ap.add_argument("--chrome", help="Chrome/Edge executable (default: auto-detect or $CHROME)")
    ap.add_argument("--lna-prompt", action="store_true",
                    help="let Chrome show its local-network-access prompt for ws://localhost (default: the QC profile bypasses it, like the Foxglove app does)")
    ap.add_argument("--list-rigs", action="store_true", help="print the rig profiles and exit")
    a = ap.parse_args(argv)
    if a.list_rigs:
        prof = qclib.load_profiles()
        for name in qclib.rig_names(prof):
            r = qclib.resolve_rig(prof, name)
            print(f"{name:10} {r.get('label', '')}  hosts={r.get('hosts', [])}  flags={' '.join(r['rig_flags'])}")
        return 0
    try:
        qc = QC(a)
    except QCError as e:
        print(f"qc: {e}", file=sys.stderr)
        return 2
    return qc.main()


if __name__ == "__main__":
    raise SystemExit(main())
