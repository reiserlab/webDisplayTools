#!/usr/bin/env node
/**
 * check_runlog_readers.js — feed a run log produced by the ROS 2 bridge node through the
 * repo's JS readers, exactly as the Studio / dashboard / replay would:
 *
 *   js/runlog-format.js  readRunlogText (gzip-aware) + createNormalizer().normalize(rec)
 *                        per line — the per-file decoder EVERY reader uses; behavior_v2
 *                        ["a",…] echoes must expand to exact v1 arena_command objects
 *   js/runlog-replay.js  parseRunLog(text) + buildTimeline(parsed) — the Studio's replay
 *                        parser (closed-loop epochs from the runner events)
 *
 * and print counts per line shape. Exit 1 if any line fails to parse/normalize, if the
 * format is not behavior_v2, if no FicTrac rows / arena echoes / tagged streams were
 * found where expected, or if the replay parser finds no runner events.
 *
 *   node tests/check_runlog_readers.js export.jsonl [--expect-kf] [--json]
 *
 * Run it with the ROOT workspace's Node (`pixi run --manifest-path ../pixi.toml node …`);
 * the rig env deliberately has no Node.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const F = require(path.join(REPO, 'js', 'runlog-format.js'));
const R = require(path.join(REPO, 'js', 'runlog-replay.js'));

async function main(argv) {
    const args = argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
        console.error('usage: check_runlog_readers.js LOG [--expect-kf] [--json]');
        return 2;
    }
    const expectKf = args.includes('--expect-kf');
    const bytes = fs.readFileSync(file);
    const text = await F.readRunlogText(new Uint8Array(bytes)); // gzip-aware, async
    const lines = text.split('\n').filter((l) => l.trim());
    const norm = F.createNormalizer();
    const counts = {
        lines: lines.length,
        fictrac_rows: 0,
        arena_echoes: 0,
        tagged: {},
        events: {},
        parse_errors: 0,
        normalize_errors: 0,
        echo_expand_bad: 0
    };
    const problems = [];
    let fmt = null;
    for (let i = 0; i < lines.length; i++) {
        let rec;
        try {
            rec = JSON.parse(lines[i]);
        } catch (e) {
            counts.parse_errors++;
            problems.push(`line ${i + 1}: JSON parse error`);
            continue;
        }
        let out;
        try {
            out = norm.normalize(rec);
        } catch (e) {
            counts.normalize_errors++;
            problems.push(`line ${i + 1}: normalize threw ${e.message}`);
            continue;
        }
        if (Array.isArray(rec)) {
            if (typeof rec[0] === 'number') counts.fictrac_rows++;
            else if (rec[0] === 'a') {
                counts.arena_echoes++;
                // The normalizer must have expanded it to the exact v1 object.
                const ok =
                    out &&
                    !Array.isArray(out) &&
                    out.type === 'log' &&
                    out.event === 'arena_command' &&
                    typeof out.head === 'string' &&
                    out.len === out.head.split(' ').length &&
                    (out.status === null
                        ? out.echo === null && out.ok === null
                        : out.ok === (out.status === 0));
                if (!ok) {
                    counts.echo_expand_bad++;
                    if (counts.echo_expand_bad <= 3)
                        problems.push(`line ${i + 1}: arena echo did not expand to a v1 object`);
                }
            } else if (typeof rec[0] === 'string') {
                counts.tagged[rec[0]] = (counts.tagged[rec[0]] || 0) + 1;
            }
        } else if (rec && typeof rec === 'object') {
            const k = rec.type === 'log' ? `log/${rec.event}` : rec.type;
            counts.events[k] = (counts.events[k] || 0) + 1;
            if (rec.type === 'frame_schema') fmt = rec.level;
        }
    }
    counts.format = fmt;
    counts.detectFormat = typeof F.detectFormat === 'function' ? F.detectFormat(text) : undefined;

    // Replay parser (the Studio's run-log replay).
    let replay = null;
    try {
        const parsed = R.parseRunLog(text, {});
        const tl = typeof R.buildTimeline === 'function' ? R.buildTimeline(parsed, {}) : null;
        replay = {
            samples: Array.isArray(parsed.samples) ? parsed.samples.length : null,
            events: Array.isArray(parsed.events) ? parsed.events.length : null,
            arenaFrames: Array.isArray(parsed.arenaFrames) ? parsed.arenaFrames.length : null,
            durationMs: parsed.durationMs,
            timelineItems: Array.isArray(tl)
                ? tl.length
                : tl && Array.isArray(tl.items)
                  ? tl.items.length
                  : null
        };
        if (!(replay.samples > 0)) problems.push('runlog-replay: no FicTrac samples parsed');
        if (!(replay.arenaFrames > 0))
            problems.push('runlog-replay: no arena frames (0x70 echoes) parsed');
    } catch (e) {
        problems.push(`runlog-replay parseRunLog threw: ${e.message}`);
    }
    counts.replay = replay;

    if (fmt !== 'behavior_v2') problems.push(`frame_schema level ${fmt}, expected behavior_v2`);
    if (!counts.fictrac_rows) problems.push('no FicTrac rows');
    if (!counts.arena_echoes) problems.push('no ["a",…] arena echoes');
    if (!(counts.events['log/runner'] > 0)) problems.push('no runner events');
    if (expectKf && !(counts.tagged.kf > 0)) problems.push('no ["kf",…] rows');

    const ok = problems.length === 0;
    if (args.includes('--json')) console.log(JSON.stringify({ ok, counts, problems }, null, 1));
    else {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${path.basename(file)}: ${JSON.stringify(counts)}`);
        for (const p of problems) console.log('  - ' + p);
    }
    return ok ? 0 : 1;
}

main(process.argv).then(
    (rc) => process.exit(rc),
    (e) => {
        console.error(e && e.stack ? e.stack : String(e));
        process.exit(1);
    }
);
