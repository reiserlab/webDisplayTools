"""Shared helpers for the two-tier release tooling (Production + Next).

Pure standard library, cross-platform (macOS / Linux / Windows): no bash, no `date`,
no GNU-only flags. Subprocesses are always called with argument lists.

The authority doc is docs/development/release-process.md.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import subprocess
from pathlib import Path

# ── Eastern Time stamps ──────────────────────────────────────────────────────
# The footer convention is `Tool vX | YYYY-MM-DD HH:MM ET`. On Windows, Git Bash has no
# tzdata and `TZ=America/New_York date` silently prints UTC labelled "ET" (this stamped a
# footer 4 h off once). zoneinfo is used when the platform has a tz database; otherwise
# the US rule (EDT from the 2nd Sunday of March 02:00 to the 1st Sunday of November 02:00,
# in force since 2007) is applied directly. tests/test-tiers-candidate.py checks the two
# agree wherever zoneinfo works.


def _nth_sunday(year: int, month: int, n: int) -> _dt.date:
    d = _dt.date(year, month, 1)
    first = d + _dt.timedelta(days=(6 - d.weekday()) % 7)
    return first + _dt.timedelta(weeks=n - 1)


def _et_offset_rule(utc: _dt.datetime) -> _dt.timedelta:
    y = utc.year
    # DST starts 02:00 EST (= 07:00 UTC) on the 2nd Sunday of March and ends 02:00 EDT
    # (= 06:00 UTC) on the 1st Sunday of November.
    start = _dt.datetime.combine(_nth_sunday(y, 3, 2), _dt.time(7), tzinfo=_dt.timezone.utc)
    end = _dt.datetime.combine(_nth_sunday(y, 11, 1), _dt.time(6), tzinfo=_dt.timezone.utc)
    return _dt.timedelta(hours=-4) if start <= utc < end else _dt.timedelta(hours=-5)


def to_et(utc: _dt.datetime, use_zoneinfo: bool = True) -> _dt.datetime:
    """Convert an aware UTC datetime to US Eastern (aware)."""
    if utc.tzinfo is None:
        raise ValueError('to_et needs an aware datetime')
    utc = utc.astimezone(_dt.timezone.utc)
    if use_zoneinfo:
        try:
            from zoneinfo import ZoneInfo

            return utc.astimezone(ZoneInfo('America/New_York'))
        except Exception:  # no tz database on this platform → fall back to the rule
            pass
    return utc.astimezone(_dt.timezone(_et_offset_rule(utc)))


def now_utc() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def et_stamp(utc: _dt.datetime | None = None) -> str:
    """`YYYY-MM-DD HH:MM ET` for the footer."""
    return to_et(utc or now_utc()).strftime('%Y-%m-%d %H:%M') + ' ET'


def et_date(utc: _dt.datetime | None = None) -> str:
    return to_et(utc or now_utc()).strftime('%Y-%m-%d')


def iso_utc(utc: _dt.datetime | None = None) -> str:
    return (utc or now_utc()).astimezone(_dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── Tool footers and versions ────────────────────────────────────────────────
# One generic footer shape: `<Name> vX(.Y)* | YYYY-MM-DD HH:MM ET`. The registry maps a
# tool key to its page and its user-facing release-notes file (created on demand).
TOOLS = {
    'studio': {
        'name': 'Arena Studio',
        'html': 'arena_studio.html',
        'notes': 'docs/development/arena-studio-release-notes.md',
        'aliases': ['studio', 'arena studio'],
    },
    'pattern-designer': {
        'name': 'Pattern Designer',
        'html': 'pattern_editor.html',
        'notes': 'docs/development/pattern-designer-release-notes.md',
        'aliases': ['pattern designer', 'pattern editor', 'designer'],
    },
    'dashboard': {
        'name': 'Course Data Dashboard',
        'html': 'dashboard/data-browser/index.html',
        'notes': 'docs/development/web-tools-release-notes.md',
        'aliases': ['dashboard', 'course data dashboard', 'data browser'],
    },
    'console': {
        'name': 'Arena Console',
        'html': 'arena_console.html',
        'notes': 'docs/development/web-tools-release-notes.md',
        'aliases': ['console', 'arena console'],
    },
    'flasher': {
        'name': 'G6 Panel Flash Programmer',
        'html': 'flasher/index.html',
        'notes': 'docs/development/web-tools-release-notes.md',
        'aliases': ['flasher', 'panel flasher', 'flash programmer'],
    },
    'arena-editor': {
        'name': 'Arena Editor',
        'html': 'arena_editor.html',
        'notes': 'docs/development/web-tools-release-notes.md',
        'aliases': ['arena editor'],
    },
    'icon-generator': {
        'name': 'Pattern Icon Generator',
        'html': 'icon_generator.html',
        'notes': 'docs/development/web-tools-release-notes.md',
        'aliases': ['icon generator', 'pattern icon generator'],
    },
    'experiment-designer': {
        'name': 'Experiment Designer',
        'html': 'experiment_designer.html',
        'notes': 'docs/development/web-tools-release-notes.md',
        'aliases': ['experiment designer'],
    },
}

_FOOTER_TMPL = r'(?P<name>{name}) v(?P<ver>[0-9]+(?:\.[0-9]+)*) \| (?P<ts>\d{{4}}-\d{{2}}-\d{{2}} \d{{2}}:\d{{2}}) ET'


def footer_re(tool_key: str) -> re.Pattern:
    return re.compile(_FOOTER_TMPL.format(name=re.escape(TOOLS[tool_key]['name'])))


def resolve_tool(label: str) -> str | None:
    """Map a release-notes `### <label>` heading to a tool key."""
    lab = label.strip().lower()
    for key, t in TOOLS.items():
        if lab == key or lab in t['aliases'] or lab == t['name'].lower():
            return key
    return None


def bump_version(ver: str) -> str:
    """'v0.90' → 'v0.91', 'v9' → 'v10', 'v0.9.31' → 'v0.9.32' (last component + 1)."""
    m = re.fullmatch(r'v?([0-9]+(?:\.[0-9]+)*)', ver.strip())
    if not m:
        raise ValueError(f'not a version: {ver!r}')
    parts = m.group(1).split('.')
    parts[-1] = str(int(parts[-1]) + 1)
    return 'v' + '.'.join(parts)


def read_footer(html_text: str, tool_key: str) -> tuple[str, str]:
    """Return (version, timestamp) from a tool page; exactly one footer must match."""
    found = footer_re(tool_key).findall(html_text)
    if len(found) != 1:
        raise ValueError(
            f'{TOOLS[tool_key]["html"]}: expected exactly one "{TOOLS[tool_key]["name"]} vX | '
            f'date ET" footer stamp, found {len(found)}'
        )
    _, ver, ts = found[0]
    return 'v' + ver, ts


def set_footer(html_text: str, tool_key: str, new_ver: str, stamp: str) -> str:
    read_footer(html_text, tool_key)  # asserts exactly one match
    if not stamp.endswith(' ET'):
        raise ValueError('stamp must end with " ET"')
    name = TOOLS[tool_key]['name']
    return footer_re(tool_key).sub(f'{name} {new_ver} | {stamp}', html_text, count=1)


# ── Release notes: from the PR body into the tool's notes file ───────────────
NOTES_HEADING = re.compile(r'^##\s+release notes\s*$', re.IGNORECASE | re.MULTILINE)


def parse_release_notes(body: str | None) -> dict:
    """Parse a PR body's `## Release notes` section.

    Returns {'present': bool, 'none': bool, 'tools': {tool_key: [markdown lines]},
             'unknown': [labels], 'default_used': bool}.
    Lines before any `### Tool` heading go to 'studio' (default_used=True).
    A section whose only content is "none" / "n/a" means "no user-visible change".
    """
    out = {'present': False, 'none': False, 'tools': {}, 'unknown': [], 'default_used': False}
    if not body:
        return out
    text = body.replace('\r\n', '\n')
    m = NOTES_HEADING.search(text)
    if not m:
        return out
    out['present'] = True
    rest = text[m.end():]
    nxt = re.search(r'^##\s+\S', rest, re.MULTILINE)  # the next level-2 heading ends it
    section = rest[: nxt.start()] if nxt else rest
    section = re.sub(r'<!--.*?-->', '', section, flags=re.DOTALL)  # template hints
    stripped = section.strip()
    if re.fullmatch(r'(?i)(none|n/?a|no user-visible changes?)\.?', stripped):
        out['none'] = True
        return out
    current = None
    for line in section.split('\n'):
        h = re.match(r'^###\s+(.+?)\s*$', line)
        if h:
            key = resolve_tool(h.group(1))
            if key is None:
                out['unknown'].append(h.group(1))
                current = '__unknown__'
            else:
                current = key
                out['tools'].setdefault(key, [])
            continue
        if current is None:
            if not line.strip():
                continue
            current = 'studio'
            out['default_used'] = True
            out['tools'].setdefault('studio', [])
        if current == '__unknown__':
            continue
        out['tools'][current].append(line)
    for k in list(out['tools']):
        lines = out['tools'][k]
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        if not lines:
            del out['tools'][k]
    return out


NOTES_HEADER = (
    '# {title} — release notes\n\n'
    'Newest first. Each entry is one Production release (see `releases/` for the exact\n'
    'candidate manifest: main commit + the PRs and their head SHAs).\n'
)


def fold_notes(notes_text: str | None, title: str, version_header: str, blocks: list) -> str:
    """Insert a new `## <version_header>` entry (newest first) into a notes file.

    blocks = [(pr_number, [markdown lines]), ...]. A missing file (None) is created.
    The entry goes above the first existing `## ` heading, after the intro.
    """
    entry = [f'## {version_header}', '']
    for pr, lines in blocks:
        if pr:
            entry.append(f'<!-- #{pr} -->')
        entry.extend(lines)
        entry.append('')
    entry_text = '\n'.join(entry).rstrip('\n') + '\n\n'
    if notes_text is None:
        return NOTES_HEADER.format(title=title) + '\n' + entry_text
    m = re.search(r'^## ', notes_text, re.MULTILINE)
    if m:
        return notes_text[: m.start()] + entry_text + notes_text[m.start():]
    return notes_text.rstrip('\n') + '\n\n' + entry_text


def clean_title(title: str) -> str:
    """'feat(closed loop): a trial opens at … — Studio v0.91' → 'a trial opens at …'."""
    t = re.sub(r'^\w+(\([^)]*\))?!?:\s*', '', title.strip())
    t = re.sub(r'\s*[—-]+\s*(Arena\s+)?Studio v[0-9.]+\s*$', '', t)
    t = re.sub(r'\s*\((Studio|studio) v[0-9.]+\)\s*$', '', t)
    return t[:1].upper() + t[1:] if t else t


# ── Manifests ────────────────────────────────────────────────────────────────
MANIFEST_TRAILER = 'Release-Manifest'
_TRAILER_RE = re.compile(rf'^{MANIFEST_TRAILER}:\s*(\S+)\s*$', re.MULTILINE)


def manifest_path(name: str) -> str:
    return f'releases/{name}.json'


def trailer_manifest(commit_message: str) -> str | None:
    m = _TRAILER_RE.search(commit_message or '')
    return m.group(1) if m else None


# Paths whose changes can't alter what a rig runs: they may move main under a live
# candidate without forcing a rebuild. (Docs/skills-only PRs also merge directly.)
DOCS_ONLY = re.compile(
    r'^(docs/|releases/|\.claude/|\.agents/|course/.*\.md$|[^/]+\.md$|AGENTS\.md$|LICENSE)'
)


def docs_only(paths) -> bool:
    return all(DOCS_ONLY.match(p) for p in paths)


# ── subprocess helpers ───────────────────────────────────────────────────────
class ToolError(RuntimeError):
    pass


def run(args, cwd=None, check=True, capture=True, input_text=None, env=None) -> str:
    """Run a command (argument list, never a shell string) and return stdout."""
    try:
        p = subprocess.run(
            [str(a) for a in args],
            cwd=cwd,
            input=input_text,
            text=True,
            capture_output=capture,
            env=env,
        )
    except FileNotFoundError as e:
        raise ToolError(f'command not found: {args[0]} (is it installed / on PATH?)') from e
    if check and p.returncode != 0:
        msg = (p.stderr or p.stdout or '').strip()
        raise ToolError(f'{" ".join(map(str, args))} failed ({p.returncode}): {msg}')
    return (p.stdout or '') if capture else ''


def git(*args, cwd=None, check=True) -> str:
    return run(['git', *args], cwd=cwd, check=check).strip()


def git_bytes(*args, cwd=None) -> bytes:
    p = subprocess.run(['git', *map(str, args)], cwd=cwd, capture_output=True)
    if p.returncode != 0:
        raise ToolError(f'git {" ".join(map(str, args))} failed: {p.stderr.decode(errors="replace")}')
    return p.stdout


def repo_root(cwd=None) -> Path:
    return Path(git('rev-parse', '--show-toplevel', cwd=cwd))


def load_json(text: str):
    return json.loads(text) if text else None
