#!/usr/bin/env node
/**
 * Strict-mode CRC verifier for G6 .pat files.
 *
 * Usage:
 *   node tests/verify-pat-crc.js <file-or-dir> [<file-or-dir> ...]
 *   node tests/verify-pat-crc.js patterns/web_generated
 *
 * Exits 0 if every G6 .pat file passes both header CRC-8/AUTOSAR and
 * per-frame CRC-16/CCITT-FALSE in strict mode; exits 1 otherwise.
 *
 * G4 .pat files are skipped (no CRC scheme in G4 format).
 *
 * Designed for CI: run on the committed patterns dir to catch regressions in
 * encoders, parsers, or files.
 */

const fs = require('fs');
const path = require('path');

const _patParser = require('../js/pat-parser.js');
const PatParser = _patParser.default || _patParser;

function walk(target, out) {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) walk(path.join(target, entry), out);
    } else if (stat.isFile() && target.endsWith('.pat')) {
        out.push(target);
    }
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: node verify-pat-crc.js <file-or-dir> [<file-or-dir> ...]');
    process.exit(2);
}

const files = [];
for (const a of args) {
    if (!fs.existsSync(a)) {
        console.error(`No such path: ${a}`);
        process.exit(2);
    }
    walk(a, files);
}

if (files.length === 0) {
    console.error('No .pat files found.');
    process.exit(2);
}

// Suppress noisy console.group/log/warn from parser
const _g = console.group, _l = console.log, _ge = console.groupEnd, _w = console.warn;
const mute = () => { console.group = () => {}; console.log = () => {}; console.groupEnd = () => {}; console.warn = () => {}; };
const unmute = () => { console.group = _g; console.log = _l; console.groupEnd = _ge; console.warn = _w; };

let pass = 0, fail = 0, skip = 0;
for (const f of files) {
    const buf = fs.readFileSync(f);
    // Detect G4 vs G6 by magic
    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    if (magic !== 'G6PT') {
        console.log(`  SKIP  ${path.relative(process.cwd(), f)} (not G6)`);
        skip++;
        continue;
    }

    try {
        mute();
        PatParser.parsePatFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { strict: true });
        unmute();
        console.log(`  PASS  ${path.relative(process.cwd(), f)}`);
        pass++;
    } catch (e) {
        unmute();
        console.log(`  FAIL  ${path.relative(process.cwd(), f)} — ${e.message}`);
        fail++;
    }
}

console.log(`\n${pass} pass, ${fail} fail, ${skip} skipped (G4) out of ${files.length} files`);
process.exit(fail > 0 ? 1 : 0);
