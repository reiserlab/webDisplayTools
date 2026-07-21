# Arena Studio — Session Handover

**Last updated:** 2026-07-01 20:52 ET · **Status:** wireframe **v5 done + user-approved** ("it's great"); Phase-1 repo review done & verified; **docs consolidated on branch `docs/arena-studio-wireframes` (rebased on main, unpushed)**; next = **the big build**.

This doc lets a fresh session (or teammate) pick up the "Arena Studio" unification work without re-deriving context. Read this + **`arena-studio-unification-design.md`** (the authoritative plan) + the memory note `arena-studio-unification`, and you're current.

---

## ⚠️ READ FIRST — git / branch state

The wireframe work is **consolidated on branch `docs/arena-studio-wireframes`, rebased onto current `main`** (main tip `35e1c90`, 2026-07-01). One commit adds all arena-studio docs: `arena-studio-wireframe-{v1,v2,v3,v4,v5}.html` + `arena-studio-unification-design.md` + this handover.

- **NOT pushed.** `main` auto-deploys via GitHub Pages, so don't merge/push casually — push the docs branch on its own or open a PR when you want it public.
- The branch's 3 prior *code* commits (FicTrac / g6_io_bench / per-condition run) were **dropped in the rebase** — already on main via #131 / #126 / #129 (different SHAs). Recover via reflog if ever needed.
- Intentionally **NOT** in this commit (still untracked): the 3 `g6-*handoff.md` docs (separate work) and `.claude/` (local preview config).
- **TODOs:** design doc **§15 (v5 density-pass writeup)** is not yet written (the fresh writeup lives in this handover's "What v5 is" section + the memory note); `~/.claude/plans/resilient-mixing-lecun.md` is the older approved plan file.

---

## Resume in 60 seconds
1. **Read:** this doc → `arena-studio-unification-design.md` (esp. **§6** canMutate blocker, **§10** phasing, **§11** open questions, **§12** staged path, **§13** feedback, **§14** v4).
2. **Preview:** server via `.claude/launch.json` → **port 8091** (`python3 .claude/nocache-server.py`). Open `http://localhost:8091/docs/development/arena-studio-wireframe-v6.html` (v5 is the A/B baseline). Wireframe is a **mockup** — Connect/Run are fake.
3. **The next arc:** Phase 1 (repo review) ✅ done · Phase 2 (v5 re-sync + density) ✅ done → **Phase 3 = the big build** (Stage B `arena_runner.html` and/or Stage C full merge).

---

## Where the work lives
| Thing | Path | Note |
|---|---|---|
| **Current wireframe** | `docs/development/arena-studio-wireframe-v6.html` | **v6.2 (2026-07-04): Console de-clutter pass** — LEFT rail of 7 tools (multi-open compact one-row boxes, ✕ to collapse, Start/Stop right-aligned), Patterns = merged device-memory+picker, **Arena Trial** = ONE trial-params box (modes 2/3/4, mode-aware field dimming) + separate Step frames, busy/mutex lock model (⏳ simulate busy), plain labels (hex → title hovers, global ? Help mode), status header + ALWAYS-visible log, default layout = all open except I/O + firmware (fits 1280×800), Edit toolbar diet + repo-connected Settings. Companion: `arena-studio-v6-notes.md` (MATLAB-restore ledger, mutex matrix, renames, draft issues, main-reconciliation §8). Baseline UI: Studio v0.5 on **main @ `8bc97e6`** (PR #139) — directly executable. |
| **A/B baseline** | `docs/development/arena-studio-wireframe-v5.html` | v5, user-approved 2026-07-01; keep for compare (v1–v4 too, on `docs/arena-studio-wireframes`). |
| **Authoritative plan/design** | `docs/development/arena-studio-unification-design.md` | Rev 3 + §14 (v4). **Needs a §15 for v5** (density pass) — not yet written. Committed only on `docs/arena-studio-wireframes`. |
| **Memory (auto-loads)** | memory note `arena-studio-unification` | Running decision log. Also `[[g6-web-runner-impl]]`, `[[g6-console-pcontrol-parity]]`, `[[js-module-load-gotcha]]`, `[[fictrac-closed-loop-v3-runner]]`. |
| **Source-of-truth code (main)** | `arena_console.html` (**v6**), `experiment_designer_v3.html` (**v0.40**), `js/arena-session.js`, `js/run-log.js`, `js/arena-runner-g6.js`, `js/plugin-registry.js` | What the wireframe stays honest to. |

---

## State of reality — shipped vs pending (VERIFIED 2026-07-01, 4-agent grounded review)

Main saw a burst of 2026-07-01 merges. **This supersedes the v4-era table.** Every row grounded in `file:line` / commit during the Phase-1 scan.

| Capability | Status on main | Evidence |
|---|---|---|
| Shared connection broker (`ArenaSession`) | ✅ **SHIPPED** (was PR #112 "open") | both tools call `ArenaSession.shared()`, zero `new ArenaLink` (`arena_console.html:1528`, `experiment_designer_v3.html:5333`) |
| Run-log builder (JSON/TXT) | ◑ **PARTIAL — module unwired** (was PR #113 "open") | `js/run-log.js` on main + unit-tested, but **no page loads it**, no Save/Download UI. Designer's `runLog()` (:5444) is an unrelated DOM logger. |
| Metadata modal (experimenter/genotype/notes) | ❌ **planned** | no such UI in either tool; fields exist only as `opts.meta` in `run-log.js:127` |
| GitHub-PR save + repo-backed dropdowns | ❌ **planned** | no GitHub write path anywhere; GitHub use is read-only raw fetch |
| Firmware trial timing (FW#4/#5) | ❌ **not landed** | host-timed interim badge correct (`arena-runner-g6.js:446-474`, `arena_console.html:905`) |
| **#126** analog-out (0xA0) + digital-out (0xAA) + field validation | ✅ **NEW/shipped** | `plugin-registry.js:132/149`, G6-only `:195`; HW-verified |
| **#129** designer "Run this whole condition on arena" | ✅ **NEW/shipped** | `experiment_designer_v3.html:4078,5571` (full command-array replay; plugins skipped) |
| **#130** console GET_PATTERN_INFO 0x88 card + panel-display-mode 0x1B/0x1C | ✅ **NEW/shipped** | `arena_console.html:3425-3474`, `:799-825` (0x88 thumbnail = reserved slot, metadata-only) |
| **#131** FicTrac closed-loop (runner-executed plugin, Mode-3) | ✅ **NEW/shipped** (on-arena closed-loop bench-unverified) | `plugin-registry.js:572-650`, `arena-runner-g6.js:331-352`; only `fictrac`+`log` are runner-executed |
| Console reliability (SD 2s timeout, 0x84 crash fix, fw error text) | ✅ shipped | commits `673085d`, `48fa579` |

**Process note:** `docs/development/ROADMAP.md` is stale (last entry Feb 2026, no Arena Studio content); there is **no** `G4G6_ROADMAP.md` in this repo. Ground status in git + tool source, not ROADMAP.

---

## What v5 is (density/ergonomics pass + honesty re-sync — 2026-07-01)

Built from v4 after a critique-first design review (independent density critique → applied winners). **Browser-verified, zero console errors.** User approved. Space-saving playbook: (1) reclaim fixed chrome first, (2) collapse-by-default + live summary, (3) priority tiering, (4) absorb new capability into existing structure not new cards, (5) responsive drop not delete, (6) guardrails on the newcomer Run path.

**Layout/density changes:**
- **Two ribbons → one 44px bar** (−54px on every view). Fit one line by: dropping the word "connected" (dot conveys it; word returns in red on disconnect); protocol summary responsive (shows ≥1400px, else → 📄 hover); `fw`/`(target)`/brand-version → hovers. Nothing removed.
- **Console = essentials + collapsible tier** (the #1 clutter target). Always-open: `display` (header-inline) + `pattern + trial params`. Six foot-gun groups are `<details>` **collapsed by default**, each with a **live-state summary** (`frame –/– · mode 3`, `SD (3) · PS-RAM 1`, `GS16 · full-field`, `panel: oneshot · A0 0.0 V · DO 0/0`, `ws://…:8765 · idle`, `fw v1 · idle`); 2-col pack; Expand/Collapse all. New capability folded in *without a wall*: 0x88 **inline** by the picker; panel-mode + analog + digital = **one "Hardware I/O" group**; a **FicTrac bridge** group added.
- **Run-log strip 208→150px, collapsible to 46px**; STOP + All-on/off pinned in header in both states; open by default.
- **Launch card slimmed** (host-timed badge inline; green Run stays dominant 15px CTA); **sequence rows tightened** (Test tap-target preserved); **footer → one line**.

**Honesty-to-shipped folded in:** FicTrac bridge group + "plugins skipped (log + fictrac run)" badge (#131); AO/DO chips + Edit-inspector I/O + "Run this condition" (#126/#129); 0x88 inline + panel-mode (#130); **`GET_CONTROLLER_INFO` opcode fixed `0x67`→`0xC2`** (was wrong in v4); `ArenaSession` shown as shipped (single broker); run-log kept **`◷ module unwired`** (shipped module, no UI) — distinct from `◷ planned` (metadata modal / GitHub-PR save, still mockup-only).

---

## Decisions locked (don't re-litigate)
- **Staged path** (design §12): Stage A = extract `ArenaSession` — **now SHIPPED on main**; Stage B = minimal `arena_runner.html` launcher; **Stage C = full merged Studio, evidence-gated.**
- **Run mode = newcomer-optimized** (uncluttered, 🔒 read-only chip, STOP by the run, foot-guns behind the Console door).
- **A′ layout:** `▶ Run | ✎ Edit ‖ ⛭ Console` 3-view; Run-log strip in Run only; Console is its own full-body view.
- **v3/v4 kept as A/B baselines**; v5 is the forward file.
- All v3 colleague feedback (design §13, F1–F8/H1–H6) already adopted/declined/explained.

---

## The next arc — Phase 3: the big build

Before writing code, **re-read design §6, §5, §10, §11, §12.**
- **Stage A is already shipped on main** → the build is *less blocked* than the v4 handover assumed. Remaining true blockers for Stage C:
  - **`canMutate()` chokepoint (§6)** — the read-only lock cannot reuse scattered `importMode` guards (**53 `pushUndo` mutation sites vs 37 `importMode` guards** — a ~16-site gap). Need ONE `canMutate()` at handler entry (ideally wrapping `pushUndo`/`saveSnapshot`). **Do not claim Run mode is safe until this audit lands.**
  - **Run-log UI wiring** — `js/run-log.js` is built + tested but unwired; wiring it into the designer's `runSequence` (feeding `onProgress` phases, stamped host-side) + a metadata modal is the last piece of the run-record pipeline.
- **Likely start with Stage B** (`arena_runner.html`, additive/low-risk) unless evidence says go straight to the merge. See design §12 Stage B for the baked-in fixes (enabled "Connect to run", device-line geometry from rig/pattern-set not Get-info, host-timed badge, committed `protocols/index.json` URL registry with allowed-key validation).
- **§11 open questions (7)** to settle first: brand/filename (`arena_studio.html`?); Edit→Run with unsaved edits; mid-run Console safety; pattern-by-name fallback with no library; URL-state resolution scope; sequence-run fidelity badge; diagnostics pruning.

**Other confirmed blockers:** STOP is best-effort *queued* (ArenaLink single-flight), not out-of-band; URL `?p=` only shareable for repo-committed YAMLs; `GET_CONTROLLER_INFO` (0xC2) returns fw + capability bits only, **NOT arena geometry** (geometry from rig/pattern-set); single-condition run must replay full command arrays.

---

## Gotchas
- **Never `prettier --write` the `*.html` tools** — Prettier is scoped to `**/*.js`; it reflows the entire HTML file. Hand-edit.
- **The wireframe is a mockup** — Connect/Run are fake, most buttons inert. Don't wire it to hardware.
- **"Change only what's asked"** — make the minimal change; don't flatten/refactor beyond scope.
- **ES-module import failure is catastrophic under GitHub-Pages cache** — keep the serial substrate as classic `<script src>` globals; `arena-session.js` is intentionally a classic script.
- **Branch hygiene:** the wireframes + docs are already consolidated on `docs/arena-studio-wireframes` (rebased on main, one commit, unpushed). When publishing, push *that docs branch* / open a PR — never push to `main` directly (it auto-deploys).

---

## Slack / comms
- Channel **#panels** (`C3V6S85RS`). v3 announcement ts `1781760520.218999`. When circulating v5: post a new top-level message + attach the HTML (the Slack API tools here can't upload files — stage a draft, user attaches + sends).

---

## How to bring up / verify the wireframe
1. `preview_start` the `webDisplayTools` config (`.claude/launch.json`, port 8091).
2. Navigate to `/docs/development/arena-studio-wireframe-v5.html`.
3. `preview_console_logs level=error` → expect **none**.
4. Toggle **Run / Edit / Console**; in Console click **Expand all / Collapse all**; in Run trigger **▶ Test experiment** to watch the run-log fill + the live condition highlight; collapse the run-log strip; open the metadata modal; flip the demo buttons (**? Help**, **✎ simulate edit**, **🐙 GitHub**).
