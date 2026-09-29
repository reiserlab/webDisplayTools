#!/usr/bin/env python3
"""Checks for scripts/bench-check.py against small synthetic bridge logs (v1 and v2 formats).

Standalone (no pytest): python tests/test-bench-check.py
"""
import gzip
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bench_check', ROOT / 'scripts' / 'bench-check.py')
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}: got {got!r}, want {want!r}')


T0 = 1_790_000_000_000
TMP = Path(tempfile.mkdtemp())


def v2_log(hold_b=75, arena_status=0, glyph=False, completed=True, errors=0):
    """start_bg (idx 0, 1 s) → epoch_a (idx 25, 2 s) → epoch_b (idx hold_b, 2 s); 10 ms frames."""
    L = [
        {'type': 'session', 'event': 'logging_started', 'ms': T0},
        {'type': 'frame_schema', 'level': 'behavior_v2', 'cols': ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd'], 't0': T0},
        {'type': 'log', 'event': 'run_metadata', 'tool_version': 'Arena Studio v0.93', 'channel': 'next',
         'build': '801a9f27b03912eee1034a2e632acc80472c227c', 'log_format': 'behavior_v2',
         'panels': {'status': 'ok', 'count': 20, 'present': 20, 'missing': [], 'mismatched': [],
                    'firmware': [{'crc32': '0x9BE0D3C7', 'panels': list(range(1, 21))}]}},
    ]
    plan = [('start_bg', 0, 1000, 0), ('epoch_a_frame25', 1000, 3000, 25), ('epoch_b_frame75', 3000, 5000, hold_b)]
    for name, a, b, idx in plan:
        L.append({'type': 'log', 'event': 'runner', 'phase': 'step-start', 'condition': name, 'rx_ms': T0 + a})
        L.append(['a', a, 5, '0d 08 03 24', arena_status if name == 'epoch_b_frame75' else 0, a + 1])
        for ms in range(a, b, 10):
            L.append([ms, ms // 10, idx, 0.0, 0.0, 0.0, 0.0])
    if glyph:
        L.append(['cs', T0 + 4000, 123, 9, 3, 2, 0])
    L.append(['cc', T0 + 4500, 456, 10, 112, 0, ''])  # a controller row must not count as a frame
    L.append({'type': 'log', 'event': 'runner', 'phase': 'sequence-complete', 'rx_ms': T0 + 5000,
              'summary': {'completed': completed, 'aborted': not completed, 'steps': 3, 'errors': errors, 'fault': None}})
    for ms in range(5000, 6000, 10):  # the bridge keeps logging after the run: outside every step
        L.append([ms, ms // 10, 99, 0.0, 0.0, 0.0, 0.0])
    return L


def write(name, rows, gz=False):
    text = '\n'.join(json.dumps(r) for r in rows) + '\n'
    p = TMP / name
    p.write_bytes(gzip.compress(text.encode()) if gz else text.encode())
    return p


HOLDS = [('epoch_a_frame25', 25), ('epoch_b_frame75', 75)]


def ok(path, **kw):
    return all(c[1] for c in B.run_checks(B.analyze(path), kw.pop('holds', HOLDS), **kw))


good = write('good.jsonl', v2_log())
a = B.analyze(good)
check('v2: arena commands counted', a['arena_total'], 3)
check('v2: controller rows are not frames', a['frames'], 600)
check('v2: steps found', [s['condition'] for s in a['steps']], ['start_bg', 'epoch_a_frame25', 'epoch_b_frame75'])
check('v2: last step stops at sequence-complete', a['steps'][-1]['idx'].get(99, 0), 0)
check('v2: good run passes', ok(good), True)
check('v2: channel + build prefix pass', ok(good, channel='next', build='801a9f2'), True)
check('v2: wrong channel fails', ok(good, channel='production'), False)
check('v2: wrong build fails', ok(good, build='deadbee'), False)
check('describe: panel inventory line', 'panels: ok · 20/20 present · fw 0x9BE0D3C7 ×20' in B.describe(a), True)

check('hold broken (snapped to frame 0) fails', ok(write('snap.jsonl', v2_log(hold_b=0))), False)
check('non-ok arena status fails', ok(write('status.jsonl', v2_log(arena_status=1))), False)
check('error glyph fails', ok(write('glyph.jsonl', v2_log(glyph=True))), False)
check('aborted run fails', ok(write('abort.jsonl', v2_log(completed=False))), False)
check('runner errors fail', ok(write('err.jsonl', v2_log(errors=2))), False)
check('hold on a missing condition fails', ok(good, holds=[('no_such_condition', 3)]), False)
check('.jsonl.gz is read', ok(write('good.jsonl.gz', v2_log(), gz=True)), True)

# behavior_v1: arena_command objects, t0 from logging_started, no t0 in frame_schema.
v1 = [r for r in v2_log() if not (isinstance(r, list) and r and r[0] == 'a')]
v1[1] = {'type': 'frame_schema', 'level': 'behavior_v1', 'cols': ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd']}
v1.insert(3, {'type': 'log', 'event': 'arena_command', 'ok': True, 'status': 0})
v1_bad = v1 + [{'type': 'log', 'event': 'arena_command', 'ok': False, 'status': 1}]
check('v1: good run passes', ok(write('v1.jsonl', v1)), True)
check('v1: a failed arena_command fails', ok(write('v1bad.jsonl', v1_bad)), False)

check('CLI: exit 0 on a good log', B.main([str(good), '--hold', 'epoch_a_frame25=25']), 0)
check('CLI: exit 1 on a bad log', B.main([str(write('snap2.jsonl', v2_log(hold_b=0))), '--hold', 'epoch_b_frame75=75']), 1)

print(f'\n=== Summary ===\n{passed} / {passed + failed} checks passed')
sys.exit(1 if failed else 0)
