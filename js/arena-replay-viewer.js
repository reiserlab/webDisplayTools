import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js';
import PatParser from './pat-parser.js';
import ThreeViewer from './pattern-editor/viewers/three-viewer.js';
import { PANEL_SPECS, STANDARD_CONFIGS, getArenaName, getConfig } from './arena-configs.js';

const Protocol = window.ArenaReplayViewerProtocol;
const DEFAULT_ARENA = 'G6_2x10';
const MM_PER_INCH = 25.4;
const BALL_DIAMETER_MM = 9;

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
    sideView: document.getElementById('view-side')
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
    materials.forEach((material) => material.dispose());
}

// The apparatus sits inside an opaque LED cylinder. Keep its physically sized
// meshes legible as a cutaway overlay; otherwise the required 9 mm ball and
// downward flashlight disappear behind the front panels in an isometric view.
function foregroundMaterial(material) {
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
            color: 0xf7f3e8,
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
    group.add(ball);

    const supportHeight = Math.max(0.01, ballY - ballRadius - arenaBottom);
    const support = foregroundMesh(
        new THREE.Mesh(
            new THREE.CylinderGeometry(0.018, 0.025, supportHeight, 16),
            foregroundMaterial(
                new THREE.MeshStandardMaterial({
                    color: 0x73787b,
                    roughness: 0.55,
                    metalness: 0.65
                })
            )
        ),
        40
    );
    support.position.y = arenaBottom + supportHeight / 2;
    group.add(support);

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
    apparatus = { group, ballMaterial, beam, lensMaterial, spot, arenaRadius, arenaHeight };
    setLedState(replayState.ledOn, true);
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
    viewer.camera.fov = 52;
    viewer.camera.updateProjectionMatrix();
    viewer.camera.position.set(span * 1.05, span * 0.82, span * 1.25);
    viewer.controls.target.set(0, 0, 0);
    viewer.controls.update();
}

function bindControls() {
    elements.resetView.addEventListener('click', resetCamera);
    elements.topView.addEventListener('click', setTopView);
    elements.sideView.addEventListener('click', setSideView);
}

function setTopView() {
    if (viewer) viewer.setViewPreset('top-down');
}

function setSideView() {
    if (viewer) viewer.setViewPreset('from-south');
}

function cleanupViewer() {
    if (cleanedUp) return;
    cleanedUp = true;
    window.removeEventListener('message', handleMessage);
    elements.resetView.removeEventListener('click', resetCamera);
    elements.topView.removeEventListener('click', setTopView);
    elements.sideView.removeEventListener('click', setSideView);
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
            views: ['reset', 'top', 'side']
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
