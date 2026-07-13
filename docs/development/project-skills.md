# Cross-model project skills

`webDisplayTools` maintains three repository skills as one cross-model set:

| Skill | Responsibility |
|---|---|
| `g6-orientation` | Repository map, system boundaries, and shared G6 conventions |
| `protocol-yaml` | Protocol v3 authoring, editing, debugging, and validation |
| `g6-pattern-maker` | Declarative G6 PAT generation, transforms, previews, and regression comparison |

## Source-of-truth layout

The complete model-neutral skills live under `.agents/skills/`. Each contains a `SKILL.md`,
optional deterministic scripts and references, and Codex UI metadata under `agents/openai.yaml`.

Claude Code discovers a thin skill with the same name and description under `.claude/skills/`.
That wrapper tells Claude to read the canonical `SKILL.md` completely and resolve resources from
the canonical directory. Do not duplicate the substantive instructions in a wrapper.

`AGENTS.md` and `CLAUDE.md` are always-on routing and repository guidance. They should direct an
agent to the appropriate skill but should not become copies of skill procedures.

## Compatibility

The maintained Protocol YAML validator is:

```bash
pixi run node --import ./tests/vendor-yaml.register.mjs \
    .agents/skills/protocol-yaml/scripts/validate-protocol.mjs protocol.yaml
```

The original `.claude/skills/protocol-yaml/bin/validate-protocol.mjs` path remains a forwarding
shim so existing commands and older sessions continue to work.

Pattern Maker discovers `js/pat-encoder.js` and `js/pat-parser.js` by walking upward from its own
installed directory and the working directory. `WEBDISPLAYTOOLS_DIR` is only an override for an
external installation; no user-specific checkout path belongs in the skill.

## Validation

Run the cross-model contract test after changing any project skill:

```bash
pixi run node tests/test-project-skills.js
```

It checks:

- canonical skill structure and matching wrapper metadata;
- wrapper routing and absence of duplicated instructions;
- both Protocol YAML validator entry points;
- portable Pattern Maker generation on 2×10, 3×10, and 4×10 arenas;
- strict PAT library audit and decoded batch scoring.

The complete repository suite (`pixi run test`) includes this contract test.

## Adding or changing a skill

1. Put substantive instructions and resources under `.agents/skills/<name>/`.
2. Keep frontmatter portable: use only `name` and `description` in `SKILL.md`.
3. Add Codex presentation metadata under `agents/openai.yaml`.
4. Add or update the small `.claude/skills/<name>/SKILL.md` wrapper with identical triggering
   metadata.
5. Keep fragile transformations in tested scripts rather than asking a model to reimplement them.
6. Run the contract test, the skill structure validator, and relevant domain tests.
7. Forward-test in fresh, isolated sessions without exposing reference answers or legacy
   generators. Use frozen target files only in the independent scorer.
