#!/usr/bin/env python3
"""Assemble the two-tier GitHub Pages site: Production at /, Next at /next/.

    python scripts/tiers/stamp.py build   --out _site [--root-ref REF] [--next auto|none|REF]
    python scripts/tiers/stamp.py preview [--next auto|none|REF]     (local; then serve _site)
    python scripts/tiers/stamp.py verify  --site _site --root-ref REF

`build` is what .github/workflows/deploy-pages.yml runs. It:
  1. resolves every input to a commit SHA ONCE (never archives a moving ref twice);
  2. `git archive`s the root commit into <out>/ and the Next candidate into <out>/next/
     (or writes a placeholder when no candidate is live);
  3. stamps each HTML page with a one-line `<meta name="wdt-build" content="{…}">`
     (the build identity of the HTML actually served — js/build-channel.js reads it)
     and writes build.json at each tier root; pages under /next/ also get a small
     self-contained NEXT banner so even the standalone tools are marked;
  4. verifies the production tree is byte-identical to the root commit apart from the
     one injected meta line + build.json (a self-check on every deploy).
A Next failure never blocks Production: on any problem resolving or reading the
candidate, the placeholder is served at /next/ and the reason goes in build.json.

Pure standard library; runs on macOS, Linux and Windows.
"""

from __future__ import annotations

import argparse
import html
import io
import json
import os
import re
import shutil
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tierlib as T  # noqa: E402

META_NAME = 'wdt-build'
META_RE = re.compile(r'\n<meta name="wdt-build" content="[^"]*">')
HEAD_RE = re.compile(r'<head(\s[^>]*)?>', re.IGNORECASE)
BODY_END_RE = re.compile(r'</body\s*>', re.IGNORECASE)
BANNER_START = '<!-- wdt-next-banner -->'
BANNER_END = '<!-- /wdt-next-banner -->'
BANNER_RE = re.compile(r'\n' + re.escape(BANNER_START) + r'.*?' + re.escape(BANNER_END), re.DOTALL)
RESERVED_TOP = 'next'


# ── ref resolution ───────────────────────────────────────────────────────────
def resolve_commit(ref: str, cwd=None) -> str:
    return T.git('rev-parse', '--verify', f'{ref}^{{commit}}', cwd=cwd)


def ref_exists(ref: str, cwd=None) -> bool:
    return bool(T.git('rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}', cwd=cwd, check=False))


def resolve_next(spec: str, cwd=None, allow_any=False):
    """Return (sha or None, note). spec: 'auto' | 'none' | a commit-ish."""
    spec = (spec or 'auto').strip()
    if spec == 'none':
        return None, 'no candidate requested'
    if spec == 'auto':
        for ref in ('origin/next', 'next'):
            if ref_exists(ref, cwd):
                return resolve_commit(ref, cwd), f'{ref} branch'
        return None, 'no next branch'
    sha = resolve_commit(spec, cwd)
    if not allow_any:
        # A candidate must live on the next pointer or a release/* branch — never an
        # arbitrary commit dispatched by hand.
        holders = T.git('branch', '-a', '--contains', sha, cwd=cwd, check=False)
        if not re.search(r'(^|\s)(remotes/origin/)?(next|release/\S+)\s*$', holders, re.MULTILINE):
            raise T.ToolError(f'{spec} ({sha[:10]}) is not on the next branch or a release/* branch')
    return sha, 'requested'


def candidate_manifest(sha: str, cwd=None):
    """The release manifest a candidate commit names in its Release-Manifest trailer."""
    msg = T.git('log', '-1', '--format=%B', sha, cwd=cwd)
    path = T.trailer_manifest(msg)
    if not path:
        return None
    try:
        return json.loads(T.git('show', f'{sha}:{path}', cwd=cwd))
    except (T.ToolError, json.JSONDecodeError):
        return None


# ── archive + stamp ──────────────────────────────────────────────────────────
def archive_to(sha: str, dest: Path, cwd=None) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    data = T.git_bytes('archive', '--format=tar', sha, cwd=cwd)
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        if hasattr(tarfile, 'data_filter'):
            tf.extractall(dest, filter='data')
        else:  # Python < 3.10.12 / 3.11.4
            tf.extractall(dest)


def html_files(root: Path, skip_top=None):
    for p in sorted(root.rglob('*.html')):
        rel = p.relative_to(root)
        if skip_top and rel.parts and rel.parts[0] == skip_top:
            continue
        yield p, rel


def meta_line(build: dict) -> str:
    compact = json.dumps(build, separators=(',', ':'), sort_keys=True)
    return f'\n<meta name="{META_NAME}" content="{html.escape(compact, quote=True)}">'


def inject_meta(text: str, build: dict):
    """Insert (or replace) the build meta right after <head>. Returns None if no <head>."""
    text = META_RE.sub('', text)
    m = HEAD_RE.search(text)
    if not m:
        return None
    return text[: m.end()] + meta_line(build) + text[m.end():]


def banner_html(build: dict, prod_href: str) -> str:
    cand = build.get('candidate') or {}
    label = cand.get('label') or 'testing build'
    prs = ' '.join(f"#{p['number']}" for p in cand.get('prs', []))
    title = f'NEXT — {label}' + (f' · {prs}' if prs else '') + ' · not for routine experiments'
    return (
        '\n' + BANNER_START
        + '<div id="wdt-next-banner" role="status" title="' + html.escape(title, quote=True) + '" '
        'style="position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:2147483000;'
        'background:#ff9100;color:#0f1419;font:600 11px/1.7 \'JetBrains Mono\',ui-monospace,monospace;'
        'padding:0 10px;border-radius:0 0 6px 6px;box-shadow:0 1px 4px rgba(0,0,0,.45);white-space:nowrap">'
        + html.escape(f'NEXT · {label}')
        + ' · <a href="' + html.escape(prod_href, quote=True) + '" '
        'style="color:#0f1419;text-decoration:underline" title="Open this page on Production">'
        'Production ↗</a></div>' + BANNER_END
    )


def inject_banner(text: str, build: dict, prod_href: str) -> str:
    text = BANNER_RE.sub('', text)
    m = None
    for m in BODY_END_RE.finditer(text):
        pass  # last </body>
    snippet = banner_html(build, prod_href)
    if m is None:
        return text + snippet
    return text[: m.start()] + snippet + '\n' + text[m.start():]


def prod_href_for(rel: Path) -> str:
    """From <tier>/next/<rel> back to the same page on Production: ../ × (depth+1)."""
    return '../' * len(rel.parts) + rel.as_posix()


def stamp_tree(root: Path, build: dict, next_banner: bool, skip_top=None) -> int:
    n = 0
    for p, rel in html_files(root, skip_top=skip_top):
        try:
            text = p.read_bytes().decode('utf-8')
        except UnicodeDecodeError:
            print(f'  skip (not UTF-8): {rel}', file=sys.stderr)
            continue
        out = inject_meta(text, build)
        if out is None:
            continue  # a fragment without <head> — leave it alone
        if next_banner:
            out = inject_banner(out, build, prod_href_for(rel))
        p.write_bytes(out.encode('utf-8'))
        n += 1
    return n


PLACEHOLDER = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Next — no candidate right now</title>
<style>
  body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f1419;color:#e6edf3;font:14px/1.6 'IBM Plex Mono',ui-monospace,monospace}}
  .box{{max-width:560px;padding:28px 32px;border:1px solid #2d3640;border-radius:8px;background:#1a1f26}}
  h1{{font:600 16px 'JetBrains Mono',ui-monospace,monospace;margin:0 0 10px;color:#ff9100}}
  a{{color:#00e676}} p{{margin:8px 0}} .dim{{color:#8b949e;font-size:12px}}
</style>
</head>
<body>
<div class="box">
  <h1>NEXT · no candidate is live right now</h1>
  <p>The Next tier shows a release candidate while one is being tested. None is up at the moment{reason}.</p>
  <p><a href="{prod}" title="Open this page on Production">Open this page on Production ↗</a></p>
  <p class="dim">How candidates work: docs/development/release-process.md</p>
</div>
</body>
</html>
"""


def write_placeholder(site: Path, next_dir: Path, build: dict, reason: str) -> int:
    """A stub under /next/ for every production HTML page, so /next/ bookmarks still land."""
    n = 0
    for _, rel in html_files(site, skip_top=RESERVED_TOP):
        dst = next_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        txt = PLACEHOLDER.format(prod=html.escape(prod_href_for(rel), quote=True),
                                 reason=html.escape(f' ({reason})' if reason else ''))
        T.write_text_exact(dst, inject_meta(txt, build))
        n += 1
    return n


# ── verification ─────────────────────────────────────────────────────────────
def _tree_files(root: Path, skip_top=None):
    out = {}
    for p in root.rglob('*'):
        if p.is_file():
            rel = p.relative_to(root)
            if skip_top and rel.parts and rel.parts[0] == skip_top:
                continue
            out[rel.as_posix()] = p
    return out


def verify_root(site: Path, root_sha: str, cwd=None) -> list:
    """Production files must equal the root commit's tree, minus only the injected meta
    line and the generated build.json. Returns a list of problems (empty = OK)."""
    import tempfile

    problems = []
    with tempfile.TemporaryDirectory() as tmp:
        ref = Path(tmp) / 'ref'
        archive_to(root_sha, ref, cwd=cwd)
        want = _tree_files(ref)
        have = _tree_files(site, skip_top=RESERVED_TOP)
        have.pop('build.json', None)
        for k in sorted(set(want) - set(have)):
            problems.append(f'missing from site: {k}')
        for k in sorted(set(have) - set(want)):
            problems.append(f'extra in site: {k}')
        for k in sorted(set(want) & set(have)):
            a, b = want[k].read_bytes(), have[k].read_bytes()
            if a == b:
                continue
            if k.endswith('.html'):
                try:
                    if META_RE.sub('', b.decode('utf-8'), count=1) == a.decode('utf-8'):
                        continue
                except UnicodeDecodeError:
                    pass
            problems.append(f'differs from {root_sha[:10]}: {k}')
    return problems


# ── build ────────────────────────────────────────────────────────────────────
def build_site(out: Path, root_ref: str, next_spec: str, cwd=None, allow_any_next=False,
               run_url: str | None = None) -> dict:
    root_sha = resolve_commit(root_ref, cwd)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    archive_to(root_sha, out, cwd=cwd)
    if (out / RESERVED_TOP).exists():
        raise T.ToolError(
            f'the root commit has a top-level "{RESERVED_TOP}/" — that path is reserved for the Next tier'
        )

    built_utc = T.now_utc()
    common = {'built_at': T.iso_utc(built_utc), 'built_at_et': T.et_stamp(built_utc)}
    if run_url:
        common['run'] = run_url
    prod = {'channel': 'production', 'sha': root_sha, **common}
    rollback_tag = None if root_ref in ('HEAD', 'main', 'origin/main') else root_ref
    if rollback_tag and not re.fullmatch(r'[0-9a-f]{7,40}', root_ref):
        prod['ref'] = root_ref  # e.g. a release-… tag during an emergency rollback

    next_dir = out / RESERVED_TOP
    next_sha, note = None, ''
    try:
        next_sha, note = resolve_next(next_spec, cwd, allow_any=allow_any_next)
    except T.ToolError as e:
        note = f'could not resolve Next ({e})'
        print(f'WARNING: {note}; serving the placeholder at /next/', file=sys.stderr)

    nxt = {'channel': 'next', 'sha': next_sha, **common}
    if next_sha:
        man = candidate_manifest(next_sha, cwd)
        if man:
            nxt['candidate'] = {
                'name': man.get('name'),
                'rc': man.get('rc'),
                'kind': man.get('kind'),
                'label': f"candidate {man.get('name')}-rc{man.get('rc')}",
                'main_sha': man.get('main_sha'),
                'versions': {k: v.get('to') for k, v in (man.get('versions') or {}).items()},
                'prs': [{'number': p['number'], 'title': p.get('title', '')} for p in man.get('prs', [])],
            }
        try:
            archive_to(next_sha, next_dir, cwd=cwd)
            n_next = stamp_tree(next_dir, nxt, next_banner=True)
        except T.ToolError as e:
            print(f'WARNING: Next archive failed ({e}); serving the placeholder', file=sys.stderr)
            shutil.rmtree(next_dir, ignore_errors=True)
            next_sha, note, nxt = None, f'archive failed: {e}', {'channel': 'next', 'sha': None, **common}
    if not next_sha:
        nxt['candidate'] = None
        nxt['note'] = note
        n_next = write_placeholder(out, next_dir, nxt, note)

    T.write_text_exact((next_dir / 'build.json'), json.dumps(nxt, indent=2) + '\n')
    n_prod = stamp_tree(out, prod, next_banner=False, skip_top=RESERVED_TOP)
    T.write_text_exact((out / 'build.json'), json.dumps(prod, indent=2) + '\n')

    problems = verify_root(out, root_sha, cwd=cwd)
    if problems:
        raise T.ToolError('production tree check failed:\n  ' + '\n  '.join(problems[:20]))
    return {'root_sha': root_sha, 'next_sha': next_sha, 'next_note': note,
            'prod_pages': n_prod, 'next_pages': n_next, 'next': nxt}


def _summary(res: dict) -> str:
    lines = ['### Pages deploy', '',
             f"- **Production** `/` ← `{res['root_sha'][:10]}` ({res['prod_pages']} pages stamped; "
             'tree verified identical to the commit apart from the build stamp)']
    if res['next_sha']:
        c = res['next'].get('candidate') or {}
        prs = ', '.join(f"#{p['number']}" for p in c.get('prs', [])) or '—'
        lines.append(f"- **Next** `/next/` ← `{res['next_sha'][:10]}` · {c.get('label', 'no manifest')} · {prs}")
    else:
        lines.append(f"- **Next** `/next/` ← placeholder ({res['next_note']})")
    return '\n'.join(lines) + '\n'


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build', help='assemble both tiers (used by the deploy workflow)')
    b.add_argument('--out', default='_site')
    b.add_argument('--root-ref', default='HEAD')
    b.add_argument('--next', default='auto', help="'auto' (the next branch), 'none', or a commit-ish")
    b.add_argument('--allow-any-next', action='store_true', help='skip the next/release-branch check')
    p = sub.add_parser('preview', help='build _site locally from your refs (then serve it)')
    p.add_argument('--out', default='_site')
    p.add_argument('--root-ref', default='origin/main')
    p.add_argument('--next', default='auto')
    v = sub.add_parser('verify', help='check a built site against its root commit')
    v.add_argument('--site', default='_site')
    v.add_argument('--root-ref', required=True)
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'verify':
            probs = verify_root(Path(a.site), resolve_commit(a.root_ref))
            print('\n'.join(probs) if probs else 'OK: production tree matches its commit')
            return 1 if probs else 0
        run_url = None
        if os.environ.get('GITHUB_RUN_ID'):
            run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/" \
                      f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        res = build_site(Path(a.out), a.root_ref, a.next,
                         allow_any_next=getattr(a, 'allow_any_next', False) or a.cmd == 'preview',
                         run_url=run_url)
        summ = _summary(res)
        print(summ)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f:
                f.write(summ)
        if a.cmd == 'preview':
            print(f'Serve it:  python -m http.server -d {a.out} 8080   then open '
                  'http://localhost:8080/arena_studio.html and http://localhost:8080/next/arena_studio.html')
        return 0
    except T.ToolError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
