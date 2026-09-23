# Logging arena sync signals in ScanImage (vDAQ) — where they go and how to check they got there

Companion to `2p-line-sync-rig-checklist.md`. Sources: ScanImage docs and the vDAQ datasheet, linked
inline; verified against the Rev. A4 datasheet tables (April 2021).

## 1. Three places an external signal can end up

| Route | Hardware input | Sample timing | Where the data lands | Good for |
|---|---|---|---|---|
| **Auxiliary trigger** | vDAQ breakout, an **input-capable digital line (D2.x)**, 5 V TTL | edge timestamps, 8 ns resolution, FPGA-timed | **inside the TIFF**: per-frame header keys `auxTrigger0…3` (shown as `Aux Trigger n = [t1 t2 …]`, seconds from acquisition start) | sparse digital events: the arena's 300 Hz frame-transfer pulse, condition-change markers, a frame clock copy |
| **Data Recorder** | breakout **precision analog inputs AI0–AI11**, ±10 V, 16-bit, 5 GΩ | continuous, 500 Hz – 500 kHz | **separate HDF5 file** (`<basename>_<acq#>.h5`), one dataset per signal, no timestamp dataset | anything continuous or analog: line clock, AO condition marker, photodiode, frame clock copy |
| **Image channel** | PCIe card rear **SMB high-speed AI 0–3**, 0.5–2 Vpp, 50 Ω, 14-bit, 62.5–125 MS/s | pixel clock, **only during the imaged part of each line** | **inside the TIFF** as an extra channel (Ch1–Ch4 ↔ AI0–AI3) | signals you want mapped onto image pixels: a photodiode showing where in the field light arrives (what Ch3 = AI2 did on 22 Sept) |

Datasheet: [vDAQ Datasheet Rev. A4](https://vidriotechnologies.com/wp-content/uploads/2022/01/vDAQ-Datasheet.pdf)
— Table 1 (high-speed AI), Table 2 (precision AI), Tables 4–5 (DIO). Digital groups 0 and 1 have
per-line direction, groups 2 and 3 are group-directed; in ScanImage practice **D2.x are the inputs
(external triggers), D3.x the outputs (exported clocks)** ([vDAQ Configuration](https://docs.scanimage.org/Configuration/DAQ/vDAQ+Config.html),
[Stage Scanning](https://docs.scanimage.org/Premium+Features/Stage+Scanning.html) uses "any of the D2.X ports as a digital input").
Input high ≥ 2.0–2.3 V, so the arena's 5 V outputs and a 3.3 V line clock both register.

## 2. Step by step

### 2a. Export the line clock and frame clock (so they exist on BNCs)

1. ScanImage → **Resource Configuration** → your imaging system (the vDAQ scan system) → **Triggers** tab.
2. **Line clock out** → pick an output line, e.g. `D3.0`. **Frame clock out** → e.g. `D3.1`.
   ([Imaging Systems](https://docs.scanimage.org/Configuration/Imaging+Systems.html), [Exported Clocks](https://docs.scanimage.org/Concepts/Triggers/Exported+Clocks.html))
3. The line clock is HIGH while a line is imaged and LOW during the turnaround (measured 22 Sept:
   44.8 µs HIGH / 18.4 µs LOW at 15.825 kHz). The frame clock is a 5 V pulse at the start of each raster.
4. Line clock BNC → **T** → arena **J4** (Digital IO 2, `in_trigger`) **and** a Data Recorder AI (see 2c).

### 2b. Aux triggers → TIFF header

1. Same **Triggers** tab → **Aux trigger 1** → pick an input line, e.g. `D2.0`; **Aux trigger 2** → `D2.1`.
   ([Auxiliary Trigger](https://docs.scanimage.org/Concepts/Triggers/Auxiliary+Trigger.html))
2. Wire **arena J3** (Digital IO 1 = `out_debug_framescan`, one ~0.7 ms HIGH pulse per SPI frame transfer,
   300 Hz) → `D2.0`. Optionally the **frame clock** (D3.1 → T → `D2.1`) so every TIFF frame also carries its
   own clock edge, which lets you align the HDF5 recording to the TIFF (§ 3).
3. Constraints from the docs page: resonant scanning only (the Bergamo is); **mutually exclusive with
   I2C recording and photon counting**; hard limit 1000 timestamps per frame, **keep it to ~10** — the
   J3 pulse gives ~5.5 per 18.2 ms frame, fine; the **line clock (288 per frame) must never go on an aux
   trigger** — the per-frame header is a fixed ~2001-byte buffer and later keys are silently dropped when
   it overflows ([scanimage-octo-reader README](https://github.com/horsto/scanimage-octo-reader)).
   Rising edges are timestamped; a debounce (`DEBOUNCE_TIME_AUX_TRIGGERS` in `Acquisition.m`) rejects very
   short pulses — 0.7 ms is far above it.
4. Where it lands: each TIFF page's `ImageDescription` gains
   `Aux Trigger 1 = [0.3138 0.3316 …];` — seconds on the same FPGA clock as `frameTimestamps_sec`.

### 2c. Data Recorder → HDF5

1. **Resource Configuration** → **+** → add **Data Recorder** (vDAQ) → open its configuration page.
   ([vDAQ Analog Data Recorder](https://docs.scanimage.org/Basic+Features/Data+Recorder.html))
2. **+** → add signals: `AI0` line clock copy, `AI1` arena **J27 AO** condition marker (0/0.5/…/3.0 V),
   `AI2` **J3** frame-transfer envelope copy, `AI3` frame-clock copy, `AI4` photodiode (if you have one).
   Give each a dataset name (no `/`), optional units.
3. **Sample Rate** = **500000** (500 kHz, the maximum → 2 µs; ~31 samples per line, ~9 in the 18 µs gap).
4. Tick **Auto Start** (starts/stops with the Grab), **Duration = Inf**, leave **Use Trigger** off.
5. **File Directory** = the same folder as the TIFF, **File Basename** = the TIFF basename; the file is
   `<basename>_<Acquisition #>.h5`. Optional **Compression** (gzip 5).
6. Where it lands: **not in the TIFF**. One `.h5` per acquisition, one dataset per signal, plain sample
   arrays at the sample rate. There is **no timestamp dataset**, hence the frame-clock copy in step 2:
   the first frame-clock edge in the `.h5` is TIFF frame 1.

### 2d. (Optional) photodiode as an image channel

1. Photodiode amplifier → PCIe **rear SMB AI3** (this is Channel 4). Keep the signal **within 0.5–2 Vpp**
   (attenuate a 5 V amplifier output; overvoltage protection is ±10 V but the ADC clips).
2. **Channels** window → Channel 4 → **Save** and **Display**.
3. Result: an image whose pixel values are the light hitting the diode *during the imaged part of each
   line* — the most direct picture of "is any LED light present while pixels are being formed". The gap
   flash itself is invisible here (not sampled), which is what the Data Recorder copy is for.

## 3. Verifying it worked (do a 10 s Grab before the real run)

1. **Aux triggers** — read a frame header:
   - MATLAB: `[header, ~, imgInfo] = scanimage.util.opentif('file_00001.tif');` and look at the per-frame
     fields, or open the TIFF's `ImageDescription` with `imfinfo` and search for `Aux Trigger`.
   - Python: `from ScanImageTiffReader import ScanImageTiffReader; r = ScanImageTiffReader(p); print(r.description(100))`
     ([ScanImage Tiff Reader](https://vidriotech.gitlab.io/scanimage-tiff-reader/)).
   - Expect `Aux Trigger 1 = [ … 5–6 values … ]` on every frame while the arena is running, `[]` while it
     is stopped. `[]` on every frame = wrong port or the arena's DIO 1 is not in `out_debug_framescan`
     (`01 AD` from the Studio prints the roles).
   - Also check `frameTimestamps_sec` is present on every frame and that the key list is complete
     (`auxTrigger0…3, I2CData` all present) — a missing tail means the header buffer overflowed.
2. **Data Recorder** — open the `.h5` (HDFView, `h5py`, or MATLAB `h5read`): one dataset per signal,
   length ≈ sample rate × grab duration, line-clock dataset toggling at ~15.8 kHz, AO dataset stepping
   with the protocol, frame-clock dataset with one pulse per 18.18 ms.
3. **Image channel** — Channel 4 shows the photodiode; with the display off it is flat.
4. Cross-check: the number of frame-clock edges in the `.h5` equals the number of TIFF pages per channel.

## 4. Recommended hook-up for the duty-sweep run (summary)

| Signal | Source | vDAQ input | Route |
|---|---|---|---|
| Line clock | D3.0 (Line clock out) | → arena J4, and AI0 | Data Recorder |
| Frame clock | D3.1 (Frame clock out) | D2.1 and AI3 | aux trigger 2 + Data Recorder |
| Frame-transfer envelope | arena J3 (DIO 1) | D2.0 and AI2 | aux trigger 1 + Data Recorder |
| Condition marker | arena J27 (AO) | AI1 | Data Recorder |
| Photodiode | amplifier | AI4, and SMB AI3 (Ch4) | Data Recorder + image channel |
| Leak (what you measure) | SiPM | Ch2 (gated), Ch3 (ungated) | TIFF |

Everything digital is 5 V TTL into 5 V-tolerant vDAQ inputs; the arena's BNC outputs are level-translated
5 V. Use BNC T-pieces on the two clock lines, not daisy chains through the arena.

## 5. What was missing on 22 Sept and why it mattered

The handover notes "Header aux-trigger fields 0–3 and I2C are empty. No line clock / frame clock / arena
sync recorded." With §2b–2c in place, the 300 Hz phase is measured directly from `Aux Trigger 1` rather
than fitted at 300.03 Hz, the condition boundaries come from the AO trace rather than frame-number
guesses, and the photodiode separates LED light during the imaged line from detector recovery after an
in-gap flash — the open question the firmware change cannot answer by itself.
