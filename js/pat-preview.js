/**
 * pat-preview.js — animated .pat thumbnail sampler for the pattern pickers (LAB-95/96).
 *
 * Shared by the v3 Experiment Designer pattern picker and the Arena Console picker.
 * Replicates the pattern_editor clipboard tray's "animated thumbnail" trick: render a
 * handful of evenly-sampled frames to small cylindrical icons, keep the middle one as
 * the static image, and let the caller cycle `img.src` through the rest on hover. This
 * is far cheaper than encoding a real GIF (bounded to `max` renders even for a
 * 200-frame pattern) and reuses icon-generator's `generatePatternIcon`.
 *
 * Pure orchestration: it never imports icon-generator or touches the arena registry —
 * the per-frame renderer is INJECTED (`opts.renderIcon`, the caller's
 * `generatePatternIcon`). The only DOM use is the optional flat-canvas fallback, which
 * is guarded by `typeof document` so this file `require()`s cleanly in Node. Mirrors
 * pattern-set.js's dependency-injection + dual-export style (window global + Node
 * CommonJS, NO bare ES `export`) so it loads as a plain <script src> in both tools and
 * can't trigger the catastrophic ES-module import-failure gotcha.
 */
(function () {
    'use strict';

    var DEFAULT_MAX = 10;
    var DEFAULT_SIZE = 72;
    // Largest card-only pattern a thumbnail may download over USB. The controller can
    // only send the WHOLE file (GET_PATTERN_FILE 0x84, no ranged read), and nothing else
    // can use the link while it streams (~10 MB/s), so a bigger file gets no thumbnail.
    var LIVE_FETCH_MAX_BYTES = 1 << 20;

    /**
     * May a thumbnail download a card-only pattern over USB right now?
     * @param info  GET_PATTERN_INFO decode for it ({ fileSize, … }) or null when unknown.
     * @param state { connected, running } — a run owns the link.
     * @returns { ok, reason } — reason ∈ 'offline' | 'running' | 'unknown-size' | 'too-large'.
     */
    function liveFetchVerdict(info, state) {
        if (!state || !state.connected) return { ok: false, reason: 'offline' };
        if (state.running) return { ok: false, reason: 'running' };
        var size = info && info.fileSize;
        if (typeof size !== 'number' || !isFinite(size) || size <= 0) {
            return { ok: false, reason: 'unknown-size' };
        }
        if (size > LIVE_FETCH_MAX_BYTES) return { ok: false, reason: 'too-large' };
        return { ok: true, reason: null };
    }

    /**
     * Pick up to `max` evenly-spaced frame indices from a [0, numFrames) range.
     * Matches pattern_editor's frameStep sampling (floor(numFrames/max), capped).
     */
    function pickFrameIndices(numFrames, max) {
        max = max || DEFAULT_MAX;
        var n = numFrames | 0;
        if (n <= 0) return [];
        if (n <= max) {
            var all = [];
            for (var i = 0; i < n; i++) all.push(i);
            return all;
        }
        var step = Math.max(1, Math.floor(n / max));
        var idxs = [];
        for (var f = 0; f < n && idxs.length < max; f += step) idxs.push(f);
        return idxs;
    }

    /**
     * Flat (rectangular) thumbnail of one frame → PNG dataURL. Green-phosphor ramp,
     * row 0 at the bottom — mirrors pattern_editor's generateThumbnail. Browser-only:
     * returns null where there is no `document` (Node) so callers can skip gracefully.
     */
    function renderFlatFrame(frameData, pixelRows, pixelCols, gsVal, size) {
        if (typeof document === 'undefined' || !frameData || !pixelRows || !pixelCols) {
            return null;
        }
        size = size || DEFAULT_SIZE;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        var scaleX = size / pixelCols;
        var scaleY = size / pixelRows;
        var maxVal = gsVal === 2 ? 1 : 15;
        for (var row = 0; row < pixelRows; row++) {
            for (var col = 0; col < pixelCols; col++) {
                var value = frameData[row * pixelCols + col];
                var brightness = value / maxVal;
                if (brightness > 0) {
                    var r = Math.round(brightness * 0.6 * 255);
                    var g = Math.round(brightness * 255);
                    var b = Math.round(brightness * 0.2 * 255);
                    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
                } else {
                    ctx.fillStyle = '#1e2329';
                }
                // flip Y so row 0 sits at the bottom
                var y = (pixelRows - 1 - row) * scaleY;
                ctx.fillRect(col * scaleX, y, Math.ceil(scaleX), Math.ceil(scaleY));
            }
        }
        return canvas.toDataURL();
    }

    /**
     * Render the animated-preview frame set for a parsed .pat.
     * @param parsed       pat-parser output ({ frames, pixelRows, pixelCols, gs_val, … }).
     * @param arenaConfig  the arena object (getConfig(name).arena) for the cylindrical icon.
     * @param opts {
     *   max         max frames to sample (default 10),
     *   renderIcon  REQUIRED (parsed, arenaConfig, iconOpts) → dataURL  (generatePatternIcon),
     *   iconOpts    extra options merged into each renderIcon call (width/height/colors…),
     *   flatFallback  use renderFlatFrame when renderIcon throws (default true)
     * }
     * @returns { frames: [dataURL…], staticIndex } — staticIndex = the middle frame.
     */
    function samplePreviewFrames(parsed, arenaConfig, opts) {
        opts = opts || {};
        var renderIcon = opts.renderIcon;
        var iconOpts = opts.iconOpts || {};
        var useFlat = opts.flatFallback !== false;
        var size = iconOpts.width || DEFAULT_SIZE;
        var numFrames = parsed && parsed.frames ? parsed.frames.length : 0;
        var idxs = pickFrameIndices(numFrames, opts.max || DEFAULT_MAX);
        var frames = [];
        for (var k = 0; k < idxs.length; k++) {
            var frameIndex = idxs[k];
            var url = null;
            if (typeof renderIcon === 'function') {
                try {
                    url = renderIcon(
                        parsed,
                        arenaConfig,
                        merge(iconOpts, { frameIndex: frameIndex })
                    );
                } catch (e) {
                    url = null;
                }
            }
            if (!url && useFlat) {
                url = renderFlatFrame(
                    parsed.frames[frameIndex],
                    parsed.pixelRows,
                    parsed.pixelCols,
                    parsed.gs_val,
                    size
                );
            }
            if (url) frames.push(url);
        }
        return { frames: frames, staticIndex: frames.length ? Math.floor(frames.length / 2) : 0 };
    }

    /** Shallow merge (Object.assign is fine in browser + Node, but keep it explicit). */
    function merge(a, b) {
        var out = {};
        var k;
        for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
        for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
        return out;
    }

    var PatPreview = {
        DEFAULT_MAX: DEFAULT_MAX,
        DEFAULT_SIZE: DEFAULT_SIZE,
        LIVE_FETCH_MAX_BYTES: LIVE_FETCH_MAX_BYTES,
        liveFetchVerdict: liveFetchVerdict,
        pickFrameIndices: pickFrameIndices,
        renderFlatFrame: renderFlatFrame,
        samplePreviewFrames: samplePreviewFrames
    };

    // Dual export — browser global + Node (CommonJS). Deliberately NO bare top-level ES
    // `export`, so this is safe to load as a plain <script src> (window global) in both
    // tools, mirroring js/pattern-set.js and js/pat-encoder.js.
    if (typeof window !== 'undefined') {
        window.PatPreview = PatPreview;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PatPreview;
    }
})();
