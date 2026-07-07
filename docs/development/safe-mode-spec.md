# Safe Mode — Implementation Handoff Spec

**Status:** Spec only — NOT implemented. Written for a future session/agent.
**Owner:** Reiser Lab (CSHL course). **Target:** `arena_studio.html` (the primary tool).
**Origin:** colleagues felt the full Studio is intimidating for students; the PI wants a
locked-down default and a password-gated "advanced" mode for the second half of the course.

---

## 0. Context for a fresh agent

Read first: the `g6-orientation` skill and `CLAUDE.md` (§ Arena Studio — the three-script-
layer architecture, the §6 `pushUndo`/`canMutate` chokepoint, the `Studio.currentRig`
session-rig rules, and the `js/studio-url-state.js` URL-state rules). Safe mode is almost
entirely a **gating + UI-affordance** feature — it disables/hides existing surfaces; it does
not add new run/edit capability. It is fully **browser-verifiable** (no arena needed).

⚠ Line numbers below are **approximate** — `arena_studio.html` grew ~280 lines in the
2026-07 batch. Anchor by **function/identifier name** (grep) rather than absolute line.

---

## 1. Locked decisions (from the PI, 2026-07)

- **Safe mode is the DEFAULT.** A plain load (no URL flag) is safe. This intentionally means
  the instructor also lands in safe mode and opts into advanced.
- **Advanced mode is reached via `?advanced=1`** + a **password**. The password is a **soft
  gate, NOT security** (it lives client-side; anyone can read the source / edit the URL) —
  its only job is to keep students from wandering into destructive surfaces. Once entered,
  advanced is **remembered per browser** (localStorage) so the instructor's machine stays
  unlocked across reloads.
- **Allowed in safe mode:** run the loaded protocol (▶ Run), ▶ Test, enter run metadata,
  **open a protocol to run it (read-only)**, and preview/inspect the loaded protocol
  read-only. Connect/disconnect the arena is allowed.
- **Disabled in safe mode:** Edit mode entirely (no protocol editing), Console mode entirely
  (no pattern/panel/ISP/SD/raw-hex ops), the session-rig selector, all GitHub save/settings,
  Build pattern set, and any other doc/config mutation.
- **Run-lock is STANDARD for everyone (not just safe mode):** while a run is active, switching
  away from the Run view (to Edit/Console) is blocked — no stray console commands can
  perturb a running experiment. (Today nothing prevents this; see §3.5.)

## 2. UX surface

- **URL:** `?advanced=1` requests advanced; absent ⇒ safe. (Add to `js/studio-url-state.js`.)
- **A visible mode indicator** (e.g. a "Safe mode" chip near the top bar) so it's obvious.
- **Unlock affordance:** a small "Advanced…" control (or clicking the disabled Edit/Console
  segment) opens a password prompt. On match: reveal Edit/Console, enable the gated controls,
  set advanced for the session, and remember it (localStorage). A "Lock" control re-enters safe.
- In safe mode: the **Edit** and **Console** mode buttons are hidden/disabled; the mode is
  locked to **Run**. The rig selector shows the rig but is disabled. File ▾ shows Open (to
  run) but not Save/Settings/Build. The Console tool rail is not reachable.

## 3. Implementation map (levers that already exist — reuse them)

**3.1 Mode + views.** `setMode(m, opts)` toggles `editmode`/`consolemode` body classes and
the `#modeSeg` buttons (`data-mode` run|edit|console). Safe mode should refuse
`setMode('edit'|'console')` unless advanced, and hide those segment buttons. The segment
click listener wires `setMode(b.dataset.mode)` — gate there.

**3.2 The §6 mutation chokepoint.** `Studio.canMutate()` → `Meta.canMutate({mode, importMode})`
in `js/studio-meta.js` returns `mode==='edit' && !importMode`. Every protocol mutation passes
`pushUndo()` (returns `canMutate()`). Since safe mode forbids Edit entirely, doc mutation is
already impossible — but do NOT rely on that alone; also gate the Console ops (3.4) and the
save/rig entry points (3.3, 3.4), which don't go through `pushUndo`.

**3.3 Session rig.** `setSessionRig(name, {explicit})` + the `#sessionRig` selector (change
listener) + `#sessionRigLock`. In safe mode disable the selector (it already locks by default;
make it hard-disabled + not unlockable unless advanced).

**3.4 Destructive / config entry points to disable in safe mode** (all in the Console script):
- Pattern SD write `uploadPatternFile` (0x8D); firmware `pickFirmware` (0xE0); panel ISP
  `flashPanelOne` / batch (0xC8); SD purge (0x8F); SD archive (0x8A). These are dispatched by
  the Console `data-cmd` handler — the whole Console view is unreachable in safe mode, so
  gating `setMode('console')` covers them, but belt-and-suspenders: also early-return in the
  dispatcher if `!advanced`.
- GitHub: `Studio.saveCurrent` / File ▾ Save/Save-as/Promote (`.edit-only`), GitHub sign-in
  + course settings. Disable/hide in safe mode.
- Build pattern set…, Reset protocol…, Copy conditions… (Edit/File surfaces).

**3.5 Run-lock (standard, all modes).** In `setMode`, if `Studio.session && Studio.session.running`
and the target is not `run`, refuse (and keep the Run view). Today the segment buttons are
clickable during a run (only per-row test buttons are CSS-hidden). This is a small, separate,
always-on safety change — do it even independent of safe mode.

**3.6 URL state.** `js/studio-url-state.js` `decode`/`encode`/`encodeApp` handle
`mode|p|repo|rig|lib|set`. Add `advanced` (validate as `0|1` only). `encodeApp` should emit
`advanced=1` only when advanced is active AND was URL-requested (mirror the rig clean-URL
rule). Wrap `setMode` calls in `Studio._urlSuppress` as the existing init/popstate paths do.

## 4. Password

Soft gate. Suggested v1: the expected password is an instructor-set value (e.g. a
course-settings field stored in localStorage, or a small constant in a course config) —
exact storage is flexible since it isn't security. `?advanced=1` prompts for it; on match,
store an `advanced-unlocked` flag in localStorage (remembered per browser). A wrong password
stays in safe mode. Document plainly in the UI that this is a guardrail, not security.

## 5. Open questions for the implementing session

- Exactly what "**test the rig**" means in safe mode — is it the ▶ Test-experiment button
  (un-recorded run of the loaded protocol), or a dedicated connectivity/all-on self-test?
  (PI said "test the rig" is allowed; confirm the affordance.)
- **Open-to-run in safe mode:** allow opening from all sources (local file / library / course
  repo) read-only, or only the protocol the course link (`?p=`) preloads? (Decision this
  session: "open to run, read-only" — confirm the source scope.)
- Where the **password** is configured (course settings vs constant) and how the instructor
  sets it per bench.
- Unlock affordance placement + the safe-mode indicator styling.

## 6. Out of scope / notes

- Not a security boundary — never gate anything genuinely sensitive behind it.
- Reuses the existing three-layer architecture; connection + STOP stay in the classic
  substrate (never move them behind the mode gate).
- Verifiable entirely in the browser preview (toggle `?advanced=1`, check what's disabled).
