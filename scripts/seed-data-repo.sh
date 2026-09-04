#!/usr/bin/env bash
# seed-data-repo.sh — create (if needed) and seed a private GitHub DATA repo for
# Arena Studio / Pattern Designer direct commits, in the layout the tools expect:
#
#   roster.yaml, genotypes.yaml, ages.yaml, sexes.yaml, fly_numbers.yaml   (root vocab)
#   protocols/shared/  runlogs/  patterns/  pattern-sets/                   (namespaced dirs)
#   README.md
#
# Idempotent: existing files are never overwritten (only missing ones are added).
# Default is a DRY RUN; pass --apply to create/push.
#
#   scripts/seed-data-repo.sh [--repo owner/name] [--public] [--apply]
#
# Requires: gh (authenticated as an org owner/admin), git, python3.
# After seeding: add the repo to DATA_REPOS in js/studio-data-repos.js so it
# appears in the Studio's Repo picker, and do NOT enable branch protection.
set -euo pipefail

REPO="reiserlab/arena-experiments"
VISIBILITY="--private"
APPLY=0
for a in "$@"; do
  case "$a" in
    --repo) shift_next=1 ;;
    --repo=*) REPO="${a#--repo=}" ;;
    --public) VISIBILITY="--public" ;;
    --apply) APPLY=1 ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) if [ "${shift_next:-0}" = 1 ]; then REPO="$a"; shift_next=0; else echo "unknown arg: $a" >&2; exit 2; fi ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
META="$HERE/configs/metadata"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*"; }
run() { if [ "$APPLY" = 1 ]; then "$@"; else say "  [dry-run] $*"; fi; }

say "== seed data repo: $REPO ($VISIBILITY) apply=$APPLY"
if gh repo view "$REPO" --json name >/dev/null 2>&1; then
  say "repo exists — will only add missing files"
else
  run gh repo create "$REPO" $VISIBILITY --description "Arena experiments: protocols, patterns and run logs written directly by Arena Studio / Pattern Designer — rig-id namespaced"
fi

if [ "$APPLY" = 1 ]; then
  gh repo clone "$REPO" "$WORK/repo" -- -q
else
  mkdir -p "$WORK/repo"; say "  [dry-run] would clone $REPO"
fi
cd "$WORK/repo"

add_if_missing() { # path, then content on stdin
  local path="$1"
  if [ -e "$path" ]; then say "  keep   $path"; return; fi
  mkdir -p "$(dirname "$path")"; cat > "$path"; say "  add    $path"
}

for f in genotypes ages sexes fly_numbers; do
  add_if_missing "$f.yaml" < "$META/$f.yaml"
done
# roster: lab people (full names) from the site library list, no rig assignments yet
python3 - "$META/people.yaml" <<'PY' | add_if_missing roster.yaml
import sys, re
src = open(sys.argv[1]).read()
people = re.findall(r'-\s+id:\s*(\S+)\s*\n\s+name:\s*"?([^"\n]+)"?', src)
print("""# Lab roster — the experimenter list for Arena Studio when this repo is the
# configured data repo (File ▾ → GitHub). Every entry feeds the Experimenter
# dropdown; the entry whose rig_id matches the rig id set on a rig computer
# pre-fills it. `mac` (optional) is cross-checked against the controller at connect.
#   id / name / rig_id? / mac?
# Edit in the GitHub UI is fine — keep the two-space indent on `- id:` lines.
format_version: 1
people:""")
for i, n in people:
    print(f"  - id: {i}\n    name: \"{n.strip()}\"")
print("""
# Physical rigs (stations), for the Rig id pick-list + MAC cross-check.
# rigs:
#   - rig_id: 3e229-g6a
#     arena: G6_3x10
#     mac: "04:E9:E5:12:91:E2"
rigs: []""")
PY
for d in protocols/shared runlogs patterns pattern-sets; do
  add_if_missing "$d/.gitkeep" < /dev/null
done
add_if_missing README.md <<EOT
# $REPO — arena experiments (data repo)

Data repo for LED-arena rigs. Rig computers write here **directly on the default
branch** from Arena Studio and the Pattern Designer; every write is namespaced by the
**rig id** set on that computer.

Layout: root controlled-vocabulary YAMLs (roster, genotypes, ages, sexes, fly_numbers),
\`protocols/<rig-id>/\`, \`protocols/shared/\`, \`patterns/\`, \`runlogs/<rig-id>/\`,
\`pattern-sets/\`. Setup, tokens and the sharing model:
https://github.com/reiserlab/webDisplayTools/blob/main/docs/development/data-repo-setup.md

**Do not enable branch protection** on the default branch.
EOT

if [ "$APPLY" = 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -q -m "seed: data repo skeleton (roster, vocab pick-lists, README, namespaced dirs)" && git push -q
    say "pushed"
  else
    say "nothing to add"
  fi
  say "== verify"; gh api "repos/$REPO/contents" --jq '.[].path' | tr '\n' ' '; echo
fi
say "== next: add '$REPO' to DATA_REPOS in js/studio-data-repos.js (if new); never enable branch protection."
