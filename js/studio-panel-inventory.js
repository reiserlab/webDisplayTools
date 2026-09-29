/**
 * studio-panel-inventory.js — read and summarize the controller's panel
 * inventory (GET_PANEL_INVENTORY 0xD1 / PANEL_INVENTORY_SCAN 0xD0, firmware
 * #59; g6_03-controller.md § 0xD_), DOM-free so it is Node-testable
 * (tests/test-studio-panel-inventory.js):
 *
 *   - readAll(send)        pages the whole fleet (32 panels per page) and re-reads
 *                          from the start when the pages' scan_id disagree (a boot
 *                          retry or another host's rescan landed between pages)
 *   - summarize(pages)     per-panel statuses → present/missing, distinct firmware
 *                          fingerprints, the panels that differ from the majority
 *   - describe(inv)        one-line label for the Console log / provenance box
 *   - toRunMeta(inv)       the compact record written to run_metadata.panels
 *
 * Gate every call on the 0xC2 feature 'panel_inventory' (decodeControllerInfo
 * ().features): firmware without it answers 0xD1 with CE_UNKNOWN_CMD and an error
 * glyph on the arena.
 *
 * LOADING: classic <script src> (window-global `StudioPanelInventory` + CommonJS),
 * no ES `export` — same rule as arena-session.js (CLAUDE.md).
 */
(function (global) {
    'use strict';

    const Wire =
        (typeof require === 'function' &&
            (() => {
                try {
                    return require('./arena-wire-g6.js');
                } catch (_) {
                    return null;
                }
            })()) ||
        global.ArenaWireG6;

    const PRESENT_STATUSES = new Set([2, 3, 4, 5, 6]);
    const FINGERPRINTED = new Set([3, 4, 5]);

    const hex32 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

    /**
     * Read every page. `send(bytes, {timeoutMs})` resolves to the raw response
     * (ArenaSession.send). Resolves to {pages[], entries[]} or throws.
     */
    async function readAll(send, opts) {
        const o = opts || {};
        const retries = o.retries == null ? 3 : o.retries;
        const timeoutMs = o.timeoutMs || 2000;
        let lastErr = null;
        for (let attempt = 0; attempt < retries; attempt++) {
            const page0 = Wire.decodePanelInventory(
                await send(Wire.encodeGetPanelInventory(), { timeoutMs })
            );
            if (!page0) throw new Error('no GET_PANEL_INVENTORY reply');
            const pages = [page0];
            let entries = page0.entries.slice();
            let consistent = true;
            while (entries.length < page0.panelCount) {
                const next = Wire.decodePanelInventory(
                    await send(Wire.encodeGetPanelInventory(entries.length), { timeoutMs })
                );
                if (!next || next.n === 0) throw new Error('short GET_PANEL_INVENTORY page');
                if (next.scanId !== page0.scanId) {
                    consistent = false;
                    lastErr = new Error('scan_id changed between pages');
                    break;
                }
                if (next.first !== entries.length || next.panelCount !== page0.panelCount) {
                    consistent = false;
                    lastErr = new Error('incoherent GET_PANEL_INVENTORY pages');
                    break;
                }
                pages.push(next);
                entries = entries.concat(next.entries);
            }
            if (consistent) return { pages, entries };
        }
        throw lastErr || new Error('panel inventory read did not settle');
    }

    /** {pages, entries} → the summary object every consumer reads. */
    function summarize(read) {
        const page0 = read.pages[0];
        const entries = read.entries;
        const statuses = entries.map((e) => e.status);
        const present = entries.filter((e) => PRESENT_STATUSES.has(e.status)).map((e) => e.panel);
        const missing = entries.filter((e) => e.status === 1).map((e) => e.panel);
        const unknown = entries.filter((e) => e.status === 0).map((e) => e.panel);
        const noIsp = entries.filter((e) => e.status === 6).map((e) => e.panel);
        const byCrc = new Map();
        for (const e of entries) {
            if (!FINGERPRINTED.has(e.status)) continue;
            if (!byCrc.has(e.crc32))
                byCrc.set(e.crc32, { crc32: e.crc32, panels: [], status: e.status });
            byCrc.get(e.crc32).panels.push(e.panel);
        }
        const firmware = Array.from(byCrc.values())
            .sort((a, b) => b.panels.length - a.panels.length || a.crc32 - b.crc32)
            .map((f) => ({
                crc32: f.crc32,
                hex: hex32(f.crc32),
                panels: f.panels,
                statusName: Wire.PANEL_STATUS_NAMES[f.status]
            }));
        const F = Wire.PANEL_INVENTORY_FLAGS;
        const refPresent = !!(page0.flags & F.REF_PRESENT);
        // "Mismatched" = a panel a preflight should flag: differs from the SD
        // image when there is one, else outside the strict fingerprint majority
        // (a tie names no majority); plus panels that answered COMM_CHECK but
        // not ISP.
        let mismatched = [];
        if (refPresent) {
            mismatched = entries.filter((e) => e.status === 4).map((e) => e.panel);
        } else if (firmware.length > 1 && firmware[0].panels.length > firmware[1].panels.length) {
            mismatched = firmware.slice(1).flatMap((f) => f.panels);
        }
        mismatched = mismatched.concat(noIsp).sort((a, b) => a - b);
        return {
            panelCount: page0.panelCount,
            statuses,
            present,
            missing,
            unknown,
            noIsp,
            firmware,
            mismatched,
            flags: page0.flags,
            flagNames: page0.flagNames,
            presenceValid: !!(page0.flags & F.PRESENCE_VALID),
            fpValid: !!(page0.flags & F.FP_VALID),
            fpInProgress: !!(page0.flags & F.FP_IN_PROGRESS),
            refPresent,
            fpPrefix: !!(page0.flags & F.FP_PREFIX),
            refCrc32: page0.refCrc32,
            fpLen: page0.fpLen,
            ageMs: page0.ageMs,
            scanId: page0.scanId
        };
    }

    /** One line: "20/20 present · fw 0x9BE0D3C7 ×20 (64 KB prefix, no SD image)". */
    function describe(inv) {
        if (!inv) return '—';
        if (!inv.presenceValid) return 'panel scan pending';
        let s = inv.present.length + '/' + inv.panelCount + ' present';
        if (inv.missing.length) s += ' (missing ' + inv.missing.join(', ') + ')';
        if (inv.fpInProgress) {
            s += ' · fingerprinting…';
        } else if (inv.firmware.length) {
            s +=
                ' · fw ' +
                inv.firmware.map((f) => f.hex + ' ×' + f.panels.length).join(', ') +
                (inv.refPresent
                    ? inv.mismatched.length
                        ? ' (' + inv.mismatched.length + ' ≠ SD panel.bin)'
                        : ' (= SD panel.bin)'
                    : ' (' + Math.round(inv.fpLen / 1024) + ' KB prefix, no SD image)');
        }
        if (inv.noIsp.length) s += ' · no ISP reply: ' + inv.noIsp.join(', ');
        return s;
    }

    /**
     * Compact, JSON-friendly record for run_metadata.panels. Always an object, so
     * a log never has to guess what a missing inventory meant: `status` is 'ok'
     * (presence scan valid), 'pending' (the controller's boot scan had not
     * finished), 'failed' (the 0xD1 read failed), 'unsupported' (firmware without
     * the feature) or 'disconnected'. `schema` guards the shape for later readers.
     */
    function toRunMeta(inv, status) {
        if (!inv) return { schema: 1, status: status || 'unsupported' };
        return {
            schema: 1,
            status: status || (inv.presenceValid ? 'ok' : 'pending'),
            count: inv.panelCount,
            present: inv.present.length,
            missing: inv.missing,
            panel_status: inv.statuses,
            firmware: inv.firmware.map((f) => ({ crc32: f.hex, panels: f.panels })),
            mismatched: inv.mismatched,
            ref_crc32: inv.refPresent ? hex32(inv.refCrc32) : null,
            fp_len: inv.fpLen,
            presence_valid: inv.presenceValid,
            fp_valid: inv.fpValid,
            fp_in_progress: inv.fpInProgress,
            scan_id: inv.scanId,
            age_ms: inv.ageMs
        };
    }

    const StudioPanelInventory = { readAll, summarize, describe, toRunMeta, hex32 };

    if (typeof module !== 'undefined' && module.exports) module.exports = StudioPanelInventory;
    global.StudioPanelInventory = StudioPanelInventory;
})(typeof window !== 'undefined' ? window : globalThis);
