#!/usr/bin/env python3
"""Two-tier releases: build a frozen Next candidate, validate it, promote it to Production.

    pixi run candidate -- 219 178 [--headline TEXT] [--name 2026-10-02] [--no-wait]
    pixi run candidate -- --hotfix "why" 225          (skips the Next soak; never moves /next/)
    pixi run candidate -- --continue | --abort          (after resolving a merge conflict)
    pixi run tiers -- status
    pixi run tiers -- validate --rig rig5 --by Isabel --notes "P3 epochs open on 25/75"
    pixi run tiers -- validate --rig rig5 --by Isabel --notes-file notes.md   (multi-line / `code`)
    pixi run release [-- --yes]
    pixi run tiers -- rollback --to release-2026-10-02 [--revert release-2026-10-09]

Model (docs/development/release-process.md): Next = exactly one frozen candidate =
main@sha + an explicit list of PR heads (pinned SHAs, merged --no-ff) + one release
commit (version bumps, release notes folded from each PR's `## Release notes` section,
and a durable manifest releases/<name>.json). Production = main. Promotion merges the
candidate's release PR with a merge commit, so the constituent PRs close as "indirectly
merged" — which bypasses their own protections, so `release` checks their CI itself.

Needs `git` and `gh` (pixi provides gh; run `gh auth login` once). Pure Python otherwise;
runs on macOS, Linux and Windows.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tierlib as T  # noqa: E402

WIP_LIMIT = 4
DEFAULT_DATA_REPO = 'reiserlab/cshl-2026-course'
CI_OK = {'SUCCESS', 'NEUTRAL', 'SKIPPED'}
STATE_FILE = 'candidate-state.json'


class Conflict(T.ToolError):
    def __init__(self, pr, files):
        super().__init__(f'merge conflict merging #{pr}: ' + ', '.join(files))
        self.pr, self.files = pr, files


# ── gh ───────────────────────────────────────────────────────────────────────
def gh_json(*args, cwd=None):
    return json.loads(T.run(['gh', *args], cwd=cwd) or 'null')


PR_FIELDS = ('number,title,url,state,isDraft,isCrossRepository,headRefName,headRefOid,'
             'baseRefName,body,statusCheckRollup,mergeable')


def fetch_pr(n: int, cwd=None) -> dict:
    return gh_json('pr', 'view', str(n), '--json', PR_FIELDS, cwd=cwd)


def ci_state(pr: dict) -> str:
    """'green' | 'pending' | 'red' | 'none' from a statusCheckRollup."""
    checks = pr.get('statusCheckRollup') or []
    if not checks:
        return 'none'
    states = []
    for c in checks:
        concl = (c.get('conclusion') or '').upper()
        status = (c.get('status') or c.get('state') or '').upper()
        if concl:
            states.append(concl)
        elif status in ('SUCCESS', 'FAILURE', 'ERROR'):  # commit-status contexts
            states.append(status)
        else:
            states.append('PENDING')
    if any(s in ('FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE')
           for s in states):
        return 'red'
    if any(s not in CI_OK for s in states):
        return 'pending'
    return 'green'


# ── pure planning helpers (unit-tested) ──────────────────────────────────────
def order_prs(prs: list, wip_limit: int = WIP_LIMIT, main: str = 'main') -> list:
    """Validate + order the selected PRs. Stacks must be explicit: a PR based on another
    PR's branch needs that PR in the list, and is merged after it."""
    if not prs:
        raise T.ToolError('no PRs given')
    if wip_limit and len(prs) > wip_limit:
        raise T.ToolError(f'{len(prs)} PRs > the WIP limit of {wip_limit} per candidate '
                          '(use --wip N to override deliberately)')
    by_branch = {p['headRefName']: p for p in prs}
    for p in prs:
        n = p['number']
        if p.get('state') not in (None, 'OPEN'):
            raise T.ToolError(f'#{n} is {p.get("state")}, not open')
        if p.get('isCrossRepository'):
            raise T.ToolError(f'#{n} comes from a fork — candidates only take same-repo branches')
        base = p.get('baseRefName')
        if base != main and base not in by_branch:
            raise T.ToolError(f'#{n} is stacked on "{base}" — list the PR for that branch too '
                              f'(dependencies must be explicit), or retarget #{n} to {main}')
    ordered, seen = [], set()

    def visit(p, stack=()):
        if p['number'] in seen:
            return
        if p['number'] in stack:
            raise T.ToolError('circular PR stack: ' + ' → '.join(f'#{x}' for x in stack))
        parent = by_branch.get(p.get('baseRefName'))
        if parent is not None:
            visit(parent, stack + (p['number'],))
        seen.add(p['number'])
        ordered.append(p)

    for p in prs:  # the given order, with parents pulled ahead of their children
        visit(p)
    return ordered


def plan_versions(changed_paths, notes_by_pr: dict, html_texts: dict, overrides: dict | None = None):
    """Which tools to bump, from→to. A tool is bumped if its page changed or any PR has
    release notes for it. html_texts: {tool_key: text of its page at main}."""
    tools = set()
    for key, t in T.TOOLS.items():
        if t['html'] in changed_paths:
            tools.add(key)
    for notes in notes_by_pr.values():
        tools.update(notes.get('tools', {}).keys())
    for k in (overrides or {}):
        tools.add(k)
    plan = {}
    for key in sorted(tools):
        if key not in html_texts:
            continue
        cur, _ = T.read_footer(html_texts[key], key)
        plan[key] = {'from': cur, 'to': (overrides or {}).get(key) or T.bump_version(cur)}
    return plan


def validation_ok(comments: list, candidate_sha: str) -> list:
    """Validation notes on the release PR that name this exact candidate (≥ 7-char SHA)."""
    short = candidate_sha[:7]
    good = []
    for c in comments or []:
        body = c.get('body') or ''
        if re.search(r'(?i)\bvalidated\b', body) and re.search(rf'\b{short}[0-9a-f]*\b', body):
            good.append(c)
    return good


def release_name(date: str, existing_tags: set, hotfix: bool) -> str:
    base = f'{date}-hotfix' if hotfix else date
    name, k = base, 1
    while f'release-{name}' in existing_tags:
        k += 1
        name = f'{base}.{k}'
    return name


def commit_message(man: dict) -> str:
    vers = ', '.join(f"{T.TOOLS[k]['name']} {v['to']}" for k, v in man['versions'].items()) or 'no version bumps'
    prs = ', '.join(f"#{p['number']}" for p in man['prs'])
    kind = 'hotfix' if man['kind'] == 'hotfix' else f"rc{man['rc']}"
    return (f"release: {man['name']} {kind} — {vers}\n\n"
            f"{'Hotfix' if man['kind'] == 'hotfix' else 'Candidate'} for Production. PRs: {prs}.\n\n"
            f"{T.MANIFEST_TRAILER}: {T.manifest_path(man['name'])}\n")


def pr_body(man: dict, notes_by_pr: dict, ci_by_pr: dict, candidate_sha: str) -> str:
    vers = '\n'.join(f"| {T.TOOLS[k]['name']} | {v['from']} → **{v['to']}** |" for k, v in man['versions'].items())
    rows = []
    for p in man['prs']:
        n = notes_by_pr.get(p['number'], {})
        note = ('none (declared)' if n.get('none') else
                ', '.join(T.TOOLS[k]['name'] for k in n.get('tools', {})) if n.get('tools') else
                '⚠ **missing**')
        rows.append(f"| #{p['number']} | {p['title']} | `{p['head_sha'][:10]}` | {ci_by_pr.get(p['number'], '?')} | {note} |")
    hot = man['kind'] == 'hotfix'
    lines = [
        f"<!-- tiers:candidate name={man['name']} rc={man['rc']} sha={candidate_sha} -->",
        f"**{'Hotfix' if hot else 'Release candidate'} `{man['name']}` "
        f"{'' if hot else 'rc' + str(man['rc'])}** · candidate commit `{candidate_sha[:10]}` · "
        f"built on main `{man['main_sha'][:10]}`",
        '',
        f"{'**Hotfix reason:** ' + man['hotfix_reason'] if hot else 'Live on **Next**: https://reiserlab.github.io/webDisplayTools/next/'}",
        '',
        '| Tool | Version |', '|---|---|', vers or '| — | no version bumps |', '',
        '| PR | Title | Head | CI | Release notes |', '|---|---|---|---|---|', *rows, '',
        '### Promotion checklist',
        '- [ ] CI green on this PR and on every constituent PR (`pixi run release` checks)',
    ]
    if not hot:
        lines += [
            f'- [ ] Validated on a rig **between sessions** — comment `Validated {candidate_sha[:7]} …` '
            '(`pixi run tiers -- validate --rig … --by …`). Any change to a constituent PR = rebuild (rc+1) = validate again.',
        ]
    lines += [
        '- [ ] Release window: Slack heads-up posted; nobody is mid-experiment (`release` lists recent rig runs — advisory)',
        '- [ ] After merge: rigs hard-refresh between sessions; if `fictrac-bridge/` changed, rig PCs `git pull` + restart the bridge',
        '',
        'Promote with `pixi run release` (merges with a merge commit — never squash — and tags '
        f"`release-{man['name']}`). Manifest: `{T.manifest_path(man['name'])}`.",
        '',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code) release tooling (`scripts/tiers/candidate.py`)',
    ]
    return '\n'.join(lines) + '\n'


def slack_text(man: dict, stage: str) -> str:
    vers = ', '.join(f"{T.TOOLS[k]['name']} {v['to']}" for k, v in man['versions'].items())
    prs = '\n'.join(f"• #{p['number']} {p['title']}" for p in man['prs'])
    if stage == 'next':
        return (f":test_tube: *Next candidate `{man['name']}` rc{man['rc']}* is live at "
                f"https://reiserlab.github.io/webDisplayTools/next/ ({vers})\n{prs}\n"
                'Please test it *between sessions* — never open Next on a rig PC mid-experiment.')
    return (f":rocket: *Releasing `{man['name']}` to Production* ({vers})\n{prs}\n"
            'After it lands: hard-refresh the Studio between sessions (Cmd/Ctrl+Shift+R).')


# ── git worktree for building candidates ─────────────────────────────────────
def work_dir(root: Path) -> Path:
    return root / '.tiers'


def state_path(root: Path) -> Path:
    return work_dir(root) / STATE_FILE


def fresh_worktree(root: Path, sha: str) -> Path:
    wt = work_dir(root) / 'candidate'
    if wt.exists():
        T.git('worktree', 'remove', '--force', str(wt), cwd=root, check=False)
        shutil.rmtree(wt, ignore_errors=True)
    T.git('worktree', 'prune', cwd=root, check=False)
    wt.parent.mkdir(parents=True, exist_ok=True)
    T.git('worktree', 'add', '--force', '--detach', str(wt), sha, cwd=root)
    return wt


def _rc(args, cwd) -> int:
    import subprocess
    return subprocess.run([str(a) for a in args], cwd=cwd, capture_output=True).returncode


def merge_prs(wt: Path, prs: list, start: int = 0) -> None:
    """Merge each PR head --no-ff, in order. On a conflict, raise Conflict and leave the
    merge in progress in the worktree (resolve there, commit, then --continue)."""
    for p in prs[start:]:
        msg = f"Merge #{p['number']}: {p['title']}"
        out = T.run(['git', '-c', 'rerere.enabled=false', 'merge', '--no-ff', '--no-edit', '-m', msg,
                     p['headRefOid']], cwd=wt, check=False)
        conflicted = T.git('diff', '--name-only', '--diff-filter=U', cwd=wt, check=False).split()
        if conflicted:
            raise Conflict(p['number'], conflicted)
        if _rc(['git', 'merge-base', '--is-ancestor', p['headRefOid'], 'HEAD'], wt) != 0:
            raise T.ToolError(f"merging #{p['number']} did not complete: {out.strip()}")


def _vtuple(v: str) -> tuple:
    return tuple(int(x) for x in v.lstrip('v').split('.'))


def adopt_legacy_bumps(wt: Path, versions: dict) -> list:
    """PRs opened before release-time versioning bumped the footer (and wrote a notes entry)
    themselves. Don't double-bump: if the merged page is already ahead of main, release
    THAT version. Returns the tool keys adopted this way."""
    adopted = []
    for key, v in versions.items():
        merged, _ = T.read_footer(T.read_text_exact((wt / T.TOOLS[key]['html'])), key)
        if _vtuple(merged) > _vtuple(v['from']) and not v.get('override'):
            v['to'] = merged
            v['legacy_pr_bump'] = True
            adopted.append(key)
    return adopted


def _newest_notes_version(text: str | None) -> str | None:
    m = re.search(r'^## (v\d+(?:\.\d+)*)\b', text or '', re.MULTILINE)
    return m.group(1) if m else None


def write_release_commit(wt: Path, man: dict, notes_by_pr: dict, headline: str, stamp: str) -> None:
    """Bump each planned tool's footer, fold release notes, write the manifest, commit."""
    date = stamp.split(' ')[0]
    for key, v in man['versions'].items():
        t = T.TOOLS[key]
        page = wt / t['html']
        T.write_text_exact(page, T.set_footer(T.read_text_exact(page), key, v['to'], stamp))
        blocks = [(n, notes['tools'][key]) for n, notes in notes_by_pr.items() if key in notes.get('tools', {})]
        notes_file = wt / t['notes']
        existing = T.read_text_exact(notes_file) if notes_file.exists() else None
        if not t['notes'].endswith('web-tools-release-notes.md') and _newest_notes_version(existing) == v['to']:
            continue  # a legacy PR already wrote this version's entry — keep it, don't duplicate
        shared = t['notes'].endswith('web-tools-release-notes.md')
        title = 'Web tools' if shared else t['name']
        header = (f"{t['name']} {v['to']}" if shared else v['to']) + f' ({date})' + (f' · {headline}' if headline else '')
        if not blocks:
            blocks = [(None, ['- Maintenance release (no user-visible notes).'])]
        notes_file.parent.mkdir(parents=True, exist_ok=True)
        T.write_text_exact(notes_file, T.fold_notes(existing, title, header, blocks))
    mp = wt / T.manifest_path(man['name'])
    mp.parent.mkdir(parents=True, exist_ok=True)
    T.write_text_exact(mp, json.dumps(man, indent=2) + '\n')
    T.git('add', '-A', cwd=wt)
    T.run(['git', 'commit', '-q', '-F', '-'], cwd=wt, input_text=commit_message(man))


# ── commands ─────────────────────────────────────────────────────────────────
def _changed_paths(a: str, b: str, cwd) -> list:
    return [p for p in T.git('diff', '--name-only', f'{a}..{b}', cwd=cwd).split('\n') if p]


def _existing_rc(root: Path, name: str) -> int:
    ref = f'origin/release/{name}'
    if T.git('rev-parse', '-q', '--verify', ref, cwd=root, check=False):
        try:
            return int(json.loads(T.git('show', f'{ref}:{T.manifest_path(name)}', cwd=root)).get('rc', 0))
        except Exception:
            return 0
    return 0


def cmd_build(a, root: Path) -> int:
    st = state_path(root)
    if a.abort:
        if st.exists():
            st.unlink()
        wt = work_dir(root) / 'candidate'
        T.git('worktree', 'remove', '--force', str(wt), cwd=root, check=False)
        print('Candidate build aborted; nothing was pushed.')
        return 0
    if a.cont:
        if not st.exists():
            raise T.ToolError('nothing to continue (no candidate build in progress)')
        state = json.loads(T.read_text_exact(st))
        wt = Path(state['worktree'])
        if T.git('diff', '--name-only', '--diff-filter=U', cwd=wt, check=False):
            raise T.ToolError(f'unresolved conflicts remain in {wt} — resolve, `git add`, `git commit`, then --continue')
        if T.git('rev-parse', '-q', '--verify', 'MERGE_HEAD', cwd=wt, check=False):
            raise T.ToolError(f'the merge in {wt} is not committed yet — run `git commit --no-edit` there first')
        prs = state['prs']
        idx = state['conflict_index']
        if _rc(['git', 'merge-base', '--is-ancestor', prs[idx]['headRefOid'], 'HEAD'], wt) != 0:
            raise T.ToolError(f"#{prs[idx]['number']} is not merged in {wt} yet")
        return _finish_build(a, root, wt, state, start=idx + 1)

    if st.exists():
        raise T.ToolError('a candidate build is in progress — `--continue` or `--abort` it first')
    if not a.prs:
        raise T.ToolError('give the PR numbers for the candidate, e.g. `pixi run candidate -- 219 178`')
    T.git('fetch', '--quiet', '--prune', '--tags', 'origin', cwd=root)
    main_sha = T.git('rev-parse', 'origin/main', cwd=root)
    raw = [fetch_pr(n, cwd=root) for n in a.prs]
    prs = order_prs(raw, wip_limit=a.wip)
    for p in prs:  # make every head available locally, and pin it
        T.git('fetch', '--quiet', 'origin', f"refs/pull/{p['number']}/head", cwd=root)
        got = T.git('rev-parse', 'FETCH_HEAD', cwd=root)
        if got != p['headRefOid']:
            raise T.ToolError(f"#{p['number']} moved while building (gh {p['headRefOid'][:10]} vs fetch {got[:10]}) — rerun")
    tags = set(T.git('tag', '--list', 'release-*', cwd=root).split())
    date = a.name or T.et_date()
    name = release_name(date, tags, bool(a.hotfix)) if not a.name else a.name
    state = {
        'name': name, 'hotfix_reason': a.hotfix, 'headline': a.headline, 'main_sha': main_sha,
        'prs': [{k: p[k] for k in ('number', 'title', 'url', 'headRefName', 'headRefOid', 'baseRefName', 'body')}
                for p in prs],
        'ci': {p['number']: ci_state(p) for p in prs},
        'versions_override': dict(v.split('=', 1) for v in (a.version or [])),
        'no_wait': a.no_wait, 'no_push': a.no_push,
    }
    wt = fresh_worktree(root, main_sha)
    state['worktree'] = str(wt)
    T.git('checkout', '-q', '-B', f'release/{name}', main_sha, cwd=wt)
    return _finish_build(a, root, wt, state, start=0)


def _finish_build(a, root: Path, wt: Path, state: dict, start: int) -> int:
    prs = state['prs']
    try:
        merge_prs(wt, prs, start=start)
    except Conflict as c:
        state['conflict_index'] = next(i for i, p in enumerate(prs) if p['number'] == c.pr)
        T.write_text_exact(state_path(root), json.dumps(state, indent=2))
        print(f'\nCONFLICT merging #{c.pr} into the candidate: {", ".join(c.files)}\n'
              f'Resolve it in the candidate worktree:\n  cd {wt}\n  (edit the files)\n'
              '  git add <files> && git commit --no-edit\n'
              'then:  pixi run candidate -- --continue      (or --abort)\n'
              'Two PRs that keep colliding belong in one batch/<name> branch (one PR).', file=sys.stderr)
        return 3
    name, main_sha = state['name'], state['main_sha']
    notes_by_pr = {p['number']: T.parse_release_notes(p.get('body')) for p in prs}
    changed = _changed_paths(main_sha, 'HEAD', wt)
    html_texts = {}
    for key, t in T.TOOLS.items():
        try:
            html_texts[key] = T.git('show', f"{main_sha}:{t['html']}", cwd=wt)
        except T.ToolError:
            pass
    overrides = state.get('versions_override') or {}
    versions = plan_versions(changed, notes_by_pr, html_texts, overrides)
    for k in overrides:
        if k in versions:
            versions[k]['override'] = True
    legacy = adopt_legacy_bumps(wt, versions)
    for k in legacy:
        print(f"note: a PR already bumped {T.TOOLS[k]['name']} to {versions[k]['to']} (pre-release-tier PR) "
              '— releasing that version, keeping its own notes entry', file=sys.stderr)
    for v in versions.values():
        v.pop('override', None)
    rc = _existing_rc(root, name) + 1
    stamp = T.et_stamp()
    man = {
        'schema': 1, 'name': name, 'kind': 'hotfix' if state.get('hotfix_reason') else 'candidate', 'rc': rc,
        'created_at': T.iso_utc(), 'created_at_et': stamp, 'main_sha': main_sha,
        'headline': state.get('headline') or '',
        'prs': [{'number': p['number'], 'title': p['title'], 'head_sha': p['headRefOid'],
                 'head_ref': p['headRefName'], 'url': p['url']} for p in prs],
        'versions': versions, 'hotfix_reason': state.get('hotfix_reason'),
        'bridge_changed': any(p.startswith('fictrac-bridge/') for p in changed),
    }
    headline = state.get('headline') or ' · '.join(T.clean_title(p['title']) for p in prs)
    write_release_commit(wt, man, notes_by_pr, headline, stamp)
    cand = T.git('rev-parse', 'HEAD', cwd=wt)
    if state_path(root).exists():
        state_path(root).unlink()
    for p in prs:
        n = notes_by_pr[p['number']]
        if not n['present'] and not legacy:
            print(f"WARNING: #{p['number']} has no '## Release notes' section (add one, or '## Release notes\\nnone')",
                  file=sys.stderr)
        if n.get('unknown'):
            print(f"WARNING: #{p['number']} release notes name unknown tools: {n['unknown']}", file=sys.stderr)
    print(f"\nCandidate {name} rc{rc} = {cand[:10]} (main {main_sha[:10]} + "
          + ', '.join(f"#{p['number']}" for p in prs) + ')')
    for k, v in versions.items():
        print(f"  {T.TOOLS[k]['name']}: {v['from']} → {v['to']}")
    if state.get('no_push'):
        print(f'--no-push: built locally only, in {wt} (branch release/{name}).')
        return 0

    branch = f'release/{name}'
    T.git('push', '--quiet', '--force', 'origin', f'HEAD:refs/heads/{branch}', cwd=wt)
    ci_by_pr = {int(k): v for k, v in state['ci'].items()}
    body = pr_body(man, notes_by_pr, ci_by_pr, cand)
    existing = gh_json('pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', cwd=root)
    title = (f"Hotfix {name}" if man['kind'] == 'hotfix' else f"Release {name}") + ': ' + \
        (', '.join(f"{T.TOOLS[k]['name']} {v['to']}" for k, v in versions.items()) or 'no version bumps')
    if existing:
        num = existing[0]['number']
        T.run(['gh', 'pr', 'edit', str(num), '--title', title, '--body-file', '-'], cwd=root, input_text=body)
    else:
        url = T.run(['gh', 'pr', 'create', '--draft', '--base', 'main', '--head', branch, '--title', title,
                     '--body-file', '-'], cwd=root, input_text=body).strip()
        num = int(url.rstrip('/').rsplit('/', 1)[-1])
    print(f'Release PR #{num}: https://github.com/{_repo_slug(root)}/pull/{num}')

    if not state.get('no_wait'):
        if not _wait_ci(root, num):
            print(f'CI is not green on the candidate — /next/ NOT updated. Fix, then rebuild.', file=sys.stderr)
            return 4
    if man['kind'] == 'hotfix':
        print('Hotfix: /next/ untouched. After CI: `pixi run release -- --pr ' + str(num) + '`')
        return 0
    T.git('push', '--quiet', '--force', 'origin', f'{cand}:refs/heads/next', cwd=root)
    T.run(['gh', 'workflow', 'run', 'deploy-pages.yml', '--ref', 'main', '-f', f'next={cand}'], cwd=root)
    print('Next deploy dispatched (≈2 min): https://reiserlab.github.io/webDisplayTools/next/')
    print('\nSlack draft:\n' + slack_text(man, 'next'))
    return 0


def _repo_slug(root: Path) -> str:
    return gh_json('repo', 'view', '--json', 'nameWithOwner', cwd=root)['nameWithOwner']


def _wait_ci(root: Path, num: int, timeout_s: int = 1800) -> bool:
    print('Waiting for CI on the release PR …')
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        pr = gh_json('pr', 'view', str(num), '--json', 'statusCheckRollup', cwd=root)
        s = ci_state(pr)
        if s == 'green':
            print('CI green.')
            return True
        if s == 'red':
            return False
        time.sleep(20)
    print('Timed out waiting for CI.', file=sys.stderr)
    return False


def _open_release_prs(root: Path) -> list:
    prs = gh_json('pr', 'list', '--state', 'open', '--json',
                  'number,title,headRefName,headRefOid,isDraft,url', cwd=root)
    return [p for p in prs if p['headRefName'].startswith('release/')]


def _pick_release_pr(root: Path, num: int | None) -> dict:
    rel = _open_release_prs(root)
    if num:
        rel = [p for p in rel if p['number'] == num]
    if not rel:
        raise T.ToolError('no open release PR' + (f' #{num}' if num else '') + ' — build a candidate first')
    if len(rel) > 1:
        raise T.ToolError('several open release PRs: ' + ', '.join(f"#{p['number']}" for p in rel) + ' — pass --pr N')
    return rel[0]


def _manifest_for(root: Path, sha: str) -> dict:
    msg = T.git('log', '-1', '--format=%B', sha, cwd=root)
    path = T.trailer_manifest(msg)
    if not path:
        raise T.ToolError(f'{sha[:10]} has no {T.MANIFEST_TRAILER} trailer — not a candidate commit')
    return json.loads(T.git('show', f'{sha}:{path}', cwd=root))


def _main_drift(root: Path, man: dict) -> tuple[list, bool]:
    paths = _changed_paths(man['main_sha'], 'origin/main', root)
    return paths, T.docs_only(paths)


def cmd_status(a, root: Path) -> int:
    T.git('fetch', '--quiet', '--prune', 'origin', cwd=root)
    nxt = T.git('rev-parse', '-q', '--verify', 'origin/next', cwd=root, check=False)
    print(f"next pointer: {nxt[:10] if nxt else '(none — /next/ shows the placeholder)'}")
    for rp in _open_release_prs(root):
        sha = rp['headRefOid']
        try:
            man = _manifest_for(root, sha)
        except T.ToolError as e:
            print(f"#{rp['number']} {rp['headRefName']}: {e}")
            continue
        live = ' (LIVE on /next/)' if nxt == sha else ''
        print(f"\n#{rp['number']} {man['kind']} {man['name']} rc{man['rc']} = {sha[:10]}{live}")
        drift, ok = _main_drift(root, man)
        if drift:
            print(f"  main moved since the candidate ({len(drift)} files){'; docs-only — fine' if ok else ' — REBUILD before release'}")
        for p in man['prs']:
            cur = fetch_pr(p['number'], cwd=root)
            moved = cur['headRefOid'] != p['head_sha']
            print(f"  #{p['number']} {cur['state']:<6} CI {ci_state(cur):<7} "
                  f"{'HEAD MOVED → rebuild (validation resets)' if moved else 'head pinned'}  {p['title']}")
        comments = gh_json('pr', 'view', str(rp['number']), '--json', 'comments', cwd=root)['comments']
        v = validation_ok(comments, sha)
        print(f"  validation notes on {sha[:7]}: {len(v)}" + ('' if v or man['kind'] == 'hotfix' else '  ← needed before release'))
    return 0


def validation_body(sha: str, man: dict, rig: str, by: str, notes: str = '') -> str:
    """The validation-note comment. `validation_ok` recognizes it by "Validated" + the short SHA."""
    return (f"✅ **Validated** `{sha[:7]}` — candidate {man['name']} rc{man['rc']} — on **{rig}** by **{by}**"
            + (f'\n\n{notes}' if notes else ''))


def read_notes(a) -> str:
    """--notes TEXT or --notes-file PATH. A file is the safe route for multi-line or
    backticked notes: pixi's task shell re-parses `pixi run tiers -- … --notes "…"`."""
    if getattr(a, 'notes_file', None):
        return T.read_text_exact(a.notes_file).strip()
    return a.notes or ''


def cmd_validate(a, root: Path) -> int:
    rp = _pick_release_pr(root, a.pr)
    sha = rp['headRefOid']
    man = _manifest_for(root, sha)
    body = validation_body(sha, man, a.rig, a.by, read_notes(a))
    T.run(['gh', 'pr', 'comment', str(rp['number']), '--body-file', '-'], cwd=root, input_text=body)
    print(f"Validation note posted on #{rp['number']} for {sha[:10]}.")
    return 0


def _recent_rigs(data_repo: str, hours: int = 24) -> dict:
    import datetime as dt
    since = T.iso_utc(T.now_utc() - dt.timedelta(hours=hours))
    try:
        commits = gh_json('api', '--paginate', f'repos/{data_repo}/commits?since={since}&path=runlogs&per_page=100')
    except T.ToolError as e:
        return {'__error__': str(e)}
    rigs = {}
    for c in commits or []:
        msg = (c.get('commit') or {}).get('message', '')
        m = re.search(r'runlogs/([^/\s]+)/', msg)
        rig = m.group(1) if m else '?'
        when = ((c.get('commit') or {}).get('author') or {}).get('date', '')
        rigs.setdefault(rig, []).append(when)
    return rigs


def cmd_release(a, root: Path) -> int:
    T.git('fetch', '--quiet', '--prune', '--tags', 'origin', cwd=root)
    rp = _pick_release_pr(root, a.pr)
    sha = rp['headRefOid']
    man = _manifest_for(root, sha)
    problems = []
    for p in man['prs']:
        cur = fetch_pr(p['number'], cwd=root)
        if cur['headRefOid'] != p['head_sha']:
            problems.append(f"#{p['number']} changed since the candidate was built — rebuild (validation resets)")
        if cur['state'] != 'OPEN':
            problems.append(f"#{p['number']} is {cur['state']}")
        if ci_state(cur) != 'green':
            problems.append(f"#{p['number']} CI is {ci_state(cur)} (an indirect merge would bypass its checks)")
    if ci_state(fetch_pr(rp['number'], cwd=root)) != 'green':
        problems.append(f"release PR #{rp['number']} CI is not green")
    drift, ok = _main_drift(root, man)
    if drift and not ok:
        problems.append(f"main moved since the candidate ({len(drift)} files incl. non-docs) — rebuild first")
    if man['kind'] != 'hotfix':
        comments = gh_json('pr', 'view', str(rp['number']), '--json', 'comments', cwd=root)['comments']
        if not validation_ok(comments, sha):
            problems.append(f'no validation note naming {sha[:7]} (pixi run tiers -- validate --rig … --by …)')
    elif not man.get('hotfix_reason'):
        problems.append('hotfix without a reason')
    if problems:
        print('NOT releasing:\n  ' + '\n  '.join(problems), file=sys.stderr)
        return 5

    rigs = _recent_rigs(a.data_repo)
    print(f'Release {man["name"]} ({sha[:10]}) — checks passed.')
    if '__error__' in rigs:
        print(f"  (could not read recent runs from {a.data_repo}: {rigs['__error__']})")
    elif rigs:
        print(f'  Rigs with run logs in the last 24 h ({a.data_repo}) — ADVISORY ONLY (logs commit after a run ends):')
        for rig, whens in sorted(rigs.items()):
            print(f'    {rig}: {len(whens)} commit(s), latest {max(whens)}')
    else:
        print(f'  No run-log commits in the last 24 h ({a.data_repo}) — advisory only.')
    print('\nSlack heads-up draft:\n' + slack_text(man, 'release') + '\n')
    if not a.yes:
        ans = input(f'Promote {man["name"]} to Production now? Type the release name to confirm: ').strip()
        if ans != man['name']:
            print('Not released.')
            return 6
    nxt = T.git('rev-parse', '-q', '--verify', 'origin/next', cwd=root, check=False)
    if nxt == sha:  # clear Next first, so the main deploy serves the placeholder
        T.git('push', '--quiet', 'origin', '--delete', 'next', cwd=root)
    if rp.get('isDraft'):
        T.run(['gh', 'pr', 'ready', str(rp['number'])], cwd=root)
    T.run(['gh', 'pr', 'merge', str(rp['number']), '--merge',
           '--subject', f"Release {man['name']} (#{rp['number']})"], cwd=root)
    merged = gh_json('pr', 'view', str(rp['number']), '--json', 'mergeCommit', cwd=root)
    msha = (merged.get('mergeCommit') or {}).get('oid')
    if msha:
        T.git('fetch', '--quiet', 'origin', cwd=root)
        tag = f"release-{man['name']}"
        T.git('tag', '-a', tag, msha, '-m', f"Release {man['name']}", cwd=root)
        T.git('push', '--quiet', 'origin', tag, cwd=root)
        print(f'Merged as {msha[:10]}; tagged {tag}.')
    time.sleep(3)
    for p in man['prs']:
        st = fetch_pr(p['number'], cwd=root)['state']
        print(f"  #{p['number']}: {st}" + ('' if st == 'MERGED' else '  ← expected MERGED (indirect merge); check it'))
    print('\nAfter the deploy (~2 min): rigs hard-refresh between sessions.')
    if man.get('bridge_changed'):
        print('This release changed fictrac-bridge/: rig PCs must `git pull` and restart the bridge.')
    linear = sorted({t for p in man['prs'] for t in re.findall(r'\bLAB-\d+\b', fetch_pr(p['number'], cwd=root).get('body') or '')})
    if linear:
        print('Linear tickets mentioned — PROPOSE transitions (never auto-Done): ' + ', '.join(linear))
    return 0


def cmd_rollback(a, root: Path) -> int:
    T.git('fetch', '--quiet', '--tags', 'origin', cwd=root)
    T.git('rev-parse', '--verify', f'{a.to}^{{commit}}', cwd=root)
    T.run(['gh', 'workflow', 'run', 'deploy-pages.yml', '--ref', 'main', '-f', f'root_ref={a.to}', '-f', 'next=none'],
          cwd=root)
    print(f'Emergency deploy dispatched: Production ← {a.to} (≈2 min). It is undone by the NEXT push to main,')
    print('so land the revert before anything else merges.')
    if a.revert:
        msha = T.git('rev-list', '-n', '1', a.revert, cwd=root)
        branch = f"hotfix/revert-{a.revert.removeprefix('release-')}"
        wt = fresh_worktree(root, T.git('rev-parse', 'origin/main', cwd=root))
        T.git('checkout', '-q', '-B', branch, cwd=wt)
        T.git('revert', '--no-edit', '-m', '1', msha, cwd=wt)
        T.git('push', '--quiet', '-u', 'origin', branch, cwd=wt)
        body = (f'Reverts {a.revert} (merge {msha[:10]}).\n\n## Release notes\n### Studio\n'
                f'- **Rolled back {a.revert}.**\n')
        url = T.run(['gh', 'pr', 'create', '--base', 'main', '--head', branch, '--title', f'Revert {a.revert}',
                     '--body-file', '-'], cwd=root, input_text=body).strip()
        print(f'Revert PR: {url}\nShip it as a hotfix:  pixi run candidate -- --hotfix "rollback {a.revert}" '
              + url.rsplit('/', 1)[-1])
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build', help='build a frozen candidate (default command of `pixi run candidate`)')
    b.add_argument('prs', nargs='*', type=int)
    b.add_argument('--hotfix', metavar='REASON', help='hotfix: skips the Next soak, never moves /next/')
    b.add_argument('--headline', help='release-notes headline (default: the PR titles)')
    b.add_argument('--name', help='release name (default: today ET, e.g. 2026-10-02)')
    b.add_argument('--version', action='append', metavar='TOOL=vX', help='override a version, e.g. studio=v1.0')
    b.add_argument('--wip', type=int, default=WIP_LIMIT, help=f'max PRs per candidate (default {WIP_LIMIT})')
    b.add_argument('--no-wait', action='store_true', help="don't wait for CI before updating /next/")
    b.add_argument('--no-push', action='store_true', help='build locally only (dry run)')
    b.add_argument('--continue', dest='cont', action='store_true', help='resume after resolving a conflict')
    b.add_argument('--abort', action='store_true', help='abandon an in-progress build')
    sub.add_parser('status', help='show the live candidate, drift, CI and validation')
    v = sub.add_parser('validate', help='post a validation note for the exact candidate SHA')
    v.add_argument('--rig', required=True)
    v.add_argument('--by', required=True)
    vn = v.add_mutually_exclusive_group()
    vn.add_argument('--notes', default='', help='short one-line note')
    vn.add_argument('--notes-file', help='read the note from a file (multi-line, `code`, links)')
    v.add_argument('--pr', type=int)
    r = sub.add_parser('release', help='promote the validated candidate to Production')
    r.add_argument('--pr', type=int)
    r.add_argument('--yes', action='store_true', help='skip the typed confirmation')
    r.add_argument('--data-repo', default=DEFAULT_DATA_REPO, help='repo whose runlogs/ show recent rig runs')
    rb = sub.add_parser('rollback', help='emergency: serve an older release at the site root')
    rb.add_argument('--to', required=True, help='release tag to serve, e.g. release-2026-10-02')
    rb.add_argument('--revert', help='also open a PR reverting this release tag')
    a = ap.parse_args(argv)
    try:
        root = T.repo_root()
        return {'build': cmd_build, 'status': cmd_status, 'validate': cmd_validate,
                'release': cmd_release, 'rollback': cmd_rollback}[a.cmd](a, root)
    except T.ToolError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
