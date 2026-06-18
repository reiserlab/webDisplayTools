/**
 * pattern-set.js — Pattern Set / SD-bundle model + manifest builder (LAB-92).
 *
 * The shared engine behind the Experiment Designer's "Pattern Set" builder and
 * (later, LAB-95) the Arena Console pattern picker. It assembles an ordered set of
 * `.pat` patterns, renames them to the firmware-friendly `pat%04d.pat` so the SD
 * card's alphabetical scan position == the 1-based index == `pattern_ID`, and emits
 * the manifest files that bind the SD card to the list that was built.
 *
 * Follows the MATLAB SD convention (maDisplayTools/utils/prepare_sd_card.m) so a
 * web-built SD is interchangeable with a MATLAB-built one and verifiable the same
 * way:
 *   - pattern files renamed `NNN_<name>.pat` (1-based; human name lives in MANIFEST.txt)
 *   - MANIFEST.bin : uint16 count + uint32 unix timestamp, LITTLE-ENDIAN (Teensy native)
 *   - MANIFEST.txt : human-readable map + Pattern Set ID, CRLF line endings
 *   - timestamps   : iso `yyyy-mm-ddTHH:MM:SS` (local), unix `uint32`, file `yyyymmdd_HHMMSS`
 *   - `set_id`     == the `yyyymmdd_HHMMSS` string (the binding key, generated at export)
 *
 * Dependency injection: the few functions that parse/encode/look-up arenas take a
 * `deps` object `{ parsePatFile, encode, getConfig }` (mirrors pat-parser's
 * `findMatchingConfig(data, STANDARD_CONFIGS)` injection). This keeps the module
 * free of sibling imports, so it loads cleanly as a plain `<script src>` global
 * (`window.PatternSet`) AND `require()`s in Node — no ESM/CJS dance, and it can't
 * trigger the catastrophic ES-module import-failure gotcha.
 */
(function () {
    'use strict';

    var TOOL = 'webDisplayTools/pattern-set';
    var MANIFEST_VERSION = 1;
    // The G6 panel duty_cycle byte the encoder defaults to (50% brightness). Dropping
    // stretchValues on re-encode lets pat-encoder apply this — the duty fix that
    // retires the bench session's patch_duty.js. (G4/G4.1 "stretch" is left alone.)
    var G6_DEFAULT_DUTY_CYCLE = 0x80;

    // ── small helpers ────────────────────────────────────────────────────────
    function pad(n, width) {
        var s = String(n);
        while (s.length < width) s = '0' + s;
        return s;
    }

    /** Normalize ArrayBuffer | TypedArray | Node Buffer → a tight ArrayBuffer. */
    function toArrayBuffer(bytes) {
        if (bytes instanceof ArrayBuffer) return bytes;
        if (bytes && bytes.buffer instanceof ArrayBuffer) {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
        throw new Error('pattern-set: expected ArrayBuffer / TypedArray / Buffer');
    }

    /** Derive a clean human name from a source filename. */
    function sanitizeName(raw) {
        var s = String(raw == null ? '' : raw);
        // strip any directory components
        s = s.replace(/^.*[\\/]/, '');
        // strip a trailing .pat (case-insensitive)
        s = s.replace(/\.pat$/i, '');
        // strip a leading SD-style prefix so re-ingesting a built set doesn't stack them
        s = s.replace(/^pat\d{1,}$/i, s); // pat0001 (no name) → leave for the fallback below
        s = s.replace(/^pat(\d{2,})[_-]?/i, ''); // pat0001_foo → foo
        s = s.replace(/^\d{1,}[_-]/, ''); // 001_foo → foo (legacy NNN_ scheme)
        // collapse anything not filename-friendly
        s = s
            .replace(/[^A-Za-z0-9_-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        return s || 'pattern';
    }

    function uniqueName(set, base) {
        var taken = {};
        for (var i = 0; i < set.items.length; i++) taken[set.items[i].name] = true;
        if (!taken[base]) return base;
        var n = 2;
        while (taken[base + '_' + n]) n++;
        return base + '_' + n;
    }

    // ── set model ────────────────────────────────────────────────────────────
    function createPatternSet(opts) {
        opts = opts || {};
        return {
            tool: TOOL,
            version: MANIFEST_VERSION,
            arenaConfig: opts.arenaConfig || null,
            source: null, // 'builtin' | 'remote' | 'local' — set on first ingest (no mixing)
            items: [],
            set_id: null, // finalized at buildBundle() time
            created: null
        };
    }

    function clearItems(set) {
        set.items = [];
        set.source = null;
    }

    /** Lightweight per-pattern metadata (pickers render real thumbnails on demand). */
    function summarizePattern(parsed) {
        return {
            gs: parsed.gs_val,
            frames: parsed.numFrames,
            rows: parsed.pixelRows,
            cols: parsed.pixelCols
        };
    }

    /**
     * Validate a parsed pattern against a target arena config (by name).
     * Returns { ok, reason } — `reason` is a user-facing message on mismatch.
     * Mirrors pat-parser's findMatchingConfig logic but against the SPECIFIC target.
     */
    function validateGeometry(parsed, arenaConfig, getConfig) {
        var cfg = getConfig ? getConfig(arenaConfig) : null;
        if (!cfg || !cfg.arena) {
            return { ok: false, reason: 'unknown arena config "' + arenaConfig + '"' };
        }
        var a = cfg.arena;
        var genOk =
            parsed.generation === a.generation ||
            (parsed.generation === 'G4' && a.generation === 'G4.1');
        var installedCols = a.columns_installed ? a.columns_installed.length : a.num_cols;
        if (!genOk) {
            return {
                ok: false,
                reason:
                    parsed.generation + ' pattern — arena ' + arenaConfig + ' is ' + a.generation
            };
        }
        if (parsed.rowCount !== a.num_rows || parsed.colCount !== installedCols) {
            return {
                ok: false,
                reason:
                    parsed.rowCount +
                    '×' +
                    parsed.colCount +
                    ' panels — arena ' +
                    arenaConfig +
                    ' is ' +
                    a.num_rows +
                    '×' +
                    installedCols
            };
        }
        return { ok: true, reason: null };
    }

    /**
     * Re-encode a parsed pattern through the injected encoder, dropping the G6
     * stretch/duty bytes so the encoder applies its 0x80 default (the duty fix).
     * G4/G4.1 "stretch" is a different concept (#97) and is preserved untouched.
     */
    function reencodeForDuty(parsed, encode) {
        var isG6 = parsed.generation === 'G6';
        var patternData = {
            generation: parsed.generation,
            gs_val: parsed.gs_val,
            numFrames: parsed.numFrames,
            rowCount: parsed.rowCount,
            colCount: parsed.colCount,
            pixelRows: parsed.pixelRows,
            pixelCols: parsed.pixelCols,
            frames: parsed.frames,
            // G6: [] → encoder fills G6_DEFAULT_DUTY_CYCLE. G4/G4.1: keep original.
            stretchValues: isG6 ? [] : parsed.stretchValues || [],
            arena_id: parsed.arena_id || 0,
            observer_id: parsed.observer_id || 0
        };
        return encode(patternData);
    }

    /**
     * Parse + validate + (if valid) re-encode a .pat into the set.
     * @param deps { parsePatFile, encode, getConfig }
     * @returns the staged item.
     */
    function ingest(set, bytes, sourceName, sourceKind, deps) {
        if (!set.arenaConfig) throw new Error('pattern-set: set has no arenaConfig');
        if (set.source && sourceKind && set.source !== sourceKind) {
            throw new Error(
                'pattern-set: cannot mix sources (' + set.source + ' vs ' + sourceKind + ')'
            );
        }
        var ab = toArrayBuffer(bytes);
        var parsed = deps.parsePatFile(ab);
        var v = validateGeometry(parsed, set.arenaConfig, deps.getConfig);
        var item = {
            name: uniqueName(set, sanitizeName(sourceName)),
            sourceName: String(sourceName == null ? '' : sourceName),
            parsed: parsed,
            preview: summarizePattern(parsed),
            valid: v.ok,
            reason: v.reason,
            matlabPath: null,
            index: null,
            sd_name: null,
            // canonical, duty-corrected bytes for valid entries; original bytes for
            // invalid ones (they can't be exported anyway)
            bytes: v.ok ? reencodeForDuty(parsed, deps.encode) : ab
        };
        set.items.push(item);
        if (sourceKind) set.source = sourceKind;
        return item;
    }

    function removeItem(set, index) {
        if (index < 0 || index >= set.items.length) return;
        set.items.splice(index, 1);
        if (set.items.length === 0) set.source = null;
    }

    function reorderItem(set, from, to) {
        if (from < 0 || from >= set.items.length) return;
        to = Math.max(0, Math.min(set.items.length - 1, to));
        var it = set.items.splice(from, 1)[0];
        set.items.splice(to, 0, it);
    }

    function renameItem(set, index, newName) {
        if (index < 0 || index >= set.items.length) return null;
        var base = sanitizeName(newName);
        // uniqueness check excluding the item being renamed
        var taken = {};
        for (var i = 0; i < set.items.length; i++) {
            if (i !== index) taken[set.items[i].name] = true;
        }
        var name = base;
        if (taken[name]) {
            var n = 2;
            while (taken[base + '_' + n]) n++;
            name = base + '_' + n;
        }
        set.items[index].name = name;
        return name;
    }

    /** Assign 1-based indices + `pat%04d.pat` SD filenames over the ordered items. */
    function assignIndices(set) {
        for (var i = 0; i < set.items.length; i++) {
            set.items[i].index = i + 1;
            // NNN_<name>.pat: the zero-padded index pins the firmware's alphabetical
            // scan order (== 1-based pattern_ID), and the descriptive suffix keeps the
            // name longer than 8.3 so it gets a FAT long-filename entry. Pure-8.3 names
            // (e.g. pat0001.pat) are mis-read by the bench G6 controller build, so this
            // scheme is what actually loads (matches the hand-staged 001_grating_gs2.pat
            // set). 3 digits supports the firmware's 256-pattern cap with stable sorting.
            set.items[i].sd_name = pad(i + 1, 3) + '_' + set.items[i].name + '.pat';
        }
        return set;
    }

    // ── timestamps (MATLAB convention) ─────────────────────────────────────────
    function makeTimestamps(date) {
        var d = date || new Date();
        var Y = d.getFullYear();
        var Mo = pad(d.getMonth() + 1, 2);
        var Da = pad(d.getDate(), 2);
        var H = pad(d.getHours(), 2);
        var Mi = pad(d.getMinutes(), 2);
        var S = pad(d.getSeconds(), 2);
        return {
            iso: Y + '-' + Mo + '-' + Da + 'T' + H + ':' + Mi + ':' + S,
            file: '' + Y + Mo + Da + '_' + H + Mi + S,
            unix: Math.floor(d.getTime() / 1000)
        };
    }

    // ── manifest writers ───────────────────────────────────────────────────────

    // FNV-1a 32-bit over sorted SD filenames, each followed by '\n'.
    // Matches the Teensy firmware's patternSetId() in SdManager.cpp.
    var _imul = Math.imul || function (a, b) {
        var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
        var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
        return ((al * bh + ah * bl) << 16) | (al * bl);
    };
    function computePatternSetId(sdNames) {
        var h = 2166136261;
        for (var i = 0; i < sdNames.length; i++) {
            for (var j = 0; j < sdNames[i].length; j++) {
                h = (h ^ sdNames[i].charCodeAt(j)) >>> 0;
                h = _imul(h, 16777619) >>> 0;
            }
            h = (h ^ 10) >>> 0;
            h = _imul(h, 16777619) >>> 0;
        }
        return ('00000000' + h.toString(16).toUpperCase()).slice(-8);
    }

    /** MANIFEST.bin: uint16 count + uint32 unix timestamp, little-endian. */
    function buildManifestBin(count, unix) {
        var buf = new ArrayBuffer(6);
        var dv = new DataView(buf);
        dv.setUint16(0, count & 0xffff, true);
        dv.setUint32(2, unix >>> 0, true);
        return new Uint8Array(buf);
    }

    /** MANIFEST.txt: human-readable map + Pattern Set ID, CRLF (matches prepare_sd_card.m). */
    function buildManifestTxt(set, ts, opts) {
        opts = opts || {};
        var sdDrive = opts.sdDrive || '(copy to the SD card root)';
        var sdNames = set.items.map(function (it) { return it.sd_name; });
        var lines = [];
        lines.push('Timestamp: ' + ts.iso);
        lines.push('SD Drive: ' + sdDrive);
        lines.push('Pattern Count: ' + set.items.length);
        lines.push('Pattern Set ID: ' + computePatternSetId(sdNames));
        lines.push('');
        lines.push('Mapping:');
        for (var i = 0; i < set.items.length; i++) {
            lines.push(set.items[i].sd_name + ' <- ' + set.items[i].name);
        }
        return lines.join('\r\n') + '\r\n';
    }

    function buildReadme(set, ts) {
        var ex1 = set.items[0] ? set.items[0].sd_name : '001_pattern.pat';
        var ex2 = set.items[1] ? set.items[1].sd_name : '002_pattern.pat';
        var lines = [];
        lines.push('Pattern set ' + ts.file + '  (arena ' + set.arenaConfig + ')');
        lines.push('Built ' + ts.iso + ' by ' + TOOL + '.');
        lines.push('');
        lines.push('DEPLOY TO THE SD CARD');
        lines.push('  Copy the CONTENTS of this bundle to the ROOT of a FAT32 SD card, so the');
        lines.push('  card looks exactly like this (the firmware scans /patterns/*.pat and');
        lines.push('  assigns the 1-based pattern_ID by alphabetical filename):');
        lines.push('');
        lines.push('    <SD root>/');
        lines.push('      patterns/');
        lines.push('        ' + ex1);
        lines.push('        ' + ex2 + '  ...');
        lines.push('      MANIFEST.bin   MANIFEST.txt   README.txt');
        lines.push('');
        lines.push('  - Do NOT drop a wrapper folder on the card -- "patterns" sits at the root.');
        lines.push('  - Do NOT rename the .pat files -- the NNN_ prefix sets the pattern_ID');
        lines.push('    order, and the long names avoid an 8.3-filename issue on the controller.');
        lines.push('  - Seat the card BEFORE powering on the controller (SD is mounted at boot).');
        lines.push('');
        lines.push('Patterns (SD index = pattern_ID):');
        for (var i = 0; i < set.items.length; i++) {
            var it = set.items[i];
            lines.push('  ' + it.index + '. ' + it.sd_name + '  ' + it.name);
        }
        lines.push('');
        return lines.join('\r\n') + '\r\n';
    }

    /**
     * Produce everything for a bundle ZIP / SD image in one call (used by the
     * designer modal and the Node default-set generator). Validates first.
     * @returns { ts, set_id, manifestBin, manifestTxt, readme,
     *            patterns: [{ name: sd_name, bytes: ArrayBuffer }] }
     */
    function buildBundle(set, opts) {
        opts = opts || {};
        if (!set.arenaConfig) throw new Error('pattern-set: set has no arenaConfig');
        if (!set.items.length) throw new Error('pattern-set: no patterns selected');
        var invalid = set.items.filter(function (it) {
            return !it.valid;
        });
        if (invalid.length) {
            throw new Error(
                'pattern-set: ' +
                    invalid.length +
                    ' invalid pattern(s): ' +
                    invalid
                        .map(function (it) {
                            return it.name + ' (' + it.reason + ')';
                        })
                        .join('; ')
            );
        }
        var ts = opts.ts || makeTimestamps();
        assignIndices(set);
        set.set_id = ts.file;
        set.created = ts.iso;
        return {
            ts: ts,
            set_id: ts.file,
            manifestBin: buildManifestBin(set.items.length, ts.unix),
            manifestTxt: buildManifestTxt(set, ts, opts),
            readme: buildReadme(set, ts),
            patterns: set.items.map(function (it) {
                return { name: it.sd_name, bytes: it.bytes };
            })
        };
    }

    // ── read API ────────────────────────────────────────────────────────────────
    /** Parse a MANIFEST.txt back into { timestamp, count, pattern_set_id, patterns:[{sd_name,index,name}] }. */
    function parseManifestTxt(text) {
        var out = { timestamp: null, count: null, pattern_set_id: null, patterns: [] };
        var lines = String(text).split(/\r\n|\n|\r/);
        var inMap = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^Timestamp:\s*/.test(line)) {
                out.timestamp = line.replace(/^Timestamp:\s*/, '').trim();
            } else if (/^Pattern Count:\s*/.test(line)) {
                out.count = parseInt(line.replace(/^Pattern Count:\s*/, ''), 10);
            } else if (/^Pattern Set ID:\s*/.test(line)) {
                out.pattern_set_id = line.replace(/^Pattern Set ID:\s*/, '').trim();
            } else if (/^Mapping:\s*$/.test(line)) {
                inMap = true;
            } else if (inMap) {
                var m = line.match(/^\s*((\d+)_.*?\.pat)\s*<-\s*(.+?)\s*$/i);
                if (m) {
                    out.patterns.push({
                        sd_name: m[1],
                        index: parseInt(m[2], 10),
                        name: m[3]
                    });
                }
            }
        }
        return out;
    }

    var PatternSet = {
        TOOL: TOOL,
        MANIFEST_VERSION: MANIFEST_VERSION,
        G6_DEFAULT_DUTY_CYCLE: G6_DEFAULT_DUTY_CYCLE,
        // model
        createPatternSet: createPatternSet,
        clearItems: clearItems,
        ingest: ingest,
        removeItem: removeItem,
        reorderItem: reorderItem,
        renameItem: renameItem,
        assignIndices: assignIndices,
        // helpers
        sanitizeName: sanitizeName,
        summarizePattern: summarizePattern,
        validateGeometry: validateGeometry,
        reencodeForDuty: reencodeForDuty,
        makeTimestamps: makeTimestamps,
        computePatternSetId: computePatternSetId,
        // manifests / bundle
        buildManifestBin: buildManifestBin,
        buildManifestTxt: buildManifestTxt,
        buildReadme: buildReadme,
        buildBundle: buildBundle,
        // read API
        parseManifestTxt: parseManifestTxt
    };

    // Dual export — browser global + Node (CommonJS). Deliberately NO bare top-level
    // ES `export` so this file is safe to load as a plain <script src> (window
    // global) the way the designer/console do, mirroring js/pat-encoder.js.
    if (typeof window !== 'undefined') {
        window.PatternSet = PatternSet;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PatternSet;
    }
})();
