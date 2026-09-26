import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js';
import PatParser from './pat-parser.js';
import ThreeViewer from './pattern-editor/viewers/three-viewer.js?v=0713-solid-ball';
import { PANEL_SPECS, STANDARD_CONFIGS, getArenaName, getConfig } from './arena-configs.js';

const Protocol = window.ArenaReplayViewerProtocol;
const DEFAULT_ARENA = 'G6_2x10';
const MM_PER_INCH = 25.4;
const BALL_DIAMETER_MM = 9;
const FLY_EYE_CLEARANCE_MM = 1;
// Ball holder (the rigs' air-supported cup): black cylinder, wider than the ball.
const HOLDER_DIAMETER_MM = 12;
const HOLDER_TOP_FRACTION = 0.45; // top rim at 45 % of the ball's height (just below the equator)
const HOLDER_BELOW_FLOOR_MM = 3; // starts just below the arena's bottom edge
// Cartoon Drosophila on the ball (a real fly is ~2.3 mm head-to-abdomen tip on a
// 9 mm ball; drawn at FLY_DISPLAY_SCALE). It faces the calibrated FRONT (−X, column
// 3 — the display's centre), i.e. away from the default rear-quarter camera.
const FLY_LENGTH_MM = 2.3;
// Drawn 2× life size (4.6 mm on the 9 mm ball) so it reads at arena scale — the
// lab's call (2026-09-24). Set to 1 for a true-scale fly; the feet stay on the ball.
const FLY_DISPLAY_SCALE = 2;
const FLY_MODEL_LENGTH_MM = 2.3; // buildFly(): head front −0.86 … abdomen tip +1.44 (model units)
const FLY_STANCE_MM = 0.72; // thorax centre above the ball's top (model units)
const FLY_HIDE_WITHIN_MM = 3; // hide when the camera is this close (fly-eye: ~0.3 mm)
// Tether, as on the rigs: a steel pin glued (UV glue) on the dorsal midline of the thorax,
// a quarter of the way back from its front, held by a brass rod that leaves the arena
// through its open top. The pin is part of the fly model (it scales with the fly); the rod
// is real size. Both lean back toward the rear (+X): behind the fly the rod stays out of
// the display it sees and out of the way of the default camera.
const TETHER_PIN_X_MODEL = -0.33; // thorax spans −0.56 (front) … +0.36 (model units)
const TETHER_PIN_LENGTH_MODEL = 1.6; // exposed steel above the glue
const TETHER_PIN_RADIUS_MODEL = 0.035;
const TETHER_TILT_DEG = 25; // lean from vertical, toward the rear
const TETHER_ROD_DIAMETER_MM = 1;
const TETHER_ROD_SLEEVE_MM = 0.5; // the pin's top sits this far inside the rod's bore
const TETHER_ROD_ABOVE_ARENA_MM = 25; // the rod ends this far above the arena's top edge
const MIN_HORIZONTAL_FOV = 60;
const MAX_HORIZONTAL_FOV = 150;
const DEFAULT_HORIZONTAL_FOV = 120;

const elements = {
    canvas: document.getElementById('arena-canvas'),
    connection: document.getElementById('connection-status'),
    condition: document.getElementById('condition-value'),
    frame: document.getElementById('frame-value'),
    led: document.getElementById('led-value'),
    ledIndicator: document.getElementById('led-indicator'),
    ledText: document.getElementById('led-text'),
    pattern: document.getElementById('pattern-status'),
    time: document.getElementById('time-value'),
    resetView: document.getElementById('view-reset'),
    overviewView: document.getElementById('view-overview'),
    topView: document.getElementById('view-top'),
    rearView: document.getElementById('view-rear'),
    flyView: document.getElementById('view-fly'),
    flyEyeView: document.getElementById('view-fly-eye'),
    viewFov: document.getElementById('view-fov')
};

let viewer = null;
let apparatus = null;
let currentConfig = getConfig(DEFAULT_ARENA);
let currentConfigName = DEFAULT_ARENA;
let currentPanelSpecs = PANEL_SPECS.G6;
let currentPattern = null;
let replayPattern = null;
let replayPatternLabel = null;
let hasReplayPattern = false;
let suppressCloseNotice = false;
let closeNoticeSent = false;
let cleanedUp = false;
let horizontalViewFov = DEFAULT_HORIZONTAL_FOV;
let replayState = Protocol.normalizeReplayState({});

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session') || '';
const localOrigin = Protocol.normalizeOrigin(window.location.origin);
const originParameter = params.get('origin');
const requestedOrigin =
    originParameter === null ? localOrigin : Protocol.normalizeOrigin(originParameter);
const expectedOrigin = requestedOrigin === localOrigin ? requestedOrigin : null;
const openerWindow = window.opener;
const canMessageOpener = Boolean(
    openerWindow &&
    Protocol.isSessionId(sessionId) &&
    expectedOrigin &&
    (expectedOrigin !== 'null' || window.location.protocol === 'file:')
);
const targetOrigin = expectedOrigin === 'null' ? '*' : expectedOrigin;

function setConnection(label, tone) {
    elements.connection.textContent = label;
    elements.connection.dataset.tone = tone || 'idle';
}

function sendToOpener(type, payload) {
    if (!canMessageOpener || !openerWindow || openerWindow.closed) return false;
    try {
        openerWindow.postMessage(
            Protocol.makeMessage(Protocol.VIEWER_SOURCE, type, sessionId, payload),
            targetOrigin
        );
        return true;
    } catch (error) {
        console.warn('Arena Replay Viewer: could not message opener', error);
        return false;
    }
}

function sendCloseNotice(reason) {
    if (closeNoticeSent || suppressCloseNotice || !canMessageOpener) return;
    closeNoticeSent = sendToOpener('close', { reason }) || closeNoticeSent;
}

function createDarkPattern(config, specs) {
    const rows = config.arena.num_rows * specs.pixels_per_panel;
    const cols = config.arena.num_cols * specs.pixels_per_panel;
    return {
        generation: config.arena.generation,
        gsMode: 2,
        gs_val: 2,
        numFrames: 1,
        pixelRows: rows,
        pixelCols: cols,
        frames: [new Uint8Array(rows * cols)]
    };
}

function createSolidPattern(config, specs) {
    const dark = createDarkPattern(config, specs);
    const level = dark.gsMode === 2 ? 1 : 15;
    dark.frames[0].fill(level);
    return dark;
}

function frameToUint8(frame) {
    if (frame instanceof Uint8Array) return new Uint8Array(frame);
    if (frame instanceof ArrayBuffer) return new Uint8Array(frame.slice(0));
    if (ArrayBuffer.isView(frame)) return Uint8Array.from(frame);
    if (Array.isArray(frame)) return Uint8Array.from(frame);
    return null;
}

function normalizePattern(pattern) {
    if (!pattern || typeof pattern !== 'object' || !pattern.frames) return null;
    const sourceFrames = Array.from(pattern.frames);
    const pixelRows = Math.floor(Number(pattern.pixelRows));
    const pixelCols = Math.floor(Number(pattern.pixelCols));
    if (!sourceFrames.length || pixelRows < 1 || pixelCols < 1) return null;

    const expectedPixels = pixelRows * pixelCols;
    const frames = sourceFrames.map(frameToUint8);
    if (frames.some((frame) => !frame || frame.length < expectedPixels)) return null;

    const gsMode = Number(pattern.gsMode || pattern.gs_val) === 2 ? 2 : 16;
    return {
        ...pattern,
        frames,
        pixelRows,
        pixelCols,
        numFrames: frames.length,
        gsMode,
        gs_val: gsMode
    };
}

function bytesToArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
}

function patternFromPayload(payload) {
    if (Object.prototype.hasOwnProperty.call(payload, 'pattern')) {
        return normalizePattern(payload.pattern);
    }
    const buffer = bytesToArrayBuffer(payload.patternBytes);
    if (!buffer || !PatParser || typeof PatParser.parsePatFile !== 'function') return null;
    try {
        return normalizePattern(PatParser.parsePatFile(buffer));
    } catch (error) {
        console.warn('Arena Replay Viewer: pattern bytes could not be parsed', error);
        return null;
    }
}

function isArenaConfig(value) {
    const arena = value && value.arena;
    return Boolean(
        arena &&
        typeof arena.generation === 'string' &&
        Number.isInteger(Number(arena.num_rows)) &&
        Number(arena.num_rows) > 0 &&
        Number.isInteger(Number(arena.num_cols)) &&
        Number(arena.num_cols) > 2
    );
}

function resolveArena(payload, pattern) {
    if (typeof payload.arenaConfigName === 'string') {
        const registered = getConfig(payload.arenaConfigName);
        if (registered) {
            return {
                config: registered,
                name: payload.arenaConfigName,
                specs: PANEL_SPECS[registered.arena.generation]
            };
        }
    }

    if (isArenaConfig(payload.arenaConfig)) {
        const generation = payload.arenaConfig.arena.generation;
        const specs = payload.panelSpecs || PANEL_SPECS[generation];
        if (specs) return { config: payload.arenaConfig, name: 'custom', specs };
    }

    if (pattern) {
        let inferredName = null;
        if (pattern.headerVersion >= 2 && pattern.arena_id > 0) {
            inferredName = getArenaName(pattern.generation, pattern.arena_id);
        }
        if (!inferredName && PatParser && typeof PatParser.findMatchingConfig === 'function') {
            inferredName = PatParser.findMatchingConfig(pattern, STANDARD_CONFIGS);
        }
        const inferred = inferredName && getConfig(inferredName);
        if (inferred) {
            return {
                config: inferred,
                name: inferredName,
                specs: PANEL_SPECS[inferred.arena.generation]
            };
        }
    }

    return { config: currentConfig, name: currentConfigName, specs: currentPanelSpecs };
}

function disposeObject(root) {
    if (!root) return;
    const geometries = new Set();
    const materials = new Set();
    root.traverse((child) => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) {
            const childMaterials = Array.isArray(child.material)
                ? child.material
                : [child.material];
            childMaterials.forEach((material) => materials.add(material));
        }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => {
        if (material.map) material.map.dispose();
        material.dispose();
    });
}

// The apparatus is a cutaway overlay (depthTest off, drawn after the LED cylinder).
// For the ball and the fly standing on it, depth still matters AMONG themselves —
// otherwise far legs paint over the body. The ball clears the depth buffer right
// before it draws (the panels' depth is irrelevant to the overlay), then ball + fly
// depth-test normally. three's clear() does not force the depth mask on, and the
// previous material may have left it off, so set it first.
// FicTrac-style ball: white with LARGE black markings — a mix of irregular round blobs
// (clusters of overlapping discs) and sharp-edged shapes (triangles, quads, a pentagon,
// an L) — so the rotation is easy to follow from frame to frame. Positions/shapes are
// a FIXED pseudo-random draw (same ball every time), spread over the sphere by jittered
// Fibonacci points. Drawn in the shader from the OBJECT-space surface direction, so the
// pattern turns with the mesh, has no texture seam or pole pinch, and keeps the
// standard lighting (incl. the LED glow). Sharp shapes are convex polygons in each
// feature's gnomonic tangent plane (an L = two rectangles).
const BALL_FEATURES = 14;
const BALL_SPOT_SEED = 20260924;
const BALL_FEATURE_KINDS = [
    'blob',
    'tri',
    'blob',
    'quad',
    'tri',
    'blob',
    'pent',
    'L',
    'blob',
    'tri',
    'blob',
    'quad',
    'tri',
    'blob'
];
const BALL_POLY_EDGES = 5; // max edges per convex polygon (unused = never limiting)

function ficTracBallFeatures(count, seed) {
    let state = seed >>> 0;
    const rnd = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const deg = Math.PI / 180;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const discs = []; // Vector4(dir, cos radius)
    const polys = []; // {c, u, v, edges:[Vector3(nx, ny, d)]}
    const addPoly = (frame, verts) => {
        // verts: CCW [x, y] in the tangent plane → outward half-planes n·p <= d
        const edges = verts.map((a, k) => {
            const b = verts[(k + 1) % verts.length];
            const nx = b[1] - a[1];
            const ny = -(b[0] - a[0]);
            const len = Math.hypot(nx, ny) || 1;
            return new THREE.Vector3(nx / len, ny / len, (nx * a[0] + ny * a[1]) / len);
        });
        while (edges.length < BALL_POLY_EDGES) edges.push(new THREE.Vector3(0, 0, 1e3));
        polys.push({ c: frame.c, u: frame.u, v: frame.v, edges });
    };
    const ring = (n, size, angJitter, radJitter) => {
        const a0 = rnd() * Math.PI * 2;
        return Array.from({ length: n }, (_, k) => {
            const a = a0 + (k * 2 * Math.PI) / n + (rnd() - 0.5) * 2 * angJitter;
            const r = size * (1 + (rnd() - 0.5) * 2 * radJitter);
            return [Math.cos(a) * r, Math.sin(a) * r];
        });
    };
    for (let i = 0; i < count; i++) {
        const y = 1 - (2 * (i + 0.5)) / count;
        const rr = Math.sqrt(1 - y * y);
        const c = new THREE.Vector3(Math.cos(golden * i) * rr, y, Math.sin(golden * i) * rr);
        c.add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.22));
        c.normalize();
        const helper =
            Math.abs(c.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const u0 = helper.clone().cross(c).normalize();
        const v0 = c.clone().cross(u0).normalize();
        const spin = rnd() * Math.PI * 2;
        const u = u0.clone().multiplyScalar(Math.cos(spin)).addScaledVector(v0, Math.sin(spin));
        const v = c.clone().cross(u).normalize();
        const frame = { c, u, v };
        const kind = BALL_FEATURE_KINDS[i % BALL_FEATURE_KINDS.length];
        const size = Math.tan((14 + rnd() * 6) * deg); // ~28–40° across
        if (kind === 'blob') {
            const main = (13 + rnd() * 6) * deg;
            discs.push(new THREE.Vector4(c.x, c.y, c.z, Math.cos(main)));
            const satellites = 2 + Math.floor(rnd() * 2);
            for (let k = 0; k < satellites; k++) {
                const a = rnd() * Math.PI * 2;
                const t = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
                const off = main * (0.65 + rnd() * 0.45);
                const d = c
                    .clone()
                    .multiplyScalar(Math.cos(off))
                    .addScaledVector(t, Math.sin(off))
                    .normalize();
                const r = main * (0.45 + rnd() * 0.35);
                discs.push(new THREE.Vector4(d.x, d.y, d.z, Math.cos(r)));
            }
        } else if (kind === 'tri') {
            addPoly(frame, ring(3, size * 1.15, 0.22, 0.18));
        } else if (kind === 'quad') {
            addPoly(frame, ring(4, size, 0.18, 0.15));
        } else if (kind === 'pent') {
            addPoly(frame, ring(5, size * 0.95, 0.1, 0.1));
        } else {
            // L: two rectangles sharing the corner block
            const s = size;
            const w = s * 0.5;
            addPoly(frame, [
                [-s, -s],
                [s, -s],
                [s, -s + w],
                [-s, -s + w]
            ]);
            addPoly(frame, [
                [-s, -s],
                [-s + w, -s],
                [-s + w, s],
                [-s, s]
            ]);
        }
    }
    return { discs, polys };
}

function applyFicTracSpots(material) {
    const { discs, polys } = ficTracBallFeatures(BALL_FEATURES, BALL_SPOT_SEED);
    const nd = discs.length;
    const np = polys.length;
    const ne = BALL_POLY_EDGES;
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uBallDiscs = { value: discs };
        shader.uniforms.uBallPolyC = { value: polys.map((p) => p.c) };
        shader.uniforms.uBallPolyU = { value: polys.map((p) => p.u) };
        shader.uniforms.uBallPolyV = { value: polys.map((p) => p.v) };
        shader.uniforms.uBallPolyE = { value: [].concat(...polys.map((p) => p.edges)) };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vBallDir;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBallDir = position;');
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                [
                    '#include <common>',
                    'varying vec3 vBallDir;',
                    'uniform vec4 uBallDiscs[' + nd + '];',
                    'uniform vec3 uBallPolyC[' + np + '];',
                    'uniform vec3 uBallPolyU[' + np + '];',
                    'uniform vec3 uBallPolyV[' + np + '];',
                    'uniform vec3 uBallPolyE[' + np * ne + '];'
                ].join('\n')
            )
            .replace(
                'vec4 diffuseColor = vec4( diffuse, opacity );',
                [
                    'vec4 diffuseColor = vec4( diffuse, opacity );',
                    'vec3 ballDir = normalize( vBallDir );',
                    'float ballInk = 0.0;',
                    'for ( int i = 0; i < ' + nd + '; i ++ ) {',
                    '    float d = dot( ballDir, uBallDiscs[ i ].xyz );',
                    '    float w = max( fwidth( d ) * 1.25, 1e-4 );',
                    '    ballInk = max( ballInk, smoothstep( uBallDiscs[ i ].w - w, uBallDiscs[ i ].w + w, d ) );',
                    '}',
                    'for ( int i = 0; i < ' + np + '; i ++ ) {',
                    '    float dc = dot( ballDir, uBallPolyC[ i ] );',
                    '    vec2 p = vec2( dot( ballDir, uBallPolyU[ i ] ), dot( ballDir, uBallPolyV[ i ] ) ) / max( dc, 0.05 );',
                    '    float m = -1e3;',
                    '    for ( int k = 0; k < ' + ne + '; k ++ ) {',
                    '        vec3 e = uBallPolyE[ i * ' + ne + ' + k ];',
                    '        m = max( m, dot( e.xy, p ) - e.z );',
                    '    }',
                    '    float w = max( fwidth( m ) * 1.0, 1e-4 );',
                    '    ballInk = max( ballInk, ( 1.0 - smoothstep( -w, w, m ) ) * step( 0.5, dc ) );',
                    '}',
                    'diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.025 ), ballInk );'
                ].join('\n')
            )
            .replace(
                'vec3 totalEmissiveRadiance = emissive;',
                'vec3 totalEmissiveRadiance = emissive * ( 1.0 - 0.85 * ballInk );'
            );
    };
    material.customProgramCacheKey = () => 'fictrac-ball-features-' + nd + '-' + np;
    material.needsUpdate = true;
}

function clearDepthBeforeDraw(renderer) {
    renderer.state.buffers.depth.setMask(true);
    renderer.clearDepth();
}

function flyMaterial(color, opts) {
    const o = opts || {};
    const material = new THREE.MeshStandardMaterial({
        color,
        roughness: o.roughness != null ? o.roughness : 0.62,
        metalness: o.metalness != null ? o.metalness : 0.02,
        emissive: o.emissive != null ? o.emissive : color,
        emissiveIntensity: o.emissiveIntensity != null ? o.emissiveIntensity : 0.22,
        map: o.map || null
    });
    material.transparent = true; // stay in the overlay's (transparent) render queue
    material.opacity = o.opacity != null ? o.opacity : 1;
    material.depthTest = true;
    material.depthWrite = o.opacity == null || o.opacity >= 1;
    if (o.doubleSide) material.side = THREE.DoubleSide;
    return material;
}

// Banded abdomen: a 1×64 canvas mapped along the sphere's pole-to-pole axis.
function abdomenTexture() {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#d7b478';
    ctx.fillRect(0, 0, 4, 64);
    ctx.fillStyle = '#5a3d22';
    // tergite bands on the posterior half (v = 0 is the tip after the rotation below)
    [8, 17, 26].forEach((y) => ctx.fillRect(0, y, 4, 5));
    ctx.fillRect(0, 0, 4, 4);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const THORAX_CENTER = [-0.1, 0.02, 0]; // model units
const THORAX_RADII = [0.46, 0.35, 0.34];

/**
 * A cartoon fly built in MILLIMETRES, facing −X (+Y up), with the thorax centre at
 * the origin and the feet on a sphere of radius `ballRadiusMm` whose top is
 * `FLY_STANCE_MM` below the origin. The caller scales mm → scene units.
 */
function buildFly(ballRadiusMm) {
    const fly = new THREE.Group();
    fly.name = 'replay-fly';
    const order = 46;
    const add = (mesh, renderOrder) => {
        mesh.renderOrder = renderOrder || order;
        fly.add(mesh);
        return mesh;
    };
    const ellipsoid = (rx, ry, rz, material, x, y, z) => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), material);
        mesh.scale.set(rx, ry, rz);
        mesh.position.set(x, y, z);
        return add(mesh);
    };
    const tan = flyMaterial(0xc89a5a);
    const thoraxTan = flyMaterial(0xb3843f);
    const legTan = flyMaterial(0x7c5a34, { emissiveIntensity: 0.15 });
    const eyeRed = flyMaterial(0xd0141f, {
        roughness: 0.35,
        emissive: 0x7a0008,
        emissiveIntensity: 0.55
    });
    const wing = flyMaterial(0xcfe3ef, {
        opacity: 0.34,
        roughness: 0.2,
        emissiveIntensity: 0.08,
        doubleSide: true
    });

    // Head (wider than long), big red compound eyes, thorax.
    ellipsoid(0.22, 0.25, 0.3, tan, -0.64, 0.06, 0);
    ellipsoid(0.15, 0.21, 0.13, eyeRed, -0.66, 0.1, 0.24);
    ellipsoid(0.15, 0.21, 0.13, eyeRed, -0.66, 0.1, -0.24);
    ellipsoid(...THORAX_RADII, thoraxTan, ...THORAX_CENTER);
    // Abdomen: a sphere turned so its poles run along the body axis (bands = rings).
    const abdomenMat = flyMaterial(0xffffff, { map: abdomenTexture(), emissive: 0x3a2a14 });
    const abdomen = ellipsoid(1, 1, 1, abdomenMat, 0.8, -0.04, 0);
    // The sphere's +Y pole carries the texture's top rows (the dark tip + bands);
    // −90° about Z sends it to +X, the posterior tip. Local y is the long axis.
    abdomen.rotation.z = -Math.PI / 2;
    abdomen.scale.set(0.37, 0.64, 0.38);

    // Folded wings over the abdomen, slightly splayed.
    [1, -1].forEach((side) => {
        const w = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 10), wing);
        w.scale.set(0.82, 0.018, 0.27);
        w.position.set(0.66, 0.34, side * 0.19);
        w.rotation.y = side * 0.2;
        w.rotation.z = -0.1;
        add(w, order + 1);
    });

    // Six two-segment legs from the thorax underside to feet ON the ball. Each keeps its
    // resting pose (hip, neutral foot, knee-bend direction, segment lengths) so poseFlyLegs
    // can walk it: the feet follow js/fly-gait.js, the knees are solved by two-bone IK.
    const limb = (a, b, r) => {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(r * 0.85, r, a.distanceTo(b), 8),
            legTan
        );
        placeLimb(mesh, a, b);
        return add(mesh);
    };
    const footY = (x, z) => {
        const r2 = x * x + z * z;
        return (
            Math.sqrt(Math.max(0, ballRadiusMm * ballRadiusMm - r2)) - ballRadiusMm - FLY_STANCE_MM
        );
    };
    const legs = [];
    [
        [-0.32, -0.8, 0.46],
        [-0.1, -0.12, 0.62],
        [0.12, 0.62, 0.5]
    ].forEach(([hipX, footX, footZ], row) => {
        [1, -1].forEach((side) => {
            const hip = new THREE.Vector3(hipX, -0.22, side * 0.16);
            const foot = new THREE.Vector3(footX, footY(footX, side * footZ), side * footZ);
            const knee = new THREE.Vector3((hipX + footX) / 2, 0.08, side * (footZ * 0.82));
            const reach = new THREE.Vector3().subVectors(foot, hip).normalize();
            const bend = new THREE.Vector3().subVectors(knee, hip);
            bend.addScaledVector(reach, -bend.dot(reach)).normalize();
            legs.push({
                key: (side > 0 ? 'L' : 'R') + (row + 1), // fly's left is +Z (it faces −X)
                hip,
                neutral: foot,
                bend,
                femurLength: hip.distanceTo(knee),
                tibiaLength: knee.distanceTo(foot),
                femur: limb(hip, knee, 0.045),
                tibia: limb(knee, foot, 0.035)
            });
        });
    });
    fly.userData.legs = legs;
    fly.userData.ballCenter = new THREE.Vector3(0, -ballRadiusMm - FLY_STANCE_MM, 0);

    // Tether pin (steel) in a bead of UV glue on the thorax's dorsal midline. Metals get
    // some emissive so they read without an environment map (as the LED tube does).
    const tilt = (TETHER_TILT_DEG * Math.PI) / 180;
    const tetherDir = new THREE.Vector3(Math.sin(tilt), Math.cos(tilt), 0);
    const tx = (TETHER_PIN_X_MODEL - THORAX_CENTER[0]) / THORAX_RADII[0];
    const thoraxTop = THORAX_CENTER[1] + THORAX_RADII[1] * Math.sqrt(Math.max(0, 1 - tx * tx));
    const pinBase = new THREE.Vector3(TETHER_PIN_X_MODEL, thoraxTop - 0.04, 0);
    const pinTop = pinBase.clone().addScaledVector(tetherDir, TETHER_PIN_LENGTH_MODEL + 0.04);
    const steel = flyMaterial(0xc3c9d0, {
        metalness: 0.55,
        roughness: 0.28,
        emissive: 0x3c4148,
        emissiveIntensity: 0.55
    });
    const pinRadius = TETHER_PIN_RADIUS_MODEL;
    const pin = new THREE.Mesh(
        new THREE.CylinderGeometry(pinRadius, pinRadius, pinBase.distanceTo(pinTop), 10),
        steel
    );
    pin.name = 'tether-pin';
    placeLimb(pin, pinBase, pinTop);
    add(pin);
    const glue = flyMaterial(0xf2eed6, {
        opacity: 0.6,
        roughness: 0.15,
        emissiveIntensity: 0.12
    });
    const bead = ellipsoid(0.1, 0.055, 0.09, glue, TETHER_PIN_X_MODEL, thoraxTop + 0.01, 0);
    bead.renderOrder = order + 1;
    fly.userData.tether = { top: pinTop, dir: tetherDir };
    return fly;
}

const _limbUp = new THREE.Vector3(0, 1, 0);
const _limbDir = new THREE.Vector3();
// A leg segment is a +Y cylinder of fixed length: centre it on a→b and point it at b.
function placeLimb(mesh, a, b) {
    _limbDir.subVectors(b, a);
    mesh.position.copy(a).addScaledVector(_limbDir, 0.5);
    mesh.quaternion.setFromUnitVectors(_limbUp, _limbDir.normalize());
}

// Walking (js/fly-gait.js): the Studio sends the gait state — tripod phase, cadence and
// the ball's 100 ms-average angular velocity — and every foot follows footPosition:
// stance feet ride the ball surface, swing feet lift and return. Model units (mm/2 at
// FLY_DISPLAY_SCALE 2); the ball's angular velocity is scale-free, so stance feet stay
// planted on the drawn ball. Knees: two-bone IK in the plane of hip→foot and the leg's
// resting bend direction (segment lengths never change).
const GAIT_LIFT_MODEL_MM = 0.16; // swing clearance
const GAIT_MAX_STRIDE_MODEL_MM = 0.6; // longest stance arc a leg can reach
const _ikReach = new THREE.Vector3();
const _ikBend = new THREE.Vector3();
const _ikKnee = new THREE.Vector3();
const _ikFoot = new THREE.Vector3();
function poseFlyLegs(fly, gait) {
    const Gait = window.FlyGait;
    const legs = fly && fly.userData && fly.userData.legs;
    if (!legs) return;
    const c = fly.userData.ballCenter;
    const center = [c.x, c.y, c.z];
    const walking = Boolean(Gait && gait && gait.walk > 0 && gait.freq > 0);
    const omega = walking ? [0, gait.yaw, gait.pitch] : [0, 0, 0];
    legs.forEach((leg) => {
        const n = leg.neutral;
        let foot = [n.x, n.y, n.z];
        if (walking) {
            const step = Gait.footTau(gait.phase, leg.key, gait.duty, gait.freq);
            foot = Gait.footPosition(foot, center, omega, step.tau, step.lift, {
                walk: gait.walk,
                liftHeight: GAIT_LIFT_MODEL_MM,
                stanceTime: step.tSt,
                maxStride: GAIT_MAX_STRIDE_MODEL_MM
            });
        }
        const a = leg.femurLength;
        const b = leg.tibiaLength;
        _ikReach.set(foot[0] - leg.hip.x, foot[1] - leg.hip.y, foot[2] - leg.hip.z);
        const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, _ikReach.length()));
        _ikReach.normalize();
        _ikBend.copy(leg.bend).addScaledVector(_ikReach, -leg.bend.dot(_ikReach));
        if (_ikBend.lengthSq() < 1e-10) _ikBend.set(0, 1, 0);
        _ikBend.normalize();
        const along = (a * a - b * b + d * d) / (2 * d);
        const lift = Math.sqrt(Math.max(0, a * a - along * along));
        _ikKnee.copy(leg.hip).addScaledVector(_ikReach, along).addScaledVector(_ikBend, lift);
        _ikFoot.copy(leg.hip).addScaledVector(_ikReach, d);
        placeLimb(leg.femur, leg.hip, _ikKnee);
        placeLimb(leg.tibia, _ikKnee, _ikFoot);
    });
}

// The apparatus sits inside an opaque LED cylinder. Keep its physically sized
// meshes legible as a cutaway overlay; otherwise the required 9 mm ball and
// downward flashlight disappear behind the front panels in an isometric view.
function foregroundMaterial(material) {
    // Full-alpha cutaway meshes stay visually opaque while sharing the
    // transparent render queue with LED halos and the light beam. Their explicit
    // renderOrder can therefore keep those effects behind the solid apparatus.
    material.transparent = true;
    material.opacity = 1;
    material.depthTest = false;
    material.depthWrite = false;
    return material;
}

function foregroundMesh(mesh, order) {
    mesh.renderOrder = order;
    return mesh;
}

function rebuildApparatus() {
    if (!viewer || !viewer.scene) return;
    if (apparatus) {
        viewer.scene.remove(apparatus.group);
        disposeObject(apparatus.group);
    }

    const stats = viewer.getArenaStats();
    const arenaHeight = stats.arenaHeight / MM_PER_INCH;
    const arenaRadius = stats.innerRadius / MM_PER_INCH;
    const ballRadius = BALL_DIAMETER_MM / 2 / MM_PER_INCH;
    const ballY = 0;
    const arenaTop = arenaHeight / 2;
    const arenaBottom = -arenaHeight / 2;
    const tubeRadius = Math.max(0.09, arenaRadius * 0.035);
    const tubeHeight = Math.max(0.58, arenaHeight * 0.2);
    const emitterY = arenaTop + Math.max(0.34, arenaHeight * 0.1);
    const tubeCenterY = emitterY + tubeHeight / 2;
    const beamHeight = emitterY - ballY;

    const group = new THREE.Group();

    // Keep the physical arena legible even when no replay pattern is available. The LED panel
    // meshes remain the cylinder surface; these quiet rims make its full extent unambiguous.
    const rimRadius = Math.max(0.012, arenaRadius * 0.0035);
    const rimMaterial = new THREE.MeshStandardMaterial({
        color: 0x66716f,
        roughness: 0.55,
        metalness: 0.62
    });
    [arenaBottom, arenaTop].forEach((height) => {
        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(arenaRadius, rimRadius, 8, 96),
            rimMaterial
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = height;
        group.add(rim);
    });

    const ballMaterial = foregroundMaterial(
        new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.72,
            metalness: 0.02,
            emissive: 0x161616,
            emissiveIntensity: 0.3
        })
    );
    applyFicTracSpots(ballMaterial);
    const ball = foregroundMesh(
        new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 40, 24), ballMaterial),
        44
    );
    ball.position.y = ballY;
    ball.castShadow = true;
    // Ball + fly form their own depth domain on top of the cutaway (see
    // clearDepthBeforeDraw): still drawn over the panels, but the fly's legs and
    // body occlude one another — and the ball hides whatever of the fly is below it.
    ballMaterial.depthTest = true;
    ballMaterial.depthWrite = true;
    ball.onBeforeRender = clearDepthBeforeDraw;
    group.add(ball);

    // Model units → mm: s. The legs are solved against the ball's radius IN MODEL
    // UNITS (4.5 mm / s) so the feet land on the real ball at any display scale.
    const flyScaleMm = (FLY_LENGTH_MM * FLY_DISPLAY_SCALE) / FLY_MODEL_LENGTH_MM;
    const fly = buildFly(BALL_DIAMETER_MM / 2 / flyScaleMm);
    fly.scale.setScalar(flyScaleMm / MM_PER_INCH);
    fly.position.set(0, ballY + ballRadius + (FLY_STANCE_MM * flyScaleMm) / MM_PER_INCH, 0);
    group.add(fly);

    // Tether rod (brass, real size): continues the pin's lean from just below the pin's
    // top out through the arena's open top. Same depth domain as the fly (drawn after the
    // ball clears depth), so it reads over the cutaway like the ball and fly do.
    const tether = fly.userData.tether;
    const rodDir = tether.dir.clone(); // the fly group is scaled, never rotated
    const rodBottom = tether.top
        .clone()
        .multiplyScalar(flyScaleMm / MM_PER_INCH)
        .add(fly.position)
        .addScaledVector(rodDir, -TETHER_ROD_SLEEVE_MM / MM_PER_INCH);
    const rodTop = rodBottom
        .clone()
        .addScaledVector(
            rodDir,
            (arenaTop + TETHER_ROD_ABOVE_ARENA_MM / MM_PER_INCH - rodBottom.y) / rodDir.y
        );
    const rodRadius = TETHER_ROD_DIAMETER_MM / 2 / MM_PER_INCH;
    const brass = flyMaterial(0xc9a646, {
        metalness: 0.6,
        roughness: 0.32,
        emissive: 0x5a4412,
        emissiveIntensity: 0.5
    });
    const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(rodRadius, rodRadius, rodBottom.distanceTo(rodTop), 20),
        brass
    );
    rod.name = 'tether-rod';
    placeLimb(rod, rodBottom, rodTop);
    rod.renderOrder = 46;
    group.add(rod);

    // Ball holder, as on the rigs: a black vertical cylinder (Ø 12 mm, wider than
    // the ball) from just below the arena floor up to just below the ball's
    // equator (45 % of the ball's height), so the ball sits in it. It joins the
    // ball+fly depth domain (drawn right after the ball clears depth) so it hides
    // the ball's lower part while the ball above its rim stays visible.
    const holderRadius = HOLDER_DIAMETER_MM / 2 / MM_PER_INCH;
    const holderTop = ballY - ballRadius + HOLDER_TOP_FRACTION * 2 * ballRadius;
    const holderBottom = arenaBottom - HOLDER_BELOW_FLOOR_MM / MM_PER_INCH;
    const holderHeight = Math.max(0.01, holderTop - holderBottom);
    const holderMaterial = new THREE.MeshStandardMaterial({
        color: 0x0b0b0c,
        roughness: 0.58,
        metalness: 0.15,
        emissive: 0x050505,
        emissiveIntensity: 0.4
    });
    holderMaterial.transparent = true; // same (transparent) queue as the ball
    holderMaterial.opacity = 1;
    holderMaterial.depthTest = true;
    holderMaterial.depthWrite = true;
    const holder = new THREE.Mesh(
        new THREE.CylinderGeometry(holderRadius, holderRadius, holderHeight, 48),
        holderMaterial
    );
    holder.renderOrder = 44.5; // after the ball's depth clear, before the fly
    holder.position.y = holderBottom + holderHeight / 2;
    group.add(holder);

    const tubeMaterial = foregroundMaterial(
        new THREE.MeshStandardMaterial({
            color: 0xd5dbdd,
            roughness: 0.24,
            metalness: 0.72,
            emissive: 0x62696b,
            emissiveIntensity: 0.72
        })
    );
    const tube = foregroundMesh(
        new THREE.Mesh(
            new THREE.CylinderGeometry(tubeRadius * 0.9, tubeRadius, tubeHeight, 32),
            tubeMaterial
        ),
        42
    );
    tube.position.y = tubeCenterY;
    group.add(tube);

    const collar = foregroundMesh(
        new THREE.Mesh(
            new THREE.CylinderGeometry(tubeRadius * 1.18, tubeRadius * 1.18, 0.1, 32),
            foregroundMaterial(
                new THREE.MeshStandardMaterial({
                    color: 0xe1e5e6,
                    roughness: 0.2,
                    metalness: 0.78,
                    emissive: 0x72787a,
                    emissiveIntensity: 0.65
                })
            )
        ),
        43
    );
    collar.position.y = emitterY + 0.05;
    group.add(collar);

    const grip = foregroundMesh(
        new THREE.Mesh(
            new THREE.TorusGeometry(tubeRadius * 1.01, tubeRadius * 0.1, 8, 30),
            foregroundMaterial(
                new THREE.MeshStandardMaterial({
                    color: 0x313638,
                    roughness: 0.55,
                    metalness: 0.55
                })
            )
        ),
        43
    );
    grip.rotation.x = Math.PI / 2;
    grip.position.y = tubeCenterY + tubeHeight * 0.18;
    group.add(grip);

    const lensMaterial = foregroundMaterial(
        new THREE.MeshStandardMaterial({
            color: 0x3d1114,
            roughness: 0.32,
            metalness: 0.12,
            emissive: 0x000000,
            emissiveIntensity: 0
        })
    );
    const lens = foregroundMesh(
        new THREE.Mesh(
            new THREE.CylinderGeometry(tubeRadius * 0.82, tubeRadius * 0.82, 0.026, 32),
            lensMaterial
        ),
        45
    );
    lens.position.y = emitterY - 0.014;
    group.add(lens);

    const beamMaterial = new THREE.MeshBasicMaterial({
        color: 0xff2435,
        transparent: true,
        opacity: 0.14,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, ballRadius * 1.8, beamHeight, 32, 1, true),
        beamMaterial
    );
    beam.position.y = ballY + beamHeight / 2;
    beam.renderOrder = 41;
    group.add(beam);

    const spotTarget = new THREE.Object3D();
    spotTarget.position.set(0, ballY, 0);
    group.add(spotTarget);

    const spot = new THREE.SpotLight(
        0xff1f2f,
        42,
        beamHeight * 1.35,
        Math.atan2(ballRadius * 1.9, beamHeight),
        0.58,
        1.4
    );
    spot.position.set(0, emitterY, 0);
    spot.target = spotTarget;
    group.add(spot);

    viewer.scene.add(group);
    apparatus = {
        group,
        ballMaterial,
        beam,
        lensMaterial,
        spot,
        fly,
        ball,
        arenaRadius,
        arenaHeight,
        ballRadius
    };
    setLedState(replayState.ledOn, true);
    applyBallOrientation(replayState.ball);
    poseFlyLegs(fly, replayState.gait);
    updateFlyVisibility();
}

// The Studio integrates the ball's rotation from the replayed FicTrac data (js/studio-
// replay.js ballDelta/ballStep) and sends it as a quaternion with every state update.
function applyBallOrientation(q) {
    if (!apparatus || !apparatus.ball || !Array.isArray(q) || q.length !== 4) return;
    apparatus.ball.quaternion.set(q[0], q[1], q[2], q[3]);
}

// The fly-eye camera sits just above the ball — inside the fly's head. Hide the fly
// whenever the camera is that close; every other view shows it.
const _flyWorld = new THREE.Vector3();
function updateFlyVisibility() {
    if (!viewer || !viewer.camera || !apparatus || !apparatus.fly) return;
    apparatus.fly.getWorldPosition(_flyWorld);
    apparatus.fly.visible =
        viewer.camera.position.distanceTo(_flyWorld) > FLY_HIDE_WITHIN_MM / MM_PER_INCH;
}

function setLedState(isOn, force) {
    const on = Boolean(isOn);
    if (!force && on === replayState.ledOn) return;
    if (apparatus) {
        apparatus.beam.visible = on;
        apparatus.spot.visible = on;
        apparatus.lensMaterial.color.setHex(on ? 0xff3344 : 0x3d1114);
        apparatus.lensMaterial.emissive.setHex(on ? 0xff0710 : 0x000000);
        apparatus.lensMaterial.emissiveIntensity = on ? 1.4 : 0;
        apparatus.ballMaterial.emissive.setHex(on ? 0x4a0005 : 0x161616);
        apparatus.ballMaterial.emissiveIntensity = on ? 0.42 : 0.3;
    }
    elements.ledText.textContent = on ? 'ON' : 'OFF';
    elements.led.dataset.on = String(on);
    elements.ledIndicator.dataset.on = String(on);
}

function configureArena(payload, pattern) {
    const next = resolveArena(payload, pattern);
    const changed = next.config !== currentConfig || next.specs !== currentPanelSpecs;
    currentConfig = next.config;
    currentConfigName = next.name;
    currentPanelSpecs = next.specs;
    if (changed) {
        viewer.reinit(currentConfig, currentPanelSpecs);
        rebuildApparatus();
    }
}

function setReplayPattern(payload, label) {
    const pattern = patternFromPayload(payload);
    configureArena(payload, pattern);
    hasReplayPattern = Boolean(pattern);
    replayPattern = pattern;
    replayPatternLabel = label || payload.patternName || 'PATTERN';
    applyDisplayMode(true);
}

function applyDisplayMode(force) {
    const mode = replayState.displayMode || 'off';
    if (mode === 'all-on') currentPattern = createSolidPattern(currentConfig, currentPanelSpecs);
    else if (mode === 'pattern' && replayPattern) currentPattern = replayPattern;
    else currentPattern = createDarkPattern(currentConfig, currentPanelSpecs);
    viewer.setPattern(currentPattern);
    viewer.setFrame(Math.min(replayState.frame, currentPattern.numFrames - 1));
    elements.pattern.textContent = hasReplayPattern
        ? `${replayPatternLabel} • ${replayPattern.numFrames} FRAME${replayPattern.numFrames === 1 ? '' : 'S'} • ${mode === 'pattern' ? 'DISPLAYING' : mode.toUpperCase()}`
        : mode === 'all-on'
          ? 'ALL ON • NO PATTERN REQUIRED'
          : 'NO PATTERN • CYLINDER IDLE';
    elements.pattern.dataset.loaded = String(hasReplayPattern);
    updateFrameReadout();
}

function updateFrameReadout() {
    if ((replayState.displayMode || 'off') !== 'pattern' || !hasReplayPattern || !currentPattern) {
        elements.frame.textContent = '—';
        return;
    }
    const index = Math.min(replayState.frame, currentPattern.numFrames - 1);
    elements.frame.textContent = `${index + 1} / ${currentPattern.numFrames}`;
}

function applyReplayState(nextState) {
    const before = replayState;
    const normalized = Protocol.normalizeReplayState(nextState, before);
    replayState = normalized;
    elements.time.textContent = Protocol.formatElapsed(normalized.elapsedMs);
    elements.condition.textContent = normalized.condition;

    if (normalized.displayMode !== before.displayMode) {
        applyDisplayMode(true);
    } else if (currentPattern && normalized.frame !== before.frame) {
        viewer.setFrame(Math.min(normalized.frame, currentPattern.numFrames - 1));
    }
    updateFrameReadout();
    if (normalized.ledOn !== before.ledOn) setLedState(normalized.ledOn, true);
    if (normalized.ball) applyBallOrientation(normalized.ball);
    if (apparatus && apparatus.fly) poseFlyLegs(apparatus.fly, normalized.gait);
}

function handleInit(payload) {
    setReplayPattern(payload, payload.patternName);
    applyReplayState(payload.state || payload);
    setConnection('LINKED', 'linked');
}

function handleMessage(event) {
    const validation = Protocol.validateInbound(event, {
        openerWindow,
        expectedOrigin,
        sessionId
    });
    if (!validation.ok) return;

    const { type, payload = {} } = validation.message;
    if (type === 'init') {
        handleInit(payload);
    } else if (type === 'pattern') {
        setReplayPattern(payload, payload.patternName);
        if (payload.state) applyReplayState(payload.state);
    } else if (type === 'state') {
        applyReplayState(payload);
    } else if (type === 'close') {
        suppressCloseNotice = true;
        sendToOpener('close', { reason: 'opener-requested' });
        window.close();
    }
}

// Starting view (and Reset): inside the arena, just behind and above the fly, looking
// slightly down past it at the front of the display — the fly at a comfortable size
// with most (not all) of the display around it. Scales with the drawn fly.
function resetCamera() {
    if (!viewer || !apparatus) return;
    const mm = 1 / MM_PER_INCH;
    const k = FLY_DISPLAY_SCALE;
    const top = apparatus.ballRadius;
    // ~18° down, a touch off-axis so the abdomen doesn't hide the head.
    viewer.camera.position.set(6 * k * mm, top + 3.6 * k * mm, 0.8 * k * mm);
    viewer.controls.target.set(-6 * k * mm, top - 0.3 * k * mm, 0);
    viewer.controls.update();
    applyHorizontalViewFov(horizontalViewFov);
    updateFlyVisibility();
}

// The whole arena from outside (the pre-v0.88 starting view).
function setOverviewView() {
    if (!viewer || !apparatus) return;
    const span = Math.max(apparatus.arenaRadius * 2, apparatus.arenaHeight);
    viewer.camera.position.set(span * 1.05, span * 0.82, span * 1.25);
    viewer.controls.target.set(0, 0, 0);
    viewer.controls.update();
    applyHorizontalViewFov(horizontalViewFov);
    updateFlyVisibility();
}

function bindControls() {
    elements.resetView.addEventListener('click', resetCamera);
    if (elements.overviewView) elements.overviewView.addEventListener('click', setOverviewView);
    elements.topView.addEventListener('click', setTopView);
    elements.rearView.addEventListener('click', setRearView);
    if (elements.flyView) elements.flyView.addEventListener('click', setFlyView);
    elements.flyEyeView.addEventListener('click', setFlyEyeView);
    elements.viewFov.addEventListener('change', handleViewFovChange);
    window.addEventListener('resize', reapplyViewFov);
    if (viewer && viewer.controls) viewer.controls.addEventListener('change', updateFlyVisibility);
}

// Close-up from just behind and above the fly, looking past it at the front of the
// display — the view to see the fly on its ball facing the pattern.
function setFlyView() {
    if (!viewer || !apparatus) return;
    const mm = 1 / MM_PER_INCH;
    const top = apparatus.ballRadius;
    // Rear three-quarter, slightly above: straight behind would foreshorten the body.
    // Distances scale with the drawn fly so it frames the same at any display scale.
    const k = FLY_DISPLAY_SCALE;
    viewer.camera.position.set(4.6 * k * mm, top + 3.4 * k * mm, 4.4 * k * mm);
    viewer.controls.target.set(-3 * k * mm, top + 0.3 * k * mm, -0.8 * k * mm);
    viewer.controls.update();
    applyHorizontalViewFov(horizontalViewFov);
    updateFlyVisibility();
}

function setTopView() {
    if (viewer) viewer.setViewPreset('top-down');
    updateFlyVisibility();
}

// The course calibration puts column 3/front at -X and column 8/rear at +X.
// Looking from behind therefore means an external camera on the +X/east side.
function setRearView() {
    if (viewer) viewer.setViewPreset('from-east');
    updateFlyVisibility();
}

function setFlyEyeView() {
    if (!viewer || !apparatus) return;

    // Start from the shared front-facing internal preset, then lift both the
    // camera and its target just above the 9 mm ball instead of leaving the
    // camera at the ball's center.
    viewer.setViewPreset('fly-west');
    const eyeHeight = apparatus.ballRadius + FLY_EYE_CLEARANCE_MM / MM_PER_INCH;
    viewer.camera.position.y = eyeHeight;
    viewer.controls.target.y = eyeHeight;
    viewer.controls.update();
    updateFlyVisibility(); // the eye point is inside the fly's head — hide it
}

function applyHorizontalViewFov(value) {
    horizontalViewFov = Protocol.clampHorizontalFov(
        value,
        MIN_HORIZONTAL_FOV,
        MAX_HORIZONTAL_FOV,
        horizontalViewFov
    );
    if (elements.viewFov) elements.viewFov.value = String(horizontalViewFov);
    if (!viewer || !viewer.camera) return;
    viewer.setFOV(Protocol.horizontalToVerticalFov(horizontalViewFov, viewer.camera.aspect));
}

function handleViewFovChange(event) {
    applyHorizontalViewFov(event.currentTarget.value);
}

function reapplyViewFov() {
    applyHorizontalViewFov(horizontalViewFov);
}

function cleanupViewer() {
    if (cleanedUp) return;
    cleanedUp = true;
    window.removeEventListener('message', handleMessage);
    window.removeEventListener('resize', reapplyViewFov);
    elements.resetView.removeEventListener('click', resetCamera);
    if (elements.overviewView) elements.overviewView.removeEventListener('click', setOverviewView);
    elements.topView.removeEventListener('click', setTopView);
    elements.rearView.removeEventListener('click', setRearView);
    if (elements.flyView) elements.flyView.removeEventListener('click', setFlyView);
    elements.flyEyeView.removeEventListener('click', setFlyEyeView);
    if (viewer && viewer.controls)
        viewer.controls.removeEventListener('change', updateFlyVisibility);
    elements.viewFov.removeEventListener('change', handleViewFovChange);
    if (apparatus && viewer && viewer.scene) {
        viewer.scene.remove(apparatus.group);
        disposeObject(apparatus.group);
    }
    apparatus = null;
    if (viewer) viewer.destroy();
    viewer = null;
}

function initialize() {
    if (!Protocol || !PatParser || !currentConfig || !currentPanelSpecs) {
        setConnection('VIEWER ERROR', 'error');
        elements.pattern.textContent = 'REQUIRED VIEWER MODULE DID NOT LOAD';
        return;
    }

    try {
        viewer = new ThreeViewer(elements.canvas);
        viewer.init(currentConfig, currentPanelSpecs);
        currentPattern = createDarkPattern(currentConfig, currentPanelSpecs);
        viewer.setPattern(currentPattern);
        rebuildApparatus();
        resetCamera();
        bindControls();
    } catch (error) {
        console.error('Arena Replay Viewer: initialization failed', error);
        setConnection('3D ERROR', 'error');
        elements.pattern.textContent = '3D VIEW COULD NOT START';
        return;
    }

    if (canMessageOpener) {
        window.addEventListener('message', handleMessage);
        setConnection('READY', 'ready');
        sendToOpener('ready', {
            protocolVersion: Protocol.VERSION,
            defaultArenaConfigName: DEFAULT_ARENA,
            accepts: ['parsed-pattern', 'pattern-bytes'],
            stateFrameBase: 0,
            views: ['reset', 'overview', 'top', 'rear', 'fly', 'fly-eye'],
            horizontalFovOptions: [60, 90, 120, 135, 150]
        });
    } else {
        setConnection('STANDALONE', 'idle');
        if (openerWindow && originParameter && !expectedOrigin) {
            elements.pattern.textContent = 'OPENER ORIGIN REJECTED';
        }
    }
}

window.addEventListener('beforeunload', () => {
    sendCloseNotice('viewer-closed');
});

window.addEventListener('pagehide', () => {
    sendCloseNotice('viewer-closed');
    cleanupViewer();
});

initialize();
