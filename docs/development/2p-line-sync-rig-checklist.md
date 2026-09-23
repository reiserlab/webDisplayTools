# Rig checklist — BETA 2P line-sync panel firmware on the Bergamo (2026-09-23)

For whoever runs the test at the rig PC. **Nothing needs to be cloned or pulled**: the Arena Studio
runs from the published site, and the two files you need are downloaded from GitHub in a browser.
No bench test was run on this firmware; the rig's own line clock is the test. Roll-back is one ISP
push of an image already in the Studio's catalog (§ 6).

## 0. Downloads (browser, any PC)

| What | Where |
|---|---|
| Arena Studio (published) | https://reiserlab.github.io/webDisplayTools/arena_studio.html |
| Panel firmware `.bin` (ISP image) | https://raw.githubusercontent.com/reiserlab/webDisplayTools/claude/2p-line-sync-beta/flasher/firmware/g6-panel-v0.3.1-isp-BETA-eintlow-2p-9014b5b.bin |
| Protocol YAML | https://raw.githubusercontent.com/reiserlab/webDisplayTools/claude/2p-line-sync-beta/protocols/g6_2x10_2p_duty_sweep.yaml |
| This checklist | https://github.com/reiserlab/webDisplayTools/blob/claude/2p-line-sync-beta/docs/development/2p-line-sync-rig-checklist.md |
| Background (why / what changed) | https://github.com/reiserlab/LED-Display_G6_Firmware_Panel/blob/claude/display-timing-sync-protocol-2d4f49/panel/bench/2p-line-sync-2026-09-22.md |

Save the `.bin` and the `.yaml` to the rig PC (right-click → Save link as…). Check the `.bin` is
136,352 bytes; the Studio will show footer version `2p-9014b5bb-d` and CRC `38282271` when you load it.
If it shows anything else, you have the wrong file.

What the firmware changes, in one line each: BCM base time 3 → 1 µs (a full-duty row is ~15 µs and
fits the ~18 µs line-clock gap; brightness at a given duty is ⅓ of before); panel display mode 2
(Triggered) free-runs one row per line-clock edge instead of stopping after 20. SPI ingest and the ISP
path are unchanged.

## 1. Flash all 18 panels (Arena Studio)

1. Connect to the controller (USB). The connect log should show firmware `781efe2b · 2×10`.
2. Panel firmware panel → **Choose…** → **📂 Load local .bin…** → pick the downloaded `.bin`.
   The dialog reads the footer (`2p-9014b5bb-d`, CRC `38282271`) and uploads it to the controller SD.
   It refuses to continue if the SD write CRC does not match — just re-upload.
3. Tick **verify each**, then flash **all 18 panels** (1–7, 9–17, 19–20). Do not leave a mixed arena.
4. The verify sweep must read `MATCH 0x38282271` for every panel. If one says MISMATCH, flash that
   panel once more. Flashing needs the display stopped (the Studio does this itself).

## 2. Two-minute functional check before imaging (this replaces the bench test)

1. Controller ▾ → panel display mode **1** (Persistent). Play any pattern. All panels show it, about
   ⅓ as bright as you are used to. → the build boots, ingests SPI, scans.
2. Panel display mode **2** (Triggered). Line-clock BNC on **J4**, J30 shunt installed. Panels go
   **dark** (no clock yet). Start ScanImage **Focus**: panels light and stay steady. Stop Focus: dark.
   → the free-running Triggered path works off the real line clock.
3. If only the top row or two of each panel light in step 2, the controller is in mode 3 (Gated).
   Set mode 2.

## 3. Setup for the protocol run

| Item | Setting | Wire (Debug ▾ → unlock → Send raw hex) |
|---|---|---|
| panel display mode | 2 (Triggered) | `02 1B 02` |
| Digital IO 1 (BNC **J3**) | out_debug_framescan — HIGH during every SPI frame transfer | `03 AC 01 03` (read back: `01 AD`) |
| Digital IO 2 (BNC **J4**) | in_trigger (boot default) — the line-clock input | leave |
| refresh rate | 300 Hz (Gray_16 default) | `03 16 2C 01` |
| telemetry ring | on (default) | — |
| pattern | `frame2_h_ccw_200f`, SD index 4 (built-in g6_2x10 set) — or any **Gray_16** pattern on the card | edit the two anchors at the top of the YAML |

Record in ScanImage (vDAQ) alongside Ch2 / Ch3:

- **J3** — frame-transfer envelope, one ~0.7 ms pulse per 300 Hz controller refresh.
- **The line clock**, looped back into a spare DI/AI — the phase reference for everything.
- **J27 (AO)** — the condition marker; the protocol steps it 0 / 0.5 / 1.0 / 1.5 / 2.0 / 2.5 / 3.0 / 0 V.
- **Photodiode** on one panel into a spare AI if at all possible — it is the one signal that separates
  "light present during the imaged line" from "detector tail after a flash in the gap".

Ch3 is the leak you are measuring, not a sync signal.

## 4. Run

Studio → Open protocol → local `.yaml` → `g6_2x10_2p_duty_sweep.yaml` (~56 s):
blank · duty 25 · 64 · 128 · 191 · 255 (rotating) · duty 128 static · blank. Start the ScanImage
acquisition first, then Run. Save the Studio run log (it holds every command with its timestamp and
the telemetry rows). If time allows, roll back (§ 6) and run the same file on the old firmware.

## 5. What to expect / what would mean trouble

- Expected: no pedestal in the imaged part of the line at any duty; no 300 Hz line in Ch3. Edge
  columns may keep a small stationary offset that is identical on every line (detector recovery).
- Pedestal only at duty 255: the ~15 µs row is over the gap margin. Usable range is everything below.
- Pedestal at all duties, scaling with duty: real light during the imaged line — stop, save everything,
  send the Ch3 folded waveform against the looped-back line clock.
- Panels lit with no line clock in mode 2: wrong mode, or wrong firmware on some panels — re-run the
  verify sweep; Panel firmware → Info (0xE3) shows the SD footer `2p-9014b5bb-d`.
- **Stop display does not blank on this firmware; All off does.** The protocol ends with allOff.

## 6. Roll-back

Studio → Choose… → official images → **"v0.3.1 — Active-low EINT trigger + ISP indicator (9014b5b)"**
→ flash all 18 with verify → `MATCH 0x9871E334` everywhere. That is exactly the firmware the arena had
on 22 Sept 2026.
