# Rig checklist — BETA 2P line-sync panel firmware on the Bergamo (2026-09-23)

For whoever runs the test at the rig PC. **Nothing needs to be cloned, pulled, or downloaded**: the
firmware and the protocol are both in the published Arena Studio's own catalogs (merged 2026-09-23).
No bench test was run on this firmware; the rig's own line clock is the test. Roll-back is one ISP push of
an image in the same catalog (§ 6).

## 0. What you need open

| What | Where |
|---|---|
| Arena Studio (published) | https://reiserlab.github.io/webDisplayTools/arena_studio.html |
| This checklist | https://github.com/reiserlab/webDisplayTools/blob/main/docs/development/2p-line-sync-rig-checklist.md |
| ScanImage logging guide (full version; § 3 below is the minimal one) | https://github.com/reiserlab/webDisplayTools/blob/main/docs/development/2p-scanimage-signal-logging.md |
| Background (why / what changed) | https://github.com/reiserlab/LED-Display_G6_Firmware_Panel/blob/main/panel/bench/2p-line-sync-2026-09-22.md |

The firmware image is the Studio catalog entry **"v0.3.1 — BETA 2P line-sync: active-low EINT + 1 µs BCM
base + free-running Triggered (9014b5b+ …)"**; the Studio checks its sha256 after fetching. The protocol
is the library entry **"2P line-sync duty sweep — G6 2×10 on the Bergamo"**. Fallback if the site's
catalog is unreachable: download
https://raw.githubusercontent.com/reiserlab/webDisplayTools/main/flasher/firmware/g6-panel-v0.3.1-isp-BETA-eintlow-2p-9014b5b.bin
(136,352 bytes) and
https://raw.githubusercontent.com/reiserlab/webDisplayTools/main/protocols/g6_2x10_2p_duty_sweep.yaml
and use "Load local .bin…" / "Open protocol → local .yaml" instead.

What the firmware changes, in one line each: BCM base time 3 → 1 µs (a full-duty row is ~15 µs and
fits the ~18 µs line-clock gap; brightness at a given duty is ⅓ of before); panel display mode 2
(Triggered) free-runs one row per line-clock edge instead of stopping after 20. SPI ingest and the ISP
path are unchanged.

## 1. Flash all 18 panels (Arena Studio)

1. Connect to the controller (USB). The connect log should show firmware `781efe2b · 2×10`.
2. Panel firmware panel → **Choose…** → under **Official ISP images** pick the **BETA 2P line-sync** entry
   (not the default) → **Use**. The Studio fetches it, verifies its sha256, reads the footer
   (`2p-9014b5bb-d`, CRC `38282271`) and uploads it to the controller SD. It refuses to continue if the
   SD write CRC does not match — just re-upload.
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

Record in ScanImage (vDAQ) alongside Ch2 / Ch3 — **minimal version, everything in the TIFF**:

- **Arena J3 → a FREE vDAQ `D2.x` input on its own cable** (Bergamo: `D2.1`; `D2.0` is the resonant
  sync), and on the imaging system's **Triggers** tab set **Aux trigger 1** to that port. **Use a FREE digital input.** The resonant scanner sync already occupies one `D2.x` port (on the Bergamo it is `D2.0`) and the acquisition triggers may occupy others — check the Resource Configuration. Never T the arena signal into an existing cable: on 2026-09-23 J3 spliced into the sync cable clamped the sync during every frame transfer, ScanImage lost period lock, and no frames were formed while the display was on.
  That puts the 300 Hz frame-transfer times into every frame header. The protocol's 2 s `allOff` between
  steps stops those pulses, so each duty epoch shows up as a block of timestamps with gaps between.
- **Optional:** photodiode on one panel → rear SMB **AI3 = Channel 4** (keep it under 2 Vpp), Channels
  window → Save. Only needed to separate real leak light from SiPM recovery at low duty.
- Nothing triggers ScanImage: start the Grab by hand, then press Run.

The full version (Data Recorder `.h5`, line/frame clock copies, AO marker) and the verification steps are
in [`2p-scanimage-signal-logging.md`](2p-scanimage-signal-logging.md). Ch3 is the leak you are measuring,
not a sync signal.

## 4. Run

The Bergamo PC has **no bridge process** (the `pixi run bridge` logger the course rigs use), and none is
needed: use the **blue ▶ Test experiment** button, not the green ▶ Run experiment. The green button is
gated on the bridge and will refuse with "Bridge not connected". Test experiment runs the whole sequence
on the arena exactly the same way; the only differences are that nothing is auto-committed to the course
repo and the controller telemetry ring is not drained (not needed — the TIFF aux-trigger record is the
timing source for this test).

1. Studio → **Open protocol** → **Open from Library…** → **"2P line-sync duty sweep — G6 2×10 on the
   Bergamo"** (~62 s: blank · duty 25 · 64 · 128 · 191 · 255 (rotating) · duty 128 static · blank, with a
   2 s allOff between steps).
2. Start the ScanImage **Grab** first, then **▶ Test experiment**.
3. When it finishes, click **⬇ Save** in the log strip — it downloads the browser run log (`.json` +
   `.txt`: every condition and command with host timestamps and controller replies). Keep it next to the
   TIFF; it is the record of which duty ran when, and of the panel-mode / DIO-role commands.
4. If time allows, roll back (§ 6) and run the same protocol again on the old firmware.

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
