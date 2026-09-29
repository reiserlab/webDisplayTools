#!/usr/bin/env python3
"""Checks for scripts/run-tests.py, the discovery-based test runner behind `pixi run test`.

Standalone (no pytest): python tests/test-run-tests.py
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('run_tests', ROOT / 'scripts' / 'run-tests.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print(f'  PASS  {name}')
    else:
        failed += 1
        print(f'  FAIL  {name}: got {got!r}, want {want!r}')


names = [p.name for p in R.discover()]
check('discovers node tests', 'test-arena-wire-g6.js' in names, True)
check('discovers python tests', 'test-tiers-candidate.py' in names, True)
check('discovers validate-* suites', 'validate-arena-calculations.js' in names, True)
check('discovers itself', 'test-run-tests.py' in names, True)
check('skips the yaml hook module', 'vendor-yaml.register.mjs' in names, False)
check('skips non-test helpers', any(n.startswith('generate-') for n in names), False)
check('sorted by name', names, sorted(names))

js = R.command(ROOT / 'tests' / 'test-arena-wire-g6.js')
check('node test gets the yaml hook', js[:2], ['node', '--import'])
check('hook passed as a file URL (Windows-safe)', js[2].startswith('file://'), True)
py = R.command(ROOT / 'tests' / 'test-tiers-candidate.py')
check('python test runs with this interpreter', py[0], sys.executable)

check('--list exits 0', R.main(['--list', 'wire']), 0)
check('a filter matching nothing exits 2', R.main(['no-such-test-name-xyz']), 2)

print(f'\n=== Summary ===\n{passed} / {passed + failed} checks passed')
sys.exit(1 if failed else 0)
