#!/usr/bin/env python3
"""export_log.py — ask the running bridge node for its run log, the way the Studio does.

    pixi run export                       # → runlogs/exports/<name>  (converted from the bag)
    pixi run export -- --out run.jsonl    # explicit path; `-` = stdout
    pixi run export -- --url ws://127.0.0.1:8765

Sends ONE `{"type":"log_export"}` over the WebSocket and writes the `log_export_result`
content. On the Plan B bridge node that closes the run's MCAP bag and the shadow file and
returns the NDJSON DERIVED from the bag (nodes/mcap_convert.py); on bridge 3.4 it returns the
live file — same message, same reply, so this also works as a plain bridge tool.

Why it exists: the Studio asks the bridge to export only when it commits the run log to the
course repo (a token stored on that origin). A rig without one keeps the bridge logging until
the next run, so the last run's bag stays open; this is the one-command way to close and
collect it. Pure Python (`websockets`), no ROS.

After a bridge crash: restart the node (`pixi run rig` does) and run this once — the node
recovers the unclosed bag first (salvage + index + metadata.yaml) and the reply says
`recovered: true`; `--json` prints the reply's fields (everything but the content) to stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


async def export(url: str, timeout_s: float) -> dict:
    from websockets.asyncio.client import connect

    async with connect(url, max_size=256 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "log_export"}))
        end = asyncio.get_running_loop().time() + timeout_s
        while True:
            remaining = end - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"no log_export_result within {timeout_s:g} s")
            msg = json.loads(await asyncio.wait_for(ws.recv(), remaining))
            if msg.get("type") == "log_export_result":
                return msg


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="ws://127.0.0.1:8765")
    ap.add_argument("--out", default=None, help="output path (default: runlogs/exports/<bridge's file name>; '-' = stdout)")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds to wait for the reply (a long run converts in well under 1 s per 10 000 lines)")
    ap.add_argument("--json", action="store_true", help="print the reply's metadata (name, lines, recovered, recovery, …) as JSON to stdout")
    a = ap.parse_args(argv)
    try:
        msg = asyncio.run(export(a.url, a.timeout))
    except (OSError, TimeoutError) as exc:
        print(f"[export] {exc} — is the bridge running on {a.url}?", file=sys.stderr)
        return 2
    if msg.get("error") or not isinstance(msg.get("content"), str):
        print(f"[export] bridge answered: {msg.get('error') or msg}", file=sys.stderr)
        return 1
    content, name = msg["content"], msg.get("name") or "arena-log-export.jsonl"
    meta = {k: v for k, v in msg.items() if k not in ("content", "type")}
    meta["bytes"] = len(content.encode("utf-8"))
    if msg.get("recovered"):
        rec = msg.get("recovery")
        if rec:  # salvaged by THIS export
            print(f"[export] RECOVERED from an unclosed bag ({rec.get('reason')}): {rec.get('salvaged_records')} records salvaged, "
                  f"metadata.yaml {'written' if (rec.get('metadata_yaml') or {}).get('written') else 'not written'}"
                  + (f"; content is the shadow file ({msg['fallback']})" if msg.get("fallback") else ""), file=sys.stderr)
        else:  # a bag recovered by an earlier export: the log still ends in its `recovered` marker
            print("[export] content comes from a bag that was recovered after a crash (no logging_stopped; see its final session line)", file=sys.stderr)
    if a.json:
        print(json.dumps(meta))
    if a.out == "-":
        sys.stdout.write(content)
        return 0
    out = Path(a.out) if a.out else HERE.parent / "runlogs" / "exports" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8", newline="\n")  # the bytes the bridge sent: LF, also on Windows
    lines = content.count("\n")
    print(f"[export] {name}: {lines} lines, {len(content.encode('utf-8'))} bytes → {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
