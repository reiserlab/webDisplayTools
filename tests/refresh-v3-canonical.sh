#!/usr/bin/env bash
#
# refresh-v3-canonical.sh
#
# Pull the latest v3 canonical YAMLs from maDisplayTools' origin/version3
# branch into tests/fixtures/. Surfaces any upstream drift via `git diff`.
#
# Why this exists:
#   The two canonical v3 YAMLs in maDisplayTools ARE the spec for the v3
#   Experiment Designer. The designer must round-trip them. If upstream
#   changes them (e.g., after hardware validation), we want to know so we
#   can update the parser, data model, and tests to match.
#
# Usage:
#   tests/refresh-v3-canonical.sh                # default repo location
#   MAREPO=/path/to/maDisplayTools tests/refresh-v3-canonical.sh
#
# Workflow:
#   1. Run this script.
#   2. `git diff tests/fixtures/v3_canonical_*.yaml` — if non-empty, upstream changed.
#   3. Inspect the diff. Update docs/development/v3-spec.md's pinned SHA.
#   4. Re-run `npm test` to confirm the parser still round-trips them.
#   5. If parser tests break, the spec drifted in a way the parser doesn't
#      handle — fix it before committing the updated fixtures.

set -euo pipefail

# Default to a sibling-directory checkout; override with MAREPO=...
MAREPO="${MAREPO:-/Users/reiserm/Documents/GitHub/maDisplayTools}"

if [ ! -d "$MAREPO/.git" ]; then
    echo "Error: maDisplayTools repo not found at $MAREPO" >&2
    echo "Set MAREPO=/path/to/maDisplayTools or clone it there." >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "Fetching latest from maDisplayTools origin..."
git -C "$MAREPO" fetch origin --quiet

UPSTREAM_SHA="$(git -C "$MAREPO" rev-parse origin/version3)"
echo "  origin/version3 currently at: $UPSTREAM_SHA"

PINNED_SHA="$(grep -oE '00c8f9[0-9a-f]*|`[0-9a-f]{7,40}`' docs/development/v3-spec.md | head -1 | tr -d '`' || true)"
echo "  Pinned in v3-spec.md:         $PINNED_SHA"

echo ""
echo "Refreshing canonical fixtures..."
git -C "$MAREPO" show origin/version3:examples/yamls/experimentExampleVersion3.yaml > tests/fixtures/v3_canonical_a.yaml
git -C "$MAREPO" show origin/version3:examples/yamls/version3Attempt.yaml         > tests/fixtures/v3_canonical_b.yaml

echo ""
echo "Diff vs committed fixtures:"
if git diff --quiet tests/fixtures/v3_canonical_a.yaml tests/fixtures/v3_canonical_b.yaml; then
    echo "  No changes. Upstream is in sync with the committed fixtures."
else
    git --no-pager diff --stat tests/fixtures/v3_canonical_a.yaml tests/fixtures/v3_canonical_b.yaml
    echo ""
    echo "Upstream changed. Next steps:"
    echo "  1. Inspect: git diff tests/fixtures/v3_canonical_*.yaml"
    echo "  2. Update pinned SHA in docs/development/v3-spec.md to: $UPSTREAM_SHA"
    echo "  3. Run: npm test  (verify parser still round-trips)"
    echo "  4. If parser tests fail, fix js/protocol-yaml-v3.js before committing."
fi
