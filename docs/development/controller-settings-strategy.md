# Controller settings: what lives in the rig config, what lives in the protocol (plan, 2026-09-23)

Status: **Phase 1 implemented** (Studio v0.88, branch claude/controller-settings-block; user doc
`docs/development/controller-settings.md`). Reviewed adversarially before implementation (Claude proposal → Codex GPT-5.5
review → reconciled here). Phases 2 (firmware) and 3 (MATLAB) are open. Raw review: `Bergamo_testing/092226_SNR/analysis/codex_review_raw/codex_strategy_review.md`.

## 1. The problem

The G6 controller has about a dozen *sticky* session settings (set over the wire, kept until changed or
rebooted). They are controlled by four unrelated mechanisms: firmware boot defaults, the rig YAML `io:` block
applied at connect, protocol commands, and the Studio's locked Controller ▾ menu. The panel display mode, the
single most consequential setting for two-photon imaging, is menu-only: set by hand, not recorded with the
data, not checked before a run (arena firmware issue #60).

## 2. The rule

> Wiring goes in the rig config. Experiment semantics go in the protocol. Installed state the protocol needs
> but cannot set goes in `requires:`. **Every sticky setting a run depends on is asserted before the run starts,
> verified after setting, and recorded in the run header.** Cleanup afterwards is best-effort, never the safety
> mechanism.

The last sentence is the main change from the first draft. "Restore the previous value at the end of the run"
looked tidy but is a trap: a closed browser tab, an unplugged USB cable or a controller reboot skips it, and a
clean 2P run would "restore" persistent mode on a rig still wired for imaging. Assert-before-run makes every
run safe on its own and makes back-to-back protocols independent.

## 3. Classification

| setting | sticky | home | mechanism |
|---|---|---|---|
| DIO 1/2 roles, AO mode, AO/DO idle levels | yes | **rig** (wiring) | applied at connect (exists); on the 2P rig DIO 2 must be declared `in_trigger`, not `off` (`off` = don't touch) |
| panel display mode | yes | **rig default + protocol requirement** | rig `defaults.panel_mode` applied at connect (course rigs: 1, 2P: 2); a protocol that *needs* a mode declares `controller.panel_mode`; runner GET → SET → GET before the first condition, refuses on mismatch. Course protocols omit it and inherit the rig default, so a copied 2P protocol cannot damage a course bench silently: it refuses to run there |
| refresh rate | yes | **derived** | not hand-authored. The runner reads the grayscale of every referenced pattern (SD header, 0x88) and picks the firmware default for it, capped by the rig's `limits.max_refresh_hz` (2P: 300). A protocol may declare `controller.refresh_policy: line_sync_safe` to insist on the cap; a bare number is only for explicit refresh experiments |
| per-trial pattern, mode 2/3/4, frame_rate, frame_index, gain, duty | no | **protocol trialParams** | unchanged (frame_rate is already per trial; it is the *refresh* rate that is sticky) |
| AO / DO changes during a run (markers) | yes | **protocol commands** | unchanged (`setAnalogOut`, `setDigitalOut`); preflight verifies AO mode is `programmable` when a protocol uses AO markers |
| panel firmware variant | persistent | **protocol `requires`** | `requires.panel_firmware: "eintlow_2p"` matched against the SD footer version (0xE3) **and** the flasher's per-panel verify status (0xC9); footer alone only proves what was uploaded |
| rig identity | – | **protocol `rig:` must match the session rig** | today the 2P protocols point at the course rig file; a mismatch becomes a blocking preflight error |
| pattern files | persistent | protocol preflight by name (exists) | 2P runs additionally log each pattern's SD header (GS mode, frames, default duty) |
| telemetry ring, SPI clock, diag/SD-diag flags | yes | **console only** | protocols never touch them; the run header snapshots what is readable |
| line-clock presence | – | **firmware follow-up** (issue #60: EINT edge counter in health) | until then a manual confirmation step in the 2P preflight |

## 4. Mechanism: declaration block, not a command

A `setPanelDisplayMode` *command* inside a condition was the first idea. It fails in exactly the ways that
matter: it is buried where preflight cannot see it, it leaks into the next protocol, and a copied protocol
puts a course bench into triggered mode with no line clock. The declarative block fixes all three:

```yaml
rig: "./configs/rigs/bergamo_g6_2x10_2p.yaml"
requires: [controller_block]       # capability token: a runner without the block refuses the file
controller:
  panel_mode: triggered            # 0 oneshot | 1 persistent | 2 triggered | 3 gated (names or numbers)
  refresh_policy: line_sync_safe   # cap at the rig's max_refresh_hz, derived per pattern grayscale
  panel_firmware: "2p"             # SD footer version/prefix + the session's fleet verify
```
(As implemented: `requires:` stays the list of capability tokens; the installed-state requirement lives
inside `controller:` and the rig may carry its own `requires.panel_firmware`.)

Runner behaviour: after connect-time rig apply, before the first condition: GET each declared setting, SET if
different, GET again; log "panel mode 1 → 2 (verified)"; refuse to run if a SET cannot be verified, a
capability is missing, or a `requires` fails. On clean completion and on cancel: best-effort `allOff` and rig
idle outputs. No "restore previous".

Known gap: the MATLAB runner ignores unknown top-level keys, so a protocol with a `controller:` block looks
safe but is not enforced there. Until MATLAB implements the block, 2P protocols are Studio-only and say so in
their header (and `requires:` with an unknown key must be *blocking* in every runner that understands
`requires` at all).

## 5. Run header

Every run log gets a header with intended / observed-before / SET result / observed-after for each declared
setting, plus a snapshot of: protocol hash, rig file and hash, Studio version, controller firmware and
capability bitmap (0xCB/0xC2), panel mode (0x1C), refresh (0x17), SPI clock (0xC6), DIO roles (0xAD), AO
level (0xA1), panel firmware footer (0xE3) and verify status, pattern headers. Post-run / abort state is
appended best-effort. This alone would have made the 22 Sept data interpretable and needs no schema change,
so it is the first thing to build.

## 6. Ordered plan (smallest set that fixes 2P without creating a course problem)

Phase 1, webDisplayTools only, no firmware change:
1. **Run header snapshot** in the web runner (§ 5). Files: `js/arena-runner-g6.js`, `js/studio-runlog-adapter.js`.
2. **2P rig config** `configs/rigs/bergamo_g6_2x10_2p.yaml`: DIO 1 `out_debug_framescan`, DIO 2 `in_trigger`,
   AO programmable idle 0 V, `defaults.panel_mode: 2`, `limits.max_refresh_hz: 300`, `requires.panel_firmware`.
   Course rigs gain `defaults.panel_mode: 1`. Entry in `configs/rigs/index.json`.
3. **Rig parser + connect-time apply** for `defaults.panel_mode` (GET/SET/GET, logged; blocking when the rig
   sets `strict: true`). Files: `js/plugin-registry.js` (parseRigIo), `arena_studio.html` (applyRigIo).
4. **Protocol `controller:` block**: parser + validator + editor "Controller" card + runner preflight
   (§ 4). Files: `js/protocol-yaml-v3.js`, `.claude/skills/protocol-yaml/bin/validate-protocol.mjs`,
   `js/plugin-registry.js`, `js/arena-runner-g6.js`, `arena_studio.html`; tests in `tests/`.
5. **`requires:` extension** for `panel_firmware` and rig identity; preflight blocks on mismatch.
6. **Refresh derivation** from pattern grayscale + rig cap (`refresh_policy`).
7. **Point both 2P protocols** at the new rig and add the block; update the rig checklist so "set panel mode 2
   by hand" becomes "connect and read the log line"; document Studio-only.

Phase 2, arena firmware (issue #60): per-trial `panel_mode` in TRIAL_PARAMS; mode in GET_HEALTH and telemetry;
EINT edge counter → preflight "line clock present".

Phase 3: MATLAB runner support for `controller:` and `requires:`.

## 7. What the review changed (for the record)

Codex agreed with the rule and with the declaration block, and changed four things: dropped restore-at-end in
favour of assert-before-run; made refresh derived rather than authored; kept course protocols silent on panel
mode (rig default) instead of having every protocol declare it; and added rig identity, per-panel firmware
verification, AO-mode verification and the MATLAB gap to the inventory. Claude's items that survived
unchanged: the rule itself, the run header, `requires:` for installed state, console-only for bench knobs.
