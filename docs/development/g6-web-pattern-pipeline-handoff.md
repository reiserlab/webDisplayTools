# G6 Web Control — Pattern Pipeline Handoff (next steps after LAB-93/94)

**Date:** 2026-06-09 (after the first-hardware bench session)
**Branch:** `bench/g6-hardware-test` (pushed to origin `reiserlab/webDisplayTools`)
**Linear project:** "G6 Web Control (CSHL)" — Team Lab

## TL;DR

LAB-93 (Arena Console) and LAB-94 (v3 dry-run) are **Done and hardware-validated** —
patterns render on a real G6 2×10 from the browser. The agreed next step is
**Path B: the pattern pipeline (LAB-91 + LAB-92)** *before* the full-sequence runner
(LAB-97), because B retires two frictions this session exposed (hand-staged patterns +
SD-index guessing) and is a prerequisite for a real acceptance run (LAB-98).

## Where we are (2026-06-09)

- **Substrate (LAB-88/89, Done):** `js/arena-link.js` (`window.ArenaLink`) + `js/arena-wire-g6.js`
  (`window.ArenaWireG6`). Merged to `main` (PR #96).
- **Arena Console (LAB-93, Done — hardware-validated):** `arena_console.html` —
  connect / all-on / all-off / stop / trial-params / set-frame / SPI / response log.
- **v3 dry-run (LAB-94, Done — hardware-validated):** per-condition **▶ Test on arena**
  in `experiment_designer_v3.html` (**v0.25**), with the run-status/Stop controller
  **docked in the inspector**. Built on shared `js/arena-runner-g6.js`.
- **Duty-cycle fix (the blank-pattern blocker):** `js/pat-encoder.js` now defaults the
  G6 panel `duty_cycle` byte to `0x80` (50%); **G4/G4.1 keep the separate "stretch"
  concept** (untouched). Robust handling tracked in **GitHub #97**. Full story in the
  `g6-panel-bench-bringup` memory.
- **Bench artifacts:** `~/Desktop/g6_sd_card/` (4 test `.pat` + `patch_duty.js` stopgap +
  README). SD card `PATSD` is patched (duty=128) and rendering.
- **All of the above lives on `bench/g6-hardware-test`** — **NOT yet on `main`**.
  Landing it (a PR) is independent housekeeping, do it whenever.
- **Follow-ups:** **LAB-109** (6 bench notes: firmware CE-glyph orientation / reverse
  playback / trial-params duration / settable refresh + web mode-3 / SD-report).

## The goal & the planned sequence

Ultimate target: **LAB-98 — end-to-end CSHL acceptance** (build an SD set → load the
CSHL rig → author a protocol in the v3 designer → run the **full sequence** from the
browser → verify display + timing).

Agreed order:

1. **B — Pattern pipeline (NOW):** **LAB-91** (CSHL rig YAML) + **LAB-92** (SD-bundle
   builder + `js/pattern-set.js`, the manifest). ← *this handoff*
2. **C — Pattern-by-name:** **LAB-95** (console) + **LAB-96** (designer) — consume the
   manifest, retire the dry-run's confirm-once index guess.
3. **A — Full-sequence runner:** **LAB-97** — extend `js/arena-runner-g6.js` with a
   `runSequence()`. **Decide the timing model first** (caveat below).
4. **E — Acceptance:** **LAB-98**.

> **Timing caveat — read before starting LAB-97.** Trial/sequence duration is currently
> a browser `setTimeout` in `ArenaRunner` (best-effort; a slept/closed tab won't fire it).
> LAB-97 as scoped uses **client-side** waits/ITI, so across a whole sequence that
> fragility compounds. Strongly consider landing the **controller-side duration field**
> (LAB-109 item #3 — firmware, coordinate with Frank) *before/with* LAB-97, so timing is
> hardware-enforced; otherwise LAB-97 gets reworked later.

## Why B first (the reasoning)

This session ran on **hand-staged, hand-patched** `.pat` files and a **confirm-once
dialog** (because the authored `pattern_ID` is **not** the true SD alphabetical index).
LAB-92 fixes both at the root: it assigns deterministic indices (zero-padded `NNN_`) and
emits a **manifest** (name → SD index) that the console + designer resolve against
(LAB-95/96), and it bakes correct patterns via the now-fixed encoder (so `patch_duty.js`
is retired). It's also a hard prerequisite for a real LAB-98, and it's **pure web (no
hardware-timing risk)**. LAB-91 is a ~30-min quick win that unblocks loading a realistic
CSHL protocol. LAB-97 is the headline but heaviest, and sits on the shaky timer above.

---

## LAB-91 — CSHL rig YAML (quick win, do first)

**Create** `configs/rigs/cshl_g6.yaml` — **the `configs/rigs/` dir does not exist yet;
create it.**

**Schema** — mirror `tests/fixtures/rigs/example_rig.yaml`:

```yaml
format_version: "1.0"
name: "CSHL G6"
description: "CSHL course rig — G6 2x10, controller over serial/USB, no external plugins"
arena: "<G6 2x10 arena reference>"   # see "open questions" — webDisplayTools uses js/arena-configs.js (has G6_2x10)
controller:
  host: "..."        # keep TCP host/port (the rig schema uses these)
  port: 62222
  # serial/USB is chosen at runtime via the browser Web Serial port picker, not the YAML
plugins: {}          # NO camera / backlight / temperature — CSHL has no external plugins
# AO note: AO is a controller-native command (LAB-80/81/82), NOT a rig plugin.
```

**Open questions to resolve while implementing:**
- How the v3 designer resolves the `arena:` field. webDisplayTools uses
  `js/arena-configs.js` (a JS registry with `G6_2x10`), whereas the rig fixture points at
  a YAML path (`../arenas/...`, a maDisplayTools convention). Check `onRigEdit` /
  `parseRigYAMLText` / `deriveRigPlugins` in `experiment_designer_v3.html` — the designer
  primarily reads the `plugins:` block for rig-aware plugin assist (#89/#91), so the
  `arena:` field may be informational on the web side.
- Whether to add an explicit `serial:`/`transport:` field or rely on the Web Serial picker.

**DoD:** loads cleanly in the v3 designer (Settings → Rig → Browse…); rig-aware plugin
assist shows **no spurious plugins**.

---

## LAB-92 — Pattern Set / SD-bundle builder + `js/pattern-set.js` (the keystone)

**Two pieces:** a builder **panel** in `experiment_designer_v3.html` + a shared
**`js/pattern-set.js`** module (dual-export, also read by `arena_console.html`).
**`js/pattern-set.js` does not exist yet — create it.**

**Flow (MVP = rebuild from scratch; manifest import / SD scan is LAB-102, deferred):**
1. Pick **one source** — public web repo / another repo / local files (File System Access
   API) — **NO mixing**.
2. Assemble an ordered set.
3. **Assign 1-based indices** → emit zero-padded `NNN_<name>.pat` filenames so the
   firmware's **alphabetical** SD scan == the intended order. *(Firmware sorts `*.pat`
   alphabetically and **ignores dotfiles** — `SdManager.cpp` `name[0] != '.'`; learned
   this session, so macOS `._*` AppleDouble files are harmless.)*
4. **Validate** each entry vs the target arena config — reuse `js/pat-parser.js` + a
   geometry check; **reject mismatches** with a clear message (a 3×16 pattern on a 2×10
   arena → reject; that's the firmware's `status=8` ARENA_MISMATCH, caught client-side).
5. **Export a ZIP**: `/patterns/NNN_*.pat` + `README.txt` (copy-to-SD) + a timestamped
   **`MANIFEST.txt`** (`Pattern Count`, `Pattern Set ID` FNV-1a hash of SD filenames,
   and `Mapping: sd_name <- human_name`) + **`MANIFEST.bin`** (uint16 count + uint32 timestamp LE).
6. Ship a **pre-built default bundle in-repo** (the start of LAB-90's library).

**Critical tie-ins from this session:**
- **Encoding goes through `js/pat-encoder.js`** (`PatEncoder.encodeG6`), which now
  defaults the G6 `duty_cycle` byte to `0x80` — so builder output **renders correctly on
  hardware**. The hand-patch `~/Desktop/g6_sd_card/patch_duty.js` is a **stopgap the
  builder retires**. (Do **not** touch G4/G4.1 "stretch" — see #97.)
- The **MANIFEST.txt** is the human-readable source of truth for SD state — `Pattern Set ID`
  (FNV-1a hash over sorted filenames) lets the host detect SD card changes without a full
  directory listing. Pattern name → SD index lookup uses 0x80/0x82 controller commands.
- ZIP: pull a zip lib via **CDN** (e.g. JSZip) — consistent with the "dependencies via
  CDN only" rule (CLAUDE.md).

**DoD (from LAB-92):**
- Pick a source → assemble → validate → export a valid ZIP whose `/patterns` order
  matches the manifest indices and carries a `set_id`/timestamp.
- Bad-geometry patterns rejected with a clear message.
- The manifest is consumed by the console + editor pattern pickers.

**Out of scope (MVP):** manifest import / SD-folder scan / round-trip edit (that's LAB-102).

---

## Key facts the next session needs (don't re-derive)

- **`duty_cycle` byte:** last byte of each G6 panel block = per-LED brightness (0–255).
  `pat-encoder.js` fixed to default `0x80`. **G4/G4.1 = "stretch"** (a different concept;
  do not change). GitHub #97 + `g6-panel-bench-bringup` memory.
- **SD indexing:** firmware sorts `/patterns/*.pat` alphabetically → 1-based index;
  **ignores dotfiles**; **mounts SD only at boot** (card must be seated before power-on,
  else `CE 04` all session).
- **Shared runner:** `js/arena-runner-g6.js` is the execution module — **extend it for
  LAB-97, don't reinvent.** Design rules (`command_name` filter, importMode guard,
  connect-on-demand, best-effort STOP) in the `g6-web-runner-impl` memory.
- **Confirm-once stopgap:** the dry-run guesses SD index from `pattern_ID`; the LAB-92
  manifest is what retires it.
- **Error glyph:** a failed trial-params shows `CE NN` on the panels (GS16 oneshot,
  750 ms) — `04`=no SD, `05`=file, `06`=header CRC, `07`=frame CRC, `08`=arena mismatch.
- **Branch:** today's closed LAB-93/94 + duty fix live on `bench/g6-hardware-test`
  (pushed), **not on `main`**.

## Pointers

- **Linear:** LAB-91, LAB-92 (this handoff) · LAB-95/96 (next: by-name) · LAB-97
  (full-sequence) · LAB-98 (acceptance) · LAB-100 (SD provenance — the marker file feeds
  it) · LAB-109 (bench follow-ups incl. timing).
- **GitHub:** webDisplayTools #97 (duty-cycle robust handling).
- **Reference repos:** Modular-LED-Display (`g6_04` .pat format), maDisplayTools
  (pattern format + `configs/rigs` convention).
- **Code:** `js/pat-encoder.js`, `js/pat-parser.js`, `js/arena-configs.js`,
  `js/arena-runner-g6.js`, `experiment_designer_v3.html`, `arena_console.html`.
- **Other handoffs:** `g6-web-console-runner-handoff.md`, `g6-web-control-substrate-handoff.md`,
  `web-serial-g6-panel-handoff.md` (same dir).
