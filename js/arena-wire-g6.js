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
    // encoded here — this is the Milestone-A substrate set. Stream-frame (0x32,
    // Mode 5) pixel assembly is deliberately out of scope (it belongs with the
    // runner, not this transport substrate).
    const OPCODES = {
        ALL_OFF: 0x00,
        TRIAL_PARAMS: 0x08, // selects mode + pattern (Modes 2/3/4)
        SET_REFRESH_RATE: 0x16,
        SET_SPI_CLOCK: 0x17, // uint16 LE MHz (1..30); echoes applied MHz
        GET_SPI_CLOCK: 0x18, // returns uint16 LE current MHz
        GET_FRAMES_SENT: 0x19, // returns uint32 LE frames pushed to panels
        RESET_FRAMES_SENT: 0x1a, // zeroes the frames-sent counter
        STOP_DISPLAY: 0x30,
        GET_ETHERNET_IP: 0x66,
        GET_CONTROLLER_INFO: 0x67, // returns {version, capability_bitmap}
        SET_FRAME_POSITION: 0x70, // Mode 3: host-commanded frame index
        ALL_ON: 0xff
    };

    // Display modes (trial-params `mode` byte). 5 = stream is set via a
    // different command and is not encodable here.
    const MODES = {
        OPEN_LOOP: 2, // host-free frame advance at frame_rate
        SHOW_FRAME: 3, // host sets the frame via SET_FRAME_POSITION
        CLOSED_LOOP: 4 // analog-in × gain, computed on the controller
    };

    // Capability bitmap bits in the get-controller-info (0x67) reply
    // (controller_info.py / main.js, g6_03-controller.md § 5).
    const CAPABILITY_BITS = [
        [0, 'g6_mode'],
        [1, 'v2_local_storage'],
        [2, 'mode_1_tsi'],
        [3, 'v3_triggered'],
        [4, 'v3_gated']
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
     * @param {number} [p.frameRate=0]  frame-advance rate in Hz (Mode 2)
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
        const rate = u16le(p.frameRate === undefined ? 0 : p.frameRate, 'frameRate');
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

    // set-refresh-rate (0x16) — host override of the panel re-transmit rate (Hz, u16 LE).
    function encodeSetRefreshRate(hz) {
        return frame(OPCODES.SET_REFRESH_RATE, u16le(hz, 'hz')); // 03 16 lo hi
    }

    // set-spi-clock (0x17) — panel SPI master clock in whole MHz (u16 LE); echoes
    // applied MHz. The firmware clamps to 1..30 MHz, so reject out-of-range here.
    function encodeSetSpiClock(mhz) {
        requireInt(mhz, 'mhz');
        if (mhz < 1 || mhz > 30) {
            throw new RangeError('mhz must be 1..30, got ' + mhz);
        }
        return frame(OPCODES.SET_SPI_CLOCK, u16le(mhz, 'mhz')); // 03 17 lo hi
    }

    function encodeGetSpiClock() {
        return frame(OPCODES.GET_SPI_CLOCK); // 01 18
    }

    function encodeGetFramesSent() {
        return frame(OPCODES.GET_FRAMES_SENT); // 01 19
    }

    function encodeResetFramesSent() {
        return frame(OPCODES.RESET_FRAMES_SENT); // 01 1A
    }

    function encodeGetIp() {
        return frame(OPCODES.GET_ETHERNET_IP); // 01 66
    }

    function encodeGetControllerInfo() {
        return frame(OPCODES.GET_CONTROLLER_INFO); // 01 67
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
     * get-controller-info (0x67) reply -> {version, capability, capabilities[]}.
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
        return { version, capability, capabilities };
    }

    // set/get-spi-clock (0x17/0x18) reply carries the clock as uint16 LE MHz.
    function decodeSpiClock(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 2) return null;
        return r.payload[0] | (r.payload[1] << 8);
    }

    // get-frames-sent (0x19) reply carries the master-sent count as uint32 LE.
    function decodeFramesSent(resp) {
        const r = asResponse(resp);
        if (!r || !r.ok || r.payload.length < 4) return null;
        const m = r.payload;
        return (m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0;
    }

    // get-ip (0x66) reply carries the dotted-quad address as ASCII bytes.
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

    return {
        // Constants
        OPCODES,
        MODES,
        CAPABILITY_BITS,

        // Encoders (request frames)
        encodeAllOn,
        encodeAllOff,
        encodeStop,
        encodeTrialParams,
        encodeSetFramePosition,
        encodeSetRefreshRate,
        encodeSetSpiClock,
        encodeGetSpiClock,
        encodeGetFramesSent,
        encodeResetFramesSent,
        encodeGetIp,
        encodeGetControllerInfo,
        // Alias under the name the handoff lists for the get-info request.
        getControllerInfo: encodeGetControllerInfo,

        // Decoders
        decodeResponse,
        decodeControllerInfo,
        decodeSpiClock,
        decodeFramesSent,
        decodeIp
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
