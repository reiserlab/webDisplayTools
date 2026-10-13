/**
 * studio-stream-geometry.js — where a Studio test figure lands in a host-streamed
 * STREAM_FRAME (0x32), DOM-free so it is Node-testable
 * (tests/test-studio-stream-geometry.js).
 *
 * The controller accepts stream frames of exactly ITS compiled panel geometry
 * (firmware constants.h panel_count_per_frame; reported by GET_FIRMWARE_VERSION
 * 0xCB as rows × cols): 2×10 on the CSHL boards, 4×12 on the arena_12-18 build.
 * Test figures are drawn on the rig's FULL arena grid (num_rows × num_cols — an
 * uninstalled column is still a grid column), and grid column c is physical
 * column c, so:
 *
 *   - grid column c → firmware column c. Only the INSTALLED columns have to fit
 *     the firmware's column count (G6_1x12of18: installed 0–11 fit a 12-column
 *     build; grid columns 12–17 have no panels and are dropped).
 *   - grid row r → firmware rows r, r + R, r + 2R, … (the rig's rows repeated up
 *     the frame), so a one-row bench install lights whichever row connector its
 *     panels are on. Only firmware rows beyond the rig's own get the repeat.
 *   - firmware without 0xCB: the legacy rule — the rig grid itself must be 20
 *     panels (it is sent as-is).
 *
 * 2×10 and 2×8of10 rigs on 2×10 firmware therefore get the identical frames they
 * got before firmware-sized streaming (the full 2×10 grid, identity mapping).
 *
 * LOADING: classic <script src> (window-global `StudioStreamGeometry` + CommonJS),
 * no ES `export` (CLAUDE.md).
 */
(function (global) {
    'use strict';

    const PANEL_PX = 20;

    /**
     * Rig figure geometry from an arena config's `arena` block (null → 2×10).
     * → { rowCount, colCount, pixelRows, pixelCols, installed: [col…] }
     */
    function rigGeometry(arena) {
        const rowCount = (arena && arena.num_rows) || 2;
        const colCount = (arena && arena.num_cols) || 10;
        const installed =
            arena && Array.isArray(arena.columns_installed) && arena.columns_installed.length
                ? arena.columns_installed.slice().sort((a, b) => a - b)
                : Array.from({ length: colCount }, (_, i) => i);
        return {
            rowCount,
            colCount,
            pixelRows: rowCount * PANEL_PX,
            pixelCols: colCount * PANEL_PX,
            installed
        };
    }

    /**
     * Where the rig's figure goes. firmware = the decoded 0xCB record ({rows, cols})
     * or null. → { ok: true, rig, rows, cols } | { ok: false, rig, reason }
     */
    function streamTarget(rig, firmware) {
        const fv = firmware && firmware.rows > 0 && firmware.cols > 0 ? firmware : null;
        if (fv) {
            const lastInstalled = rig.installed[rig.installed.length - 1];
            if (rig.rowCount > fv.rows || lastInstalled >= fv.cols) {
                return {
                    ok: false,
                    rig,
                    reason:
                        'the rig is ' +
                        rig.rowCount +
                        '×' +
                        rig.colCount +
                        (rig.installed.length < rig.colCount
                            ? ' (' + rig.installed.length + ' columns installed)'
                            : '') +
                        ' but this firmware build streams ' +
                        fv.rows +
                        '×' +
                        fv.cols
                };
            }
            return { ok: true, rig, rows: fv.rows, cols: fv.cols };
        }
        if (rig.rowCount * rig.colCount === 20)
            return { ok: true, rig, rows: rig.rowCount, cols: rig.colCount };
        return {
            ok: false,
            rig,
            reason: 'this firmware does not report its panel geometry (0xCB), so only 20-panel arenas can be streamed'
        };
    }

    /** Map a rig-grid pixel array (row-major, row 0 = bottom) into the firmware frame. */
    function toFirmwareGrid(grid, target) {
        const rp = target.rig.pixelRows;
        const cp = target.rig.pixelCols;
        const R = target.rows * PANEL_PX;
        const C = target.cols * PANEL_PX;
        if (R === rp && C === cp) return grid;
        const out = new Uint8Array(R * C);
        const w = Math.min(cp, C);
        for (let r = 0; r < R; r++) {
            const src = (r % rp) * cp;
            out.set(grid.subarray(src, src + w), r * C);
        }
        return out;
    }

    /** True when target places the rig in a different-shaped firmware frame. */
    const isMapped = (target) =>
        target.rows !== target.rig.rowCount || target.cols !== target.rig.colCount;

    /** Pixel-column span of the installed panels: { lo, hi } (hi exclusive). */
    function installedSpan(rig) {
        return {
            lo: rig.installed[0] * PANEL_PX,
            hi: (rig.installed[rig.installed.length - 1] + 1) * PANEL_PX
        };
    }

    const StudioStreamGeometry = {
        PANEL_PX,
        rigGeometry,
        streamTarget,
        toFirmwareGrid,
        isMapped,
        installedSpan
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = StudioStreamGeometry;
    global.StudioStreamGeometry = StudioStreamGeometry;
})(typeof window !== 'undefined' ? window : globalThis);
