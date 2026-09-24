# Controller settings: rig defaults, the protocol `controller:` block, the run header

*User documentation for Studio v0.88+. Design and history: `controller-settings-strategy.md`.*

The G6 controller keeps a handful of **sticky** settings across runs: the panel display mode
(0 oneshot / 1 persistent / 2 triggered / 3 gated), the re-transmit ("refresh") rate, the Digital IO
roles, the analog-out level, the SPI clock. Before v0.88 they were set by hand in the Controller ▾
menu and nothing recorded them with the data. Now:

1. the **rig YAML** declares the bench's wiring and defaults,
2. a **protocol** declares what the experiment needs in a `controller:` block,
3. Arena Studio **asserts** both before every run (read → set if needed → read back), **refuses** to
   run on a mismatch it cannot fix, and writes a **controller snapshot** into the run header.

## 1. Rig YAML

```yaml
io:
  dio:
    - port: 1
      role: out_debug_framescan   # J3
    - port: 2
      role: in_trigger            # J4 — declare it; `off` means "don't touch"
  ao:
    role: programmable
    default: 0.0
defaults:
  panel_mode: triggered           # asserted at connect and at every run start (course rigs: persistent)
limits:
  max_refresh_hz: 300             # protocols may not exceed this; line_sync_safe pins to it
requires:
  panel_firmware: "2p"            # the SD footer must match (prefix / dash-token match)
strict: true                      # mismatches BLOCK instead of warn (default false)
```

`io:` is applied at connect as before (needs io_ext firmware). `defaults.panel_mode` is applied at
connect the same way, GET → SET → GET, and logged (`panel mode: persistent → triggered (verified —
rig default)`). On a strict rig a failure there disables the run buttons until it is resolved.

Built-in rigs: `bergamo_g6_2x10_2p` (triggered, 300 Hz cap, "2p" firmware, strict); all course rigs
(`cshl_*`, `g6_3x10`, `g6_4x10`) now carry `defaults.panel_mode: persistent`, so a bench left in
triggered mode by a previous session is put back before the next run.

## 2. Protocol `controller:` block

```yaml
rig: "./configs/rigs/bergamo_g6_2x10_2p.yaml"
requires: [controller_block]
controller:
  panel_mode: triggered
  refresh_policy: line_sync_safe    # or refresh_hz: 300 (not both)
  panel_firmware: "2p"
```

| key | meaning | if absent |
|---|---|---|
| `panel_mode` | the mode the experiment needs; overrides the rig default | the rig default is asserted |
| `refresh_policy: line_sync_safe` | pin the refresh at the rig's `limits.max_refresh_hz` when the current rate or the referenced patterns' default (GS2 → 1000 Hz, GS16 → 300 Hz) would exceed it | with a rig cap the same derivation runs anyway; without one nothing is touched |
| `refresh_hz` | an explicit rate (refresh experiments); must not exceed the rig cap | — |
| `panel_firmware` | SD footer version or prefix the panel image must match; also checked against the session's fleet verify | the rig's `requires.panel_firmware`, if any |

Declaring a block makes the protocol **strict**: its `rig:` must be the session rig, every setting it
depends on must be readable, and the panel firmware must match. `requires: [controller_block]` is
what makes a runner *without* this feature (MATLAB today) refuse the file rather than run it in the
wrong mode; the validator and the Settings → Controller card warn when it is missing.

Most protocols need no block. Course protocols inherit `persistent` from their rig.

## 3. What happens at run time

Green **Run experiment** and blue **Test experiment** both go through the preflight:

1. Read the controller: panel mode (0x1C), refresh (0x17), SPI clock (0xC6), DIO roles (0xAD), AO
   level (0xA1), panel-firmware footer (0xE3), controller firmware and capabilities, the last fleet
   verify. Read the grayscale of every referenced pattern (0x88).
2. Plan (`js/controller-settings.js` `planAssertions`): rig identity, panel mode (needs the
   `v3_triggered` / `v3_gated` capability for modes 2/3), refresh, panel firmware.
3. Execute the SETs, each followed by a read-back. Every step is a line in the Studio log:
   `panel mode: persistent → triggered (verified — protocol controller: block)`.
4. If anything blocks: banner *Run refused — controller preflight: …*, nothing runs.
5. The run header (`meta.controller` in the run log JSON, one `controller:` line in the .txt)
   carries `intended`, `before`, `actions` (from → to, ok), `after`, `warnings`, `blocking`, `strict`,
   `rig`. `before`/`after` are full snapshots (mode, refresh, SPI, DIO roles, AO, footer, controller
   firmware/id/capabilities, fleet verify).

The run gate shows the planned verdict before you press anything (the hint under the run
buttons and Settings → Controller). It is recomputed when the protocol, the session rig or the
controller changes. After the run, the runner's best-effort STOP/allOff is unchanged; there is no
"restore previous mode" — every run asserts what it needs.

## 4. Panel firmware verification

Three layers, from cheap to conclusive:

| when | what | logged where |
|---|---|---|
| every connect and run | **SD footer** (0xE3): which image was last uploaded to the controller (`2p-9014b5bb-d`, `panel-fw-v1.2.0`, …) | Studio log at connect; run header `before.panel_firmware` |
| after a batch flash with *verify* on, or **Settings → Controller → Verify panels** | **fleet verify** (0xC9 per panel): CRC of each panel's running app flash vs the footer; ~1 s per panel, display stopped | Studio log; `Studio.panelVerify`; run header `before.verified` `{at, footer, ok, verified, total, mismatched[]}` |
| planned (firmware) | per-panel version report at boot, host-readable | — |

Rules: a required firmware that does not match the footer **blocks**; a failed fleet verify
**blocks** and names the panels; "not verified this session" **warns** (strongly worded on strict
rigs). Verification is per session because the answer can change only when someone flashes, and
a flash goes through the same Studio, which records the result.

## 5. Staging

- **Phase 1 (this release)**: everything above. Studio-only; MATLAB refuses protocols that carry the
  `controller_block` token.
- **Phase 2 (arena firmware, issue reiserlab/LED-Display_G6_Firmware_Arena#60)**: per-trial
  `panel_mode` in TRIAL_PARAMS; mode in GET_HEALTH / telemetry; an EINT edge counter so the
  preflight can also check "line clock present"; a boot-time per-panel firmware report so the fleet
  check needs no display stop (coordinated with the panel boot-up work).
- **Phase 3 (MATLAB runner)**: implement `controller:` and `requires:`; until then 2P protocols are
  Studio-only.

## 6. Files

`js/controller-settings.js` (planner, tested in `tests/test-controller-settings.js`),
`js/plugin-registry.js` (`parseRigIo` → defaults/limits/requires/strict), `js/protocol-yaml-v3.js`
(`extractControllerBlock`, blocking errors, `controller_block` capability), `arena_studio.html`
(`Studio.assertControllerSettings`, `readControllerSnapshot`, `verifyPanels`, run gate, Settings card),
`.claude/skills/protocol-yaml/bin/validate-protocol.mjs`, `configs/rigs/*.yaml`,
`protocols/g6_2x10_2p_*.yaml`.
