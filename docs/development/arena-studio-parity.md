# Arena Studio ↔ standalone tools — parity ledger & retirement plan

**Policy (2026-07-02, agreed):** `arena_studio.html` is the **primary development
path**. The standalone twins it absorbed — `arena_console.html` and
`experiment_designer_v3.html` — are in **maintenance mode**: bug fixes and
safety fixes only, **no new features**. We do NOT attempt per-feature parity by
discipline (it fails silently); instead this ledger makes the delta explicit,
and the endgame is retiring the standalones behind redirects once the Studio
clears the gate below.

Fixes that land in shared `js/` modules (wire, session, runner, pattern-set,
bin-classifier, run-log, …) flow to every page automatically — prefer pushing
logic down there whenever a feature is touched (see CLAUDE.md → Arena Studio).

## Ledger — Studio features NOT in the standalones

Update this list when a Studio feature intentionally skips the twins.
(2026-07-02 baseline, Studio v0.2:)

| Studio feature | Standalone console | Standalone designer |
|---|---|---|
| SD-first pattern picker (picker follows the live SD listing; web library = thumbnails only) | ✗ (manifest-driven picker) | n/a |
| Auto pattern info (quiet 0x88 on pick/idx change; info row above params) | ✗ (button-driven card) | n/a |
| Connect-time init from controller (refresh/SPI/panel-mode/AO GETs) | ✗ | n/a |
| Firmware chooser modal (official ISP .bins: same-origin + published catalog, refreshed per open; G6PANFW footer validation) | ✗ (bare file picker) | n/a |
| Frame stepper wraparound at 0/max | ✗ (clamps) | n/a |
| Duty slider + synced 0–255 value box | ✗ (slider only) | n/a |
| Always-open page-filling raw+log group | ✗ (own layout) | n/a |
| Firmware error text «…» in send log | already had (run()) | n/a |
| dur(s) host-timed auto-stop | already had | n/a |
| Bidirectional YAML tab | n/a | ✗ |
| §6 canMutate() chokepoint (read-only Run/Console lock) | n/a | ✗ (importMode guards only) |
| Unified run path (Studio.runCondition; run-log.js recording; metadata panel) | ✗ | ✗ (own #runStatusLog) |

Backported to both (the safety class): display-quiesce before ISP/SD-write ops
(`e79007f`), batch show-on-arena blink pattern, `decodeRefreshRate`/`encodeGetRefreshRate`
exports (shared module — healed all pages at once).

## Retirement gate — "we're happy with the Studio" means ALL of:

1. **Bench parity checklist passes on hardware**: SD CRUD (upload/download/
   delete/purge/ZIP), single + batch ISP flash/verify (incl. show-on-arena
   blink + final map), stream-frame suite, FicTrac bridge + closed loop, and —
   the biggest still-untested surface — the **Run path end-to-end**: open
   protocol → Test experiment → STOP mid-sequence → gated Run experiment with
   metadata → run-log ⬇ Save (.json + .txt).
2. **At least one real recorded experiment** done through the Studio.
3. **Colleague sign-off** (circulate like the wireframes; #panels).
4. `?mode=console` honored in URL state (✅ done 2026-07-02) so redirect
   deep-links land correctly.
5. One soak cycle with both available (Studio promoted on index.html — done;
   standalones marked "legacy — features land in Studio").

## Retirement mechanics (when the gate passes)

- Replace `arena_console.html` with a ~10-line stub that forwards to
  `arena_studio.html?mode=console` (preserving query params) and says where it
  went; likewise `experiment_designer_v3.html` → `arena_studio.html?mode=edit`.
- Keep the stubs indefinitely (old Slack links, quickstarts, bookmarks).
- Same commit: update `index.html`, the quickstart pages, and CLAUDE.md
  (collapse the standalone-specific sections).
- Do NOT delete the files or invest in HTML diff/sync tooling in the interim —
  effort goes to shortening the overlap, not making it comfortable.

Related: GitHub [#107](https://github.com/reiserlab/webDisplayTools/issues/107)
(URL state; read side largely done, write side pending), design doc
`arena-studio-unification-design.md` §10 phase 5 / §12 Stage C (on the
`docs/arena-studio-wireframes` branch), memory note `arena-studio-unification`.
