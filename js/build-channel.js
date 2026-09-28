/**
 * build-channel.js — which release tier is this page? (Production / Next / local)
 *
 * The Pages deploy (scripts/tiers/stamp.py) stamps EVERY served page with one line
 *     <meta name="wdt-build" content="{channel, sha, candidate, built_at_et, …}">
 * and writes build.json at each tier root. This module reads that stamp — the identity
 * of the HTML actually running, not whatever the server holds now — and provides:
 *
 *   detect(doc, loc)          → { channel: 'production'|'next'|'local', known, sha, candidate, … }
 *                               (no stamp under /next/ → 'next' with known:false, NEVER 'local')
 *   badgeModel(build)         → { text, title, cls } for the top-bar badge
 *   runMeta(build)            → { channel, build, candidate } for run_metadata
 *   windowName(base, build)   → tier-suffixed window name, so a Next link never
 *                               focuses a Production tab (and vice versa)
 *   samePageTier(path, build) → does another tab's pathname belong to this tier?
 *   checkFresh(fetchFn, build, url) → { stale, servedSha } — the HTML is older than the deploy
 *   markerCurrent(stored, current) → typed, monotonic one-time-migration marker check
 *   renderBadge(doc, host, build)   → the only DOM helper (tolerant of a missing host)
 *
 * Both tiers share ONE origin (localStorage, Web Serial grants, window names), so the
 * coexistence rules live here: see docs/development/release-process.md.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, NO bare ES
 * `export`) — loaded in the classic substrate so it survives an ES-module import failure.
 */
(function (global) {
    'use strict';

    const META_NAME = 'wdt-build';

    function parse(content) {
        if (!content) return null;
        try {
            const o = JSON.parse(content);
            return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
        } catch (_) {
            return null;
        }
    }

    function inNextPath(pathname) {
        return /(^|\/)next\//.test(String(pathname || ''));
    }

    /** Read the build stamp. doc/loc default to the page's document/location. */
    function detect(doc, loc) {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        const l = loc || (typeof location !== 'undefined' ? location : null);
        let meta = null;
        try {
            const el = d && d.querySelector && d.querySelector('meta[name="' + META_NAME + '"]');
            meta = parse(el && el.getAttribute('content'));
        } catch (_) {
            meta = null;
        }
        if (meta && (meta.channel === 'production' || meta.channel === 'next')) {
            return Object.assign({ known: true }, meta);
        }
        if (l && inNextPath(l.pathname)) {
            // Served under /next/ but unstamped: it is still the testing tier.
            return { channel: 'next', known: false, sha: null, candidate: null };
        }
        return { channel: 'local', known: false, sha: null, candidate: null };
    }

    function short(sha) {
        return sha ? String(sha).slice(0, 7) : '?';
    }

    function candidateLabel(build) {
        const c = build && build.candidate;
        if (!c) return null;
        if (c.label) return c.label;
        return c.name ? 'candidate ' + c.name + (c.rc ? '-rc' + c.rc : '') : null;
    }

    function badgeModel(build) {
        const b = build || {};
        if (b.channel === 'production') {
            return {
                cls: 'wdt-ch-prod',
                text: 'beta',
                title:
                    'Production build ' +
                    short(b.sha) +
                    (b.built_at_et ? ' · deployed ' + b.built_at_et : '') +
                    ' — the version the rigs run. The project is pre-1.0 (beta).'
            };
        }
        if (b.channel === 'next') {
            const label = candidateLabel(b);
            const prs = ((b.candidate && b.candidate.prs) || [])
                .map((p) => '#' + p.number)
                .join(' ');
            return {
                cls: 'wdt-ch-next',
                text: 'NEXT' + (label ? ' · ' + label.replace(/^candidate /, '') : ''),
                title:
                    'NEXT — testing build' +
                    (label ? ' (' + label + (prs ? ': ' + prs : '') + ')' : '') +
                    (b.known ? '' : ' (build stamp missing)') +
                    '. For validation between sessions — not for routine experiments.'
            };
        }
        return {
            cls: 'wdt-ch-local',
            text: 'LOCAL',
            title: 'Served from a local checkout (not a deployed build)'
        };
    }

    function runMeta(build) {
        const b = build || {};
        return { channel: b.channel || null, build: b.sha || null, candidate: candidateLabel(b) };
    }

    function windowName(base, build) {
        const b = build || detect();
        return b.channel === 'next' ? base + '@next' : base;
    }

    /** True when another tab's pathname is on the same tier as this page. */
    function samePageTier(pathname, build) {
        const b = build || detect();
        return inNextPath(pathname) === (b.channel === 'next');
    }

    /**
     * Compare the stamped build with the tier's build.json (no-store). A mismatch means
     * this page (or its cached scripts) predates the live deploy → hard refresh.
     */
    async function checkFresh(fetchFn, build, url) {
        const b = build || detect();
        if (!b.known || !b.sha || typeof fetchFn !== 'function')
            return { stale: false, servedSha: null };
        try {
            const r = await fetchFn(url || 'build.json', { cache: 'no-store' });
            if (!r || !r.ok) return { stale: false, servedSha: null };
            const live = await r.json();
            const served = live && live.sha ? String(live.sha) : null;
            return { stale: !!served && served !== b.sha, servedSha: served };
        } catch (_) {
            return { stale: false, servedSha: null };
        }
    }

    /**
     * One-time migration markers are shared by both tiers (same origin). Compare TYPED
     * and MONOTONIC: a marker is current when it parses to a value >= `current` of the
     * same kind (integer or ISO date). Missing / malformed / older → migrate. Never
     * `stored !== current`: that made each tier wipe the other's prefs on every switch.
     */
    function markerCurrent(stored, current) {
        const s = stored == null ? '' : String(stored).trim();
        const c = String(current).trim();
        const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
        const isInt = (v) => /^\d+$/.test(v);
        if (isDate(c)) return isDate(s) && s >= c;
        if (isInt(c)) return isInt(s) && parseInt(s, 10) >= parseInt(c, 10);
        return s === c;
    }

    /** Insert (or refresh) the badge in `host`; removes the deploy's injected banner. */
    function renderBadge(doc, host, build) {
        const d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d || !host) return null;
        const b = build || detect(d);
        const m = badgeModel(b);
        let el = host.querySelector('.wdt-channel');
        if (!el) {
            el = d.createElement('span');
            host.appendChild(el);
        }
        el.className = 'wdt-channel ' + m.cls;
        el.textContent = m.text;
        el.title = m.title;
        if (b.channel === 'next') {
            // The page shows its own badge; the generic injected banner would overlap it.
            // The deploy injects that banner just before </body>, so a badge rendered from an
            // early script runs before it is parsed — remove it now AND once the DOM is done.
            const drop = () => {
                const inj = d.getElementById('wdt-next-banner');
                if (inj && inj.parentNode) inj.parentNode.removeChild(inj);
            };
            drop();
            if (d.readyState === 'loading' && typeof d.addEventListener === 'function') {
                d.addEventListener('DOMContentLoaded', drop, { once: true });
            }
        }
        return el;
    }

    const BuildChannel = {
        META_NAME,
        parse,
        detect,
        badgeModel,
        runMeta,
        windowName,
        samePageTier,
        checkFresh,
        markerCurrent,
        renderBadge,
        inNextPath
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = BuildChannel;
    if (global) global.BuildChannel = BuildChannel;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
