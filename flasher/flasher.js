// G6 Panel WebUSB flasher — drives the RP2350 PICOBOOT interface to write flash.
//
// FINAL HOME: flasher/ in reiserlab/webDisplayTools (deploy via GitHub Pages — WebUSB
// needs a secure context, which Pages https provides). Chromium/Edge only.
//
// Why WebUSB (not Web Serial): the existing webDisplayTools console uses Web *Serial*
// to talk to the arena controller, but flashing a panel's bootloader needs the RP2350
// PICOBOOT vendor interface, which is Web *USB*. Browsers also cannot use the UF2
// mass-storage drag-drop path, so we parse the UF2 client-side and stream its blocks
// over PICOBOOT (EXCLUSIVE_ACCESS -> EXIT_XIP -> FLASH_ERASE -> WRITE -> REBOOT2).
//
// The PICOBOOT framing here follows the RP2350 datasheet / picoboot interface. It is
// modeled on piersfinlayson/picoflash (MIT) — validate against real hardware and that
// reference before production use.

const RP_VID = 0x2e8a;
// Firmware is served from the firmware repo's GitHub Pages, NOT its GitHub
// Release. Release-asset downloads (release-assets.githubusercontent.com) send
// no CORS header, so a browser fetch() of them is blocked. This Pages site and
// the flasher both live on reiserlab.github.io, so fetching here is SAME-ORIGIN
// — no CORS at all. (The g6-flash CLI still uses the Release; non-browser
// clients don't enforce CORS.) Published by the firmware repo's release.yml.
const FW_BASE = "https://reiserlab.github.io/LED-Display_G6_Firmware_Panel";
const FLASH_XIP_BASE = 0x10000000;
const SECTOR = 4096;           // RP2350 flash erase granularity
const WRITE_CHUNK = 256;       // PICOBOOT WRITE granularity (UF2 payloads are 256B)

// --- PICOBOOT command framing ---------------------------------------------------
const PICOBOOT_MAGIC = 0x431fd10b;
const CMD = {
  EXCLUSIVE_ACCESS: 0x01,
  FLASH_ERASE: 0x03,
  WRITE: 0x05,
  EXIT_XIP: 0x06,
  REBOOT2: 0x0a, // RP2350 reboot
};
let token = 1;

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(msg, cls) { const s = $("status"); s.textContent = msg; s.className = cls || ""; }

// --- UF2 parsing ----------------------------------------------------------------
// Returns sorted [{addr, data:Uint8Array(256)}], one per 512-byte UF2 block.
function parseUF2(buf) {
  const dv = new DataView(buf);
  const blocks = [];
  for (let off = 0; off + 512 <= buf.byteLength; off += 512) {
    if (dv.getUint32(off, true) !== 0x0a324655) continue;       // magicStart0 "UF2\n"
    if (dv.getUint32(off + 4, true) !== 0x9e5d5157) continue;   // magicStart1
    if (dv.getUint32(off + 508, true) !== 0x0ab16f30) continue; // magicEnd
    const flags = dv.getUint32(off + 8, true);
    if (flags & 0x00000001) continue;                            // "not main flash" block
    const addr = dv.getUint32(off + 12, true);
    const size = dv.getUint32(off + 16, true);
    const data = new Uint8Array(buf, off + 32, Math.min(size, 256));
    blocks.push({ addr, data: data.slice() });
  }
  blocks.sort((a, b) => a.addr - b.addr);
  if (!blocks.length) throw new Error("no flashable UF2 blocks found");
  return blocks;
}

// --- PICOBOOT device ------------------------------------------------------------
class Picoboot {
  constructor(device) {
    this.dev = device;
    this.epOut = null;
    this.epIn = null;
    this.iface = null;
    this.inMax = 64; // IN endpoint max packet size; read acks rounded up to this
  }

  async open() {
    await this.dev.open();
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
    // The PICOBOOT interface is the vendor-specific one (class 0xFF) with two bulk EPs.
    for (const iface of this.dev.configuration.interfaces) {
      const alt = iface.alternate;
      if (alt.interfaceClass !== 0xff) continue;
      const out = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      const inp = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
      if (out && inp) {
        this.iface = iface.interfaceNumber;
        this.epOut = out.endpointNumber;
        this.epIn = inp.endpointNumber;
        this.inMax = inp.packetSize || 64;
        break;
      }
    }
    if (this.iface === null) throw new Error("no PICOBOOT interface — is the panel in BOOTSEL mode?");
    await this.dev.claimInterface(this.iface);

    // Reset the PICOBOOT interface before issuing any command. This vendor
    // INTERFACE_RESET (request 0x41) clears any half-finished command and the
    // bulk-endpoint data toggles in the bootrom. Without it the bootrom stalls
    // the very first bulk transfer and WebUSB throws "A transfer error has
    // occurred". (matches picotool / piersfinlayson/picoflash on connect.)
    await this.dev.controlTransferOut({
      requestType: "vendor",
      recipient: "interface",
      request: 0x41, // PICOBOOT_INTERFACE_RESET
      value: 0,
      index: this.iface,
    });
  }

  async close() {
    try { await this.dev.releaseInterface(this.iface); } catch {}
    try { await this.dev.close(); } catch {}
  }

  // Build a 32-byte PICOBOOT command packet. cmdSize is the number of MEANINGFUL
  // argument bytes for THIS command (NOT the 16-byte args-field width). The
  // bootrom validates bCmdSize and rejects the command (INVALID_CMD_LENGTH,
  // surfacing as a bulk stall) if it is wrong — so each command passes its own.
  _packet(cmdId, cmdSize, transferLen, args) {
    const b = new ArrayBuffer(32);
    const dv = new DataView(b);
    dv.setUint32(0, PICOBOOT_MAGIC, true);
    dv.setUint32(4, token++, true);
    dv.setUint8(8, cmdId);
    dv.setUint8(9, cmdSize);
    dv.setUint16(10, 0, true);
    dv.setUint32(12, transferLen, true);
    if (args) new Uint8Array(b, 16).set(new Uint8Array(args));
    return b;
  }

  // Command with no data phase: send packet, then read the ZLP ack on IN.
  async _cmd(cmdId, cmdSize, args) {
    await this.dev.transferOut(this.epOut, this._packet(cmdId, cmdSize, 0, args));
    await this.dev.transferIn(this.epIn, this.inMax); // status / ZLP ack
  }

  // Command with an OUT data phase: send packet, send data, read ZLP ack on IN.
  async _cmdWrite(cmdId, cmdSize, args, data) {
    await this.dev.transferOut(this.epOut, this._packet(cmdId, cmdSize, data.byteLength, args));
    await this.dev.transferOut(this.epOut, data);
    await this.dev.transferIn(this.epIn, this.inMax);
  }

  _args(...u32) {
    const b = new ArrayBuffer(16);
    const dv = new DataView(b);
    u32.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
    return b;
  }

  // cmdSize = meaningful arg bytes per RP2350 bootrom command definition.
  exclusiveAccess() { return this._cmd(CMD.EXCLUSIVE_ACCESS, 1, this._args(1)); } // 1 = EXCLUSIVE
  exitXip() { return this._cmd(CMD.EXIT_XIP, 0, null); }
  flashErase(addr, size) { return this._cmd(CMD.FLASH_ERASE, 8, this._args(addr, size)); }
  write(addr, data) { return this._cmdWrite(CMD.WRITE, 8, this._args(addr, data.byteLength), data); }
  reboot() { return this._cmd(CMD.REBOOT2, 16, this._args(0, 100, 0, 0)); } // flags=0, delay=100ms

  // GET_COMMAND_STATUS (vendor control request 0x42): turns an opaque bulk
  // stall into the bootrom's named error. Returns a string or null.
  async getStatus() {
    try {
      const r = await this.dev.controlTransferIn(
        { requestType: "vendor", recipient: "interface", request: 0x42, value: 0, index: this.iface },
        16,
      );
      if (r.status !== "ok" || !r.data || r.data.byteLength < 9) return null;
      const NAMES = ["OK", "UNKNOWN_CMD", "INVALID_CMD_LENGTH", "INVALID_TRANSFER_LENGTH",
        "INVALID_ADDRESS", "BAD_ALIGNMENT", "INTERLEAVED_WRITE", "REBOOTING", "UNKNOWN_ERROR",
        "INVALID_STATE", "NOT_PERMITTED", "INVALID_ARG", "BUFFER_TOO_SMALL", "PRECONDITION_NOT_MET",
        "MODIFIED_DATA", "INVALID_DATA", "NOT_FOUND", "UNSUPPORTED_MODIFICATION"];
      const code = r.data.getUint32(4, true);
      return `${NAMES[code] || "code " + code} (last cmd 0x${r.data.getUint8(8).toString(16)})`;
    } catch { return null; }
  }
}

async function flashBlocks(pb, blocks, onProgress) {
  await pb.exclusiveAccess();
  await pb.exitXip();

  // Erase the sector-aligned span covering every write.
  const minAddr = blocks[0].addr & ~(SECTOR - 1);
  const lastEnd = blocks[blocks.length - 1].addr + blocks[blocks.length - 1].data.byteLength;
  const maxAddr = (lastEnd + SECTOR - 1) & ~(SECTOR - 1);
  log(`Erasing 0x${minAddr.toString(16)}…0x${maxAddr.toString(16)} (${(maxAddr - minAddr) / 1024} KiB)`);
  for (let a = minAddr; a < maxAddr; a += SECTOR) await pb.flashErase(a, SECTOR);

  // Write each 256-byte block.
  for (let i = 0; i < blocks.length; i++) {
    const { addr, data } = blocks[i];
    let chunk = data;
    if (chunk.byteLength < WRITE_CHUNK) {
      const padded = new Uint8Array(WRITE_CHUNK).fill(0xff);
      padded.set(chunk);
      chunk = padded;
    }
    await pb.write(addr, chunk);
    onProgress((i + 1) / blocks.length);
  }
  log("Rebooting panel into firmware…");
  try { await pb.reboot(); } catch { /* device drops as it reboots — expected */ }
}

// --- Firmware catalog (firmware repo's GitHub Pages, same-origin) ----------------
// manifest.json is a build CATALOG: artifacts[] = { rev, variant, label, file,
// sha256, usb_product, default }, plus top-level version / commit / built. The
// dropdown is populated straight from it, so new builds appear automatically.
let firmware = { version: null, commit: "", built: "", builds: [], byFile: {} };
let chosenFile = null;

async function resolveFirmware() {
  // no-store: always pick up the newest catalog the firmware repo published.
  const res = await fetch(`${FW_BASE}/manifest.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest.json HTTP ${res.status}`);
  const m = await res.json();
  firmware.version = m.version || "(unknown)";
  firmware.commit = m.commit || "";
  firmware.built = m.built || "";
  firmware.builds = m.artifacts || [];
  firmware.byFile = Object.fromEntries(firmware.builds.map((b) => [b.file, b]));

  populateBuilds();
  const id = [firmware.version, firmware.commit, firmware.built].filter(Boolean).join("  ·  ");
  $("build-meta").textContent = id || "(no metadata)";
  log(`Firmware ${id} — ${firmware.builds.length} build(s): ` +
      firmware.builds.map((b) => b.label || `${b.rev}/${b.variant}`).join(", "));
}

// Fill the dropdown from the catalog and select the manifest's default build.
function populateBuilds() {
  const sel = $("build-select");
  sel.innerHTML = "";
  for (const b of firmware.builds) {
    const o = document.createElement("option");
    o.value = b.file;
    o.textContent = b.label || `${b.rev} — ${b.variant}`;
    if (b.default) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = firmware.builds.length === 0;
  onBuildChange();
}

// Sync state + UI to the selected build: enable Flash and caution on non-production builds.
function onBuildChange() {
  chosenFile = $("build-select").value || null;
  const b = chosenFile ? firmware.byFile[chosenFile] : null;
  $("flash-btn").disabled = !b;
  const note = $("build-note");
  if (b && b.variant && b.variant !== "production") {
    note.hidden = false;
    note.innerHTML = `<strong>${b.label || b.variant}</strong> is a bench / bring-up build: it runs a ` +
      `visible self-test and has <em>no SPI ingest</em>. Re-flash a <strong>Production</strong> build ` +
      `before deploying the panel.`;
  } else {
    note.hidden = true;
  }
  setStatus("");
}

// --- Verify after flash ---------------------------------------------------------
// After REBOOT2 the panel re-enumerates as the firmware USB-serial device. We can't
// silently re-grab it (WebUSB needs a user gesture per device), so confirm via the
// product string of any already-granted device, else ask the operator to confirm.
async function verifyBuild(b) {
  const want = b.usb_product || "";
  const granted = await navigator.usb.getDevices();
  const match = granted.find((d) => d.vendorId === RP_VID && want && (d.productName || "").startsWith(want));
  if (match) {
    setStatus(`Verified: ${match.productName} ✓`, "status-ok");
    log(`Verified panel reports "${match.productName}".`, "status-ok");
  } else {
    setStatus(`Flashed ${b.label || b.file}. Confirm the panel boots as expected.`, "status-ok");
    log("Flash complete. (Auto-verify needs a re-grant; confirm the panel visually.)");
  }
}

// --- Live panel status (popup-free; reflects already-granted devices) -----------
// WebUSB can't silently enumerate ungranted devices (browser security), but
// getDevices() lists ones the user has authorized — e.g. after a flash, or the
// one-time "Grant access" link below — and stays current as they attach/detach.
// We poll ~1 Hz and listen for connect/disconnect. Each USB identity (running
// firmware = pid 0x0009, BOOTSEL = pid 0x000f) is granted separately.
async function refreshPanelStatus() {
  const el = $("panel-status");
  if (!el || !navigator.usb) return;
  let devs = [];
  try { devs = await navigator.usb.getDevices(); } catch { return; }
  const panels = devs.filter((d) => d.vendorId === RP_VID);
  const boot = panels.find((d) => d.productId === 0x000f);
  const app = panels.find((d) => d.productId !== 0x000f);

  let key, cls, html;
  if (boot) {
    key = "boot"; cls = "ok"; html = "● Panel in BOOTSEL — ready to flash";
  } else if (app) {
    key = "app:" + (app.productName || ""); cls = "dim";
    html = `● Panel running firmware${app.productName ? ` (${app.productName})` : ""} — hold BOOT + tap RUN for BOOTSEL`;
  } else {
    key = "none"; cls = "dim";
    html = `○ No panel detected. <a id="grant-link">Grant access</a> to watch one here (one-time).`;
  }
  if (el.dataset.key === key) return; // only re-render on a state change
  el.dataset.key = key;
  el.className = cls;
  el.innerHTML = html;
  const g = $("grant-link");
  if (g) g.onclick = async () => {
    try { await navigator.usb.requestDevice({ filters: [{ vendorId: RP_VID }] }); } catch { /* cancelled */ }
    el.dataset.key = ""; refreshPanelStatus();
  };
}

// --- UI wiring ------------------------------------------------------------------
async function onFlashClick() {
  const b = chosenFile ? firmware.byFile[chosenFile] : null;
  if (!b) return;
  const url = `${FW_BASE}/${b.file}`;

  let device, pb;
  try {
    $("flash-btn").disabled = true;
    setStatus("Requesting panel…");
    device = await navigator.usb.requestDevice({ filters: [{ vendorId: RP_VID }] });

    if (device.productId !== 0x000f) {
      setStatus("That panel is not in BOOTSEL mode.", "status-err");
      log(`Picked device "${device.productName || "?"}" (pid 0x${device.productId.toString(16)}). ` +
          "Put it in BOOTSEL (hold BOOT, plug in or tap RUN), then retry.", "status-err");
      $("flash-btn").disabled = false;
      return;
    }

    log(`Downloading ${b.label || b.file}…`);
    const uf2 = await (await fetch(url)).arrayBuffer();
    const blocks = parseUF2(uf2);
    log(`UF2: ${blocks.length} blocks (${(blocks.length * 256 / 1024).toFixed(0)} KiB).`);

    pb = new Picoboot(device);
    await pb.open();

    const prog = $("progress");
    prog.hidden = false; prog.value = 0;
    setStatus(`Flashing ${b.label || b.file}…`);
    await flashBlocks(pb, blocks, (f) => { prog.value = Math.round(f * 100); });

    await verifyBuild(b);
  } catch (err) {
    // A bulk stall surfaces as an opaque "transfer error"; ask the bootrom what
    // actually went wrong (e.g. INVALID_CMD_LENGTH, BAD_ALIGNMENT).
    let extra = "";
    if (pb) { const s = await pb.getStatus(); if (s) extra = ` [PICOBOOT: ${s}]`; }
    setStatus(`Failed: ${err.message}`, "status-err");
    log(`ERROR: ${err.message}${extra}`, "status-err");
    $("flash-btn").disabled = false;
  } finally {
    if (pb) await pb.close();
  }
}

function main() {
  if (!("usb" in navigator)) {
    $("unsupported").style.display = "block";
    $("app").style.display = "none";
    return;
  }
  $("build-select").addEventListener("change", onBuildChange);
  $("flash-btn").addEventListener("click", onFlashClick);

  // Live panel detection — no popup once a panel has been granted.
  refreshPanelStatus();
  setInterval(refreshPanelStatus, 1000);
  navigator.usb.addEventListener("connect", refreshPanelStatus);
  navigator.usb.addEventListener("disconnect", refreshPanelStatus);

  resolveFirmware().catch((e) => {
    $("build-meta").textContent = "unavailable";
    log(`Could not resolve firmware catalog: ${e.message}`, "status-err");
  });
}

main();
