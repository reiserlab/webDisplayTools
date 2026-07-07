/**
 * kinematics.js — shared FicTrac kinematic derivations for the live oscilloscope
 * (arena_studio.html Run view) AND the offline course analysis dashboard.
 *
 * SINGLE SOURCE OF TRUTH: the live scope and the offline dashboard MUST derive
 * the same behavioral channels the same way, from the same compact state — so
 * this module owns every derivation and both clients consume it. Do NOT fork the
 * math into the HTML or the dashboard.
 *
 * INPUT — the `behavior_v1` compact state (bridge WS frame / logged row; see
 * fictrac-bridge/bridge.py + issue #140):
 *     ms  bridge-relative ms since run start (integer)      — display/alignment axis
 *     fc  FicTrac frame counter (col 1)                     — drop detection / join key
 *     idx bridge/arena displayed frame index                — closed-loop diagnostics
 *     ft  FicTrac timestamp (col 22) as relative ms         — the derivative time base
 *     x   integrated lab-frame x position (rad)             \_ velocity by differencing
 *     y   integrated lab-frame y position (rad)             /  (NOT col 19 fwd/col 24 dt)
 *     hd  integrated heading (col 17, rad)                  — turning + heading channel
 *
 * DERIVED CHANNELS (shared vocabulary, units, sign conventions):
 *     turning velocity  deg/s   from unwrapped heading `hd`
 *     forward velocity  mm/s    dx·cos(h)+dy·sin(h) projected on heading × ball radius
 *     side velocity     mm/s    -dx·sin(h)+dy·cos(h)  (optional row)
 *     heading           deg     `hd` wrapped to ±180 (a position, not a rate)
 *     speed             rad/s   hypot(dx,dy)  (magnitude; ×ballR ⇒ mm/s)
 *     move_dir          deg     atan2(dy,dx)  (direction of travel)
 *
 * SIGN CONVENTIONS (agreed with the analysis dashboard, docs/development/
 * analysis-dashboard-plan.md §6): turning positive = increasing FicTrac heading;
 * forward positive = moving along the current heading. No protocol-specific
 * folding lives here — that's the dashboard's job. If the bench shows turning
 * inverted vs the intended CW-positive convention, flip with `turningSign:-1`
 * (one knob, applied identically to scope + dashboard) rather than editing math.
 *
 * TWO DERIVATIVE PATHS, ONE set of channels:
 *   - centralDiff()      the SIMPLE offline/default derivative — central
 *                        differences over ft (dt = (ft[i+1]-ft[i-1])/1000). Robust
 *                        to skipped frames because ft is an absolute timestamp
 *                        (col 22), not an inter-frame dt (col 24, which cannot
 *                        recover elapsed time across a dropped row — Frank, #143).
 *   - windowedDerived()  the SMOOTHED live-scope derivative — a windowed OLS slope
 *                        over a user-chosen window (default 0.25 s), stamped at the
 *                        window CENTER. Same channels, same units.
 *
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES
 * `export`) — same pattern as studio-url-state.js / studio-meta.js, so it also
 * loads under Node for tests and (later) the dashboard.
 */
(function (global) {
    'use strict';

    const TWO_PI = Math.PI * 2;
    const RAD2DEG = 180 / Math.PI;
    const DEG2RAD = Math.PI / 180;

    // Wrap radians to (-π, π] (matches atan2's range, so a heading and its
    // wrapped display agree at the ±π seam).
    function wrapToPi(r) {
        let x = r % TWO_PI;
        if (x <= -Math.PI) x += TWO_PI;
        else if (x > Math.PI) x -= TWO_PI;
        return x;
    }
    // Wrap degrees to (-180, 180].
    function wrapToDeg180(d) {
        let x = d % 360;
        if (x <= -180) x += 360;
        else if (x > 180) x -= 360;
        return x;
    }
    // Shortest signed angular difference a−b, in (-π, π]. This is the correct
    // "unwrapped delta" for a turning-rate central difference: unwrap_delta(hd[i+1],
    // hd[i-1]) never spikes across a ±π wrap.
    function unwrapDelta(a, b) {
        return wrapToPi(a - b);
    }
    // Unwrap a whole sequence of radian angles: remove ±π discontinuities by
    // accumulating 2π corrections. Pure — used by the dashboard on a full series,
    // by windowedDerived on a window slice, and by tests. Returns a new array.
    function unwrap(arr) {
        const n = arr.length;
        const out = new Array(n);
        if (!n) return out;
        out[0] = arr[0];
        let offset = 0;
        for (let i = 1; i < n; i++) {
            const step = wrapToPi(arr[i] - arr[i - 1]); // shortest step
            out[i] = out[i - 1] + step;
        }
        return out;
    }

    // First index i with axis(samples[i]) >= target (samples sorted ascending by axis).
    function _lowerBound(samples, target, axis) {
        let lo = 0;
        let hi = samples.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (axis(samples[mid]) < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /**
     * Ordinary-least-squares slope of ys vs ts (the derivative estimator).
     * @param {number[]} ts  regressor (e.g. seconds)
     * @param {number[]} ys  response
     * @returns {number|null} slope (ys-units per ts-unit), or null when it can't
     *   be estimated (fewer than 2 points, or zero variance in ts).
     */
    function olsSlope(ts, ys) {
        const n = ts.length;
        if (n < 2 || ys.length !== n) return null;
        let mt = 0;
        let my = 0;
        for (let i = 0; i < n; i++) {
            mt += ts[i];
            my += ys[i];
        }
        mt /= n;
        my /= n;
        let cov = 0;
        let vart = 0;
        for (let i = 0; i < n; i++) {
            const dt = ts[i] - mt;
            cov += dt * (ys[i] - my);
            vart += dt * dt;
        }
        if (vart === 0) return null;
        return cov / vart;
    }

    // Package raw velocity components (rad/s) + a heading into the shared derived
    // channel set. `ballRadiusMm` null ⇒ mm/s channels are null (calibration
    // missing) but the rad/s channels are still returned.
    function _pack(vx, vy, turningRadS, headingRad, ballRadiusMm, turningSign, extra) {
        const sgn = turningSign === -1 ? -1 : 1;
        const h = headingRad;
        const forwardRadS = vx * Math.cos(h) + vy * Math.sin(h);
        const sideRadS = -vx * Math.sin(h) + vy * Math.cos(h);
        const speedRadS = Math.hypot(vx, vy);
        const hasR = typeof ballRadiusMm === 'number' && isFinite(ballRadiusMm) && ballRadiusMm > 0;
        const out = {
            turning_deg_s: sgn * turningRadS * RAD2DEG,
            turning_rad_s: sgn * turningRadS,
            forward_rad_s: forwardRadS,
            side_rad_s: sideRadS,
            speed_rad_s: speedRadS,
            forward_mm_s: hasR ? forwardRadS * ballRadiusMm : null,
            side_mm_s: hasR ? sideRadS * ballRadiusMm : null,
            speed_mm_s: hasR ? speedRadS * ballRadiusMm : null,
            move_dir_deg: wrapToDeg180(Math.atan2(vy, vx) * RAD2DEG),
            heading_deg: wrapToDeg180(h * RAD2DEG)
        };
        if (extra) Object.assign(out, extra);
        return out;
    }

    /**
     * The SIMPLE offline/default derivative at sample i, by central differences
     * over the FicTrac timestamp `ft`. Returns the shared derived channels, or
     * null at the series edges (i===0 or i===n-1) or when dt is non-positive.
     * @param {Array} samples  time-ordered [{ft, x, y, hd, ...}, ...] (ft in ms)
     * @param {number} i
     * @param {object} [opts]  {ballRadiusMm, turningSign}
     */
    function centralDiff(samples, i, opts) {
        const o = opts || {};
        const n = samples.length;
        if (i <= 0 || i >= n - 1) return null; // edge: leave undefined (one-sided is display-only)
        const a = samples[i - 1];
        const b = samples[i + 1];
        const dtS = (b.ft - a.ft) / 1000;
        if (!(dtS > 0)) return null;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const turningRadS = unwrapDelta(b.hd, a.hd) / dtS;
        // Projection heading = heading at the CENTER sample i (cos/sin periodic,
        // so raw hd is fine — no unwrap needed for the projection itself).
        const vx = dx / dtS;
        const vy = dy / dtS;
        return _pack(vx, vy, turningRadS, samples[i].hd, o.ballRadiusMm, o.turningSign, {
            t_ms: samples[i].ms != null ? samples[i].ms : samples[i].ft,
            ft_ms: samples[i].ft,
            frame_index: samples[i].idx,
            source_fc: samples[i].fc
        });
    }

    /**
     * The SMOOTHED live-scope derivative at time `centerMs`: a windowed OLS slope
     * over the samples whose display time (`ms`, falling back to `ft`) lies in
     * [centerMs − w/2, centerMs + w/2]. Velocities regress against `ft` seconds so
     * their units match centralDiff exactly. Stamped at the window center.
     * @param {Array} samples  full time-ordered buffer [{ms, ft, x, y, hd, idx, fc}]
     * @param {number} centerMs  window center on the display axis
     * @param {object} [opts]  {windowMs=250, ballRadiusMm, turningSign, minSamples=2}
     * @returns {object|null} derived channels (+ t_ms/frame_index/source_fc), or
     *   null when the window holds fewer than minSamples (⇒ a gap in the trace,
     *   never a bogus slope — spec §4 dropout rule).
     */
    function windowedDerived(samples, centerMs, opts) {
        const o = opts || {};
        const windowMs = o.windowMs > 0 ? o.windowMs : 250;
        const minSamples = o.minSamples >= 2 ? o.minSamples : 2;
        const lo = centerMs - windowMs / 2;
        const hi = centerMs + windowMs / 2;
        const axis = (s) => (s.ms != null ? s.ms : s.ft);
        // Samples are time-ordered on the display axis — binary-search the window
        // start so a scope recomputing 100s of grid points over a whole-run buffer
        // each frame stays cheap (O(log N + windowSamples) per call, not O(N)).
        let start = _lowerBound(samples, lo, axis);
        const tS = [];
        const xs = [];
        const ys = [];
        const hds = [];
        let centerHd = null;
        let bestDist = Infinity;
        let idxAtCenter = null;
        let fcAtCenter = null;
        for (let i = start; i < samples.length; i++) {
            const s = samples[i];
            const t = axis(s);
            if (t > hi) break;
            tS.push(s.ft / 1000); // velocity units per real (FicTrac) second
            xs.push(s.x);
            ys.push(s.y);
            hds.push(s.hd);
            const d = Math.abs(t - centerMs);
            if (d < bestDist) {
                bestDist = d;
                centerHd = s.hd;
                idxAtCenter = s.idx;
                fcAtCenter = s.fc;
            }
        }
        if (tS.length < minSamples) return null;
        const vx = olsSlope(tS, xs);
        const vy = olsSlope(tS, ys);
        const turningRadS = olsSlope(tS, unwrap(hds)); // unwrap before differentiating
        if (vx === null || vy === null || turningRadS === null) return null;
        return _pack(vx, vy, turningRadS, centerHd, o.ballRadiusMm, o.turningSign, {
            t_ms: centerMs,
            frame_index: idxAtCenter,
            source_fc: fcAtCenter
        });
    }

    /** Ball RADIUS (mm) from a DIAMETER (mm); default fly-on-ball ≈ 9 mm dia. */
    function ballRadiusMm(diameterMm) {
        const d =
            typeof diameterMm === 'number' && isFinite(diameterMm) && diameterMm > 0
                ? diameterMm
                : 9;
        return d / 2;
    }

    const Kinematics = {
        RAD2DEG,
        DEG2RAD,
        wrapToPi,
        wrapToDeg180,
        unwrapDelta,
        unwrap,
        olsSlope,
        centralDiff,
        windowedDerived,
        ballRadiusMm
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Kinematics;
    }
    if (typeof global !== 'undefined') {
        global.Kinematics = Kinematics;
    }
})(typeof window !== 'undefined' ? window : this);
