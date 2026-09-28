---
name: g6-release
description: Ship webDisplayTools changes through the two release tiers — Production (the root GitHub Pages URLs the rigs run) and Next (/next/, one frozen release candidate). Use whenever work is ready to share or merge — opening a PR for web-tool code, "push this", "merge this", "ship it", "deploy", "put it on Next / the testing build", "build a candidate", "release", "promote to production", "hotfix", "roll back", or "is it safe to release" — and to check what's live on Next. Drives scripts/tiers/candidate.py (pixi run candidate / release / tiers). Not for firmware or MATLAB repos.
---

# g6-release — shipping through Production + Next

Authority: `docs/development/release-process.md` (read it for anything not covered here).
Rigs run live experiments on **Production**; nothing unvalidated reaches it.

## The three decision points — ASK, never assume (AskUserQuestion)

1. **Opening a PR** for web-tool code → "Where is this headed?"
   - *Next candidate* (default for features) · *Hotfix* (safety/data-loss only — needs a reason) ·
     *Docs/skills-only* (docs/, *.md, .claude/, releases/ — may merge straight to main).
2. **Building a candidate** → "Which PRs go in?" (≤ 4; list the open PRs with CI state and whether
   each has `## Release notes`).
3. **Promoting** → "Release now?" — show `pixi run tiers -- status`, the validation notes, and the
   advisory recent-rig list; ask about the window (nobody mid-experiment; Slack heads-up).

Routine pushes to a feature branch need no question.

## Writing a feature PR

- Base `main`, same-repo branch. **Do not** bump the footer version/timestamp, edit the top of a
  release-notes file, or touch the footer tests — the release commit does all of that.
- The PR body must have `## Release notes` with `### <Tool>` headings (Studio, Pattern Designer,
  Dashboard, Console, Flasher, …) and user-voice bullets, or `none`. The template
  (`.github/pull_request_template.md`) pre-fills it.
- New localStorage keys / migration markers / window names follow the coexistence rules
  (typed monotonic markers, never change a key's meaning, tier-suffixed window names).

## Commands (run from a checkout of the repo; `pixi run gh auth login` once)

| Step | Command | Notes |
|---|---|---|
| Build + publish a candidate | `pixi run candidate -- 219 178 [--headline "…"]` | pins each PR head, merges `--no-ff`, release commit, pushes `release/<date>`, opens a draft release PR, waits for CI, then points `next` at it and dispatches the deploy |
| Conflict | resolve in `.tiers/candidate`, `git add`, `git commit --no-edit`, then `pixi run candidate -- --continue` (or `--abort`) | two PRs that keep colliding belong in one `batch/<name>` branch |
| Dry run | `pixi run candidate -- 219 --no-push` then `pixi run next-preview -- --next release/<date>` and `python -m http.server -d _site 8080` | nothing leaves the machine |
| What's live | `pixi run tiers -- status` | head drift / main drift → rebuild (rc+1, validation resets) |
| Validation note | `pixi run tiers -- validate --rig rig5 --by Isabel --notes "…"` | names the exact candidate SHA; test **between sessions** |
| Promote | `pixi run release` | re-checks everything, prints the Slack draft, asks for the release name, merge commit + tag |
| Hotfix | `pixi run candidate -- --hotfix "why" 230` → `pixi run release -- --pr N` | never moves /next/ |
| Roll back | `pixi run tiers -- rollback --to release-<prev> --revert release-<bad>` | the next push to main undoes the emergency deploy — land the revert first |

## After a release

- Post the Slack announcement (the tool prints a draft; the claude.ai Slack connector can post it
  **with the user's OK**). Rigs hard-refresh between sessions; if `fictrac-bridge/` changed, rig
  PCs `git pull` + restart the bridge.
- **Propose** Linear transitions for the tickets the PRs mention (show a table; never auto-Done).

## Don'ts

- Never merge a feature PR directly into main, never squash a release PR, never push to `next` by
  hand, never use `pull_request_target` for deploys, never open `/next/` on a rig PC mid-experiment.
