#!/usr/bin/env python3
"""Tests for scripts/build-runlog-index.py — the data repo's runlogs/<folder>/index.json
builder (installed as a copy in the data repo's .github/scripts/).

Plain-script style like tests/test-bridge-behavior.py (no pytest dependency).

Covers: a plain `.jsonl` and its gzipped twin yield the same index entry apart from
`file`/`size`; a truncated `.gz` (half-written upload) still yields metadata and never
raises; the local CLI indexes both kinds in one folder; the run-log name filter used by
`--github` mode accepts `.jsonl` / `.jsonl.gz` only.
"""
import gzip
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'scripts', 'build-runlog-index.py')

spec = importlib.util.spec_from_file_location('build_runlog_index', SCRIPT)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f'  FAIL  {msg}')
        sys.exit(1)
    print(f'  PASS  {msg}')


def synthetic_log(n_frames=3000, complete=True):
    """A behavior_v1-shaped run log: session bookends, schema, run_metadata, frame rows
    (enough bytes that the run_metadata line is NOT in the tail and the stop line is NOT
    in the head), runner events."""
    t0 = 1788636439304
    lines = [
        json.dumps({'type': 'session', 'event': 'logging_started', 'file': 'x.jsonl', 'ms': t0}),
        json.dumps({'type': 'frame_schema', 'level': 'behavior_v1', 'cols': ['ms', 'fc', 'idx', 'ft', 'x', 'y', 'hd']}),
        json.dumps({'type': 'log', 'event': 'run_metadata', 'run_id': 'r1', 'rig_id': 'rig9',
                    'protocol_filename': 'p3.yaml', 'experimenter': 'michael', 'genotype': 'w1118',
                    'sex': 'f', 'fly_number': 4, 'age': '3d', 'notes': '', 'timestamp_start': '2026-09-05T19:27:19.251Z',
                    'tool_version': 'v0.72', 'dir': 'browser→bridge', 'rx_ms': t0 + 1}),
    ]
    for i in range(n_frames):
        lines.append(json.dumps([i * 10, i, i % 200, i * 10.0, 0.1 * i, -0.2 * i, 1.5]))
    lines.append(json.dumps({'type': 'log', 'event': 'runner', 'phase': 'sequence-complete' if complete else 'aborted',
                             'dir': 'browser→bridge', 'rx_ms': t0 + 120000}))
    if complete:
        lines.append(json.dumps({'type': 'session', 'event': 'logging_stopped', 'ms': t0 + 120500}))
    return '\n'.join(lines) + '\n'


with tempfile.TemporaryDirectory() as tmp:
    folder = os.path.join(tmp, 'runlogs', 'rig9')
    os.makedirs(folder)
    text = synthetic_log()
    plain = os.path.join(folder, 'p3__michael__2026-09-05T19-27-19__r1.jsonl')
    gz = os.path.join(folder, 'p3__michael__2026-09-05T19-27-19__r2.jsonl.gz')
    with open(plain, 'w') as fh:
        fh.write(text)
    with open(gz, 'wb') as fh:
        fh.write(gzip.compress(text.replace('"run_id": "r1"', '"run_id": "r2"').encode()))
    check(len(text) > M.HEAD_BYTES + M.TAIL_BYTES, 'fixture is longer than head + tail (bookends are exercised)')

    print('-- plain vs gz twin --')
    e1 = M.bookends(plain)
    e2 = M.bookends(gz)
    check(e1['started_ms'] == 1788636439304 and e1['stopped_ms'] == 1788636439304 + 120500, 'plain: session bookends read')
    check(e1['duration_s'] == 120.5 and e1['complete'] is True, 'plain: duration + complete')
    check(e1['file'] == os.path.basename(plain) and e1['size'] == os.path.getsize(plain), 'plain: file + size')
    check(e2['file'].endswith('.jsonl.gz'), 'gz: file keeps the .gz name')
    check(e2['size'] == os.path.getsize(gz) and e2['size'] < e1['size'] / 3, 'gz: size is the compressed size')
    strip = lambda e: {k: v for k, v in e.items() if k not in ('file', 'size', 'run_id')}
    check(strip(e1) == strip(e2), 'gz twin: every other field identical to the plain entry')
    check(e2['run_id'] == 'r2' and e2['genotype'] == 'w1118', 'gz: run_metadata fields read from the inflated head')

    print('-- truncated gz (half-written upload) --')
    trunc = os.path.join(folder, 'p3__michael__2026-09-05T19-27-19__r3.jsonl.gz')
    with open(gz, 'rb') as fh:
        raw = fh.read()
    with open(trunc, 'wb') as fh:
        fh.write(raw[: len(raw) // 2])
    e3 = M.bookends(trunc)
    check(e3['run_id'] == 'r2' and e3['started_ms'] == 1788636439304, 'truncated gz: metadata + start still read')
    check(e3['stopped_ms'] is None and e3['duration_s'] is None and e3['complete'] is None, 'truncated gz: no invented end state')
    check(e3.get('error') == 'gzip truncated', 'truncated gz: row is marked damaged, not merely unfinished')
    check('error' not in e1 and 'error' not in e2, 'plain and clean-gz rows carry no error key (index unchanged for them)')

    print('-- unreadable gz (not gzip at all, named .jsonl.gz) --')
    junk = os.path.join(folder, 'p3__michael__2026-09-05T19-27-19__r5.jsonl.gz')
    with open(junk, 'wb') as fh:
        fh.write(b'this is not a gzip stream' * 100)
    e5 = M.bookends(junk)
    check(e5.get('error') == 'gzip unreadable' and 'run_id' not in e5, 'unreadable gz: marked, no metadata invented, never raises')

    print('-- aborted run without logging_stopped --')
    ab = os.path.join(folder, 'p3__michael__2026-09-05T19-27-19__r4.jsonl.gz')
    with open(ab, 'wb') as fh:
        fh.write(gzip.compress(synthetic_log(complete=False).encode()))
    e4 = M.bookends(ab)
    check(e4['complete'] is False and e4['stopped_ms'] == 1788636439304 + 120000, 'aborted gz: runner rx_ms fallback + complete=false')

    print('-- local CLI indexes both kinds --')
    out = subprocess.run([sys.executable, SCRIPT, tmp, '--write'], capture_output=True, text=True)
    check(out.returncode == 0, 'CLI exit 0: ' + out.stdout.strip().splitlines()[-1])
    idx = json.load(open(os.path.join(folder, 'index.json')))
    files = sorted(r['file'] for r in idx['runs'])
    check(files == sorted(os.path.basename(p) for p in (plain, gz, trunc, ab, junk)), f'index lists all 5 files: {files}')
    errs = {r['file']: r.get('error') for r in idx['runs']}
    check(errs[os.path.basename(trunc)] == 'gzip truncated' and errs[os.path.basename(junk)] == 'gzip unreadable' and errs[os.path.basename(plain)] is None, 'errors land in index.json for the damaged files only')
    check(idx['format_version'] == 1 and idx['folder'] == 'rig9', 'index envelope unchanged')

    print('-- name filter for --github mode --')
    check(M.is_runlog_name('a.jsonl') and M.is_runlog_name('a.jsonl.gz') and M.is_runlog_name('A.JSONL.GZ'), 'accepts .jsonl and .jsonl.gz')
    check(not M.is_runlog_name('index.json') and not M.is_runlog_name('a.gz') and not M.is_runlog_name('a.txt'), 'rejects index.json, bare .gz, others')
    check(M.is_gz('a.jsonl.gz') and not M.is_gz('a.jsonl'), 'is_gz')

print(f'{CHECKS} / {CHECKS} checks passed')
