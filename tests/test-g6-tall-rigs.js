#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('../js/vendor/yaml/browser/dist/index.js');
const { getConfig, getArenaId, getArenaName } = require('../js/arena-configs.js');
const PatEncoder = require('../js/pat-encoder.js');
const parserModule = require('../js/pat-parser.js');
const PatParser = parserModule.default || parserModule;

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

function readYaml(relativePath) {
    return YAML.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function sharedRigFields(rig) {
    return {
        format_version: rig.format_version,
        controller: rig.controller,
        plugins: rig.plugins,
        io: rig.io
    };
}

function strictRoundTrip(rows, arenaId) {
    const cols = 10;
    const pixelRows = rows * 20;
    const pixelCols = cols * 20;
    const frame = new Uint8Array(pixelRows * pixelCols);
    frame[0] = 1;
    frame[pixelCols - 1] = 2;
    frame[(pixelRows - 1) * pixelCols] = 3;
    frame[frame.length - 1] = 4;
    const encoded = PatEncoder.encode({
        generation: 'G6',
        gs_val: 16,
        numFrames: 1,
        rowCount: rows,
        colCount: cols,
        pixelRows,
        pixelCols,
        frames: [frame],
        stretchValues: [128],
        arena_id: arenaId,
        observer_id: 0
    });
    const parsed = PatParser.parsePatFile(encoded, { strict: true });
    return (
        parsed.rowCount === rows &&
        parsed.colCount === cols &&
        parsed.arena_id === arenaId &&
        Buffer.compare(Buffer.from(parsed.frames[0]), Buffer.from(frame)) === 0
    );
}

console.log('=== G6 tall arena + rig proposal ===');

const base = readYaml('configs/rigs/cshl_g6_2x10.yaml');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'configs/rigs/index.json'), 'utf8'));

for (const rows of [3, 4]) {
    const arenaName = `G6_${rows}x10`;
    const rigName = `g6_${rows}x10`;
    const rigPath = `configs/rigs/${rigName}.yaml`;
    const expectedArenaId = rows + 2; // 3x10 -> 5; 4x10 -> 6
    const rig = readYaml(rigPath);
    const config = getConfig(arenaName);
    const entry = index.rigs.find((candidate) => candidate.name === rigName);

    check(`${arenaName}: registered`, Boolean(config));
    check(`${arenaName}: geometry`, config?.arena?.num_rows === rows && config?.arena?.num_cols === 10);
    check(`${arenaName}: full grid`, config?.arena?.columns_installed === null);
    check(`${arenaName}: ID`, getArenaId('G6', arenaName) === expectedArenaId, String(expectedArenaId));
    check(`${arenaName}: ID round-trip`, getArenaName('G6', expectedArenaId) === arenaName);
    check(`${rigName}: arena reference`, rig.arena === arenaName);
    check(
        `${rigName}: CSHL capability parity`,
        JSON.stringify(sharedRigFields(rig)) === JSON.stringify(sharedRigFields(base))
    );
    check(`${rigName}: index entry`, Boolean(entry));
    check(`${rigName}: index arena`, entry?.arena === arenaName);
    check(`${rigName}: index path`, entry?.path === `./${rigPath}`);
    check(`${arenaName}: strict pattern round-trip`, strictRoundTrip(rows, expectedArenaId));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
