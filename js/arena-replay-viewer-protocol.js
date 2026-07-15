/**
 * Message-envelope and replay-state helpers for arena_replay_viewer.html.
 *
 * This file intentionally has no DOM dependencies. The popup uses the browser global and the
 * Node regression test uses CommonJS, following the dual-export pattern used elsewhere in WDT.
 */
(function () {
    'use strict';

    var CHANNEL = 'arena-studio-replay-viewer';
    var VERSION = 1;
    var OPENER_SOURCE = 'arena-studio-alt';
    var VIEWER_SOURCE = 'arena-replay-viewer';
    var INBOUND_TYPES = ['init', 'pattern', 'state', 'close'];
    var OUTBOUND_TYPES = ['ready', 'close'];
    var SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function isSessionId(value) {
        return typeof value === 'string' && SESSION_RE.test(value);
    }

    function normalizeOrigin(value) {
        if (value === 'null') return 'null';
        if (typeof value !== 'string' || !value) return null;
        try {
            var parsed = new URL(value);
            return parsed.origin === 'null' ? null : parsed.origin;
        } catch (error) {
            return null;
        }
    }

    function makeMessage(source, type, sessionId, payload) {
        var allowedTypes = source === VIEWER_SOURCE ? OUTBOUND_TYPES : INBOUND_TYPES;
        if (source !== OPENER_SOURCE && source !== VIEWER_SOURCE) {
            throw new Error('Unknown replay message source');
        }
        if (allowedTypes.indexOf(type) === -1) {
            throw new Error('Message type is not valid for this source');
        }
        if (!isSessionId(sessionId)) {
            throw new Error('Invalid replay session id');
        }
        return {
            channel: CHANNEL,
            version: VERSION,
            source: source,
            type: type,
            sessionId: sessionId,
            payload: isPlainObject(payload) ? payload : {}
        };
    }

    /**
     * Validate a MessageEvent-like object from the Arena Studio opener.
     *
     * context: { openerWindow, expectedOrigin, sessionId }
     * The window reference check is intentional: origin validation alone is insufficient when
     * several same-origin Arena Studio windows are open.
     */
    function validateInbound(event, context) {
        var cfg = context || {};
        if (!event || event.source !== cfg.openerWindow) {
            return { ok: false, reason: 'window' };
        }
        if (event.origin !== cfg.expectedOrigin) {
            return { ok: false, reason: 'origin' };
        }

        var data = event.data;
        if (!isPlainObject(data)) return { ok: false, reason: 'envelope' };
        if (data.channel !== CHANNEL) return { ok: false, reason: 'channel' };
        if (data.version !== VERSION) return { ok: false, reason: 'version' };
        if (data.source !== OPENER_SOURCE) return { ok: false, reason: 'source' };
        if (data.sessionId !== cfg.sessionId) return { ok: false, reason: 'session' };
        if (INBOUND_TYPES.indexOf(data.type) === -1) {
            return { ok: false, reason: 'type' };
        }
        if (data.payload !== undefined && !isPlainObject(data.payload)) {
            return { ok: false, reason: 'payload' };
        }
        return { ok: true, message: data };
    }

    /**
     * Validate a MessageEvent-like object received by the Arena Studio opener.
     *
     * context: { viewerWindow, expectedOrigin, sessionId }
     * This is the opener-side counterpart to validateInbound(). Both checks bind an exchange to
     * one exact popup window, origin, and replay session so parallel viewers cannot cross-talk.
     */
    function validateFromViewer(event, context) {
        var cfg = context || {};
        if (!event || event.source !== cfg.viewerWindow) {
            return { ok: false, reason: 'window' };
        }
        if (event.origin !== cfg.expectedOrigin) {
            return { ok: false, reason: 'origin' };
        }

        var data = event.data;
        if (!isPlainObject(data)) return { ok: false, reason: 'envelope' };
        if (data.channel !== CHANNEL) return { ok: false, reason: 'channel' };
        if (data.version !== VERSION) return { ok: false, reason: 'version' };
        if (data.source !== VIEWER_SOURCE) return { ok: false, reason: 'source' };
        if (data.sessionId !== cfg.sessionId) return { ok: false, reason: 'session' };
        if (OUTBOUND_TYPES.indexOf(data.type) === -1) {
            return { ok: false, reason: 'type' };
        }
        if (data.payload !== undefined && !isPlainObject(data.payload)) {
            return { ok: false, reason: 'payload' };
        }
        return { ok: true, message: data };
    }

    function finiteNumber(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function clampHorizontalFov(value, minimum, maximum, fallback) {
        var min = finiteNumber(minimum, 60);
        var max = Math.max(min, finiteNumber(maximum, 150));
        var resolved = finiteNumber(value, finiteNumber(fallback, 120));
        return Math.min(max, Math.max(min, resolved));
    }

    function horizontalToVerticalFov(horizontalFov, aspect) {
        var horizontal = Math.min(179, Math.max(1, finiteNumber(horizontalFov, 120)));
        var safeAspect = Math.max(0.01, finiteNumber(aspect, 1));
        var halfWidth = (horizontal * Math.PI) / 360;
        return (2 * Math.atan(Math.tan(halfWidth) / safeAspect) * 180) / Math.PI;
    }

    function normalizeLedState(value, fallback) {
        if (value === undefined || value === null) return Boolean(fallback);
        if (typeof value === 'number') return Number.isFinite(value) && value > 0;
        if (typeof value === 'string') {
            var normalized = value.trim().toLowerCase();
            return (
                normalized === '1' ||
                normalized === 'true' ||
                normalized === 'on' ||
                normalized === 'active'
            );
        }
        return value === true;
    }

    /**
     * Canonical synchronized state. `frame` is zero-based on the wire.
     * Accept a few explicit aliases so callers can pass a parsed JSONL record directly.
     */
    function normalizeReplayState(value, previous) {
        var input = isPlainObject(value) ? value : {};
        var before = isPlainObject(previous) ? previous : {};
        var elapsedCandidate =
            input.elapsedMs !== undefined
                ? input.elapsedMs
                : input.timeMs !== undefined
                  ? input.timeMs
                  : input.elapsed_ms;
        var frameCandidate =
            input.frame !== undefined
                ? input.frame
                : input.patternFrame !== undefined
                  ? input.patternFrame
                  : input.framePosition !== undefined
                    ? input.framePosition
                    : input.frame_position !== undefined
                      ? input.frame_position
                      : input.frame_index;
        var ledCandidate =
            input.ledOn !== undefined
                ? input.ledOn
                : input.led_on !== undefined
                  ? input.led_on
                  : input.on !== undefined
                    ? input.on
                    : input.ledActivation !== undefined
                      ? input.ledActivation
                      : input.ledPercent !== undefined
                        ? input.ledPercent
                        : before.ledOn;
        var conditionCandidate =
            input.condition !== undefined
                ? input.condition
                : input.conditionLabel !== undefined
                  ? input.conditionLabel
                  : input.condition_name;
        var hasDisplayMode =
            input.displayMode !== undefined ||
            input.display_mode !== undefined ||
            before.displayMode !== undefined;
        var displayCandidate =
            input.displayMode !== undefined
                ? input.displayMode
                : input.display_mode !== undefined
                  ? input.display_mode
                  : before.displayMode;

        var elapsedMs = Math.max(0, finiteNumber(elapsedCandidate, before.elapsedMs || 0));
        var frame = Math.max(0, Math.floor(finiteNumber(frameCandidate, before.frame || 0)));
        var condition =
            conditionCandidate === undefined || conditionCandidate === null
                ? before.condition || '—'
                : String(conditionCandidate).slice(0, 160);

        var output = {
            elapsedMs: elapsedMs,
            condition: condition,
            frame: frame,
            ledOn: normalizeLedState(ledCandidate, before.ledOn)
        };
        if (hasDisplayMode) {
            output.displayMode =
                displayCandidate === 'all-on' || displayCandidate === 'pattern'
                    ? displayCandidate
                    : 'off';
        }
        return output;
    }

    function formatElapsed(elapsedMs) {
        var milliseconds = Math.max(0, finiteNumber(elapsedMs, 0));
        var totalSeconds = milliseconds / 1000;
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = totalSeconds - minutes * 60;
        return String(minutes).padStart(2, '0') + ':' + seconds.toFixed(2).padStart(5, '0');
    }

    var ArenaReplayViewerProtocol = {
        CHANNEL: CHANNEL,
        VERSION: VERSION,
        OPENER_SOURCE: OPENER_SOURCE,
        VIEWER_SOURCE: VIEWER_SOURCE,
        INBOUND_TYPES: INBOUND_TYPES.slice(),
        OUTBOUND_TYPES: OUTBOUND_TYPES.slice(),
        isSessionId: isSessionId,
        normalizeOrigin: normalizeOrigin,
        makeMessage: makeMessage,
        validateInbound: validateInbound,
        validateFromViewer: validateFromViewer,
        normalizeReplayState: normalizeReplayState,
        formatElapsed: formatElapsed,
        clampHorizontalFov: clampHorizontalFov,
        horizontalToVerticalFov: horizontalToVerticalFov
    };

    if (typeof window !== 'undefined') {
        window.ArenaReplayViewerProtocol = ArenaReplayViewerProtocol;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ArenaReplayViewerProtocol;
    }
})();
