# Protocol v3 — Web → MATLAB Validation

Validates that Protocol **v3** YAML produced/edited by the **v3 Experiment Designer**
(`experiment_designer_v3.html`) is loadable by the **MATLAB experiment runner**
(`ProtocolParser` + `ProtocolRunner`) in maDisplayTools.

This is the v3 analogue of [`protocol-roundtrip-testing.md`](protocol-roundtrip-testing.md)
(v1/v2). It documents Phase 1 gate item 4 (the MATLAB cross-check, deferred to Phase 8).

> **Status.** The **web side is implemented and CI-green** (576 checks in
> `tests/test-protocol-roundtrip-v3.js`). The **MATLAB side is a manual gate**:
> there is no v3-specific validation script in maDisplayTools yet (only the v2
> `validate_web_protocol_roundtrip.m`). This doc describes the flow and how to run
> the cross-check via the MATLAB MCP tools until that script is written.

## Architecture

The v3 editor differs from v2 in one load-bearing way: **the YAML document is the
single source of truth.** The editor parses a v3 YAML into a `YAML.Document`, edits
it through node-level helpers, and exports via `_doc.toString()` — so anchors,
comments, and key order survive the round-trip. Validation therefore checks that
*the editor's exported YAML* (not a freshly-generated one) loads in MATLAB.

```
Web (JavaScript)                         MATLAB (maDisplayTools)
─────────────────                        ──────────────────────
experiment_designer_v3.html              ProtocolParser.m
  └─ parseV3Protocol()  ── edits ──┐       └─ parse()   (v3-aware)
       (js/protocol-yaml-v3.js)    │            │
       │  (YAML.Document model)    │            ▼
       ▼                           │     Parsed protocol struct
  exported v3 YAML  ───────────────┴───▶   (version 3, rig, plugins,
   (anchors + comments preserved)          variables/anchors resolved,
       │                                    conditions, experiment[])
       ▼                                         │
  test-protocol-roundtrip-v3.js                  ▼
   (parse → re-emit → compare,             ProtocolRunner constructor
    576 checks, anchors/comments)            (dry-run, validates structure;
                                             no hardware init)
```

## Test coverage

| Layer | Test | Runs in CI? |
|-------|------|-------------|
| Web parse → re-emit round-trip (anchors + comments preserved) | `tests/test-protocol-roundtrip-v3.js` | Yes (Node.js) |
| Web node-edit helpers + D4 cross-library import (suites N1–N10) | `tests/test-protocol-roundtrip-v3.js` | Yes (Node.js) |
| MATLAB parse + anchor/plugin resolution (v3) | *manual gate — script TBD* | No (needs MATLAB) |
| MATLAB `ProtocolRunner` construction (v3, dry-run) | *manual gate — script TBD* | No (needs MATLAB) |

## Running the validation

### 1. Web-side (CI, no dependencies)

```bash
cd webDisplayTools
npm run test:protocol-v3          # or: node tests/test-protocol-roundtrip-v3.js
```

576 checks across the v3 round-trip suites + the D4 cross-library-import suites
(N1–N10). Covers: parsing the two canonical v3 YAMLs (pinned from maDisplayTools
`origin/version3`) plus coverage-gap fixtures; re-emitting them byte-stably with
anchors and comments intact; the node-level edit helpers; and the cross-doc import
substrate. Exit code 0 = all passed.

The canonical fixtures are kept in sync with upstream via
[`tests/refresh-v3-canonical.sh`](../../tests/refresh-v3-canonical.sh) — if upstream
changes the spec YAMLs, that surfaces the drift so the parser/tests can be updated.

### 2. MATLAB-side cross-check (manual gate)

The goal: confirm an editor-exported v3 YAML loads in MATLAB end to end.

1. In the editor, load (or import-and-commit) a protocol that exercises the features
   you care about, then **Export YAML** to a file under
   `maDisplayTools/tests/web_generated_patterns/` (e.g. `test_protocol_v3.yaml`).
2. Run the MATLAB cross-check. Until a dedicated `validate_web_protocol_roundtrip('v3')`
   path exists, drive it through the MATLAB MCP tools:
   - `check_matlab_code` — static-analyze the parser entry point.
   - `run_matlab_file` / `evaluate_matlab_code` — execute, e.g.:
     ```matlab
     p = ProtocolParser('tests/web_generated_patterns/test_protocol_v3.yaml').parse();
     assert(p.version == 3);
     % anchors resolved to literal values; plugins present; conditions/experiment populated
     r = ProtocolRunner(p);            % dry-run: constructs + validates, no hardware
     ```
3. Confirm: version = 3; every `*alias` resolved to its anchor's literal value;
   `plugins:` entries present; `conditions:` and `experiment:` populated; the
   `ProtocolRunner` constructor succeeds.

When this stabilizes, promote it into a committed
`maDisplayTools/tests/validate_web_protocol_roundtrip.m` v3 branch (mirroring the v2
checks) so it becomes a repeatable gate.

## Files

### Web side (`webDisplayTools/`)
| File | Purpose |
|------|---------|
| `experiment_designer_v3.html` | The v3 editor; exports via `_doc.toString()` |
| `js/protocol-yaml-v3.js` | v3 parser/generator + node-level edit helpers |
| `js/v3-import.js` | D4 cross-library import substrate (dual-export) |
| `tests/test-protocol-roundtrip-v3.js` | v3 round-trip + import tests (576 checks) |
| `tests/fixtures/v3_*.yaml` | Canonical + coverage-gap fixtures |
| `tests/refresh-v3-canonical.sh` | Pull canonical v3 YAMLs from upstream |

### MATLAB side (`maDisplayTools/`)
| File | Purpose |
|------|---------|
| `tests/validate_web_protocol_roundtrip.m` | v2 validator (v3 branch TBD) |
| `tests/web_generated_patterns/` | Drop exported v3 YAMLs here for the cross-check |
| Authoritative v3 spec | `docs/development/yaml_protocol_documentation_v3.md` on `origin/version3` |

## What to update when the v3 format changes

1. Refresh the canonical fixtures: `tests/refresh-v3-canonical.sh`, then
   `git diff tests/fixtures/v3_canonical_*.yaml` to see upstream drift.
2. Update the parser/generator/helpers in `js/protocol-yaml-v3.js` (and
   `js/v3-import.js` if the import substrate is affected) to match.
3. Run `npm run test:protocol-v3` — must stay green.
4. Re-export a sample and re-run the MATLAB cross-check (step 2 above).
5. Update `docs/development/v3-spec.md`'s pinned SHA if the spec moved.

## Known constraints

- **Dry-run only.** The MATLAB cross-check validates parse + construction, not
  `run()` — it does not initialize hardware (PanelsController).
- **`ProtocolParser.m` is upstream code** (Lisa's) — DO NOT MODIFY. If the editor's
  output doesn't parse, fix the web side or discuss the spec, don't patch the parser.
- **Anchors are document-local.** The editor resolves `*alias` to the anchoring
  document only. Cross-document anchor reuse is not a thing; D4 import namespaces
  imported anchors into the target document (see D4 design §3).
- **Complex anchors are read-only in the UI.** Map/sequence anchors render as a
  badge and are edited in YAML directly; the round-trip still preserves them.
- **D4-imported snippets are runnable, not behavioral clones** (D4 design §12):
  import copies conditions + their direct anchor/plugin dependencies and appends a
  bare sequence ref. It does not reproduce the source's block membership,
  repetitions, randomize, or intertrial placement.
