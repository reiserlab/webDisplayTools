# Experiment Designer v0.6 Testing Guide

Manual testing checklist for the YAML v2 migration, plugin support, and new editor views.

**Date:** 2026-04-01
**Test URL:** `http://localhost:8080/experiment_designer.html` (or GitHub Pages)
**Start server:** `python3 -m http.server 8080`

---

## 1. Fresh Experiment — Basic Functionality

### 1.1 Page loads without errors
- [ ] Open the page in Chrome
- [ ] Open DevTools Console (F12) — no JavaScript errors
- [ ] Footer shows "Experiment Designer v0.6"
- [ ] Left panel shows: Experiment, Arena, Rig Path, Structure, Phases, Plugins sections
- [ ] Tab bar shows: VISUAL | TABLE | TIMELINE
- [ ] Bottom timeline shows one condition block (condition_1, 5s)

### 1.2 Settings panel
- [ ] Fill in Name, Author fields
- [ ] Change Arena dropdown — summary updates below
- [ ] Type a rig path in "Rig Path (V2)" field
- [ ] Change Repetitions — summary updates in toolbar
- [ ] Toggle Randomize checkbox — seed field appears/disappears

### 1.3 Phases
- [ ] Enable Pretrial checkbox — PRE block appears on timeline, toggle turns green
- [ ] Enable Intertrial — ITI blocks appear between conditions
- [ ] Enable Posttrial — POST block appears at end
- [ ] Click PRE block on timeline — Visual tab shows phase editor with command cards
- [ ] Phase editor shows "Commands (2)" with allOff + wait 0.5s cards

### 1.4 Conditions
- [ ] Click "+ Add Condition" — new condition appears on timeline
- [ ] Click a condition on timeline — Visual editor shows "Condition N" with command cards
- [ ] Click "Remove" button — condition removed (only if >1 condition)
- [ ] Drag conditions on timeline to reorder

---

## 2. Plugin System

### 2.1 Enable plugins
- [ ] Scroll down in left panel to "Plugins" section
- [ ] Check "LED Backlight" — config card expands showing Serial Port field
- [ ] Check "BIAS Camera" — config card expands showing Video Format + Frame Rate
- [ ] Both checkboxes have green accent when enabled

### 2.2 Plugin commands in dropdown
- [ ] Select a condition on timeline
- [ ] Click the "+ Add Command..." dropdown at bottom of Visual editor
- [ ] Verify dropdown shows:
  - Controller: Trial Params, All On, All Off, Stop Display, Set Position X, Set Color Depth
  - Wait
  - Plugin: LED Backlight: Set IR LED Power, Set Red/Green/Blue LED Power, Turn On/Off LED, Visible Backlights Off
  - Plugin: BIAS Camera: Start/Stop Recording, Start Preview, Stop Capture, Get Timestamp, Disconnect
- [ ] Select "Get Timestamp" from Camera section — blue plugin card appears
- [ ] Select "Wait" — gray wait card appears with duration field
- [ ] Select "Set Red LED Power" from Backlight — blue plugin card appears

### 2.3 Plugin disable warning
- [ ] With plugin commands added to a condition, uncheck the plugin checkbox
- [ ] Confirm warning dialog appears about existing commands
- [ ] Cancel — checkbox stays checked
- [ ] Re-try and confirm — plugin unchecked, commands remain but plugin unavailable in dropdown

---

## 3. Command Card Editor (Visual Tab)

### 3.1 trialParams card
- [ ] Green left border, "controller" badge, "trialParams" label
- [ ] Edit Pattern field — timeline block updates with pattern name
- [ ] Edit Duration — timeline block width changes, summary total updates
- [ ] Change Mode to Closed-Loop — Frame Rate grays out, Gain activates
- [ ] Change Mode back to Constant Rate — Frame Rate activates, Gain grays out
- [ ] Edit Frame Rate, Gain, Start Frame fields

### 3.2 Plugin command cards
- [ ] Blue left border, "plugin" badge
- [ ] Shows "pluginName -> commandName" label
- [ ] Commands with params show editable fields (e.g., power, panel_num, pattern)
- [ ] Commands without params show just the header (e.g., getTimestamp, turnOnLED)

### 3.3 Wait cards
- [ ] Gray left border, "wait" badge
- [ ] Duration field editable

### 3.4 Delete commands
- [ ] Each card (except when only 1 command) shows x delete button
- [ ] Click x — command removed, editor re-renders with updated count

### 3.5 Add commands
- [ ] "+ Add Command..." dropdown resets after selection
- [ ] New command appears at bottom of card list

---

## 4. Table View

### 4.1 Switch to Table tab
- [ ] Click TABLE tab — table renders with all sections
- [ ] PRETRIAL section at top (if enabled)
- [ ] CONDITION sections for each condition
- [ ] INTERTRIAL sections between conditions (if enabled)
- [ ] POSTTRIAL section at bottom (if enabled)

### 4.2 Section headers
- [ ] Each section shows name + duration badge on right
- [ ] Click header — section collapses/expands
- [ ] ITI sections default to collapsed

### 4.3 Table columns
- [ ] # (row number), Type (badge), Target, Command, Dur, Mode, FR, Pattern/Params, actions
- [ ] Type badges: green "controller", gray "wait", blue "plugin"
- [ ] Irrelevant cells show gray "—" dash
- [ ] Plugin params display as "key: value, key: value" format

### 4.4 Row click
- [ ] Click a row in a condition section — row highlights green
- [ ] Bottom timeline highlights the corresponding condition

---

## 5. Multi-Lane Timeline View

### 5.1 Basic rendering
- [ ] Click TIMELINE tab — shows placeholder if no selection
- [ ] Click a condition on bottom timeline — SVG renders with lane diagram
- [ ] Header shows "Condition N: condition_id"
- [ ] Time axis with tick marks

### 5.2 Lane types
- [ ] **Controller** lane (green label): trialParams shows as green bar spanning duration
- [ ] **Plugin** lanes (blue labels): one lane per plugin used in this condition
- [ ] Plugin events show as blue circle markers at correct time positions
- [ ] Command labels appear next to markers
- [ ] **Waits** row: gray bars showing each wait duration

### 5.3 Timing verification
For a condition with: getTimestamp, trialParams(10s), wait(3s), setRedLEDPower, wait(4s), setVisibleBacklightsOff, wait(3s):
- [ ] Controller bar spans 0-10s
- [ ] Camera getTimestamp dot at t=0
- [ ] Backlight setRedLEDPower dot at t=3 (after first wait)
- [ ] Backlight setVisibleBacklightsOff dot at t=7 (after second wait)
- [ ] Wait bars: 3s, 4s, 3s

### 5.4 Selection sync
- [ ] Click different conditions on bottom timeline — SVG updates to show that condition
- [ ] Hover over SVG elements — native tooltips appear with command details

---

## 6. V2 YAML Export

### 6.1 Export structure
- [ ] Click "Export YAML" button — downloads .yaml file
- [ ] Open in text editor and verify:
  - `version: 2`
  - `rig: "path/to/rig.yaml"`
  - `plugins:` section with enabled plugins
  - `experiment_structure:` with repetitions + randomization
  - `pretrial:` / `intertrial:` / `posttrial:` with `include:` and `commands:[]`
  - `block: conditions:` with full command arrays per condition
  - Plugin commands have `type: "plugin"`, `plugin_name:`, `command_name:`, optional `params:`

### 6.2 Plugin config in export
- [ ] Enabled plugins include `matlab: class:` field
- [ ] Plugin config fields (port, frame_rate, etc.) appear under `config:`

---

## 7. V2 YAML Import

### 7.1 Import Lisa's test file
- [ ] Click "Import YAML"
- [ ] Select `tests/fixtures/v2_full_experiment_test.yaml`
- [ ] Verify:
  - Name: "G4.1 Test Experiment using Bias and backlight"
  - Author: "Reiser Lab"
  - Rig path populated
  - 9 conditions appear on timeline
  - Pretrial, Intertrial, Posttrial all enabled
  - LED Backlight and BIAS Camera plugins checked in left panel

### 7.2 Multi-command conditions preserved
- [ ] Click condition 1 (sq_grating_30deg_gs2) in Visual tab
- [ ] Should show 7 commands: plugin(getTimestamp), controller(trialParams), wait(3), plugin(setRedLEDPower), wait(4), plugin(setVisibleBacklightsOff), wait(3)
- [ ] Pattern: pat01_sq_grating_30deg_gs2_G4.pat
- [ ] setRedLEDPower shows params: power=5, panel_num=0, pattern=1010

### 7.3 Table view shows all commands
- [ ] Switch to TABLE tab
- [ ] PRETRIAL section: 8 commands including allOn, wait, allOff, backlight commands, camera startRecording
- [ ] Each condition section shows full command list with correct params

### 7.4 Timeline view
- [ ] Switch to TIMELINE tab, click condition 1
- [ ] Controller bar 0-10s, camera dot at 0, backlight dots at 3s and 7s, three wait bars (3s, 4s, 3s)

---

## 8. Roundtrip Integrity

### 8.1 Import → Export → Reimport
- [ ] Import `v2_full_experiment_test.yaml`
- [ ] Export YAML
- [ ] Reimport the exported file
- [ ] Verify same number of conditions, same command counts, same plugin state

### 8.2 Automated test suites
```bash
# Web-side CI tests (130 checks)
node tests/test-protocol-roundtrip.js

# Generate test protocols for MATLAB
node tests/generate-roundtrip-protocol.js --outdir ../maDisplayTools/tests/web_generated_patterns

# MATLAB validation (35 checks, requires MATLAB)
cd ../maDisplayTools
matlab -r "addpath('tests'); validate_web_protocol_roundtrip('v2'); exit"
```

---

## 9. Files Changed This Session

### New files
| File | Purpose |
|------|---------|
| `js/protocol-yaml.js` | Shared YAML parser + v1/v2 generators, inline comment stripping |
| `js/plugin-registry.js` | Plugin definitions (backlight 7 cmds, camera 6 cmds, controller 6 cmds) |
| `tests/fixtures/v2_full_experiment_test.yaml` | maDisplayTools v2 fixture (9 conditions, camera+backlight) |
| `tests/fixtures/v2_simple_backlight_test.yaml` | maDisplayTools v2 fixture (5 backlight-only conditions) |
| `tests/fixtures/v2_all_possible_plugins.yaml` | maDisplayTools v2 fixture (all plugin types) |

### Modified files
| File | Changes |
|------|---------|
| `experiment_designer.html` | v0.2 -> v0.6: v2 data model (commands[]), plugin UI, 3 editor tabs, command cards, SVG timeline |
| `tests/test-protocol-roundtrip.js` | 49 -> 130 checks, imports shared module, 4 new v2 suites |
| `tests/generate-roundtrip-protocol.js` | Imports shared module, generates v2 protocol + manifest |
| `docs/protocol-roundtrip-testing.md` | Updated for v2 coverage |

### maDisplayTools changes
| File | Changes |
|------|---------|
| `tests/validate_web_protocol_roundtrip.m` | Activated v2 tests (35 checks), fixed ProtocolRunner API |
| `tests/web_generated_patterns/test_protocol_v2.yaml` | Generated v2 test protocol |
| `tests/web_generated_patterns/test_protocol_v2_manifest.json` | Expected values for v2 validation |
| `tests/web_generated_patterns/test_browser_export_v2.yaml` | Browser export test artifact |
