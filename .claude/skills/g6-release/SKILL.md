---
name: g6-release
description: Ship webDisplayTools changes through the two release tiers — Production (the root GitHub Pages URLs the rigs run) and Next (/next/, one frozen release candidate). Use whenever work is ready to share or merge — opening a PR for web-tool code, "push this", "merge this", "ship it", "deploy", "put it on Next / the testing build", "build a candidate", "release", "promote to production", "hotfix", "roll back", or "is it safe to release" — and to check what's live on Next. Drives scripts/tiers/candidate.py (pixi run candidate / release / tiers). Not for firmware or MATLAB repos.
---

# G6 Release

Read and follow `../../../.agents/skills/g6-release/SKILL.md` completely.
Resolve every relative path mentioned by that skill from its canonical directory under
`.agents/skills/g6-release/`, not from this wrapper directory.
