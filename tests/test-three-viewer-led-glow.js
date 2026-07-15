#!/usr/bin/env node
'use strict';

/**
 * Static, network-free regression checks for the shared ThreeViewer LED glow.
 *
 * The renderer intentionally uses one batched THREE.Points halo instead of a
 * post-processing bloom pass or one extra object per LED. These checks protect
 * that performance boundary as well as the public opt-out and all-off behavior.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const viewerPath = path.join(root, 'js', 'pattern-editor', 'viewers', 'three-viewer.js');
const viewer = fs.readFileSync(viewerPath, 'utf8');
const patternEditor = fs.readFileSync(path.join(root, 'pattern_editor.html'), 'utf8');
const replayModule = fs.readFileSync(path.join(root, 'js', 'arena-replay-viewer.js'), 'utf8');
const replayHtml = fs.readFileSync(path.join(root, 'arena_replay_viewer.html'), 'utf8');

let checks = 0;
let failures = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  PASS  ${name}`);
        return;
    }
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function numericConstant(name) {
    const match = viewer.match(new RegExp(`\\bconst\\s+${name}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`));
    return match ? Number(match[1]) : NaN;
}

function methodSlice(name, nextName) {
    // Method declarations are indented four spaces; matching that boundary
    // avoids accidentally starting at an earlier `this.methodName()` call.
    const start = viewer.indexOf(`\n    ${name}(`);
    const end = start < 0 ? -1 : viewer.indexOf(`\n    ${nextName}(`, start + name.length + 6);
    return start >= 0 ? viewer.slice(start, end > start ? end : viewer.length) : '';
}

console.log('\n=== restrained LED treatment ===');
const coreScale = numericConstant('LED_CORE_SCALE');
const haloScale = numericConstant('LED_HALO_DIAMETER_SCALE');
check(
    'physical LED core is enlarged modestly (target 1.14x)',
    Number.isFinite(coreScale) && coreScale >= 1.1 && coreScale <= 1.25,
    `LED_CORE_SCALE=${String(coreScale)}`
);
check(
    'halo diameter stays local to each LED (target 2.0x)',
    Number.isFinite(haloScale) && haloScale >= 1.6 && haloScale <= 2.4,
    `LED_HALO_DIAMETER_SCALE=${String(haloScale)}`
);
check(
    'both visual scale constants are used outside their declarations',
    (viewer.match(/\bLED_CORE_SCALE\b/g) || []).length > 1 &&
        (viewer.match(/\bLED_HALO_DIAMETER_SCALE\b/g) || []).length > 1
);

console.log('\n=== one batched glow layer ===');
const pointLayers = viewer.match(/new\s+THREE\.Points\s*\(/g) || [];
check(
    'the arena creates exactly one THREE.Points glow layer',
    pointLayers.length === 1,
    `${pointLayers.length} found`
);
check('the glow uses THREE.PointsMaterial', /new\s+THREE\.PointsMaterial\s*\(/.test(viewer));
check(
    'one shared radial CanvasTexture supplies soft falloff',
    /createRadialGradient\s*\(/.test(viewer) && /new\s+THREE\.CanvasTexture\s*\(/.test(viewer)
);
check(
    'point color is dynamic and GPU-uploaded after frame changes',
    /setAttribute\s*\(\s*['"]color['"]/.test(viewer) && /\.needsUpdate\s*=\s*true/.test(viewer)
);
check(
    'glow uses additive blending without writing depth',
    /blending\s*:\s*THREE\.AdditiveBlending/.test(viewer) && /depthWrite\s*:\s*false/.test(viewer)
);
check(
    'glow color remains per-LED rather than one global brightness',
    /vertexColors\s*:\s*true/.test(viewer)
);

console.log('\n=== control, off state, and lifecycle ===');
const glowSetter = methodSlice('setLedGlowEnabled', 'reinit');
check('public setLedGlowEnabled toggle is available', glowSetter.length > 0);
check(
    'the toggle stores a Boolean state and refreshes visibility',
    /Boolean\s*\(|!!/.test(glowSetter) && /ledGlow/.test(glowSetter)
);
const colorUpdate = methodSlice('_updateLEDColors', '_getLEDBrightness');
check(
    'all-off frames suppress the entire glow layer',
    /ledGlow\.visible\s*=/.test(colorUpdate) &&
        /brightness\s*>\s*0|hasLit|anyLit|isLit/i.test(colorUpdate)
);
check(
    'pattern brightness still drives both the core and halo update',
    /_getLEDBrightness\s*\(/.test(colorUpdate) && /ledGlow/.test(colorUpdate)
);
check(
    'halo reuses the core color after Three.js sRGB-to-linear conversion',
    /const\s+coreColor\s*=\s*ledRef\.mesh\.material\.color/.test(colorUpdate) &&
        /coreColor\.r/.test(colorUpdate) &&
        /coreColor\.g/.test(colorUpdate) &&
        /coreColor\.b/.test(colorUpdate)
);
const destroyBody = methodSlice('destroy', '_animate');
check(
    'destroy releases the glow layer or calls its disposal helper',
    /ledGlow|disposeLedGlow/.test(destroyBody) && /\.dispose\s*\(/.test(viewer)
);
check(
    'rebuild cleanup covers the shared glow texture/material/geometry',
    /ledGlow(?:Texture|Material|Geometry)?[^\n]{0,100}\.dispose\s*\(|_disposeLedGlow\s*\(/.test(
        viewer
    )
);

console.log('\n=== performance guardrails ===');
check(
    'no post-processing bloom pass is imported or constructed',
    !/UnrealBloomPass|EffectComposer/.test(viewer)
);
check(
    'no per-LED halo mesh or sprite collection is introduced',
    !/ledHaloMeshes|glowMeshes|new\s+THREE\.Sprite\s*\(/.test(viewer)
);
check(
    'the batched halo uses BufferGeometry',
    /new\s+THREE\.BufferGeometry\s*\(/.test(viewer) && /new\s+THREE\.Points\s*\(/.test(viewer)
);

console.log('\n=== shared consumer cache boundaries ===');
const patternImport = patternEditor.match(
    /from\s+['"]\.\/js\/pattern-editor\/viewers\/three-viewer\.js\?([^'"]+)['"]/
);
const replayImport = replayModule.match(
    /from\s+['"]\.\/pattern-editor\/viewers\/three-viewer\.js\?([^'"]+)['"]/
);
const replayEntry = replayHtml.match(
    /<script\s+type=['"]module['"]\s+src=['"]js\/arena-replay-viewer\.js\?([^'"]+)['"]/i
);
check(
    'Pattern Editor cache-busts the shared ThreeViewer revision',
    Boolean(patternImport && /glow|0713/i.test(patternImport[1]))
);
check(
    'Replay imports the same cache-busted shared ThreeViewer',
    Boolean(replayImport && /glow|0713/i.test(replayImport[1]))
);
check(
    'Replay HTML cache-busts its module import edge',
    Boolean(replayEntry && /glow|0713/i.test(replayEntry[1]))
);

console.log(`\n${checks - failures} / ${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
