# Agent guidance for webDisplayTools

Use the repository skills under `.agents/skills/` as the canonical, model-neutral workflows:

- `g6-orientation` for repository ownership, hardware/software boundaries, and G6 conventions.
- `protocol-yaml` for v3 protocol authoring, editing, debugging, and validation.
- `g6-pattern-maker` for reproducible G6 `.pat` generation, transformation, preview, and comparison.
- `g6-release` for shipping web-tool changes through the Production and Next release tiers.

Read the selected `SKILL.md` completely before acting and resolve its relative paths from that
skill's directory. Do not hand-assemble PAT bytes or bypass the protocol validator. Claude Code
discovers equivalent wrappers under `.claude/skills/`; substantive instructions live only under
`.agents/skills/`.

Also follow `CLAUDE.md` for the repository's detailed architecture, safety rules, and testing
conventions. Treat `.agents/skills/` as the source of truth if a wrapper and canonical skill differ.
The organization and migration contract are documented in `docs/development/project-skills.md`.
