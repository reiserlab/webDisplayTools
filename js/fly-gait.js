/**
 * fly-gait.js — the walking model behind the replay 3D window's cartoon fly (Studio v0.90).
 *
 * MODEL. After NeuroMechFly v2 (Wang-Chen et al., Nature Methods 2024 — Ramdya lab): one
 * phase oscillator per leg, locked in an idealised TRIPOD (L1-R2-L3 vs R1-L2-R3, half a
 * cycle apart), driven by a TWO-DIMENSIONAL descending command. In NeuroMechFly the two
 * numbers are a left and a right drive [DN_L, DN_R]: speed sets the stepping frequency,
 * turning is an amplitude asymmetry between the sides, and a negative drive steps that
 * side BACKWARD — the three turning regimes of walking flies (Strauss & Heisenberg 1990):
 * gentle turns lengthen the outer strides, sharper turns also shorten the inner ones, and
 * in-place turns step the inner legs backward.
 *
 * Here the 2-D drive is read off the replayed FicTrac data: forward speed (mm/s) and yaw
 * rate (rad/s), each a 100 ms sliding average (`stepGait`). The per-side amplitude is not
 * a free parameter — it is the BALL: a stance foot is planted on the ball, so it has to
 * travel with the surface under it, and each leg's stride is (ω × r_leg)·T_stance
 * (`footPosition`). For the mid legs (lateral offset ±w) the fore-aft stride is then
 * ∝ v ± ω·w — exactly NeuroMechFly's asymmetric drive, with all three turning regimes
 * falling out of the geometry; the front and hind legs also sweep sideways in a turn, as
 * they sit off the yaw axis. Speed sets the cadence (`gaitDrive`): stepping frequency
 * rises linearly with speed with a roughly constant ~45 ms swing, so the duty factor
 * falls from ~0.8 (slow) to the tripod's 0.5 (fast).
 *
 * FRAME: the replay viewer's (+Y up, the fly faces −X, its right is −Z). The ball's
 * angular velocity is [roll, yaw, pitch] about [+X, +Y, +Z] — the same axes
 * js/studio-replay.js `ballStep` integrates, so stance feet move with the drawn ball.
 * The 2-D drive leaves roll (side-stepping) out.
 *
 * Pure and DOM-free: the Studio integrates the gait state per FicTrac sample (seek-priming
 * walks the same path) and the viewer poses the legs from it. Tests: tests/test-fly-gait.js.
 * LOADING: classic <script src> (window-global + CommonJS dual-export, no ES `export`).
 */
(function (global) {
    'use strict';

    const GAIT_WINDOW_MS = 100; // the sliding average behind the 2-D drive
    const GAIT_MAX_DT_MS = 250; // don't advance the phase across a dropped stretch
    const GAIT_BALL_RADIUS_MM = 4.5; // 9 mm ball: surface speed = angular rate × 4.5 mm
    const GAIT_TURN_ARM_MM = 1.6; // typical foot distance from the yaw axis
    const GAIT_WALK_ON_MM_S = [1, 3]; // below 1 mm/s the fly stands; fully walking by 3
    const GAIT_FREQ = { base: 2, perMmS: 0.45, min: 3, max: 16 }; // Hz
    const GAIT_SWING_S = 0.045; // near-constant swing duration
    const GAIT_DUTY = { min: 0.5, max: 0.8 };
    const GAIT_MAX_STRIDE_RAD = 0.28; // stride arc (ball radii); cadence rises past it
    const LEGS = ['L1', 'L2', 'L3', 'R1', 'R2', 'R3'];
    // Idealised tripod: L1, R2, L3 swing together, half a cycle from R1, L2, R3.
    const TRIPOD_OFFSETS = { L1: 0, R2: 0, L3: 0, R1: 0.5, L2: 0.5, R3: 0.5 };

    function clamp(x, lo, hi) {
        return Math.min(hi, Math.max(lo, x));
    }

    function smoothstep(e0, e1, x) {
        const t = clamp((x - e0) / (e1 - e0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    function dutyFor(freq) {
        return clamp(1 - GAIT_SWING_S * freq, GAIT_DUTY.min, GAIT_DUTY.max);
    }

    /**
     * Cadence from the 2-D drive. `speed` blends forward and turning foot speeds (mm/s);
     * `walk` (0..1) fades the stride in above ~1 mm/s so a standing fly keeps still.
     * If the stance arc would exceed GAIT_MAX_STRIDE_RAD the frequency rises instead.
     */
    function gaitDrive(forwardMmS, yawRadS) {
        const v = Number.isFinite(forwardMmS) ? forwardMmS : 0;
        const w = Number.isFinite(yawRadS) ? yawRadS : 0;
        const speed = Math.hypot(v, w * GAIT_TURN_ARM_MM);
        const walk = smoothstep(GAIT_WALK_ON_MM_S[0], GAIT_WALK_ON_MM_S[1], speed);
        let freq = clamp(GAIT_FREQ.base + GAIT_FREQ.perMmS * speed, GAIT_FREQ.min, GAIT_FREQ.max);
        const omega = speed / GAIT_BALL_RADIUS_MM; // ball radii per second
        for (let i = 0; i < 2; i++) {
            const need = (omega * dutyFor(freq)) / GAIT_MAX_STRIDE_RAD;
            if (need > freq) freq = Math.min(GAIT_FREQ.max, need);
        }
        return { speed, walk, freq, duty: dutyFor(freq) };
    }

    function createGait() {
        return {
            phase: 0, // cycles, [0, 1)
            yaw: 0, // ball angular velocity (rad/s) about +Y — 100 ms average
            pitch: 0, // … about +Z
            forward: 0, // mm/s (the fly's forward speed)
            freq: 0,
            duty: GAIT_DUTY.max,
            walk: 0,
            win: [],
            lastMs: null
        };
    }

    /**
     * Fold one FicTrac sample. `delta` is the ball rotation since the previous sample in
     * the viewer frame ({yaw, pitch, roll} radians — studio-replay.js `ballDelta`), or
     * null when that step must not count (first sample, gap, reset jump).
     */
    function stepGait(g, tMs, delta) {
        if (!g) return g;
        const t = Number(tMs);
        if (!Number.isFinite(t)) return g;
        const dtMs = g.lastMs !== null && t > g.lastMs ? t - g.lastMs : 0;
        if (g.lastMs !== null && t < g.lastMs) g.win = []; // time went backwards: restart
        g.lastMs = t;
        if (delta && Number.isFinite(delta.yaw) && Number.isFinite(delta.pitch)) {
            g.win.push({ t, yaw: delta.yaw, pitch: delta.pitch });
        }
        while (g.win.length && g.win[0].t <= t - GAIT_WINDOW_MS) g.win.shift();
        let yaw = 0;
        let pitch = 0;
        for (const s of g.win) {
            yaw += s.yaw;
            pitch += s.pitch;
        }
        const span = GAIT_WINDOW_MS / 1000;
        g.yaw = yaw / span;
        g.pitch = pitch / span;
        g.forward = -g.pitch * GAIT_BALL_RADIUS_MM;
        const d = gaitDrive(g.forward, g.yaw);
        g.freq = d.freq;
        g.duty = d.duty;
        g.walk = d.walk;
        if (d.walk > 0 && dtMs > 0 && dtMs <= GAIT_MAX_DT_MS) {
            g.phase = (g.phase + (d.freq * dtMs) / 1000) % 1;
        }
        return g;
    }

    /** What the viewer needs (plain numbers; the window stays behind). */
    function gaitState(g) {
        if (!g) return null;
        return {
            phase: g.phase,
            yaw: g.yaw,
            pitch: g.pitch,
            freq: g.freq,
            duty: g.duty,
            walk: g.walk
        };
    }

    /**
     * Where leg `leg` is in its step: `stance` + `progress` (0..1 through that stance or
     * swing). Stance comes first in each leg's cycle.
     */
    function legPhase(phase, leg, duty) {
        const off = TRIPOD_OFFSETS[leg] || 0;
        let p = ((Number(phase) || 0) + off) % 1;
        if (p < 0) p += 1;
        const beta = clamp(Number(duty) || GAIT_DUTY.max, 0.05, 0.95);
        if (p < beta) return { stance: true, progress: p / beta };
        return { stance: false, progress: (p - beta) / (1 - beta) };
    }

    /**
     * Time offset along the ball's rotation (seconds, centred on the neutral foot) and the
     * swing lift (0..1) for one leg. Stance: the foot rides the ball from −T/2 to +T/2;
     * swing: it lifts and returns to −T/2 (eased), ready for the next touchdown.
     */
    function footTau(phase, leg, duty, freq) {
        const lp = legPhase(phase, leg, duty);
        const f = Number(freq) > 0 ? Number(freq) : 0;
        const tSt = f > 0 ? clamp(Number(duty) || GAIT_DUTY.max, 0.05, 0.95) / f : 0;
        if (lp.stance) return { tau: (lp.progress - 0.5) * tSt, lift: 0, stance: true, tSt };
        const s = lp.progress;
        const eased = s * s * (3 - 2 * s);
        return { tau: (0.5 - eased) * tSt, lift: Math.sin(Math.PI * s), stance: false, tSt };
    }

    /** Rodrigues: rotate vector v about unit `axis` by `angle` (right-handed). */
    function rotateAbout(v, axis, angle) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const [kx, ky, kz] = axis;
        const [x, y, z] = v;
        const dot = kx * x + ky * y + kz * z;
        return [
            x * c + (ky * z - kz * y) * s + kx * dot * (1 - c),
            y * c + (kz * x - kx * z) * s + ky * dot * (1 - c),
            z * c + (kx * y - ky * x) * s + kz * dot * (1 - c)
        ];
    }

    /**
     * One foot's position. `neutral` is the resting foot (on the ball), `center` the ball
     * centre, `omega` the ball's angular velocity [x, y, z] rad/s, `tau`/`lift` from
     * `footTau`. opts: `walk` (0..1 stride/lift scale), `liftHeight` (swing clearance),
     * `stanceTime` + `maxStride` (cap the stance arc length; same units as the points).
     */
    function footPosition(neutral, center, omega, tau, lift, opts) {
        const o = opts || {};
        const walk = Number.isFinite(o.walk) ? clamp(o.walk, 0, 1) : 1;
        const rel = [neutral[0] - center[0], neutral[1] - center[1], neutral[2] - center[2]];
        const rate = Math.hypot(omega[0], omega[1], omega[2]);
        let out = rel;
        if (rate > 1e-9 && walk > 0) {
            const axis = [omega[0] / rate, omega[1] / rate, omega[2] / rate];
            let angle = rate * tau * walk;
            if (o.maxStride > 0 && o.stanceTime > 0) {
                const cx = omega[1] * rel[2] - omega[2] * rel[1];
                const cy = omega[2] * rel[0] - omega[0] * rel[2];
                const cz = omega[0] * rel[1] - omega[1] * rel[0];
                const stride = Math.hypot(cx, cy, cz) * o.stanceTime * walk;
                if (stride > o.maxStride) angle *= o.maxStride / stride;
            }
            out = rotateAbout(rel, axis, angle);
        }
        const h = (Number(o.liftHeight) || 0) * (Number(lift) || 0) * walk;
        if (h > 0) {
            const n = Math.hypot(out[0], out[1], out[2]) || 1;
            out = [out[0] * (1 + h / n), out[1] * (1 + h / n), out[2] * (1 + h / n)];
        }
        return [center[0] + out[0], center[1] + out[1], center[2] + out[2]];
    }

    const FlyGait = {
        GAIT_WINDOW_MS,
        GAIT_BALL_RADIUS_MM,
        GAIT_TURN_ARM_MM,
        GAIT_MAX_STRIDE_RAD,
        LEGS,
        TRIPOD_OFFSETS,
        dutyFor,
        gaitDrive,
        createGait,
        stepGait,
        gaitState,
        legPhase,
        footTau,
        rotateAbout,
        footPosition
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FlyGait;
    }
    if (typeof global !== 'undefined' && global) {
        global.FlyGait = FlyGait;
    }
})(typeof window !== 'undefined' ? window : this);
