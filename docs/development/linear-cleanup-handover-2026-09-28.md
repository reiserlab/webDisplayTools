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

- [x] **LAB-169** "closed-loop-plus-bias" command (Backlog, past due 09-18) → **Duplicate of LAB-185**. *(Applied 2026-09-29; the comment was posted as a reply in Isabel's thread.)*
  - Comment: Bias waveforms shipped via PR #175 (LAB-185, Done 2026-09-24) and the coupling rework #211 (Studio v0.85, bridge 3.3).
  - Isabel asked about the duplication on 08-25.
- [x] **LAB-160** 0x8F purge semantics + refresh defaults (Backlog) → **In Review**, then **Done** once release `2026-09-28` ships. *(Applied 2026-09-29, straight to **Done**: release `2026-09-28` shipped 09-28 via #229. All five stale spots were re-verified on `main`; #228 attached.)*
  - Comment: 3 of the 5 stale spots were fixed in a12101b (opcode rename, tooltip, confirm text). The rest (the 30 s → 120 s shared `PURGE_MEMORY_TIMEOUT_MS`, and the Console refresh-rate tooltip now reading 400/1200 Hz) are in PR #228, part of Next candidate `2026-09-28` rc1 (release PR #229).
  - Attach #228.
- [x] **LAB-212** self-healing web runner (Backlog) → **In Progress**. *(Applied 2026-09-29, with the scope narrowed instead of the comment below. Renamed "Controller-fault recovery through flow control (trial_check: device reset → retry → abort)". The description was rewritten with Done / Remaining / Dropped sections: root cause fixed in fw #56, watchdog self-reset shipped, resume-with-gap / max_recoveries / recovered status dropped. It is now blocked by the new flow-control ticket LAB-218 (item 3h).)*
  - Comment: Detection and fail-closed are shipped: #198 (v0.76, CONTROLLER_FAULT, post-mortem, soak driver), #206 (slow-host fix), #202 (SD-stall visibility), and the firmware watchdog self-reset path.
  - Remaining: recover()/resume-with-gap (web issues #200, #201).
  - PR #219's controller-settings block is the state that recover() must re-apply.
- [x] **LAB-149** controller + panel diagnostics / event log (Backlog) → **In Progress**. *(Applied 2026-09-29, with an updated comment: fw #56 had MERGED 09-27 (the doc said Frank was reviewing it), fw #62 was added, and the remaining work is the panel inventory, fw #59 + web #233.)*
  - Comment: The telemetry ring is built (0xA8/0xA9) and passed a 28 h lossless soak. It identified the Mode-3 wedge mechanism.
  - Firmware is in fw PR #56 (Frank reviewing); the host drainer is in web #198.
  - fw #54 (telemetry hardening) is the gate before course controllers.
- [x] **LAB-150** firmware versioning + capability discovery (Backlog, Frank) → **In Progress**. *(Applied 2026-09-29 as a **split**: LAB-150 keeps the firmware work (Frank: panel identity via fw #59, the capability registry). The Studio half became **LAB-220** (V1.0, Michael: one capability-gating rule + a compatibility note + web #233). The panel color layout became **LAB-221** (Frank, an open question: programmed flag vs hardware ID vs host-declared; no per-color firmware). Resident pattern identity moved to LAB-147.)*
  - Comment: GET_FIRMWARE_VERSION 0xCB with its flag bits is live and used as the gate for telemetry and the SD info commands.
  - Remaining: the Studio disabling unsupported commands; reporting the resident pattern set (from LAB-100); and the panel **color layout** that the color epic needs.
- [x] **LAB-141** design the primary 12/18 G6 arena (Backlog, High, due 10-01) → **In Progress** (the 10-01 due date stays). *(2026-09-29: this decision was superseded, and the ticket was closed as **Done**. The 12/18 v1.0 was built, but the lab chose the smaller 10-14 (LAB-219) as the primary design. LAB-219 took over the three builds (Jin Yang ephys (it may need a corner cutout or a special top), Hannah 2P, FlyMAX). LAB-27 (already Done on 09-28) keeps its historical LAB-141 link.)*
  - Comment: arena_12-18 v1.0 hardware is on the bench (used in the 09-15 light-sensor tests). Remaining: the three builds (Jin Yang, Hannah Marie, FlyMAX).
  - Note: Studio support for >20 panels is LAB-159.
- [x] **LAB-146** controller-board improvements incl. STEMMA QT (Backlog, no assignee) → **In Progress**. *(Applied differently 2026-09-29: assigned **Michael**, **rescoped** to "Update the 10-10 arena controller design with the fixes proven on the 10-14 board", stays Backlog, **blocked by LAB-219**. The fixes to carry back include the LAB-209 divider, Will Dickson's power-supply changes, and a possible analog-in ground island. LAB-219 gained the matching controller-board checklist.)*
  - Comment: STEMMA QT shipped on 12/18 v1.0. Remaining decisions: a second analog output and the analog-input count, for the next board revision.
- [x] **LAB-86** validate + calibrate G6 analog input (Backlog, no assignee) → **In Progress**, marked **blocked by LAB-209**. *(Applied 2026-09-29: assigned **Michael**, In Progress, related to (not blocked by) LAB-209, because many arenas have been reworked. Attached #191 and fw #46/#47. LAB-87 (Mode 4) was also → **In Review**, since it is on fw main and fw #46 fixes the gain. LAB-209 got a comment: the design fix goes into 10-14 / 10-10 (LAB-146) / 12-18.)*
  - Comment: The substance is in fw PRs #46/#47 (F1/F2) and web PR #191 (calibration UI). It is physically blocked by the swapped stage-2 divider resistors, which only read −10…0 V.
  - Attach #191 and fw #46/#47.
- [x] **LAB-18** red + IR checkerboard panels (In Progress, due 08-21, no assignee) → assign **Frank**, due **2026-10-26**. *(Applied 2026-09-29. A status block was prepended to the description instead of a long comment: v0.4r1 exists (it has vertical stripes, and its IR resistors run at 198 % of rating); v0.4r2 is in review in HW Panel PR #1 (47/100 Ω 0402), which supersedes the 301 Ω / IR-stepping plan. PR #1 is attached.)*
  - Comment: The v0.4r2 board is in LED-Display_G6_Hardware_Panel PR #1 (red on T0/T3 at 630 nm, IR on T1/T2 at 850 nm, 0402 column resistors 47/100 Ω, ≈0.72 A per panel at full field).
  - The release-gate checks (400-pixel map, red < 610 nm, IR resistor steps, behavioral no-detection) are still unrecorded.
  - Panel firmware PR #30 has the color-channel bench commands.
- [x] **LAB-6** PSRAM demonstration check-in (In Progress, untouched 76 days) → **Backlog**. *(2026-09-29: this decision was stale. PSRAM V2 display is production firmware (panel fw #15, arena fw #12/#36), so LAB-6 was closed as **Done** instead. Full panel local storage and panel telemetry go to a new standalone project, starting January 2027 or later.)*
  - Comment: parked; related to fw issue #40 (PSRAM duty byte).
- [x] **LAB-158** Claude-derived Studio revision (Backlog) → stays Backlog, add a comment. *(2026-09-29: first changed to "close ASAP" and delegated to the parallel audit session. That session built a ports candidate (Protocol ▾ + ⚙ Settings menus, Console Tools checklist + two columns, 1500 px Run view, labelled Scope controls, replay re-pin), which is uncommitted. Final decision: **In Progress**, assigned **Michael**. The candidate is staged via Next after the queued candidates (#219/#178/#233); Alt retirement is a separate PR; **light mode is kept as a later step**. Close after release. The audit session was told not to close the ticket and to attach its ports PR.)*
  - Comment: Most of the "retain from Alt" features are now in Classic (#210 runtime vars, #220–#224 replay + 3D).
  - Remaining: the side-by-side visual candidate and light mode. It is the natural candidate for the Next tier (validate beside Production before replacing it).
- [x] **LAB-151** bridge closed loop with independent gain + extensible offsets (G6 Arena Extensions, Backlog) → **Done**. *(Added and applied 2026-09-29; it wasn't in the original audit. Delivered by #211 coupling, #175 bias, #223/#225 frame_index start, and `idx` / `cf` / `config` / `bias_config` / `heading_tare` in the run log.)*
- [x] **LAB-156** composable display / accessory / physical-rig configuration (Backlog) → stays Backlog, **scope narrowed**. *(Added and applied 2026-09-29. Renamed "Rig config declares its accessories (LED driver, FicTrac, STEMMA QT); gate controls and protocol requires: on them". The three-layer registry was dropped, since there are only 5 rig files. Related to LAB-213 and LAB-214.)*
- [x] **LAB-147** pattern storage / caching / provenance (Backlog) → stays Backlog, **scope narrowed**. *(Added and applied 2026-09-29. Renamed "Record the exact pattern content in every run log (pattern provenance)". Goal: provenance by identity, not by copies into the repo. The cache/RAM/panel architecture was dropped. Related to LAB-150.)*
- [x] **LAB-148** YAML analysis context (Backlog) → stays Backlog, priority **Medium → Low**, comment posted. *(Added and applied 2026-09-29. The dashboard infers the protocol family from filename substrings and condition-name regexes; the question stays open until the dashboard has to support non-course protocols.)*
- [x] **LAB-159** larger G6 displays (Backlog, High) → assigned **Michael**; supported geometries fixed at **1–4 rows × 10 and × 12 columns** (the 12/18 arena, ≤ 48 panels). 3×16 dropped; scope and acceptance edited. *(Applied 2026-09-29.)*
- [x] **LAB-155** G4.1 compatibility (Backlog) → priority **Medium → Low**, comment: "may not happen, G6 has clear advantages". *(Applied 2026-09-29.)*
- [x] **LAB-217** post-run metadata correction (Backlog) → assigned **Michael**. *(Applied 2026-09-29.)*
- [x] **LAB-106** panel V1 test suite (Backlog) → **Canceled**: the bench tools have been adequate, and panel telemetry (P-LAB-28) would improve on them. *(Added and applied 2026-09-29.)*
- [x] **LAB-213** LED intensity/color calibration → moved to **Web-based V1.0**: the hardware is validated and Isabel's holder exists; the remaining work is the Studio tool. *(Added and applied 2026-09-29.)*
- [x] **LAB-214** Qwiic peripherals → **In Progress**: parts are ordered; light, temperature/humidity, tilt and maybe servos are in the plan. *(Added and applied 2026-09-29.)*
- [x] **New project P-LAB-28 "G6 Panel Local Storage + Telemetry"**: Backlog, start January 2027. It covers full PSRAM local storage and host↔panel round-trip telemetry with error logging. *(Created 2026-09-29.)*
- [x] **LAB-86 / LAB-87 / LAB-146** → assigned **Michael** (2026-09-29, at his request). Status decisions follow below.
- [x] **LAB-139** 40-panel load validation — **no change** (decision above). *(2026-09-29: status unchanged. Added a comment documenting the exception, as the gate's rule asks: the 12/18 (36 panels) and the 10-14 (30 panels) are under 40, and the ticket still gates 4×10 / 4×12.)*

## 2. Project hygiene

- [ ] **Arena Software Control** *(renamed by Michael 2026-09-29 to "Arena Software Control - towards Web-based V1.0". Applied 2026-09-29: the summary and description were rewritten around a V1.0 end state with "done when" criteria, and the **target date moved 2026-06-27 → 2026-12-19**. The milestone and status update are deferred until the survey is done.)*:
  - Add a milestone, **"Studio v0.9x — release tiers + backlog"** (target 2026-10-31).
  - Put the new tiers ticket and LAB-212/160/159/158 in it.
  - Retarget the project date from 2026-06-27 to 2026-12-19.
  - Post a **status update** (draft below).
- [ ] **G6 Arena Hardware & Firmware**:
  - Post its **first-ever status update** (draft below).
  - Consider retargeting the project date (06-05) and the four expired milestones. Close or archive the done ones.
- [x] **G6 Arena Extensions**: make it the home of the color epic (item 3b). *(2026-09-29: the project was **retired** instead, as Canceled. LAB-84 (flat arena, wanted, Backlog) and the red + IR design doc moved to G6 HW & FW. LAB-140 (cylindrical color arena) was **Canceled**, because the 12/18 arena has higher resolution. The color epic now goes in **Web-based V1.0**, and the V1.0 "done when" list gained a "Multi-color panels" line. The HW & FW boundary text was updated.)*

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

- [x] **Status updates posted (2026-09-29):** Web-based V1.0 (On track) and the **first-ever** G6 HW & FW update (On track). The HW & FW target date moved **2026-06-05 → 2026-12-19**. Milestones are still to set (round C).
- [x] **Spelling convention (2026-09-29):** American English, "color" not "colour". Every "colour" in Linear was fixed (titles, descriptions, comments, attachment titles, the status update). A "Conventions" line was added to the V1.0, HW & FW and Panel Storage project descriptions, and to `~/.claude/CLAUDE.md` and the `g6-orientation` skill.
- [x] **Linear-sync rule (2026-09-29):** added to the user-level `~/.claude/CLAUDE.md`, plus a user-level PreToolUse hook (`~/.claude/hooks/linear_sync_reminder.py`) that fires on `gh pr create|merge` and `pixi run candidate|release`. The Linear GitHub integration for `reiserlab` is to be connected by Michael.

## 3. New tickets

- [x] **a. Two-tier web releases (Production + Next)** → **LAB-222** (V1.0 · In Progress · Michael; #226/#227/#228/#229 attached; first release shipped 09-28, done after a hotfix/rollback drill)
  - Arena Software Control · In Progress · Michael. Attach #226, #227, #228, #229.
  - Description: the model (one frozen candidate), the rules, `docs/development/release-process.md`.
  - Done when the first release ships and one hotfix/rollback drill has been exercised.
- [x] **b. Multi-color G6 panels — web support (epic)** → **LAB-223** (V1.0 · Backlog · Michael). Sub-issues **attached 2026-09-29** after Michael's review: LAB-18, LAB-224, LAB-213, LAB-221. The HW Panel repo and decisions doc are linked.
  - ~~G6 Arena Extensions~~ **Web-based V1.0** (decided 2026-09-29) · Backlog. **Sub-issues: LAB-18, LAB-213** (plus c).
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
- [x] **c. Build the fly-vision four-color panels (violet / blue / green / orange)** → **LAB-224** (HW & FW · In Progress · Frank). **Corrected from the HW Panel decisions doc:** yellow-orange, not orange; Yongyu 0402 LEDs, 68 Ω ×3 + 110 Ω, not 910/442/442/301 Ω. 15 panels are built and in bench test.
  - G6 Arena Hardware & Firmware · Backlog.
  - Description: resistor banks 910/442/442/301 Ω (T0–T3). Today this exists only in a 07-15 comment on LAB-18. Bench commands are in panel fw PR #30. Calibration priority is 615–625, 420, 475, 525 nm.
- [x] **d. Write up the LAB-119 multicolor (UV) LED research findings** *(2026-09-29: no new ticket. The findings are already in `LED-Display_G6_Hardware_Panel/docs/Four-color and Red+IR panel decisions.md`, which is now attached to LAB-119 with a comment. LAB-18 and LAB-224 gained "As ordered" sections confirmed from the BOMs; the IR LED is Inolux IN-S42CTQIR, not the OSRAM SFH 4053B.)*
  - ~~G6 Arena Extensions~~ **G6 Arena Hardware & Firmware** (the Extensions project was retired 2026-09-29) · Todo. LAB-119 is Done but has an empty description and no comments, so its findings aren't recorded anywhere.
- [x] **e. Mode-3 wedge — firmware root cause + fix (fw #50)** → **LAB-225**, created as **Done** (the fix is in fw #56); Michael (the #56 author); fw #50/#51/#52/#54 attached.
  - G6 Arena Hardware & Firmware · In Progress · Frank. Attach fw #56 and issues #50, #51, #52, #54.
  - Links: LAB-149 (ring), LAB-212 (web recovery).
- [x] **f. Flashing tooling: cross-platform port detection + Windows notes** → **LAB-226**, created as **Done** (fw #57 merged 09-28, #49 closed); Frank.
  - G6 Arena Hardware & Firmware · In Review. Attach fw PRs #57, #49.
- [x] **g. Data-repo registry / lab repo picker (web PR #178)** → **LAB-227** (V1.0 · In Review · Michael; #178 attached; related LAB-147).
  - Arena Software Control · Backlog. Contents: the lab repo picker, the "Bench id" → "Rig id" rename, and no default repo. It is course-facing, so announce it. Planned for candidate 2.
  - Relates to LAB-147.

- [x] **h. Flow control Stage 1 in the web runner (`trial_check` + `repeat_until`)** *(added 2026-09-29; it wasn't in the audit)*
  - Created as **LAB-218**: Arena Software Control · Todo · Michael. Blocks LAB-212. Links the design PRs #171 and #173.

- [x] **i. Design and build the 10-14 partial G6 arena (3 rows, 10 of 14 columns)** *(added 2026-09-29; it wasn't in the audit)*
  - Created as **LAB-219**: G6 Arena Hardware & Firmware · In Progress · **Frank** · High. Built from the 2026-09-11 → 09-28 group DM (Michael, Frank, Isabel, Hannah): the 10-14 geometry (R 99.5 mm, 257°, 1.29°/px, 68.8° vertical, 30 panels), C2 layout, vertical BNCs + strain-relief holes, and Qwiic + JST PH 5 V on the long back side. Related to LAB-141, 146, 159, 139 and 203; Fly-Lab-Gear #50 attached.
  - LAB-159 gained the **10-14 partial-arena mapping** next to the 12/18 (2026-09-29).
  - ⚠ **LAB-141** (the "primary 12/18" arena) is now out of date: the 2P setup moves to the 10-14. Revise it when we reach it.

## 4. GitHub ↔ Linear links (attachments)

- [x] #228 → LAB-160 *(attached 2026-09-29 with the LAB-160 close)*
- [ ] #219 (controller-settings block) → LAB-156, LAB-212, LAB-150
- [x] #191 (analog-in calibration UI) → LAB-86, LAB-209 *(attached to LAB-86 with fw #46/#47, 2026-09-29; LAB-209 is linked via relations instead)*
- [x] #226, #227, #229 → new ticket 3a *(attached on creation of LAB-222, plus #228)*
- [ ] fw #58 (Qwiic I2C) → LAB-213, LAB-214, LAB-146

## 5. Going forward (so this doesn't drift again)

- Each release PR from `pixi run candidate` lists its PRs. The `release` step prints the LAB tickets those PRs mention and **proposes** transitions; a human approves them, and nothing moves to Done automatically.
- New web work gets a ticket (or a line in the milestone) when its PR is opened. PR bodies mention `LAB-…` so the release step can find them.

## Out of scope for this session

The CSHL 2027, fly-on-ball validation, next-gen fly ball, and T4/T5 imaging projects were surveyed but need no cleanup for the web tools. Their G6-dependent tickets (LAB-192, LAB-22, LAB-27, LAB-175, LAB-215, LAB-177) are current.
