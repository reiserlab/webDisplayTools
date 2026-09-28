# Linear cleanup — handover (2026-09-28)

**Purpose:** bring the Reiser Lab Linear workspace back in line with what has actually been built.
Work through the items **one at a time with Michael**: show the proposed change, apply it after an OK,
tick the box. Nothing below has been written to Linear yet.

**Why it's needed (audit 2026-09-27/28):**
- About 40 merged PRs in September (Arena Studio v0.70 → v0.91) have no Linear tickets.
- Every G6 project's target date and milestones are months in the past.
- Many tickets say Backlog for work that is running, or already built.
- Nothing tracks the release process or the web side of color.

## How to work in the new session

- **Use the Reiser Lab Linear server only.** Its tools are prefixed
  `mcp__8361ed24-4da0-4f58-b8a4-e9a2c8322971__` (`get_workspace` returns "Reiser Lab").
  The `mcp__linear__*` tools point at a **different, personal workspace** (mr-personal): never use them for this.
- Read-only tools are allow-listed in `~/.claude/settings.json`. **Writes** (`save_issue`, `save_comment`,
  `save_milestone`, `save_project`, `save_status_update`, `create_attachment`) prompt for each call. That is intended.
- For each item: re-read the ticket (`get_issue`) → show the diff → apply → tick the box.
  If reality moved since this doc was written, say so rather than applying stale text.
- Team **Lab**. Projects:
  - **Arena Software Control** (P-LAB-19)
  - **G6 Arena Hardware & Firmware** (P-LAB-1)
  - **G6 Arena Extensions** (P-LAB-5)
- Context docs:
  - `docs/development/release-process.md` (release tiers)
  - `~/.claude/plans/pasted-content-id-aeab-i-would-flickering-breeze.md` (the full plan and audit)

## Decisions already made (Michael, 2026-09-28)

| Ticket | Decision |
|---|---|
| LAB-18 red + IR checkerboard panels | Assign **Frank Loesche**; due **2026-10-26** |
| LAB-141 12/18 arena | Keep due **2026-10-01** |
| LAB-6 PSRAM demo check-in | Move to **Backlog** |
| LAB-139 40-panel load validation | **Keep** as is (still gates larger arenas) |

---

## 1. Status fixes on existing tickets

- [ ] **LAB-169** "closed-loop-plus-bias" command (Backlog, past due 09-18) → **Duplicate of LAB-185**.
  - Comment: Bias waveforms shipped via PR #175 (LAB-185, Done 2026-09-24) and the coupling rework #211 (Studio v0.85, bridge 3.3).
  - Isabel asked about the duplication on 08-25.
- [ ] **LAB-160** 0x8F purge semantics + refresh defaults (Backlog) → **In Review**, then **Done** once release `2026-09-28` ships.
  - Comment: 3 of the 5 stale spots were fixed in a12101b (opcode rename, tooltip, confirm text). The rest (the 30 s → 120 s shared `PURGE_MEMORY_TIMEOUT_MS`, and the Console refresh-rate tooltip now reading 400/1200 Hz) are in PR #228, part of Next candidate `2026-09-28` rc1 (release PR #229).
  - Attach #228.
- [ ] **LAB-212** self-healing web runner (Backlog) → **In Progress**.
  - Comment: Detection and fail-closed are shipped: #198 (v0.76, CONTROLLER_FAULT, post-mortem, soak driver), #206 (slow-host fix), #202 (SD-stall visibility), and the firmware watchdog self-reset path.
  - Remaining: recover()/resume-with-gap (web issues #200, #201).
  - PR #219's controller-settings block is the state that recover() must re-apply.
- [ ] **LAB-149** controller + panel diagnostics / event log (Backlog) → **In Progress**.
  - Comment: The telemetry ring is built (0xA8/0xA9) and passed a 28 h lossless soak. It identified the Mode-3 wedge mechanism.
  - Firmware is in fw PR #56 (Frank reviewing); the host drainer is in web #198.
  - fw #54 (telemetry hardening) is the gate before course controllers.
- [ ] **LAB-150** firmware versioning + capability discovery (Backlog, Frank) → **In Progress**.
  - Comment: GET_FIRMWARE_VERSION 0xCB with its flag bits is live and used as the gate for telemetry and the SD info commands.
  - Remaining: the Studio disabling unsupported commands; reporting the resident pattern set (from LAB-100); and the panel **color layout** that the color epic needs.
- [ ] **LAB-141** design the primary 12/18 G6 arena (Backlog, High, due 10-01) → **In Progress** (the 10-01 due date stays).
  - Comment: arena_12-18 v1.0 hardware is on the bench (used in the 09-15 light-sensor tests). Remaining: the three builds (Jin Yang, Hannah Marie, FlyMAX).
  - Note: Studio support for >20 panels is LAB-159.
- [ ] **LAB-146** controller-board improvements incl. STEMMA QT (Backlog, no assignee) → **In Progress**.
  - Comment: STEMMA QT shipped on 12/18 v1.0. Remaining decisions: a second analog output and the analog-input count, for the next board revision.
- [ ] **LAB-86** validate + calibrate G6 analog input (Backlog, no assignee) → **In Progress**, marked **blocked by LAB-209**.
  - Comment: The substance is in fw PRs #46/#47 (F1/F2) and web PR #191 (calibration UI). It is physically blocked by the swapped stage-2 divider resistors, which only read −10…0 V.
  - Attach #191 and fw #46/#47.
- [ ] **LAB-18** red + IR checkerboard panels (In Progress, due 08-21, no assignee) → assign **Frank**, due **2026-10-26**.
  - Comment: The v0.4r2 board is in LED-Display_G6_Hardware_Panel PR #1 (red on T0/T3 at 630 nm, IR on T1/T2 at 850 nm, 0402 column resistors 47/100 Ω, ≈0.72 A per panel at full field).
  - The release-gate checks (400-pixel map, red < 610 nm, IR resistor steps, behavioral no-detection) are still unrecorded.
  - Panel firmware PR #30 has the color-channel bench commands.
- [ ] **LAB-6** PSRAM demonstration check-in (In Progress, untouched 76 days) → **Backlog**.
  - Comment: parked; related to fw issue #40 (PSRAM duty byte).
- [ ] **LAB-158** Claude-derived Studio revision (Backlog) → stays Backlog, add a comment.
  - Comment: Most of the "retain from Alt" features are now in Classic (#210 runtime vars, #220–#224 replay + 3D).
  - Remaining: the side-by-side visual candidate and light mode. It is the natural candidate for the Next tier (validate beside Production before replacing it).
- [ ] **LAB-139** 40-panel load validation — **no change** (decision above).

## 2. Project hygiene

- [ ] **Arena Software Control**:
  - Add a milestone, **"Studio v0.9x — release tiers + backlog"** (target 2026-10-31).
  - Put the new tiers ticket and LAB-212/160/159/158 in it.
  - Retarget the project date from 2026-06-27 to 2026-12-19.
  - Post a **status update** (draft below).
- [ ] **G6 Arena Hardware & Firmware**:
  - Post its **first-ever status update** (draft below).
  - Consider retargeting the project date (06-05) and the four expired milestones. Close or archive the done ones.
- [ ] **G6 Arena Extensions**: make it the home of the color epic (item 3b).

**Status update draft — Arena Software Control (onTrack):**
> **September recap:** Studio went from v0.70 to v0.91 in about 40 PRs:
> - run logs → `behavior_v2` (.jsonl.gz);
> - analog-in console panel;
> - controller-fault detection and post-mortem (fw #50 wedge);
> - slow-host and SD-stall fixes;
> - runtime variables with the `requires:` gate;
> - closed-loop bias, then coupling (bridge 3.3) and graded LED zones;
> - run-log replay + 3D with a walking fly;
> - closed-loop trials opening at `frame_index` (#225, which fixed the rig7 P3 protocols).
>
> **New release process (2026-09-28):** Production at the root URLs; a **Next** testing tier at `/next/` serving one frozen release candidate; versions bumped at release (`pixi run candidate` / `pixi run release`); main protected (PR + CI). The first candidate, `2026-09-28` rc1 (tier badge + provenance, LAB-160), is on Next awaiting bench validation.
>
> **Next up:** candidate 2 (#219 controller settings + #178 data-repo registry), LAB-159 (larger displays, for the 12/18 arena), the Pattern Designer revival, then color.

**Status update draft — G6 Arena Hardware & Firmware (atRisk: dates are stale):**
> - Mode-3 reliability is converging. The wedge mechanism was found via the telemetry ring, and the SD fast path plus the watchdog are in fw #56 (Frank reviewing).
> - 12/18 arena v1.0 is on the bench.
> - Analog-in is blocked on the LAB-209 divider rework.
> - Color: red+IR v0.4r2 board in review (HW PR #1); the four-color board is being bench-tested (panel fw #30).
> - Dates and milestones below are from June and need a re-plan.

## 3. New tickets

- [ ] **a. Two-tier web releases (Production + Next)**
  - Arena Software Control · In Progress · Michael. Attach #226, #227, #228, #229.
  - Description: the model (one frozen candidate), the rules, `docs/development/release-process.md`.
  - Done when the first release ships and one hotfix/rollback drill has been exercised.
- [ ] **b. Multi-color G6 panels — web support (epic)**
  - G6 Arena Extensions · Backlog. **Sub-issues: LAB-18, LAB-213** (plus c).
  - Description:
    - The panel is a four-color 2×2 mosaic, `ch = 2*(row%2)+(col%2)`, banks T0–T3. There is no firmware fork and no frame-format change.
    - Web scope, in order:
      1. `js/panel-color.js`, the layout model (declared via LAB-156, discovered via LAB-150)
      2. ThreeViewer / 2D per-bank color
      3. Pattern Designer color authoring at the reduced per-color grid
      4. LAB-213 per-color calibration LUT (AS7343 via 0xB1, fw #58), applied at generation time
      5. Console per-channel tests plus protocol color metadata
      6. MATLAB + `g6_04` parity
    - Dependencies: panel fw #30, fw #58, HW PR #1, LAB-150, LAB-139/141/159.
    - Development goes on a `batch/color` branch through the Next tier.
- [ ] **c. Build the fly-vision four-color panels (violet / blue / green / orange)**
  - G6 Arena Hardware & Firmware · Backlog.
  - Description: resistor banks 910/442/442/301 Ω (T0–T3). Today this exists only in a 07-15 comment on LAB-18. Bench commands are in panel fw PR #30. Calibration priority is 615–625, 420, 475, 525 nm.
- [ ] **d. Write up the LAB-119 multicolor (UV) LED research findings**
  - G6 Arena Extensions · Todo. LAB-119 is Done but has an empty description and no comments, so its findings aren't recorded anywhere.
- [ ] **e. Mode-3 wedge — firmware root cause + fix (fw #50)**
  - G6 Arena Hardware & Firmware · In Progress · Frank. Attach fw #56 and issues #50, #51, #52, #54.
  - Links: LAB-149 (ring), LAB-212 (web recovery).
- [ ] **f. Flashing tooling: cross-platform port detection + Windows notes**
  - G6 Arena Hardware & Firmware · In Review. Attach fw PRs #57, #49.
- [ ] **g. Data-repo registry / lab repo picker (web PR #178)**
  - Arena Software Control · Backlog. Contents: the lab repo picker, the "Bench id" → "Rig id" rename, and no default repo. It is course-facing, so announce it. Planned for candidate 2.
  - Relates to LAB-147.

## 4. GitHub ↔ Linear links (attachments)

- [ ] #228 → LAB-160
- [ ] #219 (controller-settings block) → LAB-156, LAB-212, LAB-150
- [ ] #191 (analog-in calibration UI) → LAB-86, LAB-209
- [ ] #226, #227, #229 → new ticket 3a
- [ ] fw #58 (Qwiic I2C) → LAB-213, LAB-214, LAB-146

## 5. Going forward (so this doesn't drift again)

- Each release PR from `pixi run candidate` lists its PRs. The `release` step prints the LAB tickets those PRs mention and **proposes** transitions; a human approves them, and nothing moves to Done automatically.
- New web work gets a ticket (or a line in the milestone) when its PR is opened. PR bodies mention `LAB-…` so the release step can find them.

## Out of scope for this session

The CSHL 2027, fly-on-ball validation, next-gen fly ball, and T4/T5 imaging projects were surveyed but need no cleanup for the web tools. Their G6-dependent tickets (LAB-192, LAB-22, LAB-27, LAB-175, LAB-215, LAB-177) are current.
