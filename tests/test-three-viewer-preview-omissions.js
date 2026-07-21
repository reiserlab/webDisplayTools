#!/usr/bin/env node
'use strict';

/**
 * Static and pure-logic regression checks for the CSHL physical preview gap.
 *
 * Rear panels 8 and 18 are absent from the full G6 2x10 rig, but deliberately remain
 * addressable in PAT/YAML/config geometry. The shared ThreeViewer alone omits
 * their complete column from Pattern Designer and replay previews.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const viewer = fs.readFileSync(
    path.join(root, 'js', 'pattern-editor', 'viewers', 'three-viewer.js'),
    'utf8'
);
const arenaConfigs = fs.readFileSync(path.join(root, 'js', 'arena-configs.js'), 'utf8');
const patternEditor = fs.readFileSync(path.join(root, 'pattern_editor.html'), 'utf8');
const replayModule = fs.readFileSync(path.join(root, 'js', 'arena-replay-viewer.js'), 'utf8');
const replayHtml = fs.readFileSync(path.join(root, 'arena_replay_viewer.html'), 'utf8');
const benchmark = fs.readFileSync(
    path.join(root, 'tests', 'benchmark-three-viewer-led-glow.html'),
    'utf8'
);

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

function methodSlice(name, nextName) {
    const start = viewer.indexOf(`\n    ${name}(`);
    const end = start < 0 ? -1 : viewer.indexOf(`\n    ${nextName}(`, start + name.length + 6);
    return start >= 0 ? viewer.slice(start, end > start ? end : viewer.length) : '';
}

function cacheToken(text, pattern) {
    return text.match(pattern)?.[1] || null;
}

console.log('\n=== physical panel identity ===');
const omissionMatch = viewer.match(
    /G6_2X10_PREVIEW_OMITTED_PANEL_NUMBERS\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/
);
const omittedPanels = omissionMatch
    ? omissionMatch[1].split(',').map((value) => Number(value.trim()))
    : [];
check(
    'the hard-coded physical omissions are exactly rear panels 8 and 18',
    JSON.stringify(omittedPanels) === JSON.stringify([8, 18]),
    JSON.stringify(omittedPanels)
);
check(
    'panel 8 maps to lower row, zero-based rear column 7',
    Math.floor((8 - 1) / 10) === 0 && (8 - 1) % 10 === 7
);
check(
    'panel 18 maps to upper row, zero-based rear column 7',
    Math.floor((18 - 1) / 10) === 1 && (18 - 1) % 10 === 7
);

console.log('\n=== preview-only scope ===');
const visibleColumns = methodSlice('_getVisibleColumnsSet', '_buildArena');
check('visible-column logic is present', visibleColumns.length > 0);
check('omission is restricted to G6', /arena\.generation\s*!==\s*['"]G6['"]/.test(visibleColumns));
check(
    'omission is restricted to the 2x10 shape',
    /arena\.num_rows\s*!==\s*2/.test(visibleColumns) &&
        /arena\.num_cols\s*!==\s*10/.test(visibleColumns)
);
check(
    'partial arenas bypass the hard-coded omission',
    /arena\.columns_installed\s*!==\s*null/.test(visibleColumns) &&
        /arena\.columns_installed\s*!==\s*undefined/.test(visibleColumns)
);
check(
    'G6 row-major panel numbers derive the omitted column',
    /row\s*\*\s*arena\.num_cols\s*\+\s*col\s*\+\s*1/.test(visibleColumns)
);
check(
    'the omission does not mutate columns_installed',
    !/arena\.columns_installed\s*=/.test(visibleColumns)
);

console.log('\n=== geometry and logical address-map separation ===');
const buildArena = methodSlice('_buildArena', '_createLEDGlowLayer');
const skipIndex = buildArena.indexOf('if (!visibleColumns.has(col)) continue;');
const createIndex = buildArena.indexOf('this._createColumn(');
check(
    'arena construction uses the preview-visible column set',
    /this\._getVisibleColumnsSet\(\)/.test(buildArena)
);
check(
    'the missing column is skipped before any column geometry is built',
    skipIndex >= 0 && createIndex > skipIndex,
    `skip=${skipIndex}, create=${createIndex}`
);
check(
    'rendered column groups retain their original configured indices',
    /columnGroup\.userData\.columnIndex\s*=\s*col/.test(buildArena)
);
const stats = methodSlice('getArenaStats', 'getRenderStats');
check(
    'arena statistics remain based on configured columns',
    /totalPanels\s*=\s*installedCols\s*\*\s*numRows/.test(stats) &&
        /totalLEDs\s*=\s*totalPanels/.test(stats)
);
const brightness = methodSlice('_getLEDBrightness', '_brightnessToColor');
check(
    'PAT lookup keeps original configured colIndex positions',
    /colIndex\s*\*\s*pixelsPerPanel\s*\+\s*effectivePx/.test(brightness)
);
check(
    'the G6_2x10 registry remains a full logical arena',
    /"G6_2x10"[\s\S]*?"num_rows":\s*2[\s\S]*?"num_cols":\s*10[\s\S]*?"columns_installed":\s*null/.test(
        arenaConfigs
    )
);
check(
    'browser benchmark retains an omitted-vs-adjacent column mapping check',
    /workload\s*===\s*['"]gap['"]/.test(benchmark) &&
        /col\s*=\s*140;\s*col\s*<\s*160/.test(benchmark) &&
        /col\s*=\s*160;\s*col\s*<\s*180/.test(benchmark) &&
        /frameInspection/.test(benchmark)
);

console.log('\n=== shared consumer cache boundary ===');
const patternToken = cacheToken(patternEditor, /three-viewer\.js\?v=([^'"]+)['"]/i);
const replayToken = cacheToken(replayModule, /three-viewer\.js\?v=([^'"]+)['"]/i);
const replayEntryToken = cacheToken(replayHtml, /arena-replay-viewer\.js\?v=([^'"]+)['"]/i);
check(
    'Pattern Designer and replay import the same preview-gap revision',
    patternToken === '0713-solid-ball' && replayToken === patternToken,
    `${patternToken} / ${replayToken}`
);
check(
    'replay HTML cache-busts its entry module to the same revision',
    replayEntryToken === patternToken,
    `${replayEntryToken} / ${patternToken}`
);

console.log(`\n${checks - failures} / ${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
