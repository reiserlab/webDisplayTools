# Rescue snapshot — 2026-09-27

Backup of work that existed ONLY as uncommitted/untracked changes in local worktrees
under `.claude/worktrees/`, captured before the branch/worktree cleanup (release-tiers
plan, Part B1). This branch is a backup; it is not meant to be merged as-is.

| Source worktree | What | Saved as |
|---|---|---|
| `competent-montalcini-076abe` | Michael's v0.7 E2E review notes in `docs/development/v0.7-e2e-checklist.md` | `v0.7-e2e-checklist.REVIEWED.md` + `patches/competent-montalcini-076abe.patch` |
| `led-activation-variable-binding-327020` | untracked `protocols/drafts/` (Florence ch2 SBD drafts + pattern, Shubham landmark-zone rule + PNGs) and `scripts/make-florence-sbd-pattern.js` | `led-activation-untracked/` |
| `sharp-gagarin-281c6f` (`claude/modest-khorana-7cee4b`) | protocol-yaml skill edits (+193/−6, 07-07; main's copy has moved since) | `patches/sharp-gagarin-281c6f.patch` |
| `dazzling-jang-4b2959` | `arena_console.html` stop-before-flash edits (07-02; likely superseded by e79007f) | `patches/dazzling-jang-4b2959.patch` |
| `cranky-leavitt-cba88e` | `pattern_editor.html` small fix (believed already on main) | `patches/cranky-leavitt-cba88e.patch` |
| `priceless-sanderson-ae43af` | `.claude/launch.json` (+9) | `patches/priceless-sanderson-ae43af.patch` |

`patches/SOURCES.txt` records each worktree's base commit + branch (apply with
`git apply` on that base).
