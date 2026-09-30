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
const FW_BASE = 'https://reiserlab.github.io/LED-Display_G6_Firmware_Panel';
const FLASH_XIP_BASE = 0x10000000;
const SECTOR = 4096; // RP2350 flash erase granularity
const WRITE_CHUNK = 256; // PICOBOOT WRITE granularity (UF2 payloads are 256B)

// --- PICOBOOT command framing ---------------------------------------------------
const PICOBOOT_MAGIC = 0x431fd10b;
const CMD = {
    EXCLUSIVE_ACCESS: 0x01,
    FLASH_ERASE: 0x03,
    WRITE: 0x05,
    EXIT_XIP: 0x06,
    REBOOT2: 0x0a // RP2350 reboot
};
let token = 1;

const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(msg, cls) {
    const s = $('status');
    s.textContent = msg;
    s.className = cls || '';
}

// --- UF2 parsing ----------------------------------------------------------------
// Returns sorted [{addr, data:Uint8Array(256)}], one per 512-byte UF2 block.
function parseUF2(buf) {
    const dv = new DataView(buf);
    const blocks = [];
    for (let off = 0; off + 512 <= buf.byteLength; off += 512) {
        if (dv.getUint32(off, true) !== 0x0a324655) continue; // magicStart0 "UF2\n"
        if (dv.getUint32(off + 4, true) !== 0x9e5d5157) continue; // magicStart1
        if (dv.getUint32(off + 508, true) !== 0x0ab16f30) continue; // magicEnd
        const flags = dv.getUint32(off + 8, true);
        if (flags & 0x00000001) continue; // "not main flash" block
        const addr = dv.getUint32(off + 12, true);
        const size = dv.getUint32(off + 16, true);
        const data = new Uint8Array(buf, off + 32, Math.min(size, 256));
        blocks.push({ addr, data: data.slice() });
    }
    blocks.sort((a, b) => a.addr - b.addr);
    if (!blocks.length) throw new Error('no flashable UF2 blocks found');
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
            const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
            const inp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
            if (out && inp) {
                this.iface = iface.interfaceNumber;
                this.epOut = out.endpointNumber;
                this.epIn = inp.endpointNumber;
                this.inMax = inp.packetSize || 64;
                break;
            }
        }
        if (this.iface === null)
            throw new Error('no PICOBOOT interface — is the panel in BOOTSEL mode?');
        await this.dev.claimInterface(this.iface);

        // Reset the PICOBOOT interface before issuing any command. This vendor
        // INTERFACE_RESET (request 0x41) clears any half-finished command and the
        // bulk-endpoint data toggles in the bootrom. Without it the bootrom stalls
        // the very first bulk transfer and WebUSB throws "A transfer error has
        // occurred". (matches picotool / piersfinlayson/picoflash on connect.)
        await this.dev.controlTransferOut({
            requestType: 'vendor',
            recipient: 'interface',
            request: 0x41, // PICOBOOT_INTERFACE_RESET
            value: 0,
            index: this.iface
        });
    }

    async close() {
        try {
            await this.dev.releaseInterface(this.iface);
        } catch {}
        try {
            await this.dev.close();
        } catch {}
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
    exclusiveAccess() {
        return this._cmd(CMD.EXCLUSIVE_ACCESS, 1, this._args(1));
    } // 1 = EXCLUSIVE
    exitXip() {
        return this._cmd(CMD.EXIT_XIP, 0, null);
    }
    flashErase(addr, size) {
        return this._cmd(CMD.FLASH_ERASE, 8, this._args(addr, size));
    }
    write(addr, data) {
        return this._cmdWrite(CMD.WRITE, 8, this._args(addr, data.byteLength), data);
    }
    reboot() {
        return this._cmd(CMD.REBOOT2, 16, this._args(0, 100, 0, 0));
    } // flags=0, delay=100ms

    // GET_COMMAND_STATUS (vendor control request 0x42): turns an opaque bulk
    // stall into the bootrom's named error. Returns a string or null.
    async getStatus() {
        try {
            const r = await this.dev.controlTransferIn(
                {
                    requestType: 'vendor',
                    recipient: 'interface',
                    request: 0x42,
                    value: 0,
                    index: this.iface
                },
                16
            );
            if (r.status !== 'ok' || !r.data || r.data.byteLength < 9) return null;
            const NAMES = [
                'OK',
                'UNKNOWN_CMD',
                'INVALID_CMD_LENGTH',
                'INVALID_TRANSFER_LENGTH',
                'INVALID_ADDRESS',
                'BAD_ALIGNMENT',
                'INTERLEAVED_WRITE',
                'REBOOTING',
                'UNKNOWN_ERROR',
                'INVALID_STATE',
                'NOT_PERMITTED',
                'INVALID_ARG',
                'BUFFER_TOO_SMALL',
                'PRECONDITION_NOT_MET',
                'MODIFIED_DATA',
                'INVALID_DATA',
                'NOT_FOUND',
                'UNSUPPORTED_MODIFICATION'
            ];
            const code = r.data.getUint32(4, true);
            return `${NAMES[code] || 'code ' + code} (last cmd 0x${r.data.getUint8(8).toString(16)})`;
        } catch {
            return null;
        }
    }
}

async function flashBlocks(pb, blocks, onProgress) {
    await pb.exclusiveAccess();
    await pb.exitXip();

    // Erase the sector-aligned span covering every write.
    const minAddr = blocks[0].addr & ~(SECTOR - 1);
    const lastEnd = blocks[blocks.length - 1].addr + blocks[blocks.length - 1].data.byteLength;
    const maxAddr = (lastEnd + SECTOR - 1) & ~(SECTOR - 1);
    log(
        `Erasing 0x${minAddr.toString(16)}…0x${maxAddr.toString(16)} (${(maxAddr - minAddr) / 1024} KiB)`
    );
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
    log('Rebooting panel into firmware…');
    try {
        await pb.reboot();
    } catch {
        /* device drops as it reboots — expected */
    }
}

// --- Firmware catalog -----------------------------------------------------------
// Two manifests, identical schema (artifacts[] = { rev, variant, label, usb_product,
// default, fingerprint?, note?, legacy?, uf2: {file, sha256}, bin: {file, sha256} }):
//   1. FW_BASE/manifest.json — the firmware repo's PUBLISHED catalog. Its
//      `default: true` artifact is the one pre-selected. Since panel-fw-v1.3.0
//      it holds ONE production build (v0.3.1 hardware only; the 2P line-sync
//      behaviour is part of it).
//   2. firmware/legacy-manifest.json on THIS site — images kept only so a
//      replacement panel can match an arena that has not been reflashed yet.
//      Never a default: with the published catalog unreachable the dropdown
//      shows a placeholder and Flash stays disabled until the operator picks a
//      legacy build on purpose. The stale dev images that used to be listed
//      here (the 2026-06-30 "ISP Production" builds with the PE03 frame-drop
//      bug) are gone; one of them, flashed by default, is why this is strict.
// We only ever look at `uf2` here (a bin-only entry is for the arena's over-SPI
// reflashing). `fingerprint` (CRC-32 of the first 64 KiB) is what the controller's
// panel inventory (0xD1) reports per panel; we recompute it from the bytes we
// would actually flash and flag a mismatch against the manifest's value.
const LEGACY_MANIFEST = 'firmware/legacy-manifest.json';
const LEGACY_SECTION = 'Legacy builds (this site — only to match an arena not yet reflashed)';
let firmware = { version: null, commit: '', built: '', builds: [], byFile: {} };
let chosenFile = null;

function buildsFromManifest(m, { local }) {
    return (m.artifacts || [])
        .filter((a) => a.uf2)
        .map((a) => ({
            rev: a.rev,
            variant: a.variant,
            label: a.label,
            usb_product: a.usb_product,
            // legacy entries are never defaults, whatever the file says
            default: local ? false : !!a.default,
            file: local ? `firmware/${a.uf2.file}` : a.uf2.file,
            sha256: a.uf2.sha256 || null,
            fingerprint: a.fingerprint || null,
            local,
            section: local ? LEGACY_SECTION : undefined,
            caution: local ? a.note || '' : a.caution || ''
        }));
}

async function resolveFirmware() {
    let remote = [];
    let legacy = [];
    let meta = { version: null, commit: '', built: '' };
    try {
        // no-store: always pick up the newest catalog the firmware repo published.
        const res = await fetch(`${FW_BASE}/manifest.json`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`manifest.json HTTP ${res.status}`);
        const m = await res.json();
        meta = { version: m.version || '(unknown)', commit: m.commit || '', built: m.built || '' };
        remote = buildsFromManifest(m, { local: false });
    } catch (e) {
        log(
            `Published catalog unavailable (${e.message}) — pick a legacy build only if you mean to.`,
            'status-err'
        );
    }
    try {
        const res = await fetch(LEGACY_MANIFEST, { cache: 'no-store' });
        if (res.ok) legacy = buildsFromManifest(await res.json(), { local: true });
    } catch (e) {
        log(`Legacy manifest unavailable (${e.message}).`, 'status-err');
    }

    // Sanity on the published catalog: more than one default is a catalog bug —
    // trust none (placeholder) rather than whichever the <select> keeps last.
    // Duplicate file names would collide in byFile; keep the first.
    const defaults = remote.filter((b) => b.default);
    if (defaults.length > 1) {
        log(
            `Published catalog lists ${defaults.length} default builds — refusing to pick one; choose explicitly.`,
            'status-err'
        );
        remote = remote.map((b) => ({ ...b, default: false }));
    }
    const seen = new Set();
    const all = [...remote, ...legacy].filter((b) => {
        if (seen.has(b.file)) {
            log(`Duplicate catalog entry for ${b.file} ignored.`, 'status-err');
            return false;
        }
        seen.add(b.file);
        return true;
    });

    firmware.version = meta.version;
    firmware.commit = meta.commit;
    firmware.built = meta.built;
    firmware.builds = all; // published first, legacy last
    firmware.byFile = Object.fromEntries(firmware.builds.map((b) => [b.file, b]));

    populateBuilds();
    const id = [firmware.version, firmware.commit, firmware.built].filter(Boolean).join('  ·  ');
    $('build-meta').textContent = id || '(published catalog unreachable — legacy builds only)';
    log(
        `Firmware ${id || '(published catalog unreachable)'} — ${firmware.builds.length} build(s): ` +
            firmware.builds.map((b) => b.label || `${b.rev}/${b.variant}`).join(', ')
    );
}

// Section label for a build, so the dropdown groups Production vs testing/debug
// builds under <optgroup>s (otherwise the self-test builds hide behind the
// collapsed default). A build may pin its own `section` (local builds do, to
// lead the list); otherwise the variant maps to a section, falling back to a
// generic one.
const SECTION = { production: 'Production firmware', bcmtest: 'Panel self-test' };
const sectionOf = (b) => b.section || SECTION[b.variant] || 'Other builds';

// Fill the dropdown from the catalog, grouped by section, and select the
// manifest's default build.
function populateBuilds() {
    const sel = $('build-select');
    sel.innerHTML = '';
    // With no default (published catalog unreachable, or a manifest without one) a
    // <select> would silently pick its first option — here the legacy build. Put a
    // disabled placeholder first instead, so Flash stays off until a real choice.
    if (!firmware.builds.some((b) => b.default)) {
        const ph = document.createElement('option');
        ph.value = '';
        ph.disabled = true;
        ph.selected = true;
        ph.textContent = firmware.builds.length ? '— choose a build —' : '— no builds available —';
        sel.appendChild(ph);
    }
    const groups = new Map(); // insertion order: published catalog first, legacy last
    for (const b of firmware.builds) {
        const s = sectionOf(b);
        if (!groups.has(s)) groups.set(s, []);
        groups.get(s).push(b);
    }
    for (const [label, items] of groups) {
        const og = document.createElement('optgroup');
        og.label = label;
        for (const b of items) {
            const o = document.createElement('option');
            o.value = b.file;
            o.textContent = b.label || `${b.rev} — ${b.variant}`;
            if (b.default) o.selected = true;
            og.appendChild(o);
        }
        sel.appendChild(og);
    }
    sel.disabled = firmware.builds.length === 0;
    onBuildChange();
}

// --- Image fingerprint -----------------------------------------------------------
// The arena controller's panel inventory (GET_PANEL_INVENTORY 0xD1, Arena-Firmware
// #59) reports each panel's firmware as the CRC-32 of the first 64 KiB of its app
// flash. Showing the same number for the selected image lets an operator match
// "what this page will flash" against "what the inventory says the arena runs".
const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
const FINGERPRINT_BYTES = 65536;
// First 64 KiB of the flattened UF2 payload (blocks are 256 B at ascending flash
// addresses; gaps, if any, read as erased flash 0xFF).
function fingerprintOfBlocks(blocks) {
    if (!blocks.length) return null;
    const base = blocks[0].addr;
    const out = new Uint8Array(FINGERPRINT_BYTES).fill(0xff);
    for (const b of blocks) {
        const off = b.addr - base;
        if (off >= FINGERPRINT_BYTES) break;
        out.set(b.data.subarray(0, Math.min(b.data.length, FINGERPRINT_BYTES - off)), off);
    }
    return crc32(out);
}
// One verified fetch per build per page load, shared by the fingerprint display
// and the flash itself, so the number shown is computed from the bytes flashed.
// cache: 'no-store' (always the published bytes), HTTP status checked, and the
// manifest's sha256 verified when it carries one.
const bytesCache = new Map(); // file → Promise<ArrayBuffer>
async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
function fetchBuildBytes(b) {
    if (!bytesCache.has(b.file)) {
        const url = b.local ? b.file : `${FW_BASE}/${b.file}`;
        const p = (async () => {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`${b.file}: HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            if (b.sha256) {
                const got = await sha256Hex(buf);
                if (got !== String(b.sha256).toLowerCase()) {
                    throw new Error(
                        `${b.file}: sha256 mismatch (got ${got.slice(0, 12)}…, catalog ${String(b.sha256).slice(0, 12)}…)`
                    );
                }
            }
            return buf;
        })();
        p.catch(() => bytesCache.delete(b.file)); // let a transient failure be retried
        bytesCache.set(b.file, p);
    }
    return bytesCache.get(b.file);
}
function fingerprintOf(b) {
    return fetchBuildBytes(b).then((buf) => fingerprintOfBlocks(parseUF2(buf)));
}
const hex32 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
async function showFingerprint(b) {
    const el = $('build-fp');
    if (!el) return;
    if (!b) {
        el.textContent = '';
        return;
    }
    el.textContent = b.fingerprint
        ? `fingerprint ${b.fingerprint} (catalog) — verifying against the image…`
        : 'fingerprint: computing from the image…';
    let fp = null;
    let err = null;
    try {
        fp = await fingerprintOf(b);
    } catch (e) {
        err = e;
    }
    if (chosenFile !== b.file) return; // selection moved on while we fetched
    if (fp === null) {
        el.textContent = `fingerprint unavailable — ${err ? err.message : 'image not fetched'}`;
        return;
    }
    const shown = hex32(fp);
    const mismatch = b.fingerprint && b.fingerprint.toLowerCase() !== shown.toLowerCase();
    el.textContent =
        `fingerprint ${shown} — the Studio\u2019s panel inventory reports this value for panels running this image` +
        (mismatch
            ? ` — WARNING: the catalog lists ${b.fingerprint}; the image and its listing disagree`
            : '');
}

// Sync state + UI to the selected build: enable Flash and caution on non-production builds.
function onBuildChange() {
    chosenFile = $('build-select').value || null;
    const b = chosenFile ? firmware.byFile[chosenFile] : null;
    $('flash-btn').disabled = !b;
    const note = $('build-note');
    if (b && b.caution) {
        // Build-specific caution (beta / imaging-only builds) takes precedence
        // over the generic non-production note below.
        note.hidden = false;
        note.innerHTML = `<strong>${b.label}</strong>: ${b.caution}`;
    } else if (b && b.variant && b.variant !== 'production') {
        note.hidden = false;
        note.innerHTML =
            `<strong>${b.label || b.variant}</strong> is a bench / bring-up build: it runs a ` +
            `visible self-test and has <em>no SPI ingest</em>. Re-flash a <strong>Production</strong> build ` +
            `before deploying the panel.`;
    } else {
        note.hidden = true;
    }
    showFingerprint(b);
    setStatus('');
}

// --- Verify after flash ---------------------------------------------------------
// After REBOOT2 the panel re-enumerates as the firmware USB-serial device. We can't
// silently re-grab it (WebUSB needs a user gesture per device), so confirm via the
// product string of any already-granted device, else ask the operator to confirm.
async function verifyBuild(b) {
    const want = b.usb_product || '';
    const granted = await navigator.usb.getDevices();
    const match = granted.find(
        (d) => d.vendorId === RP_VID && want && (d.productName || '').startsWith(want)
    );
    if (match) {
        setStatus(`Verified: ${match.productName} ✓ — ready for the next panel.`, 'status-ok');
        log(`Verified panel reports "${match.productName}".`, 'status-ok');
    } else {
        setStatus(
            `Flashed ${b.label || b.file} ✓ — ready for the next panel (confirm it boots).`,
            'status-ok'
        );
        log('Flash complete. (Auto-verify needs a re-grant; confirm the panel visually.)');
    }
}

// --- Live panel status (popup-free; reflects already-granted devices) -----------
// WebUSB can't silently enumerate ungranted devices (browser security), but
// getDevices() lists ones the user has authorized — e.g. after a flash, or the
// one-time "Grant access" link below — and stays current as they attach/detach.
// We poll ~1 Hz and listen for connect/disconnect. Each USB identity (running
// firmware = pid 0x0009, BOOTSEL = pid 0x000f) is granted separately.
async function refreshPanelStatus() {
    const el = $('panel-status');
    if (!el || !navigator.usb) return;
    let devs = [];
    try {
        devs = await navigator.usb.getDevices();
    } catch {
        return;
    }
    const panels = devs.filter((d) => d.vendorId === RP_VID);
    const boot = panels.find((d) => d.productId === 0x000f);
    const app = panels.find((d) => d.productId !== 0x000f);

    let key, cls, html;
    if (boot) {
        key = 'boot';
        cls = 'ok';
        html = '● Panel in BOOTSEL — ready to flash';
    } else if (app) {
        key = 'app:' + (app.productName || '');
        cls = 'dim';
        html = `● Panel running firmware${app.productName ? ` (${app.productName})` : ''} — hold BOOT + tap RUN for BOOTSEL`;
    } else {
        key = 'none';
        cls = 'dim';
        html = `○ No panel detected. <a id="grant-link">Grant access</a> to watch one here (one-time).`;
    }
    if (el.dataset.key === key) return; // only re-render on a state change
    el.dataset.key = key;
    el.className = cls;
    el.innerHTML = html;
    const g = $('grant-link');
    if (g)
        g.onclick = async () => {
            try {
                await navigator.usb.requestDevice({ filters: [{ vendorId: RP_VID }] });
            } catch {
                /* cancelled */
            }
            el.dataset.key = '';
            refreshPanelStatus();
        };
}

// --- UI wiring ------------------------------------------------------------------
async function onFlashClick() {
    const b = chosenFile ? firmware.byFile[chosenFile] : null;
    if (!b) return;
    // Local builds are served from this origin (file is relative to this page);
    // remote builds come from the firmware repo's Pages catalog.
    let device, pb;
    try {
        $('flash-btn').disabled = true;
        $('build-select').disabled = true; // the build captured above is the one flashed
        setStatus('Requesting panel…');
        device = await navigator.usb.requestDevice({ filters: [{ vendorId: RP_VID }] });

        if (device.productId !== 0x000f) {
            setStatus('That panel is not in BOOTSEL mode.', 'status-err');
            log(
                `Picked device "${device.productName || '?'}" (pid 0x${device.productId.toString(16)}). ` +
                    'Put it in BOOTSEL (hold BOOT, plug in or tap RUN), then retry.',
                'status-err'
            );
            return;
        }

        log(`Downloading ${b.label || b.file}…`);
        const uf2 = await fetchBuildBytes(b); // verified: status, sha256; same bytes as the fingerprint
        const blocks = parseUF2(uf2);
        log(`UF2: ${blocks.length} blocks (${((blocks.length * 256) / 1024).toFixed(0)} KiB).`);

        pb = new Picoboot(device);
        await pb.open();

        const prog = $('progress');
        prog.hidden = false;
        prog.value = 0;
        setStatus(`Flashing ${b.label || b.file}…`);
        await flashBlocks(pb, blocks, (f) => {
            prog.value = Math.round(f * 100);
        });

        await verifyBuild(b);
        openTestModal(); // optional one-stop boot-banner check before the next panel
    } catch (err) {
        // A bulk stall surfaces as an opaque "transfer error"; ask the bootrom what
        // actually went wrong (e.g. INVALID_CMD_LENGTH, BAD_ALIGNMENT).
        let extra = '';
        if (pb) {
            const s = await pb.getStatus();
            if (s) extra = ` [PICOBOOT: ${s}]`;
        }
        setStatus(`Failed: ${err.message}`, 'status-err');
        log(`ERROR: ${err.message}${extra}`, 'status-err');
    } finally {
        if (pb) await pb.close();
        $('progress').hidden = true;
        // Re-arm for the next panel — re-flashing the SAME build is the common batch
        // case, so don't make the operator toggle the dropdown to re-enable the button.
        $('build-select').disabled = firmware.builds.length === 0;
        $('flash-btn').disabled = !chosenFile;
    }
}

// --- Optional post-flash check (inline liveness over Web Serial) ----------------
// Opens automatically after a flash. The panel has rebooted into firmware, so a
// serial port that OPENS = the panel is alive and running. NOTE: a USB-CDC reset
// (the RUN button) drops + re-enumerates the device, so we do NOT ask the user to
// press it — instead we auto-reconnect on connect events, which also recovers the
// banner for self-test builds (they wait for the host before printing; production
// prints once at boot, before any host is attached, so its banner isn't capturable
// over USB). "Done" closes the port and re-arms the flasher for the next panel.
let testPort = null,
    testReader = null,
    testReading = false;

function tlog(text, cls) {
    const el = $('test-log');
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    el.appendChild(s);
    el.scrollTop = el.scrollHeight;
}

async function openTestModal() {
    $('test-log').textContent = '';
    $('test-modal').hidden = false;
    if (!('serial' in navigator)) {
        $('test-connect').disabled = true;
        tlog('Web Serial isn’t available in this browser (Chrome/Edge only).\n', 'status-err');
        return;
    }
    $('test-connect').disabled = false;
    // Try a silent attach to an already-granted, attached panel port (no popup).
    try {
        const granted = await navigator.serial.getPorts();
        const port = granted.find((p) => (p.getInfo?.() || {}).usbVendorId === RP_VID);
        if (port) await startTest(port);
    } catch {
        /* fall back to the Connect button */
    }
}

async function startTest(port) {
    try {
        await port.open({ baudRate: 115200 });
        testPort = port;
        testReading = true;
        $('test-connect').disabled = true;
        tlog('✓ Connected — the panel is running firmware (alive).\n', 'status-ok');
        tlog(
            'Self-test builds stream their output below. Production firmware is quiet after boot — the open connection is the all-clear.\n'
        );
        readTest();
    } catch (err) {
        tlog(`Could not open serial port: ${err.message}\n`, 'status-err');
        $('test-connect').disabled = false;
    }
}

async function testConnect() {
    if (!('serial' in navigator)) return;
    try {
        const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: RP_VID }] });
        await startTest(port);
    } catch {
        /* chooser cancelled */
    }
}

async function readTest() {
    const dec = new TextDecoder();
    try {
        while (testReading && testPort && testPort.readable) {
            testReader = testPort.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await testReader.read();
                    if (done) break;
                    if (value) tlog(dec.decode(value, { stream: true }));
                }
            } finally {
                testReader.releaseLock();
                testReader = null;
            }
        }
    } catch {
        /* port closed (e.g. reset/power-cycle) — reopened by serial 'connect' */
    }
}

// On a reset/power-cycle the port re-enumerates; reopen it and resume reading. For
// self-test builds (which wait for the host) this recaptures the fresh banner.
async function reopenTestIfDropped() {
    if (testReading && testPort && !testPort.readable) {
        try {
            await testPort.open({ baudRate: 115200 });
            tlog('\n— reconnected —\n', 'status-ok');
            readTest();
        } catch {
            /* not ready yet; another connect event will retry */
        }
    }
}

async function testDone() {
    testReading = false;
    try {
        if (testReader) await testReader.cancel();
    } catch {
        /* ignore */
    }
    try {
        if (testPort) await testPort.close();
    } catch {
        /* ignore */
    }
    testPort = null;
    $('test-modal').hidden = true;
    $('test-connect').disabled = false;
    $('flash-btn').disabled = !chosenFile; // re-arm for the next panel
}

function main() {
    if (!('usb' in navigator)) {
        $('unsupported').style.display = 'block';
        $('app').style.display = 'none';
        return;
    }
    $('build-select').addEventListener('change', onBuildChange);
    $('flash-btn').addEventListener('click', onFlashClick);
    $('test-connect').addEventListener('click', testConnect);
    $('test-done').addEventListener('click', testDone);

    // Live panel detection — no popup once a panel has been granted.
    refreshPanelStatus();
    setInterval(refreshPanelStatus, 1000);
    navigator.usb.addEventListener('connect', refreshPanelStatus);
    navigator.usb.addEventListener('disconnect', refreshPanelStatus);

    // Keep the test readout alive across a panel reset / power-cycle.
    if ('serial' in navigator) {
        navigator.serial.addEventListener('disconnect', () => {
            if (testReading && testPort)
                tlog('\n— panel disconnected (reset / power-cycle); waiting…\n', 'status-err');
        });
        navigator.serial.addEventListener('connect', reopenTestIfDropped);
    }

    resolveFirmware().catch((e) => {
        $('build-meta').textContent = 'unavailable';
        log(`Could not resolve firmware catalog: ${e.message}`, 'status-err');
    });
}

main();
