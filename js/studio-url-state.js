/**
 * studio-url-state.js — Arena Studio URL state codec (#107, DOM-free, testable).
 *
 * Encodes/decodes the shareable link params: mode / p / lib / set / rig / repo.
 * Shareability boundary (design §9): `p`/`lib` resolve ONLY to committed
 * protocol keys (validated against protocols/index.json by the caller); a
 * locally file-picked YAML has NO shareable URL, so encode() omits p/set when
 * the doc is local. Running-experiment progress is deliberately NOT encoded.
 *
 * `repo` (course pipeline): `?repo=owner/name` re-scopes `p` from a registry
 * KEY to a repo-relative protocols/ PATH (dual meaning gated on repo's
 * presence — e.g. `?repo=reiserlab/cshl-2026-course-data&p=protocols/bench03/
 * looming.yaml`). Shape-validated only; the browser's PAT gates real access.
 *
 * `rig` (#135): the SESSION (bench) rig, validated against
 * configs/rigs/index.json names by the caller (allowedRigs) — a per-setup
 * bookmark, never an override of the protocol's own rig: field. It has no
 * mode implications and is independent of `p` (a rig that disagrees with the
 * loaded protocol raises the Studio's mismatch chip, never a silent
 * reconcile). Encoded only for EXPLICIT selections (user unlock-and-pick or
 * an incoming ?rig=); a session rig merely derived from the loaded protocol
 * is redundant with `p` and stays out of the URL (clean-URL rule).
 *
 * WRITE SIDE (#107): the Studio mirrors state back into the URL via
 * encodeApp() — pushState for user view (mode) changes, replaceState for
 * document-identity changes, popstate restores MODE ONLY (doc identity does
 * not time-travel; the visited entry is canonicalized to actual state, so a
 * stale `p` in an old entry is rewritten on visit). `p` means REGISTRY
 * PROVENANCE: it is kept while the doc is edited/saved (sharing a dirty doc's
 * URL gives the recipient the pristine committed copy). A valid
 * `history.state.mode` marks the AUTHORING browser's own refresh and may
 * override the shared-`p` edit→run force below. `lib`/`set` are reserved
 * (decode-validated, nothing consumes them yet) and are scrubbed by the first
 * write-side URL update — thread them through encodeApp when they get wired.
 * (`dock` was removed 2026-07-02 with the bottom-dock concept; old dock=
 * params are now unknown → silently ignored + scrubbed.)
 *
 * Security: decode() clamps `mode` to run|edit|console, drops unknown enum
 * values, and rejects path-traversal even though paths come from a committed
 * registry (belt-and-suspenders: a malformed committed index must not fetch
 * arbitrary URLs). A shared PRIMARY protocol (`p`) forces `edit` back to Run
 * (newbie-safety — never open someone's shared protocol in an editable view);
 * `console` is always honored (bench links; connect-gated, protocol-agnostic).
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`).
 */
(function (global) {
    'use strict';

    const MODES = ['run', 'edit', 'console'];
    // A committed protocol/pattern-set key: conservative slug, no separators.
    const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
    // A safe committed path under an allowed dir — no traversal, no scheme.
    const SAFE_PATH_RE = /^\.\/(protocols|configs)\/[\w./-]+\.ya?ml$/;
    // A GitHub repo ref (?repo=owner/name). Shape-only — no allowlist; actual
    // access is gated by whichever PAT the browser holds.
    const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
    // `p` when ?repo= is present: a repo-RELATIVE protocol path (no leading ./,
    // unlike SAFE_PATH_RE which validates a document's rig: field). Only
    // protocols/ is loadable — e.g. protocols/bench03/looming.yaml.
    const REPO_PATH_RE = /^protocols\/[\w.-]+(?:\/[\w.-]+)*\.ya?ml$/;

    function isSafeKey(k) {
        return typeof k === 'string' && KEY_RE.test(k);
    }

    // Reject `..`, leading `/`, backslashes, and URL schemes; require the safe shape.
    function isSafePath(p) {
        if (typeof p !== 'string' || !p) return false;
        if (p.includes('..') || p.includes('\\')) return false;
        if (/^\//.test(p) || /^[a-z]+:/i.test(p) || p.startsWith('//')) return false;
        return SAFE_PATH_RE.test(p);
    }

    function isSafeRepo(r) {
        return typeof r === 'string' && !r.includes('..') && REPO_RE.test(r);
    }

    // Repo-relative protocol path (the ?repo= meaning of `p`).
    function isSafeRepoPath(p) {
        if (typeof p !== 'string' || !p) return false;
        if (p.includes('..') || p.includes('\\') || p.startsWith('/')) return false;
        return REPO_PATH_RE.test(p);
    }

    /**
     * Decode a location.search string into validated state + warnings.
     * @param {string} search  e.g. '?p=looming_v3&mode=edit'
     * @param {object} [opts]   {allowedKeys?: string[], allowedRigs?: string[]}
     *                          committed protocol keys / known rig names
     * @returns {{state: object, warnings: string[]}}
     */
    function decode(search, opts) {
        const o = opts || {};
        const allowed = o.allowedKeys ? new Set(o.allowedKeys) : null;
        const allowedRigs = o.allowedRigs ? new Set(o.allowedRigs) : null;
        const warnings = [];
        const params = new URLSearchParams(search || '');
        const state = {};

        // repo — a course/shared data repo (owner/name). Parsed FIRST because
        // it redefines what `p` means below.
        const repo = params.get('repo');
        if (repo != null) {
            if (isSafeRepo(repo)) state.repo = repo;
            else warnings.push('Ignored repo=' + repo + ' (invalid owner/name)');
        }

        // p — contextual (#course pipeline): a registry KEY without ?repo=, a
        // repo-relative protocols/ PATH with it (no registry allowlist applies
        // to a non-curated repo — the PAT gates actual access).
        const pv = params.get('p');
        if (pv != null) {
            if (state.repo) {
                if (isSafeRepoPath(pv)) state.p = pv;
                else warnings.push('Ignored p=' + pv + ' (invalid repo path)');
            } else if (!isSafeKey(pv)) {
                warnings.push('Ignored p=' + pv + ' (invalid key)');
            } else if (allowed && !allowed.has(pv)) {
                warnings.push('Ignored p=' + pv + ' (not a known protocol)');
            } else {
                state.p = pv;
            }
        }

        // lib — committed registry keys only (D4 import source), repo-agnostic.
        const lv = params.get('lib');
        if (lv != null) {
            if (!isSafeKey(lv)) {
                warnings.push('Ignored lib=' + lv + ' (invalid key)');
            } else if (allowed && !allowed.has(lv)) {
                warnings.push('Ignored lib=' + lv + ' (not a known protocol)');
            } else {
                state.lib = lv;
            }
        }

        // mode — clamp; shared links (a `p`/`lib` present) always open in Run.
        let mode = params.get('mode');
        if (mode != null && !MODES.includes(mode)) {
            warnings.push('Ignored mode=' + mode);
            mode = null;
        }
        // A shared PRIMARY protocol (`p`) always opens in Run (newbie-safety). A
        // `lib`-only link is a D4 import source → authoring intent → honor `edit`.
        if (mode === 'edit' && state.p) {
            warnings.push('Shared link opened in Run (mode=edit ignored for a shared protocol)');
            mode = 'run';
        }
        state.mode = mode || 'run';

        // set — clamp to safe key.
        const set = params.get('set');
        if (set != null) {
            if (isSafeKey(set)) state.set = set;
            else warnings.push('Ignored set=' + set);
        }

        // rig — session/bench rig (#135), registry-validated like `p`.
        const rig = params.get('rig');
        if (rig != null) {
            if (!isSafeKey(rig)) warnings.push('Ignored rig=' + rig + ' (invalid key)');
            else if (allowedRigs && !allowedRigs.has(rig))
                warnings.push('Ignored rig=' + rig + ' (not a known rig)');
            else state.rig = rig;
        }

        return { state: state, warnings: warnings };
    }

    /**
     * Encode a state object to a query string (leading '?', or '' if empty).
     * A local (non-committed) doc omits p/set — they aren't shareable. `rig`
     * is bench identity, NOT doc state — emitted whenever present (the caller
     * only passes an explicit selection), regardless of doc locality. `repo`
     * is emitted ONLY alongside a valid repo-path `p` (a repo ref without a
     * document to point at is bench localStorage config, not URL state).
     * @param {object} state {mode, p, lib, set, rig, repo, source?: 'local'|'committed'}
     */
    function encode(state) {
        const s = state || {};
        const params = new URLSearchParams();
        const local = s.source === 'local';
        const repoMode = !local && isSafeRepo(s.repo) && isSafeRepoPath(s.p);
        if (s.mode && s.mode !== 'run' && MODES.includes(s.mode)) params.set('mode', s.mode);
        if (repoMode) {
            params.set('repo', s.repo);
            params.set('p', s.p);
        } else if (!local && isSafeKey(s.p)) {
            params.set('p', s.p);
        }
        if (isSafeKey(s.lib)) params.set('lib', s.lib);
        if (!local && isSafeKey(s.set)) params.set('set', s.set);
        if (isSafeKey(s.rig)) params.set('rig', s.rig);
        // URLSearchParams percent-encodes '/', which is legal un-encoded in a
        // query string (RFC 3986) — keep repo/path params human-readable.
        const q = params.toString().replace(/%2F/gi, '/');
        return q ? '?' + q : '';
    }

    /**
     * Encode LIVE app state for the write side (Studio.updateUrl). Reads ONLY
     * {mode, protocolKey} by construction — never doc.source/baseSource (a
     * plain local save flips baseSource to 'committed'; key-presence is the
     * only safe "this doc is the committed one" signal). `p` = registry
     * provenance: emitted whenever the doc was loaded from the registry, even
     * if since edited (see header). `rigKey` must be the EXPLICIT session-rig
     * selection or null — the caller (Studio.updateUrl) passes null for a rig
     * merely derived from the loaded protocol (clean-URL rule, #135).
     * `repo`+`repoPath` are course-repo provenance (set only by a validated
     * ?repo=&p= load or an in-app course-repo open) and take precedence over
     * `protocolKey` — a doc can't be both registry- and repo-sourced.
     * @param {object} app {mode, protocolKey, rigKey, repo, repoPath}
     * @returns {string} query string (leading '?', or '' when all defaults)
     */
    function encodeApp(app) {
        const a = app || {};
        if (a.repo && a.repoPath) {
            return encode({
                mode: a.mode,
                repo: a.repo,
                p: a.repoPath,
                rig: a.rigKey || undefined,
                source: 'committed'
            });
        }
        return encode({
            mode: a.mode,
            p: a.protocolKey || undefined,
            rig: a.rigKey || undefined,
            source: a.protocolKey ? 'committed' : 'local'
        });
    }

    /**
     * The LITERAL clamped mode of a search string — for in-session history
     * traversal (popstate). No shared-`p` edit→run force: that rule protects
     * fresh loads of shared links; applying it here would bounce Forward
     * navigation into an Edit entry back to Run.
     * @param {string} search  e.g. '?mode=edit&p=x'
     * @returns {'run'|'edit'|'console'}
     */
    function navMode(search) {
        const mode = new URLSearchParams(search || '').get('mode');
        return MODES.includes(mode) ? mode : 'run';
    }

    const StudioUrlState = {
        encode,
        encodeApp,
        navMode,
        decode,
        isSafeKey,
        isSafePath,
        isSafeRepo,
        isSafeRepoPath,
        MODES
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StudioUrlState;
    }
    if (typeof global !== 'undefined') {
        global.StudioUrlState = StudioUrlState;
    }
})(typeof window !== 'undefined' ? window : this);
