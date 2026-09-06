#!/usr/bin/env python3
"""Build/refresh `runlogs/<folder>/index.json` for a data-repo clone.

Why: the data-browser dashboard wants each run's start time, duration and end
state WITHOUT downloading multi-MB logs. Reading a file tail from the browser is
blocked (raw.githubusercontent.com rejects the CORS preflight that a `Range`
header triggers), so every runlog folder carries a small index the dashboard
fetches in ONE request. The index has ONE writer: this script, run by the data
repo's `runlog-index` GitHub Action on every push under runlogs/ (see
scripts/data-repo-workflows/runlog-index.yml) — and by hand for a backfill.
Idempotent: each folder's index is rebuilt from the files present, so deletions
and out-of-band pushes (git push of a large log, migrations) are picked up too.

Per run: run_id, file, size, started_ms (logging_started), stopped_ms
(logging_stopped, else last runner rx_ms), duration_s, complete
(true = runner 'sequence-complete' seen, false = 'aborted', null = unknown),
plus the run_metadata fields the catalog shows (protocol_filename, experimenter,
genotype, sex, fly_number, age, notes, rig_id, timestamp_start).

usage: build-runlog-index.py <clone-root> [--write] [--folder NAME ...]
       build-runlog-index.py --github owner/repo [--branch main] [--write] [--folder NAME ...]
  --folder may repeat (the Action passes only the folders a push touched).
  (default = dry run: prints the table; --write rewrites each index.json —
   on disk for a clone, via the Contents API for --github. --github reads only
   a 64 KB head + 4 KB tail per file with Range requests on the raw URL, so it
   never downloads the logs; needs `gh auth token` or $GITHUB_TOKEN.)
"""
import json, os, sys, glob, subprocess, urllib.request, urllib.error, base64

HEAD_BYTES = 65536
TAIL_BYTES = 4096

def _token():
    tok = os.environ.get('GITHUB_TOKEN')
    if tok: return tok
    try: return subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
    except Exception: return ''

def _http(url, headers=None, data=None, method=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req) as r:
        return r.status, r.read(), dict(r.headers)

def _gh_api(repo, path, method='GET', body=None):
    tok = _token(); h = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    data = json.dumps(body).encode() if body is not None else None
    if data: h['Content-Type'] = 'application/json'
    st, raw, _ = _http(f'https://api.github.com/repos/{repo}/{path}', h, data, method)
    return json.loads(raw) if raw else None

def _put_index(repo, branch, path, content, name, n):
    """PUT index.json unless it is already identical (no no-op commits); on a
    stale-sha conflict (409/422 — another run wrote the same file meanwhile)
    re-read the sha and retry, up to 3 attempts."""
    import urllib.error, time
    for attempt in range(3):
        sha = None
        try:
            cur = _gh_api(repo, f'contents/{path}?ref={branch}')
            sha = cur.get('sha')
            if cur.get('encoding') == 'base64' and base64.b64decode(cur.get('content') or '').decode('utf-8', 'replace') == content:
                print(f'  {name}: index.json unchanged — skipped'); return None
        except Exception: pass
        body = {'message': f'runlogs({name}): refresh index.json ({n} runs)', 'content': base64.b64encode(content.encode()).decode(), 'branch': branch}
        if sha: body['sha'] = sha
        try:
            return _gh_api(repo, f'contents/{path}', 'PUT', body)
        except urllib.error.HTTPError as e:
            if e.code in (409, 422) and attempt < 2:
                time.sleep(2 + attempt); continue
            raise

def _raw_range(repo, branch, path, rng):
    """Partial read of one file via raw.githubusercontent.com (honours Range; the
    API host does not). Retries transient network errors (connection resets were
    seen on a 340-request full rebuild)."""
    import time
    tok = _token(); h = {'Range': rng}
    if tok: h['Authorization'] = 'Bearer ' + tok
    url = f'https://raw.githubusercontent.com/{repo}/{branch}/{urllib.request.quote(path)}'
    last = None
    for attempt in range(4):
        try:
            st, raw, hdr = _http(url, h)
            if st != 206: raise RuntimeError(f'{path}: expected 206 for {rng}, got {st}')
            return raw.decode('utf-8', 'replace')
        except (ConnectionError, OSError, urllib.error.URLError) as e:  # incl. ConnectionResetError
            last = e; time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'{path}: {last}')

def bookends(path, size=None, head=None, tail=None):
    if head is None:
        size = os.path.getsize(path)
        with open(path, 'rb') as fh:
            head = fh.read(HEAD_BYTES).decode('utf-8', 'replace')
            fh.seek(max(0, size - TAIL_BYTES)); tail = fh.read().decode('utf-8', 'replace')
    def recs(text):
        out = []
        for line in text.split('\n'):
            if line.startswith('{'):
                try: out.append(json.loads(line))
                except Exception: pass
        return out
    h, t = recs(head), recs(tail)
    meta = next((r for r in h if r.get('event') == 'run_metadata'), {})
    started = next((r['ms'] for r in h if r.get('event') == 'logging_started' and isinstance(r.get('ms'), (int, float))), None)
    stopped = next((r['ms'] for r in reversed(t) if r.get('event') == 'logging_stopped' and isinstance(r.get('ms'), (int, float))), None)
    complete = None
    for r in t:
        if r.get('event') == 'runner' and r.get('phase') == 'sequence-complete': complete = True
        if r.get('event') == 'runner' and r.get('phase') == 'aborted': complete = False
    if stopped is None:
        rx = [r['rx_ms'] for r in t if r.get('event') == 'runner' and isinstance(r.get('rx_ms'), (int, float))]
        stopped = max(rx) if rx else None
    dur = round((stopped - started) / 1000, 3) if started is not None and stopped is not None and stopped >= started else None
    keep = ['run_id', 'rig_id', 'protocol_filename', 'protocol_sha256', 'experimenter', 'genotype', 'sex', 'fly_number', 'age', 'notes', 'timestamp_start', 'tool_version']
    entry = {k: meta.get(k) for k in keep if k in meta}
    entry.update({'file': os.path.basename(path), 'size': size, 'started_ms': started, 'stopped_ms': stopped, 'duration_s': dur, 'complete': complete})
    return entry

def main_github(repo, branch, write, only):
    dirs = [d for d in _gh_api(repo, f'contents/runlogs?ref={branch}') if d['type'] == 'dir']
    total = 0
    for d in sorted(dirs, key=lambda x: x['name']):
        name = d['name']
        if only and name not in only: continue
        items = [i for i in _gh_api(repo, f"contents/{d['path']}?ref={branch}") if i['type'] == 'file' and i['name'].endswith('.jsonl')]
        runs = []
        for it in items:
            head = _raw_range(repo, branch, it['path'], f'bytes=0-{HEAD_BYTES-1}')
            tail = _raw_range(repo, branch, it['path'], f'bytes=-{TAIL_BYTES}') if it['size'] > TAIL_BYTES else head
            runs.append(bookends(it['path'], it['size'], head, tail))
        index = {'format_version': 1, 'folder': name, 'generated': 'scripts/build-runlog-index.py', 'runs': runs}
        total += len(runs)
        known = sum(1 for r in runs if r['duration_s'] is not None); aborted = sum(1 for r in runs if r['complete'] is False)
        print(f"{name:12s} {len(runs):3d} runs  duration known {known:3d}  aborted {aborted:2d}")
        if write:
            _put_index(repo, branch, f"{d['path']}/index.json", json.dumps(index, indent=1) + '\n', name, len(runs))
    print(f"{'WROTE' if write else 'dry-run'}: {total} runs in {len(dirs)} folders ({repo}@{branch})")

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    write = '--write' in sys.argv
    only = {sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == '--folder' and i + 1 < len(sys.argv)} or None
    if '--github' in sys.argv:
        repo = sys.argv[sys.argv.index('--github') + 1]
        branch = sys.argv[sys.argv.index('--branch') + 1] if '--branch' in sys.argv else 'main'
        return main_github(repo, branch, write, only)
    if not args: print(__doc__); sys.exit(2)
    root = args[0]
    folders = sorted(d for d in glob.glob(os.path.join(root, 'runlogs', '*')) if os.path.isdir(d))
    total = 0
    for folder in folders:
        name = os.path.basename(folder)
        if only and name not in only: continue
        files = sorted(glob.glob(os.path.join(folder, '*.jsonl')) + glob.glob(os.path.join(folder, '*.jsonl.gz')))
        files = [f for f in files if not f.endswith('.gz')]  # gz handled once behavior_v2 lands
        runs = [bookends(f) for f in files]
        index = {'format_version': 1, 'folder': name, 'generated': 'scripts/build-runlog-index.py', 'runs': runs}
        total += len(runs)
        known = sum(1 for r in runs if r['duration_s'] is not None)
        aborted = sum(1 for r in runs if r['complete'] is False)
        print(f"{name:12s} {len(runs):3d} runs  duration known {known:3d}  aborted {aborted:2d}")
        if write:
            with open(os.path.join(folder, 'index.json'), 'w') as fh:
                json.dump(index, fh, indent=1, sort_keys=False); fh.write('\n')
    print(f"{'WROTE' if write else 'dry-run'}: {total} runs in {len(folders)} folders")

if __name__ == '__main__': main()
