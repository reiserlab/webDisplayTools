/**
 * controller-settings.js — the "assert before run" logic for sticky controller settings.
 *
 * Design: docs/development/controller-settings-strategy.md. A protocol may declare a
 * top-level `controller:` block (panel_mode, refresh_hz | refresh_policy, panel_firmware);
 * a rig YAML may declare `defaults:` (panel_mode), `limits:` (max_refresh_hz),
 * `requires:` (panel_firmware) and `strict:`. Before every run the Studio reads a snapshot
 * of the controller, asks planAssertions() what to SET, what to BLOCK on and what to WARN
 * about, executes the SETs (GET → SET → GET), and writes intended / before / after into
 * the run header. Nothing here touches hardware: the planner is pure so it can be tested.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    // Wire value === index. `persist` is the firmware's own word for mode 1; `persistent`
    // is what people write.
    const PANEL_MODE_NAMES = ['oneshot', 'persistent', 'triggered', 'gated'];
    const PANEL_MODE_ALIASES = { oneshot: 0, persist: 1, persistent: 1, triggered: 2, gated: 3 };
    // Controller capability bit a panel mode needs (arena-wire-g6 CAPABILITY_BITS).
    const PANEL_MODE_CAPABILITY = { 2: 'v3_triggered', 3: 'v3_gated' };

    const REFRESH_POLICIES = ['line_sync_safe'];
    // Firmware default re-transmit rate per pattern grayscale (the .pat header gs code:
    // 1 = GS2, 2 = GS16). A GS2 pattern on an unmodified controller streams at 1000 Hz.
    const DEFAULT_REFRESH_HZ = { 1: 1000, 2: 300 };
    const REFRESH_HZ_MIN = 1;
    const REFRESH_HZ_MAX = 2000;

    function normalizePanelMode(v) {
        if (v === undefined || v === null || v === '') return null;
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (Object.prototype.hasOwnProperty.call(PANEL_MODE_ALIASES, s)) return PANEL_MODE_ALIASES[s];
            if (/^[0-3]$/.test(s)) return Number(s);
            return null;
        }
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) return v;
        return null;
    }

    function panelModeName(m) {
        return m === null || m === undefined ? '?' : PANEL_MODE_NAMES[m] || 'mode' + m;
    }

    /**
     * Does a panel-firmware footer version satisfy a requirement string?
     * The SD footer version is `<tag>` for tagged builds (e.g. "panel-fw-v1.2.0") or
     * `<abbrev>-<sha8>[-d]` for variants (e.g. "2p-9014b5bb-d"). A requirement matches when
     * the version starts with it or contains it as a dash/underscore-delimited token
     * (case-insensitive). So `panel_firmware: "2p"` accepts "2p-9014b5bb-d" and
     * "panel-fw-v1.2.0" accepts exactly that tag.
     */
    function firmwareMatches(footerVersion, required) {
        if (!required) return true;
        if (!footerVersion) return false;
        const v = String(footerVersion).trim().toLowerCase();
        const r = String(required).trim().toLowerCase();
        if (!r) return true;
        if (v === r || v.startsWith(r)) return true;
        return v.split(/[-_ ]+/).includes(r);
    }

    /**
     * Normalize a protocol's raw `controller:` block. Never throws; reports problems in
     * `errors` (blocking) and `warnings`. `declared` is false when the block is absent.
     */
    function normalizeControllerBlock(raw) {
        const out = {
            declared: false,
            panel_mode: null,
            refresh_hz: null,
            refresh_policy: null,
            panel_firmware: null,
            errors: [],
            warnings: []
        };
        if (raw === undefined || raw === null) return out;
        out.declared = true;
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            out.errors.push('controller: must be a mapping (panel_mode / refresh_hz / refresh_policy / panel_firmware)');
            return out;
        }
        const known = ['panel_mode', 'refresh_hz', 'refresh_policy', 'panel_firmware'];
        for (const k of Object.keys(raw)) {
            if (!known.includes(k)) out.warnings.push('controller: unknown key "' + k + '" is ignored (known: ' + known.join(', ') + ')');
        }
        if (raw.panel_mode !== undefined && raw.panel_mode !== null) {
            const m = normalizePanelMode(raw.panel_mode);
            if (m === null) {
                out.errors.push('controller.panel_mode ' + JSON.stringify(raw.panel_mode) + ' is not 0–3 or one of ' + PANEL_MODE_NAMES.join('/'));
            } else {
                out.panel_mode = m;
            }
        }
        if (raw.refresh_hz !== undefined && raw.refresh_hz !== null) {
            const hz = Number(raw.refresh_hz);
            if (!Number.isInteger(hz) || hz < REFRESH_HZ_MIN || hz > REFRESH_HZ_MAX) {
                out.errors.push('controller.refresh_hz ' + JSON.stringify(raw.refresh_hz) + ' must be an integer ' + REFRESH_HZ_MIN + '–' + REFRESH_HZ_MAX);
            } else {
                out.refresh_hz = hz;
            }
        }
        if (raw.refresh_policy !== undefined && raw.refresh_policy !== null) {
            const p = String(raw.refresh_policy).trim();
            if (!REFRESH_POLICIES.includes(p)) {
                out.errors.push('controller.refresh_policy ' + JSON.stringify(raw.refresh_policy) + ' must be one of ' + REFRESH_POLICIES.join('/'));
            } else {
                out.refresh_policy = p;
            }
        }
        if (out.refresh_hz !== null && out.refresh_policy !== null) {
            out.errors.push('controller: declare refresh_hz OR refresh_policy, not both');
        }
        if (raw.panel_firmware !== undefined && raw.panel_firmware !== null) {
            if (typeof raw.panel_firmware !== 'string' || !raw.panel_firmware.trim()) {
                out.errors.push('controller.panel_firmware must be a non-empty string (a footer version or its prefix, e.g. "2p")');
            } else {
                out.panel_firmware = raw.panel_firmware.trim();
            }
        }
        return out;
    }

    /**
     * Decide what a run must do about the controller's sticky state.
     *
     * @param {object} a
     * @param {object} [a.block]        normalizeControllerBlock() result (or raw block)
     * @param {object} [a.rig]          parseRigIo() result: {name, defaults:{panel_mode}, limits:{max_refresh_hz},
     *                                  requires:{panel_firmware}, strict}
     * @param {object} [a.snapshot]     {panel_mode, refresh_hz, capabilities[], panel_firmware:{version}|null,
     *                                  verified:{ok, verified, total, at}|null}; fields null when unreadable
     * @param {Array}  [a.patterns]     [{name, gsVal}] for the patterns the sequence references (gsVal 1|2|null)
     * @param {string} [a.protocolRig]  rig name the protocol's `rig:` path resolves to (basename without .yaml)
     * @param {string} [a.sessionRig]   the Studio's session rig name
     * @returns {{ok:boolean, strict:boolean, actions:Array, blocking:string[], warnings:string[], intended:object}}
     */
    function planAssertions(a) {
        a = a || {};
        const block = a.block && typeof a.block === 'object' && 'declared' in a.block ? a.block : normalizeControllerBlock(a.block);
        const rig = a.rig || {};
        const rigDefaults = rig.defaults || {};
        const rigLimits = rig.limits || {};
        const rigRequires = rig.requires || {};
        const snap = a.snapshot || {};
        const caps = Array.isArray(snap.capabilities) ? snap.capabilities : null;
        const patterns = Array.isArray(a.patterns) ? a.patterns : [];
        const strict = !!rig.strict || !!block.declared;
        const actions = [];
        const blocking = [];
        const warnings = [];
        const intended = {};
        const problem = (msg) => (strict ? blocking : warnings).push(msg);

        for (const e of block.errors || []) blocking.push(e);
        for (const w of block.warnings || []) warnings.push(w);

        // 1. Rig identity — the protocol's rig and the bench's rig must agree.
        if (a.protocolRig && a.sessionRig && a.protocolRig !== a.sessionRig) {
            problem('protocol is written for rig "' + a.protocolRig + '" but the session rig is "' + a.sessionRig + '"' +
                (strict ? ' — pick the right rig in the top bar or fix the protocol\'s rig: path' : ''));
        }

        // 2. Panel display mode: protocol wins, else the rig default. Nothing declared → record only.
        const wantMode = block.panel_mode !== null && block.panel_mode !== undefined ? block.panel_mode : normalizePanelMode(rigDefaults.panel_mode);
        if (wantMode !== null) {
            intended.panel_mode = wantMode;
            const needCap = PANEL_MODE_CAPABILITY[wantMode];
            if (needCap && caps && !caps.includes(needCap)) {
                blocking.push('panel mode ' + panelModeName(wantMode) + ' needs controller capability "' + needCap + '", which this controller does not report');
            } else if (snap.panel_mode === null || snap.panel_mode === undefined) {
                problem('cannot read the panel display mode (GET_PANEL_DISPLAY_MODE 0x1C gave no reply) — wanted ' + panelModeName(wantMode));
            } else if (snap.panel_mode !== wantMode) {
                actions.push({ setting: 'panel_mode', from: snap.panel_mode, to: wantMode });
            }
        }

        // 3. Refresh rate: explicit refresh_hz, else derived (rig cap + pattern grayscale).
        const cap = Number.isInteger(rigLimits.max_refresh_hz) ? rigLimits.max_refresh_hz : null;
        const gsList = patterns.map((p) => (p && (p.gsVal === 1 || p.gsVal === 2) ? p.gsVal : null));
        const gsKnown = gsList.filter((g) => g !== null);
        intended.pattern_gs = gsKnown.length ? Array.from(new Set(gsKnown)).map((g) => (g === 1 ? 'GS2' : 'GS16')) : null;
        if (block.refresh_hz !== null) {
            intended.refresh_hz = block.refresh_hz;
            if (cap !== null && block.refresh_hz > cap) {
                blocking.push('controller.refresh_hz ' + block.refresh_hz + ' exceeds the rig limit max_refresh_hz ' + cap);
            } else if (snap.refresh_hz === null || snap.refresh_hz === undefined) {
                problem('cannot read the refresh rate (GET_REFRESH_RATE 0x17 gave no reply) — wanted ' + block.refresh_hz + ' Hz');
            } else if (snap.refresh_hz !== block.refresh_hz) {
                actions.push({ setting: 'refresh_hz', from: snap.refresh_hz, to: block.refresh_hz });
            }
        } else if (block.refresh_policy === 'line_sync_safe' || cap !== null) {
            if (cap === null) {
                problem('controller.refresh_policy line_sync_safe needs the rig to declare limits.max_refresh_hz — nothing to cap at');
            } else {
                intended.refresh_hz_max = cap;
                // The firmware default for the referenced patterns' grayscale is what the controller
                // would stream at if nobody had set the rate; if that (or the current rate) is above the
                // cap, pin the rate to the cap.
                const wouldDefault = gsKnown.length ? Math.max.apply(null, gsKnown.map((g) => DEFAULT_REFRESH_HZ[g])) : null;
                if (snap.refresh_hz === null || snap.refresh_hz === undefined) {
                    problem('cannot read the refresh rate (GET_REFRESH_RATE 0x17 gave no reply) — rig caps it at ' + cap + ' Hz');
                } else if (snap.refresh_hz > cap) {
                    actions.push({ setting: 'refresh_hz', from: snap.refresh_hz, to: cap });
                } else if (wouldDefault !== null && wouldDefault > cap && snap.refresh_hz !== cap) {
                    // e.g. a GS2 pattern (default 1000 Hz) on a 300 Hz-capped rig: pin explicitly.
                    actions.push({ setting: 'refresh_hz', from: snap.refresh_hz, to: cap });
                }
                if (gsKnown.length !== patterns.length && patterns.length) {
                    warnings.push('grayscale unknown for ' + (patterns.length - gsKnown.length) + ' referenced pattern(s) — refresh derived from the readable ones only');
                }
            }
        }

        // 4. Panel firmware: protocol requirement wins, else the rig's. A declared requirement is hard.
        const wantFw = block.panel_firmware || (typeof rigRequires.panel_firmware === 'string' ? rigRequires.panel_firmware : null);
        if (wantFw) {
            intended.panel_firmware = wantFw;
            const ver = snap.panel_firmware && snap.panel_firmware.version ? snap.panel_firmware.version : null;
            if (!ver) {
                problem('cannot read the panel firmware footer (GET_FIRMWARE_INFO 0xE3) — required "' + wantFw + '"');
            } else if (!firmwareMatches(ver, wantFw)) {
                blocking.push('panel firmware on the SD card is "' + ver + '", required "' + wantFw + '" — flash the fleet (Console → Panel firmware) or change the requirement');
            }
            const v = snap.verified;
            if (!v) {
                warnings.push('panels not verified this session — the footer says which image is on the SD card, not which firmware every panel runs; run Verify panels (' + (strict ? 'strongly recommended on this rig' : 'optional') + ')');
            } else if (v.ok === false) {
                blocking.push('panel verify failed: ' + (v.total - v.verified) + ' of ' + v.total + ' panels do not match the SD footer "' + (v.footer || ver || '?') + '"' + (v.mismatched && v.mismatched.length ? ' (panels ' + v.mismatched.join(', ') + ')' : ''));
            }
        }

        return { ok: blocking.length === 0, strict, actions, blocking, warnings, intended };
    }

    /** One line for the transcript / run header. */
    function formatSnapshot(s) {
        if (!s) return 'controller: (no snapshot)';
        const parts = [];
        parts.push('panel mode ' + (s.panel_mode === null || s.panel_mode === undefined ? '?' : panelModeName(s.panel_mode) + ' (' + s.panel_mode + ')'));
        parts.push('refresh ' + (s.refresh_hz === null || s.refresh_hz === undefined ? '?' : s.refresh_hz + ' Hz'));
        if (s.spi_mhz !== null && s.spi_mhz !== undefined) parts.push('SPI ' + s.spi_mhz + ' MHz');
        if (s.dio_roles) parts.push('DIO ' + s.dio_roles.map((d, i) => (i + 1) + '=' + d.role).join(' '));
        if (s.ao_mv !== null && s.ao_mv !== undefined) parts.push('AO ' + s.ao_mv + ' mV');
        if (s.panel_firmware && s.panel_firmware.version) parts.push('panel fw «' + s.panel_firmware.version + '»');
        if (s.verified) parts.push('verified ' + s.verified.verified + '/' + s.verified.total + (s.verified.ok ? '' : ' MISMATCH'));
        if (s.controller_firmware) parts.push('controller ' + s.controller_firmware);
        return parts.join(' · ');
    }

    const ControllerSettings = {
        PANEL_MODE_NAMES,
        PANEL_MODE_CAPABILITY,
        REFRESH_POLICIES,
        DEFAULT_REFRESH_HZ,
        normalizePanelMode,
        panelModeName,
        firmwareMatches,
        normalizeControllerBlock,
        planAssertions,
        formatSnapshot
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ControllerSettings;
    }
    if (typeof global !== 'undefined') {
        global.ControllerSettings = ControllerSettings;
    }
})(typeof window !== 'undefined' ? window : this);
