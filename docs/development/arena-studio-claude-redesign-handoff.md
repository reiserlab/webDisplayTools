# Arena Studio: Claude-derived revision handoff

**Decision date:** 2026-07-17

**Audience:** Claude and anyone implementing the next Arena Studio candidate

**Status:** product direction and implementation handoff; the Alt page remains a reference implementation

## Decision

Build the next Arena Studio candidate from the current Classic/Claude design in
`arena_studio.html`. Do not use Arena Studio Alt's visual shell as the new base.
Keep Classic, Alt, and the new candidate available side-by-side until the lab
accepts the replacement.

This is a visual and interaction redesign, not a functional reset. Preserve the
Classic control wiring and carry forward the useful functionality developed for
Alt. Prefer shared modules and the existing Studio substrate over duplicated
handlers.

The lab discussion is in the [2026-07-15 `#panels` Slack
thread](https://hhmi.enterprise.slack.com/archives/C3V6S85RS/p1784134662614579?thread_ts=1784134662.614579&cid=C3V6S85RS).
Three respondents preferred the Claude/Classic design. One respondent liked the
Alt appearance but deferred to experienced operators. The concrete Alt ideas
the team wanted to retain were:

- Console **Tools** visibility presented as checkboxes.
- The Run view's use of the full available width.

The same feedback identified problems that should not be repeated: compressing
Edit controls into the top ribbon, the unclear **Tuning** label and Sound
disclosure, toggles without visible state, and several light-mode contrast
failures.

## Product principles

1. Start with Classic's hierarchy, density, and familiar control locations.
2. Add functionality while minimizing complexity; do not hide frequent bench
   actions merely to make the header sparse.
3. Preserve every wired Classic action unless an accepted replacement is
   documented and tested.
4. Build a new side-by-side candidate rather than modifying Classic in place.
5. Reuse the shared substrate and modules. Alt is an implementation reference,
   not a second copy to fork indefinitely.
6. Treat both themes, narrow screens, ordinary desktop screens, and larger
   displays as supported states rather than cosmetic afterthoughts.

## Retain from the Alt work

### Navigation and settings organization

- Rename **File** to **Protocol** because its primary actions open, save, share,
  reset, and manipulate protocols.
- Put Edit-mode protocol actions, including Designer/YAML, Undo/Redo, Protocol
  Settings, and condition-copy operations, under the Protocol concept without
  crowding them into an always-visible ribbon.
- Keep application-wide settings separate from protocol settings. Rig selection,
  GitHub/storage, logging, and theme belong in **Studio Settings** (a gear is
  appropriate); YAML-backed protocol settings do not.
- The rig does not need a permanent top-bar selector. Its identity must remain
  easy to discover from Studio Settings and from Connect hover/focus text.
- Avoid status labels that resize or shift the Connect control. A stable control
  plus a clear status lamp is sufficient when its accessible label also reports
  state.

### Runlog replay/emulator

Retain the replay implementation and its tests while adapting its presentation
to the Claude-derived design:

- Load an existing JSONL runlog and its YAML protocol. If the URL, run metadata,
  or repository provenance already identifies the protocol, recover it
  automatically instead of forcing a duplicate selection.
- Support local files and repository-backed files, including anonymous reads of
  public repositories and signed-in write paths.
- Offer 0.5x, 1x, 2x, and 4x playback; default to 1x.
- Provide Start, Pause/Resume, Stop, and a seek slider. Stop ends replay; Pause
  does not.
- Interlock hardware output during replay. The replay screen is read-only apart
  from playback, seek, display, and sound controls.
- Keep the current step visible, highlighted, and synchronized with the scope.
  Auto-scroll the sequence as needed and hide **Test experiment** during replay.
- Reproduce scope annotations and optional replay sound. Pause and Stop must
  pause/stop sound consistently.
- Parse long JSONL logs without recursive stack growth, and tolerate a torn final
  line while still reporting malformed complete records.

### Runtime-control sidecar

- Show only YAML-declared runtime controls, expected to be one or two variables.
- Apply changes at the next trial boundary.
- Log each change without rewriting the source YAML.
- Follow
  [`flow-control-counter-proposal.md`](flow-control-counter-proposal.md) for the
  data model and provenance requirements.

### Synchronized 3D replay viewer

- Keep the viewer available in a separate movable window with minimal camera
  controls and synchronization to replay time.
- Resolve PAT files from repository provenance or the declared pattern library,
  with a user-supplied local PAT as an explicit override.
- Provide front, rear, and fly-eye cameras. Fly-eye starts at the arena center
  immediately above the ball and looks forward.
- Retain a horizontal view-width/FOV control in the useful range of roughly
  60–150 degrees.
- Always render the 9 mm ball as opaque solid white.
- Render the LED as a small silver tube pointing down. Illuminate the ball and
  arena with a restrained red glow only while the logged LED state is on.
- Keep the shared, batched LED-glow implementation described in
  [`three-viewer-led-glow.md`](three-viewer-led-glow.md).
- For the CSHL preview geometry, omit rear column panels 8 and 18. Column 8 is
  behind the fly and column 3 is in front.

### Repository, provenance, and one-link workflows

- Preserve `?repo=OWNER/REPO&p=PATH` protocol preloading so a shared link can
  open the relevant protocol before a user selects only the JSONL runlog.
- Keep public-repository reads usable without GitHub sign-in.
- Keep repository selection race-safe: pending state is visible and the last
  selection wins.
- Preserve runlog protocol/repository provenance and the explicit local PAT
  override path.
- Keep same-origin and declared-library constraints around automatic pattern
  retrieval; do not silently fetch arbitrary paths from run data.

### Scope and Console refinements

- Retain the Console **Tools** checklist for showing and hiding modules.
- Retain Full/Clean scope-label modes and the useful scope controls.
- Rename **Tuning** to a direct label such as **Scope controls** or **Display**.
- Make Auto-Y, Sound, and other toggle states visible through text/icon state,
  `aria-pressed`, and styling—not color alone.
- Make the Sound settings affordance explicit rather than an unexplained arrow.
- Keep popovers within the viewport and within their owning control area.

## Light-mode requirements

Add first-class light and dark themes to the Claude-derived candidate. Theme
selection must not change behavior or available controls.

Acceptance details from the lab review:

- Safe Mode must remain readable and visibly distinct in light mode.
- Help links and accent text need sufficient contrast on the light background.
- Pattern GIF previews should retain a deliberate dark/black neutral surround
  in both themes rather than an accidental beige box.
- Active toggles must communicate state without relying on color alone.
- Focus rings, disabled states, warnings, graphs, and popovers must remain
  legible in both themes.
- Verify both themes visually in Run, Edit, and Console, including narrow and
  wide layouts.

## Do not carry forward

- The overall Arena Studio Alt visual shell.
- The Edit layout that crams Designer/YAML and Undo/Redo into the top ribbon.
- **Tuning** as a label for scope controls.
- Premature header compression or floating tool groups surrounded by unused
  horizontal space.
- Light-theme colors copied mechanically from dark mode.
- Any Alt-only handler that duplicates an existing Classic/shared handler.

## Implementation map

Use these files to recover the functional work without inheriting the Alt shell:

| Area | Current implementation/reference |
| --- | --- |
| Classic Studio substrate and shell | `arena_studio.html` |
| Alt entry and visual integration | `arena_studio_alt.html`, `js/arena-studio-alt.js`, `css/arena-studio-alt.css` |
| Replay parsing and timeline | `js/runlog-replay.js` |
| Runtime controls | `js/runtime-controls.js` |
| Replay viewer | `arena_replay_viewer.html`, `js/arena-replay-viewer.js`, `js/arena-replay-viewer-protocol.js` |
| Shared 3D renderer | `js/pattern-editor/viewers/three-viewer.js` |
| Alt contract tests | `tests/test-arena-studio-alt.js` |
| Replay tests | `tests/test-runlog-replay.js`, `tests/test-arena-replay-viewer-protocol.js` |
| Runtime-control tests | `tests/test-runtime-controls.js` |
| 3D effect/geometry tests | `tests/test-three-viewer-led-glow.js`, `tests/test-three-viewer-preview-omissions.js` |
| Browser smoke pages | `tests/arena-studio-alt-browser-smoke.html`, `tests/arena-replay-viewer-browser-smoke.html` |

Useful design and safety references:

- [`arena-studio-unification-design.md`](arena-studio-unification-design.md)
- [`arena-studio-parity.md`](arena-studio-parity.md)
- [`safe-mode-spec.md`](safe-mode-spec.md)
- [`flow-control-counter-proposal.md`](flow-control-counter-proposal.md)
- [`three-viewer-led-glow.md`](three-viewer-led-glow.md)
- [`run-log-encoding-options.md`](run-log-encoding-options.md)

The Alt implementation history is concentrated in commits `62af67a` through
`40f5056`. Use the modules and tests above as the more durable source of truth.

## Delivery and acceptance

1. Introduce a new preview entry derived from `arena_studio.html`; do not replace
   Classic or delete Alt during design review.
2. Inventory every Classic control and every retained feature above, and map
   each to a shared handler or documented replacement.
3. Run `pixi run test` and keep the existing Alt/replay/runtime/3D tests passing.
4. Browser-smoke Run, Edit, and Console in both themes at narrow, standard, and
   large viewport widths. Exercise dropdowns, popovers, Protocol, Studio
   Settings, scope controls, repository preload, and replay.
5. Bench-smoke Classic and the candidate on the same 20-panel rig before any
   replacement decision. Larger-display bench coverage is tracked separately.
6. Present the candidate to the lab with Classic alongside it. Replace Classic
   only after explicit review; then update the parity ledger and retirement plan.
