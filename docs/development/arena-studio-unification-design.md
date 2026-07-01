# Arena Studio — Unifying the v3 Experiment Designer + Arena Console

**Status:** Design proposal (rev 3) — 2026-06-17 ET
**Build decision (2026-06-16):** **staged path chosen** (see §12). Extract the shared connection first + ship a minimal runner; the full single-page Studio (§3–§9) is the *eventual* end-state, built only after the staged work proves the merge is warranted. §3–§9 describe that end-state vision; §12 is the committed near-term plan.
**Wireframe iteration (2026-06-17):** wireframe **v3** (`arena-studio-wireframe-v3.html`) supersedes v1/v2 and folds in the first round of colleague feedback (Lisa, Frank, Hannah — #panels Slack thread). See **§13** for the feedback-driven change list. v3 is the version circulated next.
**Scope:** Merge `experiment_designer_v3.html` + `arena_console.html` into one page (`arena_studio.html`) with a Run/Preview vs Edit mode model, a single persistent serial connection, a disclosable low-level Console, and URL-encoded state (GitHub #107).
**Source:** 10-agent review workflow (inventory → redundancy → URL-state → 3 design proposals → synthesis → 2 adversarial critiques) + two confirmed code facts.

---

## 1. Goals (from the user)

1. **Unify** the designer and the console into one page.
2. **One common mode:** load an existing YAML, *do not allow editing it*, just **run it** on the arena. Make this dead easy.
3. **Two modes:** a **Run/Preview** mode (run any trial or the whole sequence) and an **Edit** mode (the loaded protocol becomes editable).
4. **One open serial connection**, usable from anywhere — "test anything from anything."
5. **Fewer, better-organized options.** Power users keep access to *everything*; newbies are not intimidated.
6. **URL-encoded state** (#107): shareable links can pre-load YAML(s) and a mode. A *running* experiment's progress need not be encoded. Params short but human-readable.

## 2. Critical review of the current tools

### What's wrong today (the "too many options, badly organized" problem)

- **Three Stop buttons, two Connects, two pattern-set pickers, two `ArenaLink` instances.** Confirmed: `new window.ArenaLink` exists at `arena_console.html:1139` *and* `experiment_designer_v3.html:5216`. The console Stop, the designer "Run on arena" Stop, and the docked run-status Stop are three buttons hitting the same opcode (`0x30`). An emergency control that is duplicated and sometimes off-screen is worse than one.
- **The designer's first screen is hostile to newcomers.** Four empty zones each say "Import a v3 YAML to populate…" (`:1470/:1480/:1496/:1507`). A new lab member is given nothing to *do*.
- **The console front-loads foot-guns.** The raw trial-params row (mode select, *1-based SD index*, int8 gain, frame rate) is meaningless to a newbie and easy to get wrong. Pattern is picked by raw index, not name, in the worst case.
- **Disabled "firmware-gated" stub buttons** (SD card report, Reverse rate, Panel debug modes) read as "I'm doing something wrong," not "not built yet."
- **The designer header is overloaded:** New / Import YAML / Import-from-YAML / Load demo ▾ / Pattern Set… / Export / Undo / Redo / Reset / Settings — 11 controls, all at equal weight, all visible before you've loaded anything.
- **Capabilities are split across two tools that share a controller** but can't share a connection, so you constantly switch tabs to "just check something."

### What's *right* today (keep these instincts)

- Pattern **preview thumbnails** next to a name selector (console) — high value, low clutter.
- The designer **already** owns a serial connection and runs on the arena: per-condition **"▶ Test on arena"** (single trial, LAB-94 dry-run) and **"▶ Run on arena"** (whole sequence, host-timed). The run-status panel persists across re-renders.
- Per-mode field relevance (designer greys gain in mode 2, frame-rate in mode 4).
- Classic-script globals for the serial substrate (`arena-wire-g6.js` / `arena-link.js` / `arena-runner-g6.js`) — dodges the catastrophic ES-module-import-failure bug.

## 3. Recommended concept — "Arena Studio"

A **persistent-connection workbench** with a **protocol-pane mode toggle** and a **universal Console dock**. Three persistent layers, top to bottom:

```
┌─────────────────────────────────────────────────────────────────────┐
│ ① CONNECTION BAR  (always-on, ~56px, classic-script-owned)            │
│   Arena Studio │ ● connected · G6 2×10 · fw v1 │ [Run|Edit] │ ■ STOP │
│   [Connect/Disconnect]                          run: ▸ trial 3/12 12s │ ⚙
├─────────────────────────────────────────────────────────────────────┤
│ ② PROTOCOL BODY  (the ONLY mode-dependent region)                     │
│     RUN view = centered launcher    │    EDIT view = full v3 designer  │
├─────────────────────────────────────────────────────────────────────┤
│ ③ CONSOLE DOCK  ▸ Manual / Console   (collapsed bar; expands ~40vh)    │
│     Quick test · Frame stepper · Stream · Raw+log · Device memory      │
└─────────────────────────────────────────────────────────────────────┘
```

- **① Connection bar** owns the *one* `ArenaLink`, the *one* global status, the *one* STOP, the relocated run-status, and a ⚙ menu (All tools, Quick Start, Diagnostics submenu). Never re-rendered by mode/protocol changes.
- **② Protocol body** is the only thing the Run|Edit toggle changes. Both Run and Edit are *views of the same in-memory protocol*. The body never touches the port.
- **③ Console dock** holds the *entire* low-level surface, tabbed, bound to the same `ArenaLink`. This is how "test anything from anything" is satisfied.

**Product rules:** pick patterns by **name** everywhere a newbie touches them (raw SD index becomes derived/locked); expose mode/rate/gain/init only in the Edit Inspector + the Console advanced row; **one** run path, **one** Stop, **one** Connect, **one** pattern-set source.

> Why this over the alternatives: the review ranked three proposals — (#2) connection-as-chassis [winner], (#1) mode-first toggle [harvested heavily for the Run launcher + cleanup list], (#3) left-rail progressive disclosure [weakest]. The winner treats the serial link as the page's *spine* and scopes Run|Edit to the protocol pane only, so a one-field tweak doesn't cost a full app-mode round-trip.

## 4. Mode model — Run/Preview vs Edit

A **per-pane lock** on the protocol body, toggled in the connection bar. **Not** an app-level modal split, and it **never** touches the serial port.

**RUN/PREVIEW (default on load, default for any opened YAML):**
- The protocol is **read-only**. You can run the whole sequence, run any single condition (per-row ▶), run an ad-hoc single trial (pattern-by-name), Stop, and use the entire Console dock. None of these mutate the protocol.
- This is the locked *"load a YAML and just run it"* path.

**EDIT (entered via a demoted, secondary control — see §8 fix):**
- Unlocks editing, reveals the editing banner, Undo/Redo/Reset, Import/D4/Export, full Inspector trial params. The full v3 three-zone designer renders in place.
- Entering Edit does **not** set dirty (viewing ≠ mutating). Only an actual edit sets the `● edited` badge.

**Switching:** Run→Edit is non-destructive, no port change. Edit→Run with unsaved edits keeps the edited protocol **in memory** and runs it, but **only after an explicit, visible choice** ("Run edited / Revert to loaded file") — not a silent tiny note (critique fix).

**Single run path:** the v3 "▶ Run on arena" button is **removed**; the console "Send trial params" becomes a Console Quick-test advanced action. Every sequence/trial run routes through the launcher + top-bar machinery → exactly one run path and one Stop.

## 5. Connection model — single owner, classic-script, **extracted not relocated**

> **Critical correction from the feasibility critic.** Calling this a "relocation" of the v3 run-status is wrong. In `experiment_designer_v3.html` the entire serial layer lives *inside the ES-module block*: `arenaLink` (~`:5216`), `updateRunStatus` (~`:5265`), and the Connect/Disconnect/runSeq/runStatusClose listeners (~`:5476–5507`), and `runSequence` depends on module-imported `parseV3Protocol`/`flattenStructure`. Achieving the resilience property requires a **cross-boundary extraction**, not a move.

**The fix — a new classic script `js/arena-session.js` (no ES export):**
- Owns the **singleton** `ArenaLink`, `connect()`, `disconnect()`, `STOP` (`0x30`), a module-level `runState` (`idle | running`), and a **run-status pub/sub**.
- The ES-module block *subscribes* to run-status and *pushes the parsed `experiment`* into the session, so:
  - Connect / STOP / status are module-independent (a stale `protocol-yaml-v3` import after a GitHub-Pages deploy cannot disable them — honors the CLAUDE.md gotcha).
  - The runner still has protocol data to read.
- **Honest caveat:** even after extraction, if the module import dies, Connect/STOP survive but *Run sequence produces nothing* (no parsed `experiment` to run). That's strictly better than today and acceptable — the emergency control is what must never die.

**Shared access:** Run body, Edit body, and Console dock all reference the *same* session link.

**Run-state collision rule (corrected to match the transport):** `arena-link.js` is single-flight + echo-correlated, so read-only actions are **never *blocked* but are serialized** behind any in-flight runner send and may briefly stall — *not* "never gated." Destructive display actions and raw-hex sends during a run get a one-click "a sequence is running — interrupt?" confirm that issues STOP first. Starting any run issues STOP first, so no overlapping-trial corruption. Disconnect is always allowed and force-clears `runState`.

**Launcher executes verbatim (critique fix):** the launcher and per-row run build wire commands from the in-memory protocol **command arrays** (mode/rate/gain/init **as stored**), never re-derived from the pattern name. Name selection only chooses *which* condition. (Prevents a mode-4 gain or mode-2 frame-rate condition from being run as the wrong mode.)

## 6. The read-only lock must be a single chokepoint (BLOCKER fix)

The synthesis assumed Run mode could "reuse the existing `importMode` guard pattern." **It cannot as-is:** there are **53 `pushUndo()` mutation sites but only 37 `importMode` guards** (confirmed by grep) — a ~16-site gap. A Run-mode `readOnly` flag wired only to existing `importMode` checks would leave mutation paths live, so a newbie who peeks at Edit and returns to Run could silently corrupt the protocol.

**Fix:** introduce **one** `canMutate()` chokepoint — return `false` when `readOnly || importMode` — and call it at the **top of every mutation** (ideally wrap `pushUndo()` / `saveSnapshot()` so the guard is unavoidable). Audit all 53 sites; the ~16 without an `importMode` guard are the proof the scattered pattern is insufficient. **Do not claim Run mode is safe until that audit lands.**

## 7. Cleanup list (what we remove / merge / hide)

| Action | Item | Why |
|---|---|---|
| **MERGE** | 2 Connects → 1 | One global pair; one `ArenaLink`. Removes duplicate at v3:5216. |
| **MERGE** | 3 Stops → 1 | One persistent global STOP, always enabled while connected. |
| **REMOVE** | Designer "▶ Run on arena" button | Running unifies into the launcher path; `runSequence` machinery stays. |
| **MERGE** | Console "Controller ▾" + "Debug ▾" menubars | Folded into ⚙ → Diagnostics submenu. |
| **REMOVE** | 3 firmware-gated disabled stubs | Clutter; track in ROADMAP, re-add live when FW#4/#5 lands. |
| **MERGE** | "Load set…" + "Pattern Set…" | One shared "Pattern set" source at dock top. |
| **HIDE** | Raw mode/pat-index/rate/gain/init as *primary* | Pattern by name; raw knobs only in Edit Inspector + Console advanced row. |
| **HIDE** | Frame stepper + stream/synthetic-frame block | Move into collapsed Console dock tabs. |
| **HIDE** | Get IP / frames-sent / SPI / Refresh | ⚙ Diagnostics submenu only. |
| **HIDE** | Designer multi-sentence editing banner *in Run mode* | At most a one-line "read-only" note; full banner only in Edit. |
| **RELABEL** | Run-status panel → connection bar | Survives every body re-render, visible in both modes. |
| **RELABEL** | "Send trial params" → "Run one trial" (launcher) / advanced action (dock) | Same opcode 0x08, clearer everyday label. |
| **RELABEL** | "v3 Experiment Designer" + "Arena console" → "Arena Studio" | Two-tool identity disappears for the user. |
| **KEEP** | All on / All off | The "is it wired up" sanity action; Console Quick-test in both modes. |
| **KEEP** | SD-card list box | Carries real on-device flashed state the name selector lacks. |

## 8. Newbie-safety fixes (from the newbie critic — adopted)

- **Re-baseline the claim:** it's *"two clicks past Connect,"* not "2-click." Connect needs a user gesture + native port picker. After a successful connect, immediately fire **Get-info** to confirm the link is alive and show **firmware + capabilities** from its reply (e.g. `fw v1`). **Correction (Codex):** `GET_CONTROLLER_INFO` returns firmware version + capability bits only — **not arena geometry**. The `G6 2×10` part of the device line must come from the loaded rig / pattern-set / UI default, not the controller reply. Add a one-line hint ("Pick the USB serial port for the arena").
- **Demote the Edit entrance.** Do **not** give Run|Edit peer prominence in the persistent bar. Default to Run; put **"Edit this protocol →"** as a quieter secondary control under the summary card, with a first-entry confirm ("changes won't run until you switch back / export").
- **Disconnected launcher state.** Render "▶ Run sequence" disabled-with-reason ("Connect to run"); clicking it (or the launcher) routes to Connect — the big green button *teaches* the next step instead of dead-ending.
- **One dominant action.** "▶ Run sequence" is the sole primary; "Run one trial" is a quieter secondary; per-row ▶ in the read-only list runs an individual condition.
- **Gate the Console dock doorway in Run mode** for newbies: either don't render "Manual / Console ▸" in Run unless opted in via ⚙, or open it to a minimal Quick-test (All on/off + one named test pattern) with raw-hex/stream/advanced behind an "Advanced" disclosure.
- **Edit→Run reconciliation is explicit** (see §4) — never silently run a mutated protocol.

## 9. URL state schema (#107) — with the shareability boundary

| Param | Example | Meaning |
|---|---|---|
| `mode` | `?mode=run` | `run` (default) \| `edit`. **Shared links always open in Run regardless of saved value** (newbie-safety); `edit` honored only for the authoring browser. |
| `p` | `?p=looming_v3` | Primary protocol — a short key resolved against bundled fixtures/committed library via **same-origin** fetch. |
| `lib` | `?p=…&lib=stim_library` | Second protocol as the D4 import *source*. |
| `dock` | `?dock=raw` | `closed` (default) \| `quick` \| `stepper` \| `stream` \| `raw` \| `mem`. |
| `set` | `?set=cshl_2026` | Pattern-set source key so name→index + previews are ready on load. |

**Shareability boundary (critique fix):** `p`/`lib` resolve **only to repo-bundled/committed keys** via same-origin fetch (`no-store`, mirroring the existing `configs/rigs/index.json` fetch). **A locally file-picked YAML has no shareable URL** — on such a load, do *not* write `?p=`. Document this as a known #107 limit. **Failure handling:** on non-ok fetch / CORS / non-v3 YAML, fall back to the empty drop-zone with a non-blocking banner (reuse the `V3ParseError` path + v2-reject guard) — never a blank screen. **Running experiment progress is deliberately not encoded.**

## 10. Phasing (incremental, lowest-risk first)

0. **Shell + single connection.** New `arena_studio.html` loads the classic-script substrate; build **only** the connection bar around the new `js/arena-session.js` singleton (merged Connect/Disconnect, global status, global STOP, relocated run-status). Prove one connection + one STOP against the bench arena. *Classic-script only — zero ES-module risk.*
1. **Console dock.** Port the `arena_console.html` core into the collapsed dock (5 tabs), all binding to the Phase-0 session. Merge 3 Stops/2 Connects, remove 3 stubs, fold menus into ⚙. **Shippable as a strictly-better console on its own.**
2. **Run/Preview launcher.** Summary card, single primary "▶ Run sequence" + secondary "Run one trial" (name picker + preview thumb), read-only sequence list with per-row ▶, `runSequence` wiring, the `runState` collision guard, disconnected affordance.
3. **Edit body (full v3 in place).** Embed the v3 three-zone designer as the Edit body, governed by the toggle and the **`canMutate()` chokepoint** (§6). Remove "▶ Run on arena." Move Settings/Import/D4/Export/Undo into the Edit-only sub-toolbar. *Largest/riskiest step — done last, behind the already-working bar.*
4. **URL state + share links.** Read/write `mode/p/lib/dock/set`; restore on load; round-trip-test shared links. Add `window.__studioLoadProtocol(key)` / `window.__studioRun()` test seams (the merge invalidates the per-tool test hooks).
5. **Polish + retire originals.** Tooltip audit, version-stamp footer, redirect the two old files (or keep as deep-links), update `index.html` + ROADMAP. Add a CLAUDE.md note: *connection/STOP/runState live in `js/arena-session.js` as a classic script and must never move into the module block.*

## 11. Open questions for the user

1. **Brand/filename:** confirm "Arena Studio" / `arena_studio.html`, or keep one existing filename so bookmarks survive?
2. **Edit→Run with unsaved edits:** explicit "Run edited / Revert" choice (recommended) vs. prompt-to-export-or-discard on leaving Edit?
3. **Mid-run Console safety:** one-click "interrupt?" confirm on destructive actions (recommended) vs. hard-disable destructive actions while running (read-only queries still allowed)?
4. **Pattern-by-name with no library loaded:** confirm Run mode stays name-only and the raw-index fallback is "use Console advanced row or Edit mode"?
5. **URL protocol resolution:** bundled/committed keys only (safe, offline) — confirmed? Or also accept arbitrary URLs (more powerful, CORS/trust questions)?
6. **Sequence run fidelity:** `runSequence` is host-timed/best-effort and skips plugins (FW duration not landed). Badge Run-mode sequence runs as "host-timed / plugins skipped"? Does "done" wait on FW#4?
7. **Diagnostics pruning:** keep Get IP / frames-sent in ⚙, or drop them too?

---

## 12. Staged path (CHOSEN near-term plan)

Both the workflow's adversarial critic and Codex-adversarial independently recommended **not** committing to the full single-page merge first — it "solves a product-boundary problem with a product merge before proving the boundary is the problem." The committed near-term plan extracts the genuinely-shared piece (the connection), delivers the headline newbie win as a small purpose-built page, and defers the large editor-embed until evidence justifies it.

### Stage A — Extract `js/arena-session.js` (the shared connection), retrofit both existing pages
- New **classic-script** module (no ES export; window-global, like `arena-link.js`). Owns the **singleton** `ArenaLink`, and a public API: `connect()`, `disconnect()` (with public cleanup — today v3 reaches into the private `_clear()`), `stop()` (best-effort *queued* STOP, opcode 0x30), `queryInfo()`, `getState()`, `subscribeStatus(cb)` pub/sub, plus `setExperiment()` / `setPatternSet()` and run entry points `runSequence()`, `runCondition(name)` (full **command-array replay**, *not* `ArenaRunner.start()`), `runQuickTrial(...)`. Activity state is **richer than idle|running**: `idle | sequence | trial | streaming | stepping`.
- Retrofit `arena_console.html` and `experiment_designer_v3.html` to *use* this session instead of each `new window.ArenaLink(...)`. Collapses the two link instances + duplicate connect/stop logic. **No UI merge** — both tools keep working, now sharing one connection broker. Low risk, fully reversible, immediately removes the worst redundancy.
- Tests (extend `tests/`): session singleton, queued-STOP behavior, run-state collision, disconnect cleanup, command-array replay for a single condition.

### Stage B — Ship `arena_runner.html` (the minimal newbie launcher)
- A small **new** page = essentially the **Run view** of the wireframe: connection bar (status, Connect, global STOP, ⚙ Diagnostics) + the centered launcher (summary card, one dominant **▶ Run sequence**, quiet name-based "run one trial", read-only per-row ▶ list, "what's skipped" note). Binds to the Stage-A session. **No editor, no dock** (a "Open in Console / Designer" link is enough).
- Fixes baked in from review: **enabled** "Connect to run" primary (a real `disabled` button can't route clicks); device line geometry from rig/pattern-set (not Get-info); host-timed runs **badged** "host-timed · plugins skipped"; `loadedProtocolText` baseline retained.
- URL state here (a clean slice of #107): `?p=` / `?set=` resolved against a **committed `protocols/index.json`** registry (mirroring `configs/rigs/index.json`) with allowed-key validation + path-traversal rejection; **local file-picked YAMLs clear `p`/`set`** (not shareable — documented limit); malformed → empty drop-zone + non-blocking banner via the `V3ParseError` path.
- This delivers "load a YAML, just run it" for CSHL/course use **without touching the 6,700-line designer**.

### Stage C — Decide on full Studio (evidence-gated)
- Use Stage A+B. If real bench/course usage shows people constantly need Edit + low-level Console *during* running, build the full single-page Studio (§3–§9): Run|Edit per-pane lock via the `canMutateProtocol()` chokepoint (audit all 53 mutation sites — gate the *handler*, not the snapshot), the Console dock, full URL schema. If not, keep three lean tools sharing one session and stop here.
- Hard one-way doors to defer until this stage: retiring the original pages, threading `canMutateProtocol()` through the whole designer, making the URL schema public.

**Why this ordering is lowest-risk:** Stage A is pure refactor behind unchanged UIs (reversible). Stage B is additive (originals stay live). Only Stage C touches the editor monolith and retirement — and only with evidence.

---

## 13. Colleague feedback round 1 (2026-06-17) → wireframe v3

v2 was circulated in the #panels Slack thread. Feedback from **Lisa Ferguson**, **Frank Loesche**, **Hannah Marie Santos** (Lisa: "design looks great… easy to figure out what everything is without instruction"). The agreed changes are baked into **`arena-studio-wireframe-v3.html`** (browser-verified: renders clean, no console errors, run/test/stop/metadata flows work). IDs map to the thread (F# = Frank, H# = Hannah).

### Adopted — built into v3
1. **Block vs condition detail (F1).** A *condition* row shows `mode · duration · framerate` chips; a *block/sequence* shows a color-coded composition strip + condition count + repeat + **total** duration (not crammed per-condition detail — Michael's clarification that a block ≠ a condition).
2. **STOP appearance + placement (F2 / H1).** STOP is muted/disabled until a run is *actually running* (not merely connected); the loud green/red state is reserved for the running state. STOP is **removed from beside Disconnect** — it now lives in the Run launcher (appears loud when running) and in the always-visible Run-log header. Disconnect sits alone in the session ribbon (anti-misclick, CSHL-safety).
3. **Test buttons, not links (F3 / H4).** The "dry-run" link is gone. Vocabulary trio: **Test trial** (per-condition ▶, blue) / **Test experiment** (whole sequence, blue) — both *not* recorded — vs **Run experiment** (green) which **always logs**. No "log data" checkbox (declined — see below).
4. **Quick Test relocated (F4).** The ad-hoc "play any pattern" tester moved from the Run view into the Console/Device drawer (it's a manual bench tool, not part of the loaded protocol). The per-condition ▶ stays in Run.
5. **Console dock (F5).** Run log (main/left column) + a narrower right "Device" column. Device shows a **single compact memory box** — SD card by default, flick to PS-RAM (was a bulky 2-up grid). Heavier pro tools (quick test, frame stepper, stream, raw) behind a "Pro tools ▾" disclosure. **De-bulk correction:** the dock is the *console surface* and is shown in the **Run/console view ONLY — it is hidden in Edit** (Edit gets the full-height three-zone designer). Earlier "reachable in Run AND Edit" was wrong per user.
6. **Removed the bottom "Edit this protocol" link (F7 / H3)** — duplicated the Edit toggle and mixed website-link / app-button idioms.
7. **Plugins (F8 — revised in de-bulk pass).** F8's Run-view *card* was too bulky on a laptop, so it's **removed from the Run body**. Plugins now live as a **hover-pill on the protocol ribbon** ("⚡ Plugins · 2") whose tooltip lists what's expected (backlight, camera). Inline `⚡` chips also removed from the Run sequence; plugin detail stays in Edit (library chips + Settings). This still answers "where are the plugins?" without consuming Run real estate.
8. **Callouts → Help (H2).** The demo annotation system is relabeled "? Help"; the intent is to grow it into real persistent in-app help.
9. **Read-only cue (H5).** The wordy read-only banner is replaced by a small persistent **🔒 read-only** chip on the protocol ribbon (Run mode only).
10. **"level" → "Brightness" (H6)** in the (now Console-housed) quick test.
11. **File menu Save target (F6).** "Save" is no longer ambiguous: a **visible, reversible checkbox** ("Save as Pull Request") sets the target. Signed out → Save writes a local `.yaml`. **Signing into GitHub auto-checks the box** → Save commits to a branch + opens a PR on the repo (the **web-only authoring path**). Uncheck any time to revert to a local file. Feasible fully client-side via a fine-grained PAT (api.github.com is CORS-friendly); a polished "Log in with GitHub" OAuth button would need a tiny serverless token-exchange (breaks the pure-static model) — PAT is the MVP.
12. **Run-metadata dropdowns are repo-backed (Michael, 2026-06-17).** The run-metadata dialog's experimenter + genotype dropdowns are populated from controlled-vocabulary files committed in the repo (`configs/metadata/people.yaml`, `genotypes.yaml`), and each field links to its source file on GitHub ("↗ source list") so anyone can extend the list via PR. Coheres with F6's GitHub path.

### Live run highlight (2026-06-17, user request — "highlight the condition/block being run")
While a run steps through the sequence, the **currently-running condition row lights up** (accent border + tint + bold name + a pulsing left bar) and its **containing block** gets an accent outline — a live "you are here". Green for a recorded Run, blue for a Test run (`body.testing`). Driven off the runner's per-step events (host-side); clears on sequence-complete and on STOP/abort. In the real build this binds to `arena-runner-g6.js`'s `onProgress` `step-start{index,step}` phase. Cheap, high-value orientation cue.

### Ribbon-control consistency fix (2026-06-17) — NARROW; an earlier broad flatten was a misread and was reverted
The only change: the **second (protocol) ribbon's two control groups now look identical in Run and Edit**.
- **Run|Edit segmented toggle:** the active segment uses **one consistent muted-blue style** (`#26405e` / `#cfe6ff`) regardless of which is active — previously it was bright-green for Run vs blue for Edit, which read as two different controls.
- **Open protocol** gets `white-space:nowrap` so it stays one line at the same height as **File ▾** (it had been wrapping to two lines → taller group).
- **Everything else is left exactly as it was** — the bright-green big "Run experiment" launcher, the Connect button, etc. A prior pass that flattened the whole Run page (launcher, Connect, all buttons → muted) was a misread of "make these *3 buttons* match" and was fully reverted. (The 2-agent extraction of the designer's/console's control design language is preserved in the session notes should a deliberate, page-wide flatten ever be wanted.)

### De-bulk pass (2026-06-17, after first laptop preview — "too bulky, too much going on")
- **Run-experiment launcher ~halved in height** (compact padding/font); cards tightened → much more vertical room for the sequence list, which was the priority.
- **Plugins card removed** (→ ribbon hover, item 7) and **device-memory grid → single compact flick box** (item 5).
- **Dock hidden in Edit** (item 5) — Edit is now a clean full-height designer.
- **"Save a copy… (Export)" removed** from the File menu: redundant with "Save → local file" now that Save downloads a YAML (or opens a PR when signed in). Can re-add a true "export a copy without renaming the current doc" later if a real need appears.

### Declined (with reasons) — for the Slack reply
- **Frank's "log data" checkbox** that converts Run→dry-run: a single checkbox silently turning a recorded run un-recorded is a data-loss foot-gun for course users. The explicit two-button model (Test experiment vs Run experiment) makes "recorded vs not" a deliberate choice each time.
- **Console always-expanded as the global default (part of F5):** kept the *log* always-visible (adopted) but the heavier tools stay behind the Pro-tools disclosure so Run mode stays uncluttered for newcomers. State can be persisted per-user later.

### Explanations (not changes) — for the Slack reply
- It's a wireframe — most buttons are intentionally inert (answers Lisa).
- **Plugins** already exist in the data model / Edit → Settings; v3 now also surfaces them in Run.
- **Callouts** were a demo device; becoming real Help.
- **"Level"** = LED brightness; relabeled + moved to the Console.
- **Save** writes a local YAML by default — and (new) can open a PR when signed into GitHub.

**Artifact:** `arena-studio-wireframe-v3.html` supersedes v1/v2 and is the version to circulate next. Audience decision is effectively settled by the above: **Run mode is optimized for the newcomer/course user** (uncluttered, lock chip, STOP separated, pro tools tucked); the always-visible log + Device Memory serve power users too.

## 14. Wireframe v4 — re-sync to shipped reality + Console-as-first-class view (2026-06-30)

After ~2 weeks, a 3-agent repo scan found **main barely advanced** since v3: the `arena-session.js` broker (PR #112) and `run-log.js` (PR #113) are still **open, unmerged**, and the metadata modal / run-log download / GitHub-PR save / repo-backed dropdowns **don't exist in the shipped tools at all** (mockup-only). What *did* ship: a 3rd core plugin (`temperature`/DAQ), and `arena_console.html` v5 is now a full PControl surface (STREAM_FRAME suite, `.bin/.pat` upload via `bin-classifier.js`, name→SD picker w/ preview thumbnails, mode-3 `setPositionX`/0x70 stepper). User chose **re-sync to shipped reality + open to a bigger layout rethink**.

**`docs/development/arena-studio-wireframe-v4.html`** is a NEW file (v3 kept untouched as the A/B comparison baseline). Browser-verified, no console errors. Changes:
- **Content re-sync:** `⚡ Plugins · 3` (adds `temperature`); Mode-3 `init pos` field in the Edit Inspector (SET_FRAME_POSITION 0x70); honest **`⏱ host-timed · plugins skipped`** badge on the launcher; per-condition buttons → real **`▶ Test on arena`** copy; pattern-by-name + preview thumbnail in the Console.
- **`.planned` cue (◷):** one dashed-amber chip marking the four mockup-only features — run-log download (PR #113), GitHub/PR save block, metadata modal, and the shared-connection premise (PR #112) — plus a footer legend. Live log + step-highlight are left *unbadged* (those are shipped).
- **Layout rethink (A′):** the Run|Edit toggle becomes **`▶ Run | ✎ Edit ‖ ⛭ Console`** (3 segments; divider marks Console as a *bench surface*, not a document-view). The old bottom dock is **deleted**; its two jobs split — the **Run log → a strip inside Run only** (with All on/off for the "is it wired?" check), and the **Device/bench surface → its own full-body Console view** laid out as honest groups (display · device memory SD/PS-RAM · pattern+trial-params · frame stepper · STREAM_FRAME suite · raw+log). Edit is unchanged (full-height designer; Console is simply a different view).

**Why A′:** honest about the Console's true scale *and* keeps Run uncluttered with the run-log visible in Run (the v3 instinct), while isolating foot-guns behind their own door. **v3 + v4 both on disk** → side-by-side compare, then a consolidated "best of both" pass before anything is finalized. Next: circulate v4 (Slack), gather feedback; the broker/run-log/metadata stay gated on PR #112/#113 merge + bench test.
