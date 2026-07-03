/**
 * arena-wire-g6.js — G6 Arena controller wire protocol (encoders + decoder).
 *
 * Pure bytes-in / bytes-out: every encoder returns a Uint8Array request frame,
 * `decodeResponse` parses a response frame, and the field decoders pull typed
 * values out of a decoded response. There is NO I/O here — that lives in
 * js/arena-link.js (the Web Serial transport). Keeping this module pure makes
 * it trivially Node-testable (see tests/test-arena-wire-g6.js).
 *
 * This is a PORT of an already-proven protocol, not a new design. The wire
 * format and opcodes are lifted from, and cross-checked against, the firmware
 * (LED-Display_G6_Firmware_Arena: src/commands.h, src/CommandProcessor.cpp,
 * src/SerialManager.cpp) and the reference host encoders (scripts/web-serial/
 * main.js, scripts/play_pattern.py, scripts/all_on.py, scripts/controller_info.py).
 * The firmware wins any disagreement.
 *
 * Wire format (identical on the USB-CDC serial path and the legacy TCP path):
 *   Request  frame: [length, cmd, params...]   length = #bytes AFTER it.
 *   Response frame: [length, status, echo_cmd, ...payload]   length = #bytes
 *                   after it (status + echo + payload). status == 0 means OK;
 *                   payload is ASCII for most commands, raw bytes for GET_*.
 *
 * So: all-off = `01 00`, all-on = `01 FF`, stop = `01 30`.
 *
 * Browser-global + Node CommonJS export, mirroring js/crc.js / js/g6-encoding.js.
 * No ES `export` keyword on purpose — a top-level `export` would make the file
 * module-only and break plain `<script src=>` loading. Browser callers load via
 * `<script src="js/arena-wire-g6.js">` and read `window.ArenaWireG6`; Node
 * callers use `require('./arena-wire-g6.js')`.
 */

const ArenaWireG6 = (function () {
    'use strict';

    // G4-compatible host command opcodes (src/commands.h). Not every opcode is
    // encoded here — this is the substrate set the web tools need. Stream-frame
    // (0x32) IS encoded (encodeStreamFrame, used by the Arena Console) but uses a
    // different on-wire header than the binary commands below: opcode first, then
    // a uint16 LE payload length (per the firmware SerialManager stream header),
    // not the single leading length byte the `frame()` helper emits.
    const OPCODES = {
        ALL_OFF: 0x00,
        SYSTEM_RESET: 0x01, // software reset — acks then reboots (SCB_AIRCR SYSRESETREQ)
        TRIAL_PARAMS: 0x08, // selects mode + pattern (Modes 2/3/4)
        SET_REFRESH_RATE: 0x16,
        GET_REFRESH_RATE: 0x17, // returns current refresh rate as uint16 LE Hz
        SET_PANEL_DISPLAY_MODE: 0x1b, // [02 1B mode] 0=oneshot 1=persist 2=triggered 3=gated; sticky
        GET_PANEL_DISPLAY_MODE: 0x1c, // [01 1C] returns current panel display mode as single byte
        SET_SPI_CLOCK: 0xc5, // uint16 LE MHz (1..30); echoes applied MHz
        GET_SPI_CLOCK: 0xc6, // returns uint16 LE current MHz
        GET_FRAMES_SENT: 0x33, // returns uint32 LE frames pushed to panels
        RESET_FRAMES_SENT: 0x34, // zeroes the frames-sent counter
        GET_FILE_COUNT: 0x80, // returns pattern file count on SD as uint16 LE
        GET_PATTERN_FILENAME: 0x82, // [03 82 idx_lo idx_hi] 1-based; returns 1-byte-len + filename
        GET_PATTERN_INFO: 0x88, // [03 88 idx_lo idx_hi] 1-based; framed reply: header metadata + frame-0 stretch (cheap preview)
        SET_PATTERN_FILENAME: 0x83, // [0x83, idx_lo, idx_hi, len, chars…] rename; returns new uint16 LE index
        GET_PATTERN_FILE: 0x84, // [03 84 idx_lo idx_hi] 1-based; response: uint64 LE size, then raw bytes
        SET_PATTERN_FILE: 0x85, // [0x85, idx_lo, idx_hi, len64 LE, data…] upload file (bulk stream)
        DELETE_PATTERN_FILE: 0x86, // [03 86 idx_lo idx_hi] delete 1-based pattern; idx=0 deletes pattern.temp
        DELETE_ALL_PATTERNS: 0x8f, // [01 8F] delete all files in /patterns
        GET_SD_ARCHIVE: 0x8a, // [01 8A] stream full SD as ZIP; only in ALL_OFF state
        STOP_DISPLAY: 0x30,
        STREAM_FRAME: 0x32, // host-streamed full frame ("FR"+blocks; see encodeStreamFrame)
        SET_ETHERNET_IP: 0xc0, // reserved — not yet implemented
        GET_ETHERNET_IP: 0xc1,
        GET_CONTROLLER_INFO: 0xc2, // returns {version, capability_bitmap}
        SET_DIAG_OUTPUT: 0xc3, // [len=2,0xC3,on] mute/unmute DEBUG_SERIAL diagnostics
        GET_DIAG_OUTPUT: 0xc4, // returns current g_dbg_on state (0/1)
        SET_AO_VOLTAGE: 0xa0, // [03 A0 mv_lo mv_hi] set analog output (BNC J27) 0–5000 mV
        GET_AO_VOLTAGE: 0xa1, // [01 A1] returns last commanded AO level as uint16 LE mV
        SET_DIGITAL_OUT: 0xaa, // [03 AA ch state] DO1 (ch=1, J3/D37) or DO2 (ch=2, J4/D35)
        GET_DIGITAL_OUT: 0xab, // [01 AB] returns current state of DO1 and DO2 as two bytes
        SET_FRAME_POSITION: 0x70, // Mode 3: host-commanded frame index
        // Panel firmware / ISP (g6_03-controller.md § Panel firmware update).
        SET_FIRMWARE_FILE: 0xe0, // [0xE0, len64 LE, data…] upload image → /firmware/panel.bin; reply u32 LE CRC-32
        GET_FIRMWARE_INFO: 0xe3, // [01 E3] reply: 32-byte footer {magic[8], version[16], crc32 LE, size LE}
        G6_PROGRAM_PANEL: 0xc8, // [02 C8 panel_index] reflash one panel from /firmware/panel.bin via SPI ISP
        G6_VERIFY_PANEL: 0xc9, // [02 C9 panel_index] CRC the panel's running app flash vs /firmware/panel.bin footer
        ALL_ON: 0xff
    };

    // Stream-frame payload byte counts (firmware constants.h): a 4-byte
    // "FR"+frame_index prefix followed by 20 row-major panel blocks. GS2 blocks
    // are 53 B, GS16 blocks are 203 B → 4 + 20*53 and 4 + 20*203. The firmware
    // infers the grayscale mode from the payload size, so these are the only two
    // lengths it accepts (full-grid 20-panel arenas, e.g. G6_2x10).
    const STREAM_FRAME_BYTES = { GS2: 1064, GS16: 4064 };

    // Display modes (trial-params `mode` byte). 5 = stream is set via a
    // different command and is not encodable here.
    const MODES = {
        OPEN_LOOP: 2, // host-free frame advance at frame_rate (negative = reverse)
        SHOW_FRAME: 3, // host sets the frame via SET_FRAME_POSITION
        CLOSED_LOOP: 4 // analog-in × gain, computed on the controller
    };

    // Panel display modes (set/get-panel-display-mode 0x1B/0x1C low 2 bits).
    // Index === wire value; use PANEL_DISPLAY_MODE_NAMES[mode] for labels. Only
    // oneshot/persist are physically exercisable today — triggered/gated need an
    // EINT trigger line the Slim controller lacks (wire-complete, not yet wired).
    const PANEL_DISPLAY_MODE_NAMES = ['oneshot', 'persist', 'triggered', 'gated'];

    // Capability bitmap bits in the get-controller-info (0xC2) reply
    // (controller_info.py / main.js, g6_03-controller.md § 5).
    const CAPABILITY_BITS = [
        [0, 'g6_mode'],
        [1, 'v2_local_storage'],
        [2, 'mode_1_tsi'],
        [3, 'v3_triggered'],
        [4, 'v3_gated'],
        // Extended I/O command set (#135): SET_DIO_ROLE 0xAC / GET_DIO_ROLE
        // 0xAD / SET_AO_MODE 0xA3 / GET_ANALOG_IN 0xA4 — hosts detect the
        // DIO-role machinery by this bit, not by firmware-version guessing.
        [5, 'io_ext']
    ];

    // ───────────────────────── validation helpers ─────────────────────────

    function requireInt(value, name) {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
            throw new TypeError(name + ' must be an integer, got ' + value);
        }
        return value;
    }

    // Validate a uint8 and return it.
    function u8(value, name) {
        requireInt(value, name);
        if (value < 0 || value > 0xff) {
            throw new RangeError(name + ' must be 0..255, got ' + value);
        }
        return value;
    }

    // Validate a uint16 and return it as [lo, hi] little-endian.
    function u16le(value, name) {
        requireInt(value, name);
        if (value < 0 || value > 0xffff) {
            throw new RangeError(name + ' must be 0..65535, got ' + value);
        }
        return [value & 0xff, (value >> 8) & 0xff];
    }

    // Validate a signed int8 and return the unsigned wire byte (two's
    // complement). e.g. gain -50 -> 0xCE. This is the easy-to-get-wrong case
    // the golden tests pin.
    function int8Byte(value, name) {
        requireInt(value, name);
        if (value < -128 || value > 127) {
            throw new RangeError(name + ' must be -128..127 (int8), got ' + value);
        }
        return value & 0xff;
    }

    // Validate a signed int16 and return [lo, hi] little-endian two's
    // complement. e.g. -2 -> [0xFE, 0xFF]. Used for trial-params frame_rate,
    // which firmware reads as int16 (fw #4, ee74c33: negative = Mode-2
    // reverse). NOTE this also REJECTS 32768..65535 — since the firmware went
    // signed, those unsigned values would silently alias to reverse rates.
    function i16le(value, name) {
        requireInt(value, name);
        if (value < -32768 || value > 32767) {
            throw new RangeError(name + ' must be -32768..32767 (int16), got ' + value);
        }
        return [value & 0xff, (value >> 8) & 0xff];
    }

    // Validate a trial-params display mode. The firmware only accepts 2/3/4 and
    // rejects anything else with a controller-side error glyph, so we fail fast
    // here rather than emit a known-bad frame.
    function requireMode(value) {
        requireInt(value, 'mode');
        if (
            value !== MODES.OPEN_LOOP &&
            value !== MODES.SHOW_FRAME &&
            value !== MODES.CLOSED_LOOP
        ) {
            throw new RangeError(
                'mode must be 2 (open-loop), 3 (show-frame), or 4 (closed-loop), got ' + value
            );
        }
        return value;
    }

    // Frame a command: [length, cmd, ...params] with length = #bytes after it.
    function frame(cmd, params) {
        params = params || [];
        return Uint8Array.from([params.length + 1, cmd, ...params]);
    }

    // ───────────────────────────── encoders ───────────────────────────────
    // Each returns a Uint8Array request frame ready to write to the transport.

    function encodeAllOn() {
        return frame(OPCODES.ALL_ON); // 01 FF
    }

    function encodeAllOff() {
        return frame(OPCODES.ALL_OFF); // 01 00
    }

    function encodeStop() {
        return frame(OPCODES.STOP_DISPLAY); // 01 30
    }

    function encodeSystemReset() {
        return frame(OPCODES.SYSTEM_RESET); // 01 01
    }

    /**
     * trial-params (0x08) — select display mode + pattern + timing.
     * Emits the documented 13-byte combined command:
     *   [0C 08 mode pat(LE16) rate(LE16) gain init(LE16) 00 00 00]
     * The length byte 0x0C = 12 = cmd + 11 param bytes. The 3 trailing reserved
     * bytes pad the combined-command length; the firmware reads only the first
     * 8 param bytes.
     *
     * @param {object} p
     * @param {number} [p.mode=2]       display mode (2 open / 3 show-frame / 4 closed)
     * @param {number} [p.patternId=1]  1-based pattern id (Nth .pat in /patterns)
     * @param {number} [p.frameRate=0]  frame-advance rate in Hz, int16 — negative
     *                                  plays Mode 2 in REVERSE (G4-style count-down;
     *                                  fw ee74c33+); sign ignored in Modes 3/4
     * @param {number} [p.gain=0]       signed int8 velocity gain (×10 fps/V in Mode 4)
     * @param {number} [p.initPos=0]    initial frame index (0-based)
     */
    function encodeTrialParams(p) {
        p = p || {};
        const mode = requireMode(p.mode === undefined ? MODES.OPEN_LOOP : p.mode);
        const patternId = p.patternId === undefined ? 1 : p.patternId;
        requireInt(patternId, 'patternId');
        if (patternId < 1) {
            throw new RangeError('patternId must be >= 1 (1-based), got ' + patternId);
        }
        const pat = u16le(patternId, 'patternId');
        const rate = i16le(p.frameRate === undefined ? 0 : p.frameRate, 'frameRate');
        const gain = int8Byte(p.gain === undefined ? 0 : p.gain, 'gain');
        const init = u16le(p.initPos === undefined ? 0 : p.initPos, 'initPos');
        // mode, pat(2), rate(2), gain, init(2), reserved(3) = 11 param bytes.
        const params = [mode, ...pat, ...rate, gain, ...init, 0, 0, 0];
        return frame(OPCODES.TRIAL_PARAMS, params); // 0C 08 ...
    }

    // set-frame-position (0x70) — Mode 3 host-commanded frame index (u16 LE).
    function encodeSetFramePosition(index) {
        return frame(OPCODES.SET_FRAME_POSITION, u16le(index, 'index')); // 03 70 lo hi
    }

    /**
     * stream-frame (0x32) — host-streamed full frame. The controller copies the
     * payload into its frame buffer, enters STREAMING_FRAME, and displays it
     * until the next command (no pattern/SD prerequisite).
     *
     * UNLIKE the binary commands above, the on-wire header is opcode-first with a
     * 2-byte little-endian payload length: [0x32, len_lo, len_hi, ...payload]
     * (firmware SerialManager stream header), NOT the single leading length byte
     * the `frame()` helper emits. `payload` is the per-frame body — a 4-byte
     * "FR"+frame_index prefix followed by the row-major panel blocks — i.e.
     * exactly one .pat frame minus its 2-byte CRC trailer. Build it by reusing
     * the proven pattern encoder and slicing off the file header + trailer:
     *     const buf = new Uint8Array(PatEncoder.encodeG6({ ...one frame... }));
     *     const len = STREAM_FRAME_BYTES[gs === 2 ? 'GS2' : 'GS16'];
     *     const payload = buf.subarray(PatEncoder.G6_HEADER_SIZE,
     *                                  PatEncoder.G6_HEADER_SIZE + len);
     * That guarantees a streamed frame displays exactly as the same .pat would
     * from SD. The firmware infers GS2 vs GS16 from the payload length, so only
     * the two STREAM_FRAME_BYTES sizes are accepted.
     *
     * Correlation note: because the opcode is byte 0 (not byte 1), pass the
     * matching expectedCmd to the transport — link.send(frame, {expectedCmd: 0x32}).
     *
     * @param {Uint8Array|number[]} payload per-frame body (1064 GS2 / 4064 GS16)
     * @returns {Uint8Array} on-wire stream frame [0x32, len_lo, len_hi, ...payload]
     */
    function encodeStreamFrame(payload) {
        const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
        if (body.length !== STREAM_FRAME_BYTES.GS2 && body.length !== STREAM_FRAME_BYTES.GS16) {
            throw new RangeError(
                'stream-frame payload must be ' +
                    STREAM_FRAME_BYTES.GS2 +
                    ' (GS2) or ' +
                    STREAM_FRAME_BYTES.GS16 +
                    ' (GS16) bytes, got ' +
                    body.length
            );
        }
        const out = new Uint8Array(3 + body.length);
        out[0] = OPCODES.STREAM_FRAME; // 0x32
        out[1] = body.length & 0xff; // payload length lo
        out[2] = (body.length >> 8) & 0xff; // payload length hi
        out.set(body, 3);
        return out;
    }

    // set-refresh-rate (0x16) — host override of the panel re-transmit rate (Hz, u16 LE).
    function encodeSetRefreshRate(hz) {
        return frame(OPCODES.SET_REFRESH_RATE, u16le(hz, 'hz')); // 03 16 lo hi
    }

    // get-refresh-rate (0x17) — read the current re-transmit rate.
    function encodeGetRefreshRate() {
        return frame(OPCODES.GET_REFRESH_RATE); // 01 17
    }

    // get-refresh-rate / set-refresh-rate reply carries the rate as uint16 LE Hz.
    function decodeRefreshRate(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return r.payload[0] | (r.payload[1] << 8);
    }

    // set-panel-display-mode (0x1B) — sticky panel display mode applied to every
    // frame the controller forwards/synthesizes (SD, streamed, ALL_ON). mode:
    // 0 oneshot / 1 persist / 2 triggered / 3 gated. Echoes the mode byte back.
    function encodeSetPanelDisplayMode(mode) {
        requireInt(mode, 'mode');
        if (mode < 0 || mode > 3) {
            throw new RangeError(
                'mode must be 0..3 (oneshot/persist/triggered/gated), got ' + mode
            );
        }
        return frame(OPCODES.SET_PANEL_DISPLAY_MODE, [mode]); // 02 1B mode
    }

    // get-panel-display-mode (0x1C) — read the current sticky panel display mode.
    function encodeGetPanelDisplayMode() {
        return frame(OPCODES.GET_PANEL_DISPLAY_MODE); // 01 1C
    }

    // set/get-panel-display-mode (0x1B/0x1C) reply carries the mode as a single
    // byte (0..3). Returns the mode number, or null on error / short payload.
    function decodePanelDisplayMode(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 1) return null;
        return r.payload[0];
    }

    // set-spi-clock (0xC5) — panel SPI master clock in whole MHz (u16 LE); echoes
    // applied MHz. The firmware clamps to 1..30 MHz, so reject out-of-range here.
    function encodeSetSpiClock(mhz) {
        requireInt(mhz, 'mhz');
        if (mhz < 1 || mhz > 30) {
            throw new RangeError('mhz must be 1..30, got ' + mhz);
        }
        return frame(OPCODES.SET_SPI_CLOCK, u16le(mhz, 'mhz')); // 03 C5 lo hi
    }

    function encodeGetSpiClock() {
        return frame(OPCODES.GET_SPI_CLOCK); // 01 C6
    }

    function encodeGetFramesSent() {
        return frame(OPCODES.GET_FRAMES_SENT); // 01 33
    }

    function encodeResetFramesSent() {
        return frame(OPCODES.RESET_FRAMES_SENT); // 01 34
    }

    function encodeGetIp() {
        return frame(OPCODES.GET_ETHERNET_IP); // 01 C0
    }

    function encodeGetControllerInfo() {
        return frame(OPCODES.GET_CONTROLLER_INFO); // 01 C1
    }

    // get-file-count (0x80) — number of *.pat files in /patterns on the SD card.
    function encodeGetFileCount() {
        return frame(OPCODES.GET_FILE_COUNT); // 01 80
    }

    // set-pattern-filename (0x83) — rename pattern at 1-based idx (0 = pattern.temp).
    // Returns new 1-based uint16 index after re-sort via decodeSetPatternFilenameResponse.
    // Uses opcode-first framing (same as 0x85): [0x83, idx_lo, idx_hi, name_len, chars…]
    // NOT frame() — the standard length-prefixed framing overflows for filenames > 45 chars
    // because the length byte would equal or exceed STREAM_FRAME_CMD (0x32 = 50).
    function encodeSetPatternFilename(index, name) {
        requireInt(index, 'index');
        if (index < 0 || index > 0xffff) {
            throw new RangeError('index must be 0..65535, got ' + index);
        }
        const nameBytes = [];
        for (let i = 0; i < name.length; i++) nameBytes.push(name.charCodeAt(i) & 0xff);
        if (nameBytes.length === 0 || nameBytes.length > 63) {
            throw new RangeError('filename must be 1..63 chars, got ' + nameBytes.length);
        }
        const idx = u16le(index, 'index');
        return new Uint8Array([
            OPCODES.SET_PATTERN_FILENAME,
            ...idx,
            nameBytes.length,
            ...nameBytes
        ]);
    }

    // set-pattern-file (0x85) — upload a .pat file. Opcode-first framing (NOT
    // the standard frame() helper): [0x85, idx_lo, idx_hi, len_b0..b7, data…]
    // idx = 0 writes to /patterns/pattern.temp; idx >= 1 overwrites that pattern.
    function encodeSetPatternFile(index, data) {
        requireInt(index, 'index');
        if (index < 0 || index > 0xffff) {
            throw new RangeError('index must be 0..65535, got ' + index);
        }
        const fileData = data instanceof Uint8Array ? data : new Uint8Array(data);
        const len = fileData.length;
        // [0x85, idx_lo, idx_hi, len_b0..b7, file_data…]
        const out = new Uint8Array(11 + len);
        out[0] = OPCODES.SET_PATTERN_FILE;
        out[1] = index & 0xff;
        out[2] = (index >> 8) & 0xff;
        // uint64 LE length — upper 4 bytes are 0 (files < 4 GB in practice).
        out[3] = len & 0xff;
        out[4] = (len >> 8) & 0xff;
        out[5] = (len >> 16) & 0xff;
        out[6] = (len >> 24) & 0xff;
        out[7] = 0;
        out[8] = 0;
        out[9] = 0;
        out[10] = 0;
        out.set(fileData, 11);
        return out;
    }

    // ─────────────────────── panel firmware / ISP ─────────────────────────

    // set-firmware-file (0xE0) — upload a panel firmware image to the controller
    // SD as /firmware/panel.bin (the controller holds a single firmware at a
    // time, so there is NO index). Opcode-first framing like 0x85:
    //   [0xE0, len_b0..b7 (uint64 LE), file_data…]
    // Reply payload: uint32 LE CRC-32 of the stored bytes (decodeSetFirmwareFileResponse).
    function encodeSetFirmwareFile(data) {
        const fileData = data instanceof Uint8Array ? data : new Uint8Array(data);
        const len = fileData.length;
        const out = new Uint8Array(9 + len);
        out[0] = OPCODES.SET_FIRMWARE_FILE;
        // uint64 LE length — upper 4 bytes are 0 (firmware images are < 4 GB).
        out[1] = len & 0xff;
        out[2] = (len >> 8) & 0xff;
        out[3] = (len >> 16) & 0xff;
        out[4] = (len >> 24) & 0xff;
        out[5] = 0;
        out[6] = 0;
        out[7] = 0;
        out[8] = 0;
        out.set(fileData, 9);
        return out;
    }

    // get-firmware-info (0xE3) — read the 32-byte footer of /firmware/panel.bin.
    function encodeGetFirmwareInfo() {
        return frame(OPCODES.GET_FIRMWARE_INFO); // 01 E3
    }

    // g6-program-panel (0xC8) — reflash one panel from /firmware/panel.bin over
    // the SPI ISP path. `panelNumber` is 1-based (matches the panel-map labels);
    // the controller converts to its 0-based arena index. Long-running (stage to
    // LittleFS + reboot + OTA install), so give the transport a generous timeout.
    function encodeG6ProgramPanel(panelNumber) {
        if (panelNumber < 1) throw new RangeError('panelNumber is 1-based (>= 1)');
        return frame(OPCODES.G6_PROGRAM_PANEL, [u8(panelNumber, 'panelNumber')]); // 02 C8 n
    }

    // g6-verify-panel (0xC9) — CRC the panel's running app flash against the SD
    // footer (ISP_ENTER + ISP_VERIFY_CRC). Confirms a g6-program-panel install
    // actually took; no reboot, no flash write. `panelNumber` is 1-based.
    function encodeG6VerifyPanel(panelNumber) {
        if (panelNumber < 1) throw new RangeError('panelNumber is 1-based (>= 1)');
        return frame(OPCODES.G6_VERIFY_PANEL, [u8(panelNumber, 'panelNumber')]); // 02 C9 n
    }

    // get-pattern-filename (0x82) — filename for the 1-based pattern index on SD.
    function encodeGetPatternFilename(index) {
        requireInt(index, 'index');
        if (index < 1) {
            throw new RangeError('index must be >= 1 (1-based), got ' + index);
        }
        return frame(OPCODES.GET_PATTERN_FILENAME, u16le(index, 'index')); // 03 82 lo hi
    }

    // get-pattern-info (0x88) — cheap header metadata for the 1-based pattern:
    // frame count, grayscale, geometry, arena/observer id, file size, and the
    // first frame's panel-0 stretch. A small framed reply (NOT the 0x84 bulk
    // path), so it sidesteps the bulk-download stall and needs no ALL_OFF.
    function encodeGetPatternInfo(index) {
        requireInt(index, 'index');
        if (index < 1) throw new RangeError('index must be >= 1 (1-based), got ' + index);
        return frame(OPCODES.GET_PATTERN_INFO, u16le(index, 'index')); // 03 88 lo hi
    }

    // get-pattern-file (0x84) — request raw content of the 1-based pattern.
    // Use link.sendBulkRead() (not link.send()) to receive the streaming response.
    function encodeGetPatternFile(index) {
        requireInt(index, 'index');
        if (index < 1) throw new RangeError('index must be >= 1 (1-based), got ' + index);
        return frame(OPCODES.GET_PATTERN_FILE, u16le(index, 'index')); // 03 84 lo hi
    }

    // delete-all-patterns (0x8F) — delete every file in /patterns.
    function encodeDeleteAllPatterns() {
        return frame(OPCODES.DELETE_ALL_PATTERNS); // 01 8F
    }

    // delete-pattern-file (0x86) — delete the pattern at 1-based index.
    // index=0 deletes /patterns/pattern.temp if it exists.
    function encodeDeletePatternFile(index) {
        requireInt(index, 'index');
        if (index < 0 || index > 0xffff)
            throw new RangeError('index out of range [0, 65535], got ' + index);
        return frame(OPCODES.DELETE_PATTERN_FILE, u16le(index, 'index')); // 03 86 lo hi
    }

    // get-sd-archive (0x8A) — trigger full SD content as a ZIP download.
    // Only accepted when the display is in ALL_OFF (waiting) state.
    function encodeGetSdArchive() {
        return frame(OPCODES.GET_SD_ARCHIVE); // 01 8A
    }

    // set-ao-voltage (0xA0) — drive the MCP4725 DAC (BNC J27) to a DC level.
    // mv: 0–5000 millivolts; 0 drives DAC code 0 (0 V = effectively off).
    // Firmware converts: dacCode = mv * 4095 / 5000.
    function encodeSetAoVoltage(mv) {
        requireInt(mv, 'mv');
        if (mv < 0 || mv > 5000) {
            throw new RangeError('mv must be 0..5000, got ' + mv);
        }
        return frame(OPCODES.SET_AO_VOLTAGE, u16le(mv, 'mv')); // 03 A0 lo hi
    }

    // get-ao-voltage (0xA1) — read back the last commanded AO level (mV, uint16 LE).
    function encodeGetAoVoltage() {
        return frame(OPCODES.GET_AO_VOLTAGE); // 01 A1
    }

    // set-digital-out (0xAA) — drive a "Digital IO n (5V)" BNC HIGH/LOW as a TTL output.
    // channel: 1 = "Digital IO 1 (5V)" (J3, D37), 2 = "Digital IO 2 (5V)" (J4, D35) —
    // channel number == board silkscreen number == rig io: port number.
    // state: true/1 = HIGH, false/0 = LOW
    function encodeSetDigitalOut(channel, state) {
        if (channel !== 1 && channel !== 2)
            throw new RangeError('channel must be 1 or 2, got ' + channel);
        return frame(OPCODES.SET_DIGITAL_OUT, [channel, state ? 1 : 0]); // 03 AA ch state
    }

    // get-digital-out (0xAB) — read current state of both digital outputs.
    // Response payload: [do1_state, do2_state], each 0 (LOW) or 1 (HIGH).
    function encodeGetDigitalOut() {
        return frame(OPCODES.GET_DIGITAL_OUT); // 01 AB
    }

    // ───────────────────────────── decoders ───────────────────────────────

    /**
     * Parse a complete response frame [length, status, echo_cmd, ...payload].
     * `length` counts the bytes after itself. Returns a structured object, or
     * null for an absent / incomplete / too-short-to-be-a-response frame.
     *
     * @param {Uint8Array|number[]} bytes a full response frame (incl. length byte)
     * @returns {{length:number,status:number,echoCmd:number,payload:Uint8Array,ok:boolean}|null}
     */
    function decodeResponse(bytes) {
        if (!bytes || bytes.length === 0) return null;
        // Normalize to Uint8Array so a plain number[] works too (TypedArray.slice
        // throws on a non-typed-array receiver — see tests).
        const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        const length = buf[0];
        // A response carries at least status + echo_cmd, so length >= 2.
        if (length < 2) return null;
        // Need every byte the length claims; otherwise the frame is incomplete.
        if (buf.length < 1 + length) return null;
        const status = buf[1];
        const echoCmd = buf[2];
        // payload = the bytes after echo_cmd, bounded by the claimed length.
        const payload = buf.slice(3, 1 + length);
        return { length, status, echoCmd, payload, ok: status === 0 };
    }

    // Coerce either a decoded response object or a raw frame into a decoded
    // object, so the field decoders accept whichever the caller has on hand.
    function asResponse(resp) {
        if (!resp) return null;
        if (resp.payload !== undefined && resp.status !== undefined) return resp;
        return decodeResponse(resp); // assume a raw frame
    }

    /**
     * get-controller-info (0xC2) reply -> {version, capability, capabilities[]}.
     * Payload is {version_byte, capability_bitmap}.
     */
    function decodeControllerInfo(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        const version = r.payload[0];
        const capability = r.payload[1];
        const capabilities = CAPABILITY_BITS.filter(([bit]) => capability & (1 << bit)).map(
            ([, name]) => name
        );
        // Optional trailing MAC (6 bytes) — the controller's Ethernet MAC is
        // derived from the Teensy's burned-in unique ID, so it identifies the
        // physical setup. Older firmware sends only {version, capability};
        // mac is null then (tolerant extension, see firmware issue).
        let mac = null;
        if (r.payload.length >= 8) {
            mac = Array.from(r.payload.slice(2, 8))
                .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
                .join(':');
        }
        return { version, capability, capabilities, mac };
    }

    // set/get-spi-clock (0xC5/0xC6) reply carries the clock as uint16 LE MHz.
    function decodeSpiClock(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return r.payload[0] | (r.payload[1] << 8);
    }

    // get-frames-sent (0x33) reply carries the master-sent count as uint32 LE.
    function decodeFramesSent(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 4) return null;
        const m = r.payload;
        return (m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0;
    }

    // get-file-count (0x80) reply carries the count as uint16 LE.
    function decodeFileCount(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return r.payload[0] | (r.payload[1] << 8);
    }

    // set-pattern-filename (0x83) response: uint16 LE new 1-based index.
    function decodeSetPatternFilenameResponse(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return r.payload[0] | (r.payload[1] << 8);
    }

    // get-pattern-filename (0x82) reply: 1-byte length prefix + ASCII filename chars.
    function decodePatternFilename(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 1) return null;
        const len = r.payload[0];
        if (r.payload.length < 1 + len) return null;
        let s = '';
        for (let i = 1; i <= len; i++) s += String.fromCharCode(r.payload[i]);
        return s;
    }

    // get-pattern-info (0x88) reply: 12-byte little-endian payload
    //   frame_count u16 · gs u8 · rows u8 · cols u8 · arena u8 · observer u8
    //   · file_size u32 · stretch u8
    // Returns a structured object, or null on error / short payload.
    function decodePatternInfo(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 12) return null;
        const p = r.payload;
        return {
            frameCount: p[0] | (p[1] << 8),
            gsVal: p[2],
            rows: p[3],
            cols: p[4],
            arenaId: p[5],
            observerId: p[6],
            fileSize: (p[7] | (p[8] << 8) | (p[9] << 16) | (p[10] << 24)) >>> 0,
            stretch: p[11]
        };
    }

    // get-ip (0xC1) reply carries the dotted-quad address as ASCII bytes.
    function decodeIp(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length === 0) return null;
        let s = '';
        for (let i = 0; i < r.payload.length; i++) {
            const b = r.payload[i];
            if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
        }
        return s;
    }

    // get-digital-out (0xAB) reply: {do1: 0|1, do2: 0|1} or null on error.
    function decodeDigitalOut(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return { do1: r.payload[0] & 1, do2: r.payload[1] & 1 };
    }

    // set/get-ao-voltage (0xA0/0xA1) reply carries the commanded level as uint16 LE mV.
    function decodeAoVoltage(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return r.payload[0] | (r.payload[1] << 8);
    }

    // set-firmware-file (0xE0) reply: uint32 LE CRC-32 of the stored image.
    function decodeSetFirmwareFileResponse(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 4) return null;
        const m = r.payload;
        return (m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0;
    }

    // get-firmware-info (0xE3) reply: 32-byte footer
    //   {magic[8], version[16], image_crc32 (u32 LE), image_size (u32 LE)}.
    function decodeFirmwareInfo(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 32) return null;
        const p = r.payload;
        const ascii = (start, end) => {
            let s = '';
            for (let i = start; i < end; i++) {
                const b = p[i];
                if (b === 0) break;
                if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
            }
            return s;
        };
        const u32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
        return {
            magic: ascii(0, 8),
            version: ascii(8, 24),
            imageCrc32: u32(24),
            imageSize: u32(28)
        };
    }

    // g6-program-panel (0xC8) reply: status byte + ASCII detail. `ok` === flash
    // succeeded; `message` carries the controller's diagnostic / failure step.
    function decodeProgramPanelResponse(resp) {
        const r = asResponse(resp);
        if (!r) return null;
        let message = '';
        for (let i = 0; i < r.payload.length; i++) {
            const b = r.payload[i];
            if (b >= 0x20 && b < 0x7f) message += String.fromCharCode(b);
        }
        return { ok: r.ok, status: r.status, message };
    }

    return {
        // Constants
        OPCODES,
        MODES,
        PANEL_DISPLAY_MODE_NAMES,
        CAPABILITY_BITS,
        STREAM_FRAME_BYTES,

        // Encoders (request frames)
        encodeAllOn,
        encodeAllOff,
        encodeStop,
        encodeSystemReset,
        encodeTrialParams,
        encodeSetFramePosition,
        encodeStreamFrame,
        encodeSetRefreshRate,
        encodeGetRefreshRate,
        encodeSetPanelDisplayMode,
        encodeGetPanelDisplayMode,
        encodeSetSpiClock,
        encodeGetSpiClock,
        encodeGetFramesSent,
        encodeResetFramesSent,
        encodeGetIp,
        encodeGetControllerInfo,
        // Alias under the name the handoff lists for the get-info request.
        getControllerInfo: encodeGetControllerInfo,
        encodeGetFileCount,
        encodeGetPatternFilename,
        encodeGetPatternInfo,
        encodeSetPatternFilename,
        encodeGetPatternFile,
        encodeSetPatternFile,
        encodeDeletePatternFile,
        encodeDeleteAllPatterns,
        encodeGetSdArchive,
        encodeSetFirmwareFile,
        encodeGetFirmwareInfo,
        encodeG6ProgramPanel,
        encodeG6VerifyPanel,
        encodeSetAoVoltage,
        encodeGetAoVoltage,
        encodeGetDigitalOut,
        encodeSetDigitalOut,

        // Decoders
        decodeResponse,
        decodeControllerInfo,
        decodeSpiClock,
        decodeRefreshRate,
        decodePanelDisplayMode,
        decodeFramesSent,
        decodeIp,
        decodeFileCount,
        decodePatternFilename,
        decodePatternInfo,
        decodeSetPatternFilenameResponse,
        decodeAoVoltage,
        decodeDigitalOut,
        decodeSetFirmwareFileResponse,
        decodeFirmwareInfo,
        decodeProgramPanelResponse
    };
})();

// Export for Node.js (CommonJS) — used by tests/test-arena-wire-g6.js.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ArenaWireG6;
}

// Export for browser (global) — used by <script src=> callers (the G6 web
// console, LAB-93) which read window.ArenaWireG6.
if (typeof window !== 'undefined') {
    window.ArenaWireG6 = ArenaWireG6;
}
