---
name: g6-orientation
description: Orientation map for the Reiser Lab G6 (and G4) modular LED arena project — which repo holds what (web tools, MATLAB/Python, firmware, hardware, course data), the cross-repo conventions (arena geometry, panel numbering + rotation direction, pattern naming + colocation, protocol↔pattern link, versioning, pixi dev env), how the web tools connect to the arena hardware (Web Serial + wire protocol + FicTrac bridge), and pointers to the authoritative deep docs. Use when getting oriented, deciding which repo a change belongs in, locating firmware/hardware/MATLAB code, onboarding a colleague, or answering "where is X", "how does the web talk to the arena", "what's the panel-numbering convention", "how are patterns linked to protocols".
---

# G6 project — orientation & repo map

A **map, not a manual.** It says which repo owns what and points to the authoritative
source for each topic — it does not duplicate them. For web-tool depth read
`webDisplayTools/CLAUDE.md` (auto-loaded when working in that repo); for protocol authoring
use the **`protocol-yaml`** skill.

Modular LED **arena displays** for *Drosophila* vision. Current generation = **G6**; G4/G4.1
still supported (maDisplayTools spans both); G5 deprecated; G2/G3 legacy.

## 📖 Primary G6 documentation — start here

The authoritative G6 system reference lives in the **umbrella repo**
(`reiserlab/Modular-LED-Display`). It is more current than any single tool's `CLAUDE.md` and
supersedes the older maDisplayTools roadmap — **read it first** for anything touching the
panel/controller wire protocols, LED mapping, the `.pat` file format, or the arena↔firmware
interface.

- **In-progress full protocol docs — the source of truth for every G6 subsystem** →
  **https://github.com/reiserlab/Modular-LED-Display/tree/main/docs/development**
  `g6_00-architecture` · `g6_01-panel-protocol` · `g6_02-led-mapping` · `g6_03-controller` ·
  `g6_04-pattern-file-format` · `g6_05-host-software` · `g6_06-arena-firmware-interface`
  (+ `g6_arena_configs.h`, `g6_docs-open-issues`).
- **Rendered docs site** (published subset, MkDocs) →
  **https://reiserlab.github.io/Modular-LED-Display/**

## The repos

### Web + experiment control (the hub)
| repo | role |
|---|---|
| **reiserlab/webDisplayTools** | The web tools — **Arena Studio** (`arena_studio.html`: Run/Edit/Console), **Pattern Designer** (`pattern_editor.html`), 3D viewer, flasher, serial console. Standalone HTML, no build, pixi dev env. Deep reference = its `CLAUDE.md`. *(this repo)* |
| **reiserlab/cshl-2026-course** | Shared **bench data** written directly by Arena Studio / Pattern Designer: `protocols/<bench-id>/`, `patterns/` (shared library), `runlogs/<bench-id>/`, `roster.yaml`, `genotypes.yaml`. bench-id namespaced. |

### Reference tool suites (other language bindings)
| repo | role |
|---|---|
| **reiserlab/maDisplayTools** | **MATLAB** tools (G4+). The reference executor — **web output must match MATLAB exactly** (CI validates, tol 1e-4). (Its `docs/development/G4G6_ROADMAP.md` is largely historical now — use the umbrella docs for current G6.) |
| **reiserlab/LED-Display_pyDisplayTools** (pyDisplayTools) | **Python** tools for the displays. |

### G6 firmware (what the web connects to over USB)
| repo | role |
|---|---|
| **reiserlab/LED-Display_G6_Firmware_Arena** | Teensy-based G6 **arena controller** firmware — the Web-Serial peer. Owns TRIAL_PARAMS, SD card, ISP panel-flash, `GET_CONTROLLER_INFO` (0xC2 incl. MAC / 0xE3), panel display-mode, DIO/AO. |
| **reiserlab/LED-Display_G6_Firmware_Panel** | G6 **panel** firmware (the 20×20 panels). Row-major `panel_index`; frame path. Branch `panel-isp` = production+ISP. |
| **iorodeo/g6_firmware_devel** | IO Rodeo (vendor) G6 firmware development / upstream. |
| **mbreiser/G6_Panels_Test_Firmware** | Panel test firmware. |

### G6 hardware (KiCad design + production files)
| repo | role |
|---|---|
| **reiserlab/LED-Display_G6_Hardware_Arena** | Arena controller board. |
| **reiserlab/LED-Display_G6_Hardware_Panel** | Panel board. |
| **reiserlab/LED-Display_G6_Hardware_Test_Arena** | Panel test-arena. |

### Neighbors
| repo | role |
|---|---|
| **mbreiser/bias** | BIAS camera control — the `camera` / BiasPlugin target in protocols. |
| **reiserlab/Modular-LED-Display** | Umbrella: aggregates the display repos as submodules and **hosts the primary G6 documentation** — the full per-subsystem protocol docs in [`docs/development/`](https://github.com/reiserlab/Modular-LED-Display/tree/main/docs/development) + the rendered site https://reiserlab.github.io/Modular-LED-Display/. **The most important reference for G6** (see the top of this skill). |
| **reiserlab/Fly-Lab-Gear** | Lab tools/methods sharing (formerly Component-Designs). |

## Essential conventions (one-liners → depth in webDisplayTools/CLAUDE.md)

- **Generations & geometry** — G6: 45.4 mm panels, 20×20 px, SMD LEDs rotated 45°. G4.1
  40 mm/16×16; G4 40.45 mm/16×16 (circle LEDs); G3 32 mm/8×8. Arena radius
  `cRadius = panelWidth / tan(α/2) / 2`, α = 2π/numPanels. *(CLAUDE.md "Panel Specifications")*
- **Panel numbering & rotation (bench-confirmed 2026-07-05)** — G6 firmware is **row-major**:
  `panel_index = row*numCols + col`, **row 0 = bottom**. The arena's own panel map reads
  **1–10 along the bottom row, 11–20 across the top**, wrapping **CW**. The fresh
  Designer→SD→arena pipeline is direction-correct (CW in = CW out); **legacy `.pat` files may
  have reversed baked-in motion — check a pattern's provenance before chasing a "direction bug."**
- **Patterns** — reference = **filename minus `.pat`** (an `NNN_` SD index prefix is tolerated).
  Same name ⇒ assumed same bytes — never reuse a name for different content; bump `_v2`.
  **Colocation is the protocol↔set link**: `protocols/<bench>/<name>_patterns/` next to
  `<name>.yaml`; reusable patterns live in the repo-level `patterns/` library.
- **Protocols** — v3 YAML → the **`protocol-yaml`** skill (waits rule, trial modes, I/O, FicTrac).
- **Versioning** — two-digit `vX` (no semver); footer `Tool vX | YYYY-MM-DD HH:MM ET`; get ET
  via `TZ='America/New_York' date "+%Y-%m-%d %H:%M ET"` (never guess a timestamp).
- **Design system** — dark theme (`--bg #0f1419`, surface `#1a1f26`, border `#2d3640`, accent
  `#00e676`); JetBrains Mono headings, IBM Plex Mono body.
- **Dev env = pixi only** — `pixi install` provisions Node + Prettier + Python + websockets
  (conda-forge). **No npm / package.json / node_modules.** `pixi run test | format | bridge | sim`.
- **Two gotchas** — Prettier is scoped to `**/*.js`; **never run it on the HTML tools** (it
  reflows the whole file). And an **ES-module import failure is catastrophic** — the entire
  `<script type="module">` block dies (empty dropdowns / dead page), classically from a cached
  stale module missing a newly-added export.

## How the web connects to the arena

- **Transport** — **Web Serial** (Chromium ↔ G6 controller over USB). One `ArenaLink` + one
  `ArenaRunner` per page via the **`ArenaSession.shared()`** broker (`js/arena-session.js`);
  Connect/STOP live in the classic `<script src>` layer so they survive an ES-module failure.
- **Wire protocol** — byte encoders/decoders in **`js/arena-wire-g6.js`**. Command families:
  `trialParams` (modes **2** constant-rate / **3** host-stepped·FicTrac / **4** analog),
  display (`allOn`/`allOff`/`stopDisplay`), SD (listing/read/write), ISP (panel flash),
  `GET_CONTROLLER_INFO` (0xC2/0xE3), panel display-mode (0x1B/0x1C), pattern info (0x88),
  `setDigitalOut`/`setAnalogOut` (board silkscreen numbering, **1-based**).
- **Quiesce rule** — firmware refuses SD-write + ISP unless the **display is stopped**
  (`CE_DISPLAY_ACTIVE`); STOP also blanks the panels (they latch the last frame).
- **"Web is the runner"** (CSHL) — the browser **executes** the protocol, host-timed:
  `js/arena-runner-g6.js`.
- **FicTrac closed loop** — `fictrac_sim.py` (or real FicTrac) → **`fictrac-bridge/bridge.py`**
  (WebSocket `ws://localhost:8765` ← UDP `:60000`) → browser. `pixi run bridge` + `pixi run
  sim` (start the bridge first). The web runner executes only the `fictrac` and `log` plugins;
  `backlight`/`camera`/`temperature` are declared for MATLAB and **skipped on the web**.

## Pointers (go here for depth)

- **Primary G6 documentation** (see the top of this skill) → `docs/development/` in `reiserlab/Modular-LED-Display` (the full per-subsystem protocol docs) + the rendered site https://reiserlab.github.io/Modular-LED-Display/.
- **Web architecture / conventions / gotchas** → `webDisplayTools/CLAUDE.md` (auto-loaded here).
- **Protocol + pattern authoring** → `.claude/skills/protocol-yaml/SKILL.md` (+ its validator).
- **End-to-end workflow** (blank screen → recorded run) → `docs/protocol-pattern-workflow.md`.
- **Arena Studio internals** → `docs/development/arena-studio-handover.md`, `arena-studio-release-notes.md`.
- **Firmware / hardware** → the `LED-Display_G6_*` repos above; vendor dev `iorodeo/g6_firmware_devel`.
- **MATLAB roadmap** (largely historical — kept for context) → `maDisplayTools/docs/development/G4G6_ROADMAP.md`.
