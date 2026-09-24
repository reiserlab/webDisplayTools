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
function clearDepthBeforeDraw(renderer) {
    renderer.state.buffers.depth.setMask(true);
    renderer.clearDepth();
}

function flyMaterial(color, opts) {
    const o = opts || {};
    const material = new THREE.MeshStandardMaterial({
        color,
        roughness: o.roughness != null ? o.roughness : 0.62,
        metalness: 0.02,
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
    ellipsoid(0.46, 0.35, 0.34, thoraxTan, -0.1, 0.02, 0);
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

    // Six two-segment legs from the thorax underside to feet ON the ball.
    const up = new THREE.Vector3(0, 1, 0);
    const limb = (a, b, r) => {
        const dir = new THREE.Vector3().subVectors(b, a);
        const len = dir.length();
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, len, 8), legTan);
        mesh.position.copy(a).addScaledVector(dir, 0.5);
        mesh.quaternion.setFromUnitVectors(up, dir.normalize());
        add(mesh);
    };
    const footY = (x, z) => {
        const r2 = x * x + z * z;
        return (
            Math.sqrt(Math.max(0, ballRadiusMm * ballRadiusMm - r2)) - ballRadiusMm - FLY_STANCE_MM
        );
    };
    [
        [-0.32, -0.8, 0.46],
        [-0.1, -0.12, 0.62],
        [0.12, 0.62, 0.5]
    ].forEach(([hipX, footX, footZ]) => {
        [1, -1].forEach((side) => {
            const hip = new THREE.Vector3(hipX, -0.22, side * 0.16);
            const foot = new THREE.Vector3(footX, footY(footX, side * footZ), side * footZ);
            const knee = new THREE.Vector3((hipX + footX) / 2, 0.08, side * (footZ * 0.82));
            limb(hip, knee, 0.045);
            limb(knee, foot, 0.035);
        });
    });
    return fly;
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
        arenaRadius,
        arenaHeight,
        ballRadius
    };
    setLedState(replayState.ledOn, true);
    updateFlyVisibility();
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

function resetCamera() {
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
            views: ['reset', 'top', 'rear', 'fly', 'fly-eye'],
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
