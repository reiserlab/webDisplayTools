/**
 * panel-color.js — color-layout model for multi-color G6 panels (LAB-223 / LAB-228).
 *
 * A color G6 panel is the standard 20×20 board with its four LED banks T0–T3 populated
 * with different LEDs. The panel firmware (layout.cpp, NUM_COLOR = 4) lays the banks out
 * as a repeating 2×2 mosaic. In HOST coordinates — the ones the .pat frames, the grid
 * editor and every viewer use; row 0 = bottom, col 0 = left:
 *
 *     bank(row, col) = 2 * (row % 2) + (col % 2)
 *         T0 even row / even col · T1 even / odd · T2 odd / even · T3 odd / odd
 *
 * Spec: Modular-LED-Display docs/development/g6_02-led-mapping.md (color banks section).
 *
 * Consequences the rest of the tool relies on:
 *   - Color is a PANEL property, orthogonal to generation and arena config. No new
 *     generation id, no PANEL_SPECS entry, no arena config, no .pat format change: a color
 *     pattern is an ordinary GS2/GS16 frame whose pixel color is fixed by its position.
 *   - A pure single-color stimulus therefore lights only 100 of the 400 LEDs per panel
 *     (a 10×10 lattice at 2-px pitch). The renderers show exactly that.
 *   - ROW_PARITY_FLIP is the ONE bench-decided knob. js/pat-encoder.js packs panel rows as
 *     `19 - row`, so host-row parity and wire-row parity are opposite; spec + firmware say
 *     host row 0 = bottom = T0/T1 (flip 0). If a bank-0-only pattern lights the other row
 *     parity on a real color panel, set this to 1 — nothing else changes.
 *
 * Dual export — browser global (`window.PanelColor`) + Node (CommonJS). Deliberately NO
 * bare top-level ES `export`, so this file is safe as a plain <script src> (the designer)
 * and readable as `globalThis.PanelColor` from ES-module viewers, mirroring js/pattern-set.js.
 */
(function () {
    'use strict';

    var ROW_PARITY_FLIP = 0;
    var DEFAULT_LAYOUT = 'g6-green';
    var OFF_CSS = '#1e2329'; // the grid's "LED off" color (matches the legacy renderers)

    // LED channels (the spectral types a bank can be populated with). rgb = on-screen
    // primary at full brightness. Green is the legacy phosphor ramp at full (0.6, 1.0, 0.2)
    // so a green bank in a color layout looks exactly like today's mono panel.
    var CHANNELS = {
        green: { id: 'green', label: 'green 525 nm', nm: 525, rgb: [153, 255, 51], visible: true },
        violet: {
            id: 'violet',
            label: 'violet 405 nm',
            nm: 405,
            rgb: [150, 60, 255],
            visible: true
        },
        blue: { id: 'blue', label: 'blue 470 nm', nm: 470, rgb: [40, 120, 255], visible: true },
        yellow: {
            id: 'yellow',
            label: 'yellow-orange 590 nm',
            nm: 590,
            rgb: [255, 170, 20],
            visible: true
        },
        red: { id: 'red', label: 'red 630 nm', nm: 630, rgb: [255, 50, 40], visible: true },
        // Invisible to us and (mostly) to the fly — drawn as a dim false color so the
        // lattice is still visible on screen. Legend text says so.
        ir: {
            id: 'ir',
            label: 'IR 850 nm (false color)',
            nm: 850,
            rgb: [190, 70, 110],
            visible: false
        }
    };

    // [key, label, filename tag, banks T0..T3]. Bank→channel is a BOM-only property of each
    // board variant (g6_02-led-mapping.md): v0.4r1 pilot boards have red on T0+T2 (vertical
    // stripes); v0.4r2 swaps T2↔T3 for the checkerboard.
    var LAYOUT_DEFS = [
        ['g6-green', 'G6 green (standard)', '', ['green', 'green', 'green', 'green']],
        [
            'four-color',
            'G6 four-color (violet · blue · green · yellow-orange)',
            '_4c',
            ['violet', 'blue', 'green', 'yellow']
        ],
        ['red-ir-v0.4r2', 'G6 red + IR checkerboard (v0.4r2)', '_rir', ['red', 'ir', 'ir', 'red']],
        [
            'red-ir-v0.4r1',
            'G6 red + IR stripes (v0.4r1 pilot boards)',
            '_rir1',
            ['red', 'ir', 'red', 'ir']
        ]
    ];

    var LAYOUTS = {};
    var LAYOUT_KEYS = [];
    LAYOUT_DEFS.forEach(function (def) {
        var banks = def[3];
        var channels = [];
        banks.forEach(function (id) {
            if (
                !channels.some(function (c) {
                    return c.id === id;
                })
            )
                channels.push(CHANNELS[id]);
        });
        LAYOUTS[def[0]] = Object.freeze({
            key: def[0],
            label: def[1],
            tag: def[2],
            mono: channels.length === 1,
            banks: banks.slice(),
            bankChannel: banks.map(function (id) {
                return CHANNELS[id];
            }),
            channels: channels
        });
        LAYOUT_KEYS.push(def[0]);
    });

    function layoutKeys() {
        return LAYOUT_KEYS.slice();
    }
    function getLayout(key) {
        return (key && LAYOUTS[key]) || null;
    }
    function isMono(key) {
        var l = getLayout(key);
        return !l || l.mono;
    }
    function getChannel(id) {
        return CHANNELS[id] || null;
    }

    /** Bank index 0..3 of the LED at host (row, col). The one place the mosaic lives. */
    function bankAt(row, col) {
        return 2 * ((row + ROW_PARITY_FLIP) & 1) + (col & 1);
    }
    /** Bottom-left (even/even) corner of the 2×2 cell containing (row, col). */
    function cellOrigin(row, col) {
        return [row & ~1, col & ~1];
    }

    function channelAt(key, row, col) {
        var l = getLayout(key);
        if (!l) return CHANNELS.green;
        return l.bankChannel[bankAt(row, col)];
    }

    function clamp01(x) {
        return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    /**
     * Per-bank ON-color weights [w0..w3] ∈ [0,1].
     *   preset = 'all' | null      → [1,1,1,1]
     *   preset = <channel id>      → 1 on that channel's banks, 0 elsewhere
     *   preset = { id: level0..15} → level/15 per bank (GS16) or level>0 ? 1 : 0 (GS2);
     *                                channels absent from the object are 0
     * Mono / unknown layouts always return [1,1,1,1] (there is nothing to mask).
     */
    function channelWeightsFromPreset(key, preset, gsMode) {
        var l = getLayout(key);
        if (!l || l.mono || preset == null || preset === 'all') return [1, 1, 1, 1];
        if (typeof preset === 'string') {
            if (
                !l.channels.some(function (c) {
                    return c.id === preset;
                })
            )
                return [1, 1, 1, 1];
            return l.banks.map(function (id) {
                return id === preset ? 1 : 0;
            });
        }
        var binary = gsMode === 2;
        return l.banks.map(function (id) {
            var lvl = Number(preset[id]);
            if (!Number.isFinite(lvl)) return 0;
            lvl = Math.max(0, Math.min(15, Math.round(lvl)));
            return binary ? (lvl > 0 ? 1 : 0) : lvl / 15;
        });
    }

    function isIdentity(weights) {
        return (
            !weights ||
            (weights[0] === 1 && weights[1] === 1 && weights[2] === 1 && weights[3] === 1)
        );
    }

    /**
     * Mask a frame in place by the ON-color weights: v → min(maxVal, round(v · w[bank])).
     * Identity for mono layouts or all-ones weights. Returns the frame.
     */
    function applyOnColor(frame, pixelRows, pixelCols, gsMode, key, weights) {
        if (isMono(key) || isIdentity(weights)) return frame;
        var maxVal = gsMode === 2 ? 1 : 15;
        for (var r = 0; r < pixelRows; r++) {
            for (var c = 0; c < pixelCols; c++) {
                var i = r * pixelCols + c;
                var v = frame[i];
                if (!v) continue;
                var out = Math.round(v * clamp01(weights[bankAt(r, c)]));
                frame[i] = out > maxVal ? maxVal : out;
            }
        }
        return frame;
    }

    /**
     * 2×2 cell brush: set the four LEDs of the cell containing (row, col) to
     * round(value · w[bank]) — replace semantics. Out-of-range LEDs are skipped.
     */
    function paintCell(frame, pixelRows, pixelCols, gsMode, key, row, col, value, weights) {
        var maxVal = gsMode === 2 ? 1 : 15;
        var o = cellOrigin(row, col);
        var w = isMono(key) || !weights ? [1, 1, 1, 1] : weights;
        for (var dr = 0; dr < 2; dr++) {
            for (var dc = 0; dc < 2; dc++) {
                var r = o[0] + dr;
                var c = o[1] + dc;
                if (r < 0 || c < 0 || r >= pixelRows || c >= pixelCols) continue;
                var out = Math.round(value * clamp01(w[bankAt(r, c)]));
                frame[r * pixelCols + c] = out > maxVal ? maxVal : out;
            }
        }
        return frame;
    }

    // Legacy green-phosphor ramp (the value the renderers used before color): r 0.6, g 1, b 0.2.
    function legacyRgb(b, fn) {
        return [fn(b * 0.6 * 255), fn(b * 255), fn(b * 0.2 * 255)];
    }
    function pixelRgb(key, row, col, brightness, fn) {
        var b = clamp01(brightness);
        if (isMono(key)) return legacyRgb(b, fn);
        var rgb = channelAt(key, row, col).rgb;
        return [fn(rgb[0] * b), fn(rgb[1] * b), fn(rgb[2] * b)];
    }

    /** 2D canvas fill color for the LED at (row, col). Off → OFF_CSS. Math.round like the grid. */
    function pixelCss(key, row, col, brightness) {
        if (!(brightness > 0)) return OFF_CSS;
        var c = pixelRgb(key, row, col, brightness, Math.round);
        return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    }
    /** 3D material color (THREE hex). Math.floor like the legacy ThreeViewer ramp. */
    function pixelHex(key, row, col, brightness) {
        var c = pixelRgb(key, row, col, brightness, Math.floor);
        return (c[0] << 16) | (c[1] << 8) | c[2];
    }
    /** Position-free value ramp (palette swatches): the mono ramp. */
    function valueCss(brightness) {
        return pixelCss(DEFAULT_LAYOUT, 0, 0, brightness);
    }
    /** A channel's on-screen color at full brightness (chip dots, legends). */
    function channelCss(id) {
        var ch = getChannel(id) || CHANNELS.green;
        return 'rgb(' + ch.rgb[0] + ',' + ch.rgb[1] + ',' + ch.rgb[2] + ')';
    }

    function describeLayout(key) {
        var l = getLayout(key);
        if (!l) return '';
        if (l.mono) return 'All four LED banks ' + l.channels[0].label + ' (standard G6 panel).';
        return (
            l.banks
                .map(function (id, i) {
                    return 'T' + i + ' ' + CHANNELS[id].label;
                })
                .join(' · ') + ' — 2×2 mosaic: bank = 2·(row%2)+(col%2), row 0 = bottom.'
        );
    }
    /** Short hint for the status bar; '' for mono. */
    function legendText(key) {
        var l = getLayout(key);
        if (!l || l.mono) return '';
        var s = 'values are per-LED; color is where the LED sits';
        if (
            l.channels.some(function (c) {
                return !c.visible;
            })
        )
            s += ' · IR shown as false color';
        return s;
    }
    function filenameTag(key) {
        var l = getLayout(key);
        return l ? l.tag : '';
    }

    var PanelColor = {
        ROW_PARITY_FLIP: ROW_PARITY_FLIP,
        DEFAULT_LAYOUT: DEFAULT_LAYOUT,
        OFF_CSS: OFF_CSS,
        CHANNELS: CHANNELS,
        LAYOUTS: LAYOUTS,
        layoutKeys: layoutKeys,
        getLayout: getLayout,
        getChannel: getChannel,
        isMono: isMono,
        describeLayout: describeLayout,
        legendText: legendText,
        filenameTag: filenameTag,
        bankAt: bankAt,
        cellOrigin: cellOrigin,
        channelAt: channelAt,
        channelWeightsFromPreset: channelWeightsFromPreset,
        applyOnColor: applyOnColor,
        paintCell: paintCell,
        pixelCss: pixelCss,
        pixelHex: pixelHex,
        valueCss: valueCss,
        channelCss: channelCss
    };

    if (typeof window !== 'undefined') {
        window.PanelColor = PanelColor;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PanelColor;
    }
})();
