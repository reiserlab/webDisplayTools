#!/usr/bin/env python3
"""Run the whole test suite: every tests/test-*.js, tests/test-*.py and tests/validate-*.js.

    pixi run test                 everything (what CI runs)
    pixi run test -- tiers wire   only files whose name contains "tiers" or "wire"
    pixi run test -- --list       show what would run

Discovery replaces the old hand-maintained `&&` chain in pixi.toml. Every PR that added a
test appended to the same line of that string, so any two such PRs conflicted in every
release candidate. A new test file now only has to follow the naming convention.

Each file runs in its own process from the repo root. Node tests always get the vendored
`yaml` resolve hook (tests/vendor-yaml.register.mjs); it only maps the bare 'yaml'
specifier, so it is harmless for tests that don't import it. Unlike the `&&` chain, a
failure does not stop the run: every file runs, then a summary lists the failures and the
exit status is non-zero if any failed. Pure Python, so it works on macOS, Linux and Windows.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / 'tests'
PATTERNS = ('test-*.js', 'test-*.py', 'validate-*.js')
YAML_HOOK = TESTS / 'vendor-yaml.register.mjs'


def discover():
    files = set()
    for pat in PATTERNS:
        files.update(TESTS.glob(pat))
    return sorted(files, key=lambda p: p.name)


def command(path):
    if path.suffix == '.py':
        return [sys.executable, str(path)]
    # A file URL keeps --import working on Windows paths too.
    return ['node', '--import', YAML_HOOK.as_uri(), str(path)]


def main(argv):
    listing = '--list' in argv
    filters = [a for a in argv if not a.startswith('--')]
    files = [f for f in discover() if not filters or any(s in f.name for s in filters)]
    if not files:
        print('no test files match ' + ' '.join(filters), file=sys.stderr)
        return 2
    if listing:
        for f in files:
            print(f.relative_to(ROOT).as_posix())
        return 0
    failed, timings = [], []
    t_all = time.monotonic()
    for f in files:
        rel = f.relative_to(ROOT).as_posix()
        print(f'\n=== {rel}', flush=True)
        t0 = time.monotonic()
        rc = subprocess.run(command(f), cwd=ROOT).returncode
        dt = time.monotonic() - t0
        timings.append((rel, dt))
        if rc != 0:
            failed.append((rel, rc))
            print(f'--- FAILED {rel} (exit {rc}, {dt:.1f} s)', flush=True)
    total = time.monotonic() - t_all
    print(f'\n=== test suite: {len(files) - len(failed)}/{len(files)} files passed in {total:.1f} s')
    slow = sorted(timings, key=lambda t: -t[1])[:3]
    print('    slowest: ' + ', '.join(f'{name} {dt:.1f} s' for name, dt in slow))
    for rel, rc in failed:
        print(f'    FAILED: {rel} (exit {rc})')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
