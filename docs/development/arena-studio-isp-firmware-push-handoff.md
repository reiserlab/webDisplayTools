# Handoff — Arena Studio: ISP firmware-push from the official build catalog

**Target session:** the Arena Studio build-out (see `docs(arena-studio)` wireframes/handover on this
branch's parent, `docs/arena-studio-wireframes`).
**Goal:** Arena Studio gets a "Panel firmware" flow that fetches **official footered ISP images**
from the firmware repo's published catalog and pushes them to panels over the arena — no local
toolchain, no hand-carried files. This doc gives you the catalog schema, the wire flow, working
reference code, and same-origin dev artifacts committed alongside.

## 1. The pipeline that feeds you (already built)

- Firmware repo `reiserlab/LED-Display_G6_Firmware_Panel`, workflow `.github/workflows/release.yml`.
  Tagging `panel-fw-v*` builds every catalog entry and publishes **UF2s + footered ISP `.bin`s +
  `manifest.json`** to (a) the GitHub Release and (b) **GitHub Pages**:
  `https://reiserlab.github.io/LED-Display_G6_Firmware_Panel/`
- **Fetch from Pages, never from Release assets** — release-asset downloads send no CORS headers;
  Pages shares the `reiserlab.github.io` origin with this site, so `fetch()` is same-origin. (Same
  pattern as `flasher/flasher.js` `FW_BASE`.)
- The ISP-image publishing was added in firmware-repo **PR #17** (`release-isp-images` branch).
  Until it merges *and* a tag is cut, the live Pages catalog has **no** `bin` entries — use the
  dev artifacts in §3.

## 2. Catalog schema (manifest.json)

Top level: `version` (release tag), `commit`, `built`, `artifacts[]`. Each artifact is one
*selectable build* — UF2 and ISP `.bin` are two optional nested dicts on the SAME entry, not
separate list entries:

| field | meaning |
|---|---|
| `rev` | hardware revision, `v0.2.1` / `v0.3.1` |
| `variant` | `production` \| `bcmtest` \| future |
| `label` | human label for dropdowns |
| `usb_product` | expected USB product string post-flash (`G6 Panel v0.3` / `v0.2`) |
| `default` | true on exactly one entry that HAS a `uf2` (the WebUSB flasher's initial selection) |
| **`uf2`: `{file, sha256}`** | UF2 (BOOTSEL/WebUSB flashing — the existing flasher's food). Optional. |
| **`bin`: `{file, sha256}`** | **the footered ISP image — Arena Studio's food.** Optional. |

`bin.file` = raw flash image + 32-byte trailer `{magic[8]="G6PANFW\0", version[16]=release tag,
crc32 (zlib, u32 LE), size (u32 LE)}`. The arena controller validates this footer before flashing
("bad footer magic" = wrong/unfootered file). Verify `bin.sha256` after fetch before pushing.

## 3. Dev artifacts (committed here, same-origin — develop against these today)

`flasher/firmware/` + **`flasher/firmware/manifest-dev.json`** (schema-identical to the official
manifest, 4 entries):

- `g6-panel-v0.{3,2}.1-isp-progress-23d66af.bin` (+ matching UF2s) — **dev build with the visual
  programming indicator**: panels draw a progress bar (central 10 rows) while being ISP-flashed and
  a smiley on the new image's first boot. Firmware-repo branch `isp-progress-display` (23d66af).
- `g6-panel-v0.{3,2}.1-isp-fleet-dd7d3f9.bin` — the build the whole arena runs today (PR #15).

Point your dev fetch at `flasher/firmware/manifest-dev.json`; flip to the Pages URL when PR #17 +
a release tag land. Entries with no `uf2` key are ISP-only (no UF2 staged).

## 4. The push flow (wire level — all encoders/decoders exist in `js/arena-wire-g6.js`)

1. **Upload to arena SD:** `encodeSetFirmwareFile(bytes)` → `0xE0` (opcode-first framing:
   `[0xE0, len u64 LE, data…]`). Reply payload = u32 LE CRC-32 of stored bytes — compare against a
   local `crc32(bytes)` before proceeding. Long transfer (~140 KB); generous timeout.
2. **(Optional) confirm what's on SD:** `encodeGetFirmwareInfo()` → `0xE3`; `decodeFirmwareInfo()`
   returns `{magic, version, imageCrc32, imageSize}` — `version` is the release tag. Great UI field.
3. **Per panel:** `encodeG6ProgramPanel(n)` → `0xC8` (1-based index). Long-running: the
   controller stages ~540 pages over SPI, then POLLS the panel's commit receipt (15 s ceiling)
   and post-reboot liveness (12 s ceiling) instead of fixed waits, so it returns as soon as the
   panel is back up (~3.2 s typical, fleet-validated; ceilings bound the worst case).
   `decodeProgramPanelResponse()` gives `{ok, status, message}` with the
   controller's step-by-step failure text; the success message now carries a per-phase timing
   summary.
4. **Verify:** `encodeG6VerifyPanel(n)` → `0xC9` — CRCs the panel's live app flash against the SD
   footer. `MATCH` = that exact release is installed. Non-destructive; also useful as a fleet
   "which version is everyone running?" audit loop.
5. **What the human sees** (with the progress-indicator firmware running on the target): one
   weighted bar spans the visible process: upload sweeps columns 0-16, verify lights 17, the
   LittleFS commit animates 17-20 (full bar = staged, reboot imminent) → dark during the OTA
   copy → **smiley** held until the first real display frame arrives. Failed panels: **sad
   smiley** on a failed commit, or no smiley after the dark window.

**Reference implementation that ran the real fleet reflash (2026-07-02):** the Python tool
`isp_roundtrip.py` (firmware-session scratchpad; mirrors this exact flow with response-frame
scanning + timeouts — `upload` / `info` / `verify` / `program`). The console runner should mirror
its behavior: scan for `[len, status, echo==cmd, payload…]`, tolerate debug chatter, 240 s program
timeout, always verify after program.

## 5. UX suggestions (from the fleet-reflash experience)

- Batch mode: ordered panel list → per-panel {pre-verify (expect MISMATCH), program, post-verify
  (require MATCH)} with a stop-on-failure toggle; show the controller's `message` text verbatim.
- Show SD-card state (`0xE3` footer version) persistently — "arena is loaded with panel-fw-v1.0.0".
- Sequential only — one `0xC8` at a time (the controller ISPs one panel per command).
- The controller now polls the panel back to life before answering `0xC8`, so a success response
  means the panel already rebooted and is answering COMM_CHECK; verify right after.

## 6. Gotchas

- **CORS:** Pages ✓, Release assets ✗, same-origin dev files ✓.
- Panels running firmware **older than 23d66af show no progress bar** (the bar is drawn by the
  *running* firmware). First reflash is visually silent; every subsequent one shows the bar + 😊.
- The smiley persists across power cycles until the panel's first display command — that's by
  design (flag file retired on first content).
- `0xC8`/`0xC9` are 1-based panel indices matching the panel-map labels.
- Don't push non-footered files; the controller rejects them ("bad footer magic") — that's the
  guard working.

## 7. Status ledger (2026-07-02)

| piece | state |
|---|---|
| Footer format + `make_isp_image.py` | shipped, hardware-validated (fleet runs its output) |
| Release pipeline publishes ISP bins | firmware repo **PR #17** (open) |
| Merged production firmware (two-PIO+ISP) | firmware repo **PR #15** (open; fleet already runs it) |
| Progress-bar/smiley firmware | branch `isp-progress-display` (23d66af; USB-validated, arena ISP demo pending) |
| Dev artifacts + this doc | merged (webDisplayTools PR #134) |
| Arena Studio fetch/push UI | ✅ **shipped 2026-07-02** — `arena_studio.html` Console → panel-firmware tile → Choose… modal: consumes BOTH manifests (published Pages + `manifest-dev.json`, refreshed per open), verifies `bin.sha256` post-fetch, validates the G6PANFW footer, checks the 0xE0 stored-CRC against a local crc32 before any flash, 240 s program timeouts, on-SD footer version shown at connect. Single + batch (retry-once, per-panel report, blink progress map) included. |
