# Release process — Production + Next

**This is the authority doc for how web-tool changes reach the rigs.** The tooling lives in
`scripts/tiers/` (`candidate.py`, `stamp.py`, `tierlib.py`) and the deploy in
`.github/workflows/deploy-pages.yml`. Why it is shaped this way (incl. the Codex
adversarial review): `~/.claude/plans/…flickering-breeze.md` and
`.codex-review/report-20260927-200832.md` (local).

## The two tiers

| Tier | URL | What it serves | Who uses it |
|---|---|---|---|
| **Production** ("beta" — the project is pre-1.0) | `https://reiserlab.github.io/webDisplayTools/…` (unchanged URLs; `?p=` links, course docs, bookmarks keep working) | the tree of `main` | every rig running experiments |
| **Next** | `https://reiserlab.github.io/webDisplayTools/next/…` (same page names under `/next/`) | **one frozen release candidate**, or a placeholder when none is live | whoever is validating the candidate, *between sessions* |

Every page is stamped at deploy time with `<meta name="wdt-build" content="{…}">` (channel, commit,
candidate name/rc/PRs) and each tier has a `build.json`. Pages under `/next/` also carry an orange
**NEXT** banner with a link back to the same page on Production.

## The model: one frozen candidate at a time

```
feature PRs (base main · no version bumps · "## Release notes" in the PR body)
    │
    ▼  pixi run candidate -- 219 178          ← pick ≤ 4 PRs (the "bunch")
release/<date> = main@sha + each PR head (pinned SHAs, merged --no-ff)
               + ONE release commit: per-tool footer bumps + ET stamp,
                 release notes folded from the PR bodies, releases/<name>.json
    │  CI green → `next` branch → deploy dispatched from main
    ▼
/next/ = exactly this candidate ── validate on a rig, between sessions ──▶ validation note
    │  a PR needs a fix?  push to it → rebuild → rc+1 (validation resets)
    │  a PR isn't ready?  rebuild without it → rc+1 (re-validate)
    ▼
pixi run release  → checks → merge commit → Production · tag release-<name>
                    (the constituent PRs close as "merged" — an indirect merge)
```

**Why frozen:** what was tested is exactly what ships. Promoting a subset of a combined build
would ship an untested combination; pinned SHAs also stop later pushes to a PR from reaching the
shared origin (which holds the GitHub token) unreviewed.

## Everyday commands

```bash
pixi run candidate -- 219 178            # build + publish a candidate from those PRs
pixi run candidate -- 219 178 --headline "Controller settings + lab repo picker"
pixi run candidate -- --continue         # after resolving a merge conflict (or --abort)
pixi run tiers -- status                 # live candidate, head drift, CI, validation notes
pixi run tiers -- validate --rig rig5 --by Isabel --notes "P3 epochs open on 25/75"
pixi run tiers -- validate --rig rig5 --by Isabel --notes-file /path/to/notes.md  # multi-line / `code`
pixi run release                         # promote the validated candidate
pixi run candidate -- --hotfix "why" 230 # safety/data-loss fix: skips the soak, not CI
pixi run tiers -- rollback --to release-2026-10-02 [--revert release-2026-10-09]
pixi run next-preview -- --next release/2026-10-02   # assemble both tiers into _site/ locally
```

`gh` comes with pixi (`pixi run gh auth login` once). Everything is Python + git, so it runs the
same on macOS, Linux and Windows (CI runs the tooling tests on all three).

## The rules

1. **The tier question is asked at three decision points** — never on routine feature-branch pushes:
   - **opening a PR:** is this for a *next candidate*, a *hotfix*, or *docs/skills-only*?
   - **building a candidate:** which PRs go in (≤ 4)?
   - **promoting:** go? — and is this a safe window?
   Claude sessions ask with AskUserQuestion and never assume the answer.
2. **Code reaches `main` only through a release PR built by `candidate.py`**, merged with a
   **merge commit** (never squash/rebase — the constituent PRs' commits must stay reachable).
   Docs/skills-only changes (`docs/`, `*.md`, `.claude/`, `releases/`) are the one exception and
   may merge straight to main.
3. **Promotable** = CI green on the release PR **and on every constituent PR** (an indirect merge
   bypasses their own protections, so `release` checks them) + a validation note naming the
   **exact candidate SHA** + a confirmed release window.
4. **Feature PRs never bump versions.** They don't touch the footer version/timestamp, the top of a
   release-notes file, or the footer tests. They put user-facing notes in the PR body (template in
   `.github/pull_request_template.md`). The release commit does all bumping.
5. **One candidate at a time, ≤ 4 PRs** (the WIP limit; `--wip N` overrides deliberately).
   **Hotfix = safety or data-loss only**, with a stated reason.

## Release notes in the PR body

```markdown
## Release notes
### Studio
- **Closed-loop trials open at their `frame_index`.** One sentence of why it matters to a user.
### Pattern Designer
- **…**
```

- Headings name the tool (`Studio`, `Pattern Designer`, `Dashboard`, `Console`, `Flasher`, …).
  Lines before any `###` go to Studio. `none` means no user-visible change.
- The release commit folds each tool's lines into that tool's notes file under the new version
  (`docs/development/arena-studio-release-notes.md`; Pattern Designer gets
  `pattern-designer-release-notes.md`; the other tools share `web-tools-release-notes.md`).
- A tool is bumped when its page changed **or** a PR has notes for it. Version = last component + 1
  (`v0.91 → v0.92`); override with `--version studio=v1.0`.
- Footer-test invariant (`tests/test-studio-replay.js`): the Studio footer's version equals the
  newest `## vX` entry in its notes file — the release commit updates both.
- **Pre-tier PRs** that already bumped the footer and wrote their own notes entry are adopted, not
  double-bumped (their version and entry are kept; only the timestamp is refreshed).

## Before validation: adversarial review of the candidate

Once a candidate is built, and **before asking anyone for bench time**, get an adversarial review of
exactly what would ship: the diff `origin/main...origin/release/<name>`. Claude sessions use the
`codex-diff-review` skill (Codex standard + adversarial passes, reconciled with Claude's own review).
Fix or drop what it finds, rebuild (rc+1), and only then validate. On 2026-09-29, rc1 and rc2 were
bench-validated first; the review then held #219 back, so both bench runs had to be repeated on rc3.

## Validation

- Validate on a rig **between sessions**. Never open `/next/` on a rig PC while an experiment is
  running: the FicTrac bridge accepts several browser clients and a second tab can change its config
  mid-run (`fictrac-bridge/bridge.py`), and two tabs compete for the serial port.
- Post the note with `pixi run tiers -- validate …` (it names the candidate SHA). Put anything
  longer than one plain line in a file and pass `--notes-file` (an absolute path: pixi tasks run
  from the repo root). pixi's task shell re-parses `--notes "…"`, so backticks and line breaks there
  break the command. Any change to a constituent PR, or to main beyond docs, means rebuild → rc+1 →
  validate again; `status` and `release` detect both.
- If a candidate touches `fictrac-bridge/`, testers run the bridge from a checkout of the
  candidate's `release/<name>` branch (a pinned commit, not a moving ref).

### Bench validation kit (G6 2×10 fly-on-ball bench, ~5 min)

1. Start the bridge with a log directory, and a stationary simulated fly:
   `pixi run bridge -- --log-dir <dir>` and `pixi run sim -- --noise 0`.
2. Open `https://reiserlab.github.io/webDisplayTools/next/arena_studio.html` and load
   `protocols/validation/bench_closed_loop_2x10.yaml`. It needs the CSHL course pattern bundle on the
   SD card. Connect the bridge, then Connect the arena.
3. **Turn the course-repo upload off for the test.** The lab browsers have the course pipeline
   configured (token + `reiserlab/cshl-2026-course` + direct commit), so a completed
   **Run experiment** commits its log into the course data as the configured bench id. Use a browser
   profile without the course token, or switch off "Commit directly" for the session. Never
   validate with **Test experiment** instead: test runs don't write `run_metadata` to the bridge log.
4. **Run experiment** (confirm the NEXT dialog). About 22 s.
5. Check the log:
   `pixi run bench-check -- <dir>/arena-log-*.jsonl --hold epoch_a_frame25=25 --hold epoch_b_frame75=75 --channel next --build <candidate sha>`.
   It checks that the run completed, every arena command was ok, there were no error glyphs, the
   closed loop held frames 25 and 75, and the log names this tier and build. It also prints the
   controller firmware and the panel inventory. Exit status 0 = pass.
6. Post the note with `--notes-file`, then free the bench: disconnect, close the tab, stop the
   bridge and the simulator.

## Releasing

`pixi run release` re-checks everything (heads unchanged, CI green, main not moved beyond docs,
validation note present), lists rigs with run-log commits in the last 24 h in the data repo
(**advisory only** — logs commit after a run ends), prints a Slack heads-up draft, and asks you to
type the release name. It then clears the `next` pointer, merges with a merge commit, tags
`release-<name>`, and confirms each constituent PR shows **MERGED**. It prints the Linear tickets
the PRs mention so transitions can be *proposed* — never auto-set to Done.

After the deploy (~2 min): rigs **hard-refresh between sessions** (Pages caches up to 10 min;
mixed cached assets are the ES-module-failure gotcha in CLAUDE.md). If the release changed
`fictrac-bridge/`, rig PCs `git pull` and restart the bridge.

## Hotfix and rollback

- **Hotfix:** `pixi run candidate -- --hotfix "why" <PR>` builds a release branch the same way but
  never touches `/next/`; after CI, `pixi run release -- --pr N`. A live candidate built on the old
  main must then be rebuilt (the checks enforce it).
- **Emergency rollback:** `pixi run tiers -- rollback --to release-<previous>` redeploys that tag at
  the site root in minutes (Next → placeholder). **The next push to main undoes it**, so land the
  revert first: add `--revert release-<bad>` to open a revert PR, then ship it as a hotfix.
  Rolling back files does not undo browser state, bridge config, firmware, or collected data.

## Coexistence rules (both tiers share one origin and the same rigs)

1. **Migration markers compare typed and monotonically** (parse the stored value; migrate only when
   it is missing, malformed, or older) — never `!== current`, or each tier wipes the other's prefs.
2. **A storage key's format is a compatibility contract.** Next may add keys, never change an
   existing key's meaning; a format change means a new key name. Test Production → Next → Production.
3. **Window names are tier-suffixed**, so a Next link never focuses a Production tab.
4. **The GitHub token is readable by Next code.** Accepted because candidates are maintainer-pinned
   SHAs; the escalation path is a separate origin (custom domain) if that ever changes.
5. **Bridge changes stay backward-compatible** with Production Studio.
6. **`next/` is a reserved top-level path** — the deploy fails if main ever contains it.

## Provenance

- `releases/<name>.json` — main SHA, each PR's head SHA, versions, rc, kind; found by the
  deploy through the release commit's `Release-Manifest:` trailer.
- `release-<name>` tags — what Production served, and the rollback targets.
- The `wdt-build` meta + `build.json` — which build a page is (`js/build-channel.js` reads the
  meta; run logs record `run_metadata.channel` + `build`).

## Guardrails on GitHub

- Ruleset on `main`: pull request required + the `test` check (`ci.yml`), no force-push; admins
  may bypass (docs pushes, emergencies).
- Automatically delete head branches after merge.
- The `github-pages` environment allows `main` only — deploys run from `main`'s workflow via
  `workflow_dispatch`, never `pull_request_target` (blocked by default on public repos from
  2026-11-02).
