#!/usr/bin/env python3
"""Check a bench-validation run from its FicTrac-bridge log (docs/development/release-process.md).

    pixi run bench-check -- arena-log-20260929-164557-084.jsonl
    pixi run bench-check -- LOG --hold epoch_a_frame25=25 --hold epoch_b_frame75=75 \\
        --channel next --build 801a9f2

Prints what the run recorded (Studio version, tier, build, controller firmware, panel
inventory) and checks the run itself. The checks: it completed with no runner errors, every
arena command was acknowledged ok, the controller showed no error glyph, and (with --hold) the
display held the given frame for each named condition. Exits 1 if any check fails, 0 otherwise.

Reads behavior_v2 logs (compact ["a", …] arena rows, controller ["cc"|"cf"|"cs", …] rows) and
the older behavior_v1 logs (arena_command objects). Plain .jsonl or .jsonl.gz. The log is the
bridge's file for one run, as written by `pixi run bridge -- --log-dir <dir>`.
"""
import argparse
import collections
import gzip
import json
import sys
from pathlib import Path

CS_KIND_ERROR_GLYPH = 3  # controller state row kind (js/arena-telemetry.js header comment)


def read_lines(path):
    raw = Path(path).read_bytes()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return raw.decode('utf-8', errors='replace').splitlines()


def analyze(path):
    """Parse a bridge log into the facts the checks need. Never raises on odd lines."""
    t0 = None
    meta = None
    steps = []  # (start_ms_rel, condition)
    end_ms = None
    summary = None
    frames = []  # [ms_rel, fc, idx, ...]
    arena_total = arena_bad = glyphs = 0
    for line in read_lines(path):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict):
            typ, ev = r.get('type'), r.get('event')
            if typ == 'frame_schema' and r.get('t0') is not None:
                t0 = r['t0']
            elif typ == 'session' and ev == 'logging_started' and t0 is None:
                t0 = r.get('ms')
            elif ev == 'run_metadata':
                meta = r
            elif ev == 'runner':
                phase, rx = r.get('phase'), r.get('rx_ms')
                if phase == 'step-start' and rx is not None and t0 is not None:
                    steps.append((rx - t0, r.get('condition')))
                elif phase == 'sequence-complete':
                    summary = r.get('summary') or {}
                    if rx is not None and t0 is not None:
                        end_ms = rx - t0
            elif ev == 'arena_command':  # behavior_v1
                arena_total += 1
                if r.get('ok') is False:
                    arena_bad += 1
        elif isinstance(r, list) and r:
            if isinstance(r[0], str):
                tag = r[0]
                if tag == 'a':  # ["a", t_off, dt, hex, status, rx_off]
                    arena_total += 1
                    if len(r) > 4 and r[4] not in (0, None):
                        arena_bad += 1
                elif tag == 'cs' and len(r) > 4 and r[4] == CS_KIND_ERROR_GLYPH:
                    glyphs += 1
            elif isinstance(r[0], (int, float)) and len(r) > 2:
                frames.append(r)
    per_step = []
    bounds = steps + [(end_ms if end_ms is not None else float('inf'), None)]
    for i, (start, name) in enumerate(steps):
        stop = bounds[i + 1][0]
        idx = collections.Counter(f[2] for f in frames if start <= f[0] < stop)
        per_step.append({'condition': name, 'start_s': round(start / 1000, 2), 'frames': sum(idx.values()), 'idx': idx})
    return {
        'meta': meta,
        'summary': summary,
        'arena_total': arena_total,
        'arena_bad': arena_bad,
        'glyphs': glyphs,
        'frames': len(frames),
        'steps': per_step,
    }


def run_checks(a, holds=(), channel=None, build=None, min_share=0.99):
    """[(name, ok, detail)] for an analyze() result."""
    out = []
    s = a['summary']
    out.append(('run completed', bool(s and s.get('completed') and not s.get('aborted')), json.dumps(s)))
    out.append(('no runner errors', bool(s) and not s.get('errors') and not s.get('fault'), f"errors={s and s.get('errors')} fault={s and s.get('fault')}"))
    out.append(('arena commands all ok', a['arena_total'] > 0 and a['arena_bad'] == 0, f"{a['arena_total'] - a['arena_bad']}/{a['arena_total']} ok"))
    out.append(('no controller error glyphs', a['glyphs'] == 0, f"{a['glyphs']} glyph event(s)"))
    m = a['meta'] or {}
    out.append(('run_metadata present', a['meta'] is not None, ''))
    if channel:
        out.append((f'channel is {channel}', m.get('channel') == channel, f"channel={m.get('channel')}"))
    if build:
        out.append((f'build is {build}', str(m.get('build') or '').startswith(build), f"build={m.get('build')}"))
    for cond, want in holds:
        seen = [st for st in a['steps'] if st['condition'] == cond]
        if not seen:
            out.append((f'{cond} holds frame {want}', False, 'condition not in this run'))
            continue
        for st in seen:
            n = st['frames']
            share = (st['idx'].get(want, 0) / n) if n else 0.0
            out.append((f'{cond} holds frame {want}', n > 0 and share >= min_share,
                        f"{st['idx'].get(want, 0)}/{n} frames at {want} ({share:.1%}); most common {st['idx'].most_common(2)}"))
    return out


def describe(a):
    m = a['meta'] or {}
    lines = []
    for k in ('tool_version', 'channel', 'build', 'candidate', 'firmware', 'controller_id', 'rig', 'rig_id', 'log_format', 'protocol_filename'):
        if m.get(k) is not None:
            lines.append(f'  {k}: {m[k]}')
    p = m.get('panels')
    if isinstance(p, dict):
        fw = ', '.join(f"{g.get('crc32')} ×{len(g.get('panels') or [])}" for g in p.get('firmware') or [])
        lines.append(f"  panels: {p.get('status')} · {p.get('present')}/{p.get('count')} present"
                     + (f" · missing {p.get('missing')}" if p.get('missing') else '')
                     + (f" · mismatched {p.get('mismatched')}" if p.get('mismatched') else '')
                     + (f' · fw {fw}' if fw else ''))
    lines.append(f"  arena commands: {a['arena_total']} ({a['arena_bad']} not ok) · frames: {a['frames']} · error glyphs: {a['glyphs']}")
    for st in a['steps']:
        lines.append(f"  step {st['condition']} @ {st['start_s']} s: {st['frames']} frames, idx {st['idx'].most_common(3)}")
    return '\n'.join(lines)


def parse_hold(text):
    cond, _, idx = text.rpartition('=')
    if not cond or not idx.lstrip('-').isdigit():
        raise argparse.ArgumentTypeError(f'--hold wants CONDITION=FRAME, got {text!r}')
    return cond, int(idx)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Check a bench-validation run from its bridge log.')
    ap.add_argument('log', help='bridge log (.jsonl or .jsonl.gz)')
    ap.add_argument('--hold', type=parse_hold, action='append', default=[], metavar='CONDITION=FRAME',
                    help='the display must hold FRAME during every occurrence of CONDITION')
    ap.add_argument('--channel', choices=['next', 'production'], help='expected run_metadata.channel')
    ap.add_argument('--build', help='expected run_metadata.build (a prefix of the commit SHA is enough)')
    ap.add_argument('--min-share', type=float, default=0.99,
                    help='fraction of a held condition\'s frames that must be at FRAME (default 0.99; one boundary frame is normal)')
    a = ap.parse_args(argv)
    res = analyze(a.log)
    print(f'{Path(a.log).name}\n{describe(res)}\n')
    checks = run_checks(res, a.hold, a.channel, a.build, a.min_share)
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f' — {detail}' if detail and not ok else ''))
    bad = [c for c in checks if not c[1]]
    print(f'\n{len(checks) - len(bad)}/{len(checks)} checks passed')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
