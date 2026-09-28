#!/usr/bin/env python3
"""Offline tests for the two-tier release tooling (scripts/tiers/): candidate.py planning
+ the stamp.py site assembly. No network and no `gh`: every git operation runs against a
throwaway repo in a temp dir, so this runs the same on macOS, Linux and Windows
(CI runs it on all three).

Covers: ET stamps (zoneinfo vs the built-in US rule), version bumps, footer read/write,
PR-body release notes, notes folding, PR ordering (stacks explicit, forks refused, WIP
limit), CI rollup, validation-note matching, release naming, docs-only drift, the merge
loop (clean + conflict), manifest trailer → stamp, meta/banner injection, the placeholder,
the reserved next/ path, and the production-tree self-check.

Run: python tests/test-tiers-candidate.py
"""
import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TIERS = HERE.parent / 'scripts' / 'tiers'
sys.path.insert(0, str(TIERS))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, TIERS / f'{name}.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


T = _load('tierlib')
C = _load('candidate')
S = _load('stamp')

total = 0
failures = 0


def check(name, got, expected):
    global total, failures
    total += 1
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ('' if ok else f' — got {got!r}, expected {expected!r}'))
    if not ok:
        failures += 1


def raises(name, fn, needle=''):
    global total, failures
    total += 1
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        ok = needle.lower() in str(e).lower()
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + ('' if ok else f' — raised {e!r}, wanted {needle!r}'))
        if not ok:
            failures += 1
        return
    failures += 1
    print(f'  FAIL  {name} — did not raise')


# ── ET stamps ────────────────────────────────────────────────────────────────
print('=== ET stamps ===')
U = dt.timezone.utc
cases = [
    (dt.datetime(2026, 9, 27, 20, 8, tzinfo=U), '2026-09-27 16:08 ET'),   # EDT
    (dt.datetime(2026, 1, 15, 12, 0, tzinfo=U), '2026-01-15 07:00 ET'),   # EST
    (dt.datetime(2026, 3, 8, 6, 59, tzinfo=U), '2026-03-08 01:59 ET'),    # just before spring-forward
    (dt.datetime(2026, 3, 8, 7, 0, tzinfo=U), '2026-03-08 03:00 ET'),     # just after
    (dt.datetime(2026, 11, 1, 5, 59, tzinfo=U), '2026-11-01 01:59 ET'),   # EDT, before fall-back
    (dt.datetime(2026, 11, 1, 6, 0, tzinfo=U), '2026-11-01 01:00 ET'),    # EST, after
]
for utc, want in cases:
    check(f'rule {utc:%Y-%m-%d %H:%M}Z', T.to_et(utc, use_zoneinfo=False).strftime('%Y-%m-%d %H:%M') + ' ET', want)
try:
    from zoneinfo import ZoneInfo  # noqa: F401

    ZoneInfo('America/New_York')
    for utc, want in cases:
        check(f'zoneinfo {utc:%Y-%m-%d %H:%M}Z', T.et_stamp(utc), want)
except Exception:  # noqa: BLE001
    print('  (zoneinfo unavailable here — the built-in rule is what runs)')

# ── versions + footers ───────────────────────────────────────────────────────
print('=== versions + footers ===')
check('bump v0.90', T.bump_version('v0.90'), 'v0.91')
check('bump v0.99', T.bump_version('v0.99'), 'v0.100')
check('bump v9', T.bump_version('v9'), 'v10')
check('bump v0.9.31', T.bump_version('v0.9.31'), 'v0.9.32')
raises('bump garbage', lambda: T.bump_version('beta'), 'not a version')
page = ('<footer>Arena Studio v0.90 | 2026-09-26 15:50 ET · <a href="x">GitHub</a></footer>'
        '<script>/Arena Studio v[0-9.]+/</script>')
check('read footer', T.read_footer(page, 'studio'), ('v0.90', '2026-09-26 15:50'))
new = T.set_footer(page, 'studio', 'v0.91', '2026-10-02 14:05 ET')
check('set footer', T.read_footer(new, 'studio'), ('v0.91', '2026-10-02 14:05'))
check('set footer keeps the link', '· <a href="x">GitHub</a>' in new, True)
raises('two footers refused', lambda: T.read_footer(page + page, 'studio'), 'exactly one')
raises('stamp must say ET', lambda: T.set_footer(page, 'studio', 'v0.91', '2026-10-02 14:05'), 'ET')
check('pattern designer footer', T.read_footer('Pattern Designer v0.10 | 2026-07-05 13:40 ET · ', 'pattern-designer'),
      ('v0.10', '2026-07-05 13:40'))
check('resolve "Arena Studio"', T.resolve_tool('Arena Studio'), 'studio')
check('resolve "pattern editor"', T.resolve_tool('pattern editor'), 'pattern-designer')
check('resolve unknown', T.resolve_tool('Toaster'), None)

# ── release notes ────────────────────────────────────────────────────────────
print('=== release notes ===')
body = """## Summary
stuff

## Release notes
<!-- hint: user voice -->
### Studio
- **Closed-loop trials open at their frame.** Detail.
  continuation line
### Pattern Designer
- **GS2 guard.**

## Test plan
- [x] tests
"""
n = T.parse_release_notes(body)
check('notes present', n['present'], True)
check('notes tools', sorted(n['tools']), ['pattern-designer', 'studio'])
check('studio lines', n['tools']['studio'], ['- **Closed-loop trials open at their frame.** Detail.', '  continuation line'])
check('section ends at next ##', any('tests' in l for l in n['tools']['pattern-designer']), False)
check('none declared', T.parse_release_notes('## Release notes\nNone.\n')['none'], True)
check('missing section', T.parse_release_notes('## Summary\nx')['present'], False)
d = T.parse_release_notes('## Release notes\n- bare bullet\n')
check('bare bullets → studio', (d['tools'], d['default_used']), ({'studio': ['- bare bullet']}, True))
check('unknown tool heading', T.parse_release_notes('## Release notes\n### Toaster\n- x\n')['unknown'], ['Toaster'])
tmpl = Path(HERE.parent / '.github' / 'pull_request_template.md')
if tmpl.exists():
    check('untouched PR template → no notes', T.parse_release_notes(tmpl.read_text(encoding='utf-8'))['tools'], {})
check('CRLF bodies', T.parse_release_notes('## Release notes\r\n### Studio\r\n- a\r\n')['tools'], {'studio': ['- a']})
existing = '# Arena Studio — release notes\n\nIntro.\n\n## v0.90 (2026-09-26) · Old\n\n- old\n'
folded = T.fold_notes(existing, 'Arena Studio', 'v0.91 (2026-10-02) · New', [(225, ['- new'])])
check('fold: newest first', folded.index('## v0.91') < folded.index('## v0.90'), True)
check('fold: intro kept', folded.startswith('# Arena Studio — release notes\n\nIntro.\n\n## v0.91'), True)
check('fold: PR marker', '<!-- #225 -->\n- new' in folded, True)
created = T.fold_notes(None, 'Pattern Designer', 'v0.11 (2026-10-02)', [(43, ['- x'])])
check('fold: creates a missing file', created.startswith('# Pattern Designer — release notes') and '## v0.11' in created, True)
check('clean title', T.clean_title('feat(closed loop): a trial opens at its frame — Studio v0.91'), 'A trial opens at its frame')

# ── PR ordering / CI / validation / naming ───────────────────────────────────
print('=== planning ===')


def pr(n, head, base='main', **kw):
    return {'number': n, 'headRefName': head, 'baseRefName': base, 'state': 'OPEN', 'isCrossRepository': False,
            'title': f'PR {n}', **kw}


check('order: given order', [p['number'] for p in C.order_prs([pr(1, 'a'), pr(2, 'b')])], [1, 2])
check('order: parent first', [p['number'] for p in C.order_prs([pr(2, 'b', base='a'), pr(1, 'a')])], [1, 2])
raises('stack parent missing', lambda: C.order_prs([pr(2, 'b', base='a')]), 'stacked on "a"')
raises('fork refused', lambda: C.order_prs([pr(1, 'a', isCrossRepository=True)]), 'fork')
raises('WIP limit', lambda: C.order_prs([pr(i, f'b{i}') for i in range(5)]), 'WIP limit')
check('WIP override', len(C.order_prs([pr(i, f'b{i}') for i in range(5)], wip_limit=6)), 5)
raises('closed PR refused', lambda: C.order_prs([pr(1, 'a', state='MERGED')]), 'not open')
raises('empty list', lambda: C.order_prs([]), 'no PRs')

check('ci none', C.ci_state({'statusCheckRollup': []}), 'none')
check('ci green', C.ci_state({'statusCheckRollup': [{'conclusion': 'SUCCESS'}, {'conclusion': 'SKIPPED'}]}), 'green')
check('ci pending', C.ci_state({'statusCheckRollup': [{'conclusion': 'SUCCESS'}, {'status': 'IN_PROGRESS'}]}), 'pending')
check('ci red', C.ci_state({'statusCheckRollup': [{'conclusion': 'FAILURE'}, {'status': 'IN_PROGRESS'}]}), 'red')
check('ci status context', C.ci_state({'statusCheckRollup': [{'state': 'SUCCESS'}]}), 'green')

sha = 'abc1234def5678' + '0' * 26
check('validation: matching sha', len(C.validation_ok([{'body': '✅ **Validated** `abc1234` on rig5'}], sha)), 1)
check('validation: other sha', len(C.validation_ok([{'body': 'Validated `fff1234`'}], sha)), 0)
check('validation: sha without the word', len(C.validation_ok([{'body': 'looked at abc1234'}], sha)), 0)
check('name: plain', C.release_name('2026-10-02', set(), False), '2026-10-02')
check('name: second same day', C.release_name('2026-10-02', {'release-2026-10-02'}, False), '2026-10-02.2')
check('name: hotfix', C.release_name('2026-10-02', set(), True), '2026-10-02-hotfix')
check('docs-only drift', T.docs_only(['docs/x.md', 'README.md', '.claude/skills/a/SKILL.md', 'releases/r.json']), True)
check('code drift', T.docs_only(['docs/x.md', 'arena_studio.html']), False)
check('course md is docs', T.docs_only(['course/cshl-2026/docs/p3.md']), True)

html_main = {'studio': page, 'pattern-designer': 'Pattern Designer v0.10 | 2026-07-05 13:40 ET'}
plan = C.plan_versions(['js/arena-runner-g6.js'], {225: T.parse_release_notes(body)}, html_main)
check('plan: tools from notes', plan, {'pattern-designer': {'from': 'v0.10', 'to': 'v0.11'},
                                        'studio': {'from': 'v0.90', 'to': 'v0.91'}})
plan2 = C.plan_versions(['arena_studio.html'], {1: {'tools': {}}}, html_main)
check('plan: tool from a changed page', plan2, {'studio': {'from': 'v0.90', 'to': 'v0.91'}})
plan3 = C.plan_versions([], {}, html_main, {'studio': 'v1.0'})
check('plan: override', plan3, {'studio': {'from': 'v0.90', 'to': 'v1.0'}})
man = {'name': '2026-10-02', 'kind': 'candidate', 'rc': 2, 'versions': plan2, 'prs': [{'number': 225, 'title': 't'}]}
msg = C.commit_message(man)
check('commit message trailer', T.trailer_manifest(msg), 'releases/2026-10-02.json')
check('commit message subject', msg.split('\n')[0], 'release: 2026-10-02 rc2 — Arena Studio v0.91')


# ── git fixtures ─────────────────────────────────────────────────────────────
def g(repo, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@x', GIT_COMMITTER_NAME='t',
               GIT_COMMITTER_EMAIL='t@x', GIT_CONFIG_NOSYSTEM='1')
    p = subprocess.run(['git', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
                        '-c', 'core.autocrlf=false', *args], cwd=repo, capture_output=True, text=True, env=env)
    if p.returncode != 0 and args[0] not in ('merge',):
        raise RuntimeError(f'git {args}: {p.stderr}')
    return p.stdout.strip()


def write(repo, rel, text):
    p = Path(repo) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode('utf-8'))


STUDIO = ('<!doctype html>\n<html>\n<head>\n<title>S</title>\n</head>\n<body>\n<p>line A</p>\n'
          '<footer>Arena Studio v0.90 | 2026-09-26 15:50 ET · <a href="gh">GitHub</a></footer>\n</body>\n</html>\n')
os.environ.setdefault('GIT_AUTHOR_NAME', 't')
os.environ.setdefault('GIT_AUTHOR_EMAIL', 't@x')
os.environ.setdefault('GIT_COMMITTER_NAME', 't')
os.environ.setdefault('GIT_COMMITTER_EMAIL', 't@x')

with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp) / 'repo'
    repo.mkdir()
    g(repo, 'init', '-q')
    # repo-local, so candidate.py's own git calls see it too (Windows runners default to
    # core.autocrlf=true, which would make this fixture differ from the helper's view)
    g(repo, 'config', 'core.autocrlf', 'false')
    write(repo, 'arena_studio.html', STUDIO)
    write(repo, 'flasher/index.html', '<html><head></head><body>flash</body></html>\n')
    write(repo, 'docs/fragment.html', '<p>no head here</p>\n')
    write(repo, 'js/a.js', 'one\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-qm', 'base')
    main_sha = g(repo, 'rev-parse', 'HEAD')

    print('=== byte-exact I/O (Windows line endings) ===')
    crlf_page = STUDIO.replace('\n', '\r\n')
    cp = Path(tmp) / 'crlf.html'
    T.write_text_exact(cp, crlf_page)
    T.write_text_exact(cp, T.set_footer(T.read_text_exact(cp), 'studio', 'v0.91', '2026-10-02 14:05 ET'))
    raw = cp.read_bytes()
    check('CRLF page keeps every CRLF', (raw.count(b'\r\n'), raw.count(b'\n')),
          (crlf_page.count('\r\n'), crlf_page.count('\r\n')))
    lp = Path(tmp) / 'lf.html'
    T.write_text_exact(lp, STUDIO)
    T.write_text_exact(lp, T.set_footer(T.read_text_exact(lp), 'studio', 'v0.91', '2026-10-02 14:05 ET'))
    check('LF page gains no CR', lp.read_bytes().count(b'\r'), 0)

    print('=== merge loop ===')
    g(repo, 'checkout', '-qb', 'feat-a')
    write(repo, 'js/a.js', 'one\ntwo\n')
    g(repo, 'commit', '-qam', 'a')
    a_sha = g(repo, 'rev-parse', 'HEAD')
    g(repo, 'checkout', '-q', 'main')
    g(repo, 'checkout', '-qb', 'feat-b')
    write(repo, 'arena_studio.html', STUDIO.replace('line A', 'line B'))
    g(repo, 'commit', '-qam', 'b')
    b_sha = g(repo, 'rev-parse', 'HEAD')
    g(repo, 'checkout', '-q', 'main')
    g(repo, 'checkout', '-qb', 'feat-c')
    write(repo, 'arena_studio.html', STUDIO.replace('line A', 'line C'))
    g(repo, 'commit', '-qam', 'c')
    c_sha = g(repo, 'rev-parse', 'HEAD')
    g(repo, 'checkout', '-q', '--detach', main_sha)
    prs = [{'number': 1, 'title': 'A', 'headRefOid': a_sha}, {'number': 2, 'title': 'B', 'headRefOid': b_sha}]
    C.merge_prs(repo, prs)
    check('clean merges', g(repo, 'show', 'HEAD:js/a.js').split('\n'), ['one', 'two'])
    check('both heads are ancestors',
          all(subprocess.run(['git', 'merge-base', '--is-ancestor', s, 'HEAD'], cwd=repo).returncode == 0
              for s in (a_sha, b_sha)), True)
    check('merge commits (--no-ff)', g(repo, 'log', '--merges', '--format=%s', f'{main_sha}..HEAD').split('\n'),
          ['Merge #2: B', 'Merge #1: A'])
    try:
        C.merge_prs(repo, [{'number': 3, 'title': 'C', 'headRefOid': c_sha}])
        check('conflict raised', False, True)
    except C.Conflict as e:
        check('conflict names the PR + file', (e.pr, e.files), (3, ['arena_studio.html']))
    g(repo, 'merge', '--abort')

    print('=== release commit ===')
    notes = {1: T.parse_release_notes('## Release notes\n### Studio\n- **A thing.**\n')}
    plan = C.plan_versions(C._changed_paths(main_sha, 'HEAD', repo), notes,
                           {'studio': g(repo, 'show', f'{main_sha}:arena_studio.html')})
    man = {'schema': 1, 'name': '2026-10-02', 'kind': 'candidate', 'rc': 1, 'main_sha': main_sha,
           'prs': [{'number': 1, 'title': 'A', 'head_sha': a_sha}, {'number': 2, 'title': 'B', 'head_sha': b_sha}],
           'versions': plan, 'hotfix_reason': None}
    C.write_release_commit(repo, man, notes, 'A thing', '2026-10-02 14:05 ET')
    cand = g(repo, 'rev-parse', 'HEAD')
    check('footer bumped', T.read_footer((repo / 'arena_studio.html').read_text(encoding='utf-8'), 'studio'),
          ('v0.91', '2026-10-02 14:05'))
    rn = (repo / 'docs/development/arena-studio-release-notes.md').read_text(encoding='utf-8')
    check('notes file created with the entry', '## v0.91 (2026-10-02) · A thing' in rn and '- **A thing.**' in rn, True)
    check('manifest committed', json.loads(g(repo, 'show', f'{cand}:releases/2026-10-02.json'))['rc'], 1)
    check('stamp finds the manifest', S.candidate_manifest(cand, cwd=repo)['name'], '2026-10-02')
    g(repo, 'branch', '-f', 'next', cand)

    print('=== stamp: meta + banner ===')
    b = {'channel': 'production', 'sha': 'x"<y'}
    out = S.inject_meta(STUDIO, b)
    check('meta after <head>', out.split('\n')[2].startswith('<head>') and out.split('\n')[3].startswith('<meta name="wdt-build"'), True)
    check('meta escaped', '&quot;' in out and 'x"<y' not in out, True)
    check('meta idempotent', S.inject_meta(out, b), out)
    check('meta strip round-trip', S.META_RE.sub('', out, count=1), STUDIO)
    check('no <head> → skipped', S.inject_meta('<p>x</p>', b), None)
    bn = S.inject_banner(out, {'channel': 'next', 'candidate': {'label': 'candidate 2026-10-02-rc1',
                                                                'prs': [{'number': 1}]}}, '../arena_studio.html')
    check('banner before </body>', bn.index('wdt-next-banner') < bn.rindex('</body>'), True)
    check('banner links back to Production', 'href="../arena_studio.html"' in bn, True)
    check('prod href depth 0', S.prod_href_for(Path('arena_studio.html')), '../arena_studio.html')
    check('prod href depth 1', S.prod_href_for(Path('flasher/index.html')), '../../flasher/index.html')

    print('=== stamp: build ===')
    site = Path(tmp) / '_site'
    res = S.build_site(site, main_sha, 'next', cwd=repo)
    check('root sha', res['root_sha'], main_sha)
    check('next sha', res['next_sha'], cand)
    check('root build.json', json.loads((site / 'build.json').read_text())['channel'], 'production')
    nb = json.loads((site / 'next' / 'build.json').read_text())
    check('next build.json candidate', (nb['channel'], nb['candidate']['name'], nb['candidate']['rc']),
          ('next', '2026-10-02', 1))
    nxt_page = (site / 'next' / 'arena_studio.html').read_text(encoding='utf-8')
    check('next page is the candidate (v0.91)', T.read_footer(nxt_page, 'studio')[0], 'v0.91')
    check('next page has the banner', 'wdt-next-banner' in nxt_page, True)
    check('prod page has no banner', 'wdt-next-banner' in (site / 'arena_studio.html').read_text(encoding='utf-8'), False)
    check('prod page is main (v0.90)', T.read_footer((site / 'arena_studio.html').read_text(encoding='utf-8'), 'studio')[0], 'v0.90')
    check('fragment without <head> untouched', (site / 'docs/fragment.html').read_text(), '<p>no head here</p>\n')
    check('production verified', S.verify_root(site, main_sha, cwd=repo), [])
    (site / 'js/a.js').write_text('tampered\n')
    check('tampering detected', S.verify_root(site, main_sha, cwd=repo), [f'differs from {main_sha[:10]}: js/a.js'])

    res2 = S.build_site(site, main_sha, 'none', cwd=repo)
    ph = (site / 'next' / 'arena_studio.html').read_text(encoding='utf-8')
    check('placeholder when no candidate', (res2['next_sha'], 'no candidate is live' in ph), (None, True))
    check('placeholder for nested pages', (site / 'next' / 'flasher' / 'index.html').exists(), True)
    check('placeholder links to Production', 'href="../../flasher/index.html"' in
          (site / 'next' / 'flasher' / 'index.html').read_text(encoding='utf-8'), True)
    check('placeholder build.json', json.loads((site / 'next' / 'build.json').read_text())['candidate'], None)

    res3 = S.build_site(site, main_sha, 'no-such-ref', cwd=repo)
    check('bad Next ref → placeholder, production still builds', (res3['next_sha'], res3['root_sha']), (None, main_sha))
    g(repo, 'checkout', '-q', '--detach', main_sha)
    g(repo, 'checkout', '-qb', 'stray')
    write(repo, 'js/a.js', 'stray\n')
    g(repo, 'commit', '-qam', 'stray')
    stray = g(repo, 'rev-parse', 'HEAD')
    raises('arbitrary commit refused as Next', lambda: S.resolve_next(stray, cwd=repo), 'not on the next branch')

    write(repo, 'next/index.html', '<html><head></head></html>\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-qm', 'reserved')
    bad = g(repo, 'rev-parse', 'HEAD')
    raises('reserved next/ in main refused', lambda: S.build_site(site, bad, 'none', cwd=repo), 'reserved')

print('\n=== Summary ===')
print(f'{total - failures} / {total} checks passed')
sys.exit(1 if failures else 0)
