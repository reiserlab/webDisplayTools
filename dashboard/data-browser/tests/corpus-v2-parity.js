#!/usr/bin/env node
/**
 * corpus-v2-parity.js — the dashboard's half of the behavior_v2 corpus gate
 * (docs/development/runlog-behavior-v2-plan.md, Part 3 §4).
 *
 * For EVERY run log under a course-repo clone: parse the v1 file, convert it to
 * behavior_v2 in memory (js/runlog-format.js, the JS mirror of the bridge's
 * converter), gzip it, read it back through the SAME loader path the dashboard
 * uses (readRunlogText → parseJsonl) and assert the analysis is identical:
 * frame count + first/last frame, event count, step summaries, every P3
 * preference index, and — for every P3 run — the CSV rows of every built page.
 * Prints a Markdown table; exit 1 on any difference. Needs the clone (not part of
 * `pixi run test`, like test-analysis.js).
 *
 *   node dashboard/data-browser/tests/corpus-v2-parity.js [ROOT]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const A = require('../analysis-core.js');
const P = require('../plot-specs.js');
const F = require('../vendor/runlog-format.js');

const root =
    process.argv[2] || path.join(process.env.HOME || '', 'Documents/GitHub/cshl-2026-course');
const OPTS = { ballDiameterMm: 9, smoothWindowS: 0.5 };

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (F.isRunlogName(entry.name)) out.push(p);
    }
    return out.sort();
}

function stripVolatile(run) {
    // Everything analysis-relevant, minus what legitimately differs between the
    // v1 and the v2.gz read: the file name, and the frame_schema line itself (a
    // legacy/full-level file has none; its v2 conversion inserts one).
    const events = run.events.filter((e) => e.type !== 'frame_schema');
    // lineNumber is a file position (shifts by one when a schema line is inserted),
    // not an analysis value.
    const frame = (f) => (f ? { ...f, lineNumber: undefined } : null);
    return {
        frames: run.frames.length,
        firstFrame: frame(run.frames[0]),
        lastFrame: frame(run.frames[run.frames.length - 1]),
        events: events.length,
        eventShapes: events.map((e) => `${e.type}/${e.event || ''}/${e.phase || ''}`).join(','),
        steps: run.steps.map((s) => ({
            index: s.index,
            condition: s.condition,
            startMs: s.startMs,
            endMs: s.endMs,
            frameCount: s.frameCount,
            meanForward: s.meanForward,
            meanTurning: s.meanTurning,
            missingFrames: s.missingFrames
        })),
        metadata: run.metadata,
        family: run.protocolInfo.family,
        totalMissingFrames: run.totalMissingFrames,
        parseErrors: run.parseErrors.length
    };
}

function pagesCsv(run) {
    return P.buildPages([run], { mode: 'single', showIndividuals: true }).map((page) => ({
        id: page.id,
        csv: page.csvRows || []
    }));
}

async function checkFile(file) {
    const rel = path.relative(root, file);
    const row = { file: rel, ok: true, notes: [] };
    try {
        const raw = fs.readFileSync(file);
        const v1Text = await F.readRunlogText(new Uint8Array(raw));
        const fmt = F.detectFormat(v1Text);
        row.fmt = fmt;
        const v2Text = fmt === 'behavior_v2' ? v1Text : F.convertV1ToV2Text(v1Text);
        const gz = zlib.gzipSync(Buffer.from(v2Text));
        const readBack = await F.readRunlogText(new Uint8Array(gz));
        const name = path.basename(file);
        const r1 = A.parseJsonl(v1Text, name, rel, OPTS);
        const r2 = A.parseJsonl(readBack, name + '.gz', rel + '.gz', OPTS);
        row.frames = r1.frames.length;
        row.v1 = raw.length;
        row.v2gz = gz.length;
        row.logFormat = r2.logFormat;
        const s1 = JSON.stringify(stripVolatile(r1));
        const s2 = JSON.stringify(stripVolatile(r2));
        if (s1 !== s2) {
            row.ok = false;
            row.notes.push('run summary differs');
        }
        if (r2.id !== r1.id) {
            row.ok = false;
            row.notes.push('run id differs');
        }
        const isP3 = /^p3/.test(r1.protocolInfo.family);
        row.p3 = isP3;
        if (isP3) {
            const pi1 = r1.steps.map((s) => A.p3PreferenceIndex(r1, s, 0));
            const pi2 = r2.steps.map((s) => A.p3PreferenceIndex(r2, s, 0));
            if (JSON.stringify(pi1) !== JSON.stringify(pi2)) {
                row.ok = false;
                row.notes.push('P3 preference indices differ');
            }
            const c1 = JSON.stringify(pagesCsv(r1));
            const c2 = JSON.stringify(pagesCsv(r2));
            row.csvRows = pagesCsv(r1).reduce((n, p) => n + p.csv.length, 0);
            if (c1 !== c2) {
                row.ok = false;
                row.notes.push('P3 page CSV rows differ');
            }
        }
    } catch (e) {
        row.ok = false;
        row.notes.push(`${e.constructor.name}: ${e.message}`);
    }
    return row;
}

(async () => {
    const files = walk(root);
    if (!files.length) {
        console.error(`no run logs under ${root}`);
        process.exit(2);
    }
    console.error(`[parity] ${files.length} files under ${root}`);
    const rows = [];
    for (const file of files) {
        const row = await checkFile(file);
        rows.push(row);
        console.error(
            `[parity] ${row.ok ? 'ok  ' : 'FAIL'} ${row.file}${row.notes.length ? ' — ' + row.notes.join('; ') : ''}`
        );
    }
    const ok = rows.filter((r) => r.ok).length;
    const p3 = rows.filter((r) => r.p3);
    const mb = (n) => (n / 1e6).toFixed(1);
    const out = [];
    out.push(`## Dashboard v1 vs v2.gz parity — ${files.length} run logs under \`${root}\``);
    out.push('');
    out.push(
        `**${ok} / ${rows.length} identical** (frames, events, step summaries, metadata, run id${p3.length ? `; plus every P3 preference index and every P3 page's CSV rows for the ${p3.length} P3 runs` : ''}). Formats: ` +
            Object.entries(rows.reduce((m, r) => ((m[r.fmt] = (m[r.fmt] || 0) + 1), m), {}))
                .map(([k, v]) => `${v} ${k}`)
                .join(', ') +
            '.'
    );
    out.push('');
    const bad = rows.filter((r) => !r.ok);
    if (bad.length) {
        out.push('### FAILURES');
        for (const r of bad) out.push(`- \`${r.file}\`: ${r.notes.join('; ')}`);
        out.push('');
    }
    out.push('<details><summary>All files</summary>');
    out.push('');
    out.push('| file | fmt | ok | frames | P3 csv rows | v1 MB | v2.gz MB |');
    out.push('|---|---|---|---:|---:|---:|---:|');
    for (const r of rows)
        out.push(
            `| ${r.file} | ${r.fmt || '?'} | ${r.ok ? '✓' : '✗'} | ${r.frames ?? ''} | ${r.csvRows ?? ''} | ${r.v1 ? mb(r.v1) : ''} | ${r.v2gz ? mb(r.v2gz) : ''} |`
        );
    out.push('');
    out.push('</details>');
    console.log(out.join('\n'));
    process.exit(bad.length ? 1 : 0);
})();
