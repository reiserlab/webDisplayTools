#!/usr/bin/env node
'use strict';

/**
 * Pattern filenames vs the controller's SD rules, end to end:
 *   - js/pattern-set.js checkSdFilename / sanitizeSdFilename / fitSdFilename (the shared rule:
 *     ASCII, <= 63 characters, <= 58 so a same-name re-upload — stored as X001_<name> —
 *     keeps its .pat);
 *   - the Pattern Designer's generated names (short words + the compact color code) stay
 *     within 58 for every arena prefix, and withColorTag / fitPatternFilename normalize them;
 *   - the Studio checks the name BEFORE uploading the bytes, doesn't retry a bad name, and
 *     treats the X001_ prefix as a duplicate of the original (sdLogicalName).
 * Editor/Studio functions are extracted from the HTML and run in a sandbox.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PS = require('../js/pattern-set.js');
const PC = require('../js/panel-color.js');
const { STANDARD_CONFIGS } = require('../js/arena-configs.js');

const designer = fs.readFileSync(path.join(ROOT, 'pattern_editor.html'), 'utf8');
const studio = fs.readFileSync(path.join(ROOT, 'arena_studio.html'), 'utf8');

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

function extract(src, name, file) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${file}: function ${name} not found`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`${file}: unbalanced braces in ${name}`);
}

console.log('\n=== shared rule: js/pattern-set.js ===');
{
    check('SD_NAME_MAX = 63 (64-byte firmware buffer incl. NUL)', PS.SD_NAME_MAX === 63);
    check('SD_NAME_SAFE = 58 (room for the X001_ re-upload prefix)', PS.SD_NAME_SAFE === 58);
    const lvl = (n) => PS.checkSdFilename(n).level;
    check('a Designer name is ok', lvl('G6_2x10_grat_rot_20px_50pct_4c-B-G.pat') === 'ok');
    check('58 characters is ok', lvl('a'.repeat(54) + '.pat') === 'ok');
    check('59 characters warns', lvl('a'.repeat(55) + '.pat') === 'warn');
    check('63 characters warns', lvl('a'.repeat(59) + '.pat') === 'warn');
    check('64 characters is an error', lvl('a'.repeat(60) + '.pat') === 'error');
    check('non-ASCII (°) is an error', lvl('grat_30°.pat') === 'error');
    check('a space is fine on the card (FAT long names)', lvl('my grating.pat') === 'ok');
    check(
        'a browser duplicate "… (1).pat" is fine',
        lvl('G6_2x10_grating_rotation_200px_94pct (1).pat') === 'ok'
    );
    check(
        'FAT-forbidden characters are errors',
        ['a:b.pat', 'x?.pat', 'a/b.pat', 'q"t.pat', 'p|q.pat'].every((n) => lvl(n) === 'error')
    );
    check('control characters are errors', lvl('tab\there.pat') === 'error');
    check('missing .pat is an error', lvl('foo.bin') === 'error');
    check('a leading dot is an error (the firmware hides it)', lvl('.hidden.pat') === 'error');
    check('decimals are fine', lvl('G6_2x10_grat_rot_22.5deg_50pct.pat') === 'ok');
    check(
        'sanitize: spaces and symbols become _',
        PS.sanitizeSdFilename('my grating → 30°.pat') === 'my_grating_30.pat'
    );
    const fit = PS.fitSdFilename(
        'G6_3x16_full_',
        'star_trans_1000dot_1000f_with_a_long_note',
        '_4c-F80A-0404'
    );
    check('fit: shortens the middle to at most 58', fit.length <= 58 && fit.length >= 50, fit);
    check(
        'fit: keeps the arena prefix and the color tag',
        fit.startsWith('G6_3x16_full_star_trans') && fit.endsWith('_4c-F80A-0404.pat'),
        fit
    );
    check('fit: the result passes the check', PS.checkSdFilename(fit).level === 'ok');
    check(
        'fit: a short name is unchanged',
        PS.fitSdFilename('G6_2x10_', 'grat_rot_20px', '_4c') === 'G6_2x10_grat_rot_20px_4c.pat'
    );
}

console.log('\n=== Pattern Designer: generated names ===');
function designerFor(layoutKey, configName) {
    const sandbox = {
        PanelColor: PC,
        PatternSet: PS,
        STANDARD_CONFIGS,
        console,
        state: { panel: { layoutKey }, arena: { configName } }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        ['withColorTag', 'motionAbbrev', 'fitPatternFilename', 'findArenaPrefix', 'addArenaPrefix']
            .map((n) => extract(designer, n, 'pattern_editor.html'))
            .join('\n') +
            '\nconst MOTION_ABBREV = { rotation: "rot", expansion: "exp", translation: "trans" };',
        sandbox
    );
    return sandbox;
}
{
    const templates = designer.match(/filename = `[^`]*\.pat`/g) || [];
    check(
        'generated templates use the short words (grat/star/offon/anim, motionAbbrev)',
        templates.some((t) => t.includes('`grat_${motionAbbrev(')) &&
            templates.some((t) => t.includes('`star_${motionAbbrev(')) &&
            templates.some((t) => t.includes('`offon_')) &&
            /`anim_\$\{frames\.length\}f\.pat`/.test(designer) &&
            !/`(grating|starfield|off_on|animation)_/.test(designer),
        templates.join(' | ')
    );
    const d = designerFor('four-color', 'G6_2x10');
    check('motionAbbrev: translation → trans', d.motionAbbrev('translation') === 'trans');
    check(
        'motionAbbrev: rotation → rot, expansion → exp',
        d.motionAbbrev('rotation') === 'rot' && d.motionAbbrev('expansion') === 'exp'
    );
    check(
        'withColorTag: generation stamps the code',
        d.withColorTag('grat_rot_20px_50pct.pat', '-B-G') === 'grat_rot_20px_50pct_4c-B-G.pat'
    );
    check(
        'withColorTag: save keeps the code',
        d.withColorTag('G6_2x10_grat_rot_20px_50pct_4c-B-G.pat') ===
            'G6_2x10_grat_rot_20px_50pct_4c-B-G.pat'
    );
    check(
        'withColorTag: replaces another layout tag (no _rir_4c)',
        d.withColorTag('x_rir-I.pat') === 'x_4c.pat'
    );
    check(
        'withColorTag: unstacks old _4c_rir names',
        d.withColorTag('x_4c_rir.pat') === 'x_4c.pat'
    );
    check(
        'withColorTag: default choice adds just the layout tag',
        d.withColorTag('x.pat', '') === 'x_4c.pat'
    );
    const green = designerFor('g6-green', 'G6_2x10');
    check(
        'withColorTag: green layout leaves names alone',
        green.withColorTag('x_4c-B.pat') === 'x_4c-B.pat'
    );

    // Worst cases the Generate tab can produce today, for every arena prefix + longest tag
    const longest = [
        'star_trans_1000dot_1000f.pat',
        'grat_trans_22.5deg_50pct.pat',
        'edge_trans_22.5deg_100f.pat',
        'sine_trans_22.5deg.pat'
    ];
    const worstCode = '-F80A-0404';
    let worstLen = 0;
    let worstName = '';
    for (const config of Object.keys(STANDARD_CONFIGS)) {
        const ed = designerFor('four-color', config);
        for (const n of longest) {
            const name = ed.withColorTag(ed.addArenaPrefix(n), worstCode);
            if (name.length > worstLen) {
                worstLen = name.length;
                worstName = name;
            }
        }
    }
    check(`longest generated name fits in 58 (${worstLen}: ${worstName})`, worstLen <= 58);
    const ed = designerFor('four-color', 'G6_3x16_full');
    const long = ed.fitPatternFilename(
        'G6_3x16_full_star_trans_1000dot_1000f_my_extra_long_note_here_4c-F80A-0404.pat'
    );
    check(
        'fitPatternFilename: shortens a long name to at most 58',
        long.name.length <= 58 && long.name.length >= 50,
        long.name
    );
    check(
        'fitPatternFilename: keeps prefix + color tag and reports why',
        long.name.startsWith('G6_3x16_full_') &&
            long.name.endsWith('_4c-F80A-0404.pat') &&
            long.problems.length > 0,
        long.name
    );
    const spaced = ed.fitPatternFilename('G6_2x10_Frame 1_h_cw_200f.pat');
    check(
        'fitPatternFilename: the Designer still tidies spaces (style, though the card accepts them)',
        spaced.name === 'G6_2x10_Frame_1_h_cw_200f.pat' && spaced.problems.length === 1,
        JSON.stringify(spaced)
    );
    const bad = ed.fitPatternFilename('G6_3x16_full_my grating 30°.pat');
    check(
        'fitPatternFilename: cleans characters',
        bad.name === 'G6_3x16_full_my_grating_30.pat',
        bad.name
    );
    const ok = ed.fitPatternFilename('G6_2x10_grat_rot_20px_50pct_4c-B.pat');
    check(
        'fitPatternFilename: a good name passes untouched',
        ok.name === 'G6_2x10_grat_rot_20px_50pct_4c-B.pat' && ok.problems.length === 0
    );
    check(
        'save path runs fitPatternFilename',
        /fitPatternFilename\(withColorTag\(addArenaPrefix\(/.test(
            extract(designer, 'buildPatternDataForSave', 'pattern_editor.html')
        )
    );
}

console.log('\n=== G6 playback warning (partial arenas / grid mismatch) ===');
{
    global.PANEL_SPECS = require('../js/arena-configs.js').PANEL_SPECS;
    const PatEncoder = require('../js/pat-encoder.js');
    const pat = (rows, cols) => {
        const W = cols * 20;
        const H = rows * 20;
        return new Uint8Array(
            PatEncoder.encode({
                generation: 'G6',
                gs_val: 2,
                numFrames: 1,
                rowCount: rows,
                colCount: cols,
                pixelRows: H,
                pixelCols: W,
                frames: [new Uint8Array(W * H)],
                stretchValues: [128]
            })
        );
    };
    const full = STANDARD_CONFIGS.G6_2x10.arena;
    const partial = STANDARD_CONFIGS.G6_2x8of10.arena;
    const g = PS.g6HeaderGrid(pat(2, 10));
    check(
        'header grid: 2×10, 20 panels in the mask',
        g && g.rows === 2 && g.cols === 10 && g.maskPanels === 20,
        JSON.stringify(g)
    );
    check('a non-G6 buffer is not read', PS.g6HeaderGrid(new Uint8Array(32)) === null);
    check(
        '2×10 pattern on a 2×10 rig: no warning',
        PS.g6PlaybackWarning(pat(2, 10), full) === null
    );
    check(
        'web-encoded 2×8 (partial) pattern on a 2×10 rig: warned (the controller rejects it)',
        /2×8 panels, but the session rig is 2×10/.test(PS.g6PlaybackWarning(pat(2, 8), full) || '')
    );
    const masked = pat(2, 10);
    masked[11] &= 0xfe; // clear panel 0 (the MATLAB writer's partial-arena mask)
    check(
        'a masked (MATLAB-style partial) pattern: warned',
        /partial-arena pattern/.test(PS.g6PlaybackWarning(masked, null) || '')
    );
    check(
        'partial rig detection',
        PS.isPartialG6Arena(partial) && !PS.isPartialG6Arena(full) && !PS.isPartialG6Arena(null)
    );
    check(
        'no rig known: only the file itself is judged',
        PS.g6PlaybackWarning(pat(2, 8), null) === null
    );
}

console.log('\n=== cache tokens on the changed shared modules ===');
{
    const pages = {
        'pattern_editor.html': designer,
        'arena_studio.html': studio,
        'arena_console.html': fs.readFileSync(path.join(ROOT, 'arena_console.html'), 'utf8'),
        'experiment_designer_v3.html': fs.readFileSync(
            path.join(ROOT, 'experiment_designer_v3.html'),
            'utf8'
        ),
        'icon_generator.html': fs.readFileSync(path.join(ROOT, 'icon_generator.html'), 'utf8')
    };
    for (const [page, src] of Object.entries(pages)) {
        const icon = src.match(/from '\.\/js\/icon-generator\.js(\?v=[^']+)?'/);
        check(
            `${page}: icon-generator.js import is cache-busted`,
            !!(icon && icon[1]),
            icon ? icon[0] : 'no import'
        );
        if (page !== 'icon_generator.html') {
            check(
                `${page}: pattern-set.js is cache-busted`,
                /<script src="js\/pattern-set\.js\?v=[^"]+"><\/script>/.test(src)
            );
        }
    }
    check(
        'pattern_editor.html: panel-color.js is cache-busted',
        /<script src="js\/panel-color\.js\?v=[^"]+"><\/script>/.test(designer)
    );
}

console.log('\n=== Studio: upload order + X001_ duplicates ===');
{
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(extract(studio, 'sdLogicalName', 'arena_studio.html'), sb);
    check('sdLogicalName: plain', sb.sdLogicalName('grat_rot.pat') === 'grat_rot');
    check('sdLogicalName: NNN_ index prefix', sb.sdLogicalName('003_grat_rot.pat') === 'grat_rot');
    check(
        'sdLogicalName: X001_ re-upload = the original',
        sb.sdLogicalName('X001_grat_rot.pat') === 'grat_rot'
    );
    check(
        'sdLogicalName: X002_ of an indexed name',
        sb.sdLogicalName('X002_003_grat_rot.pat') === 'grat_rot'
    );
    check(
        'sdLogicalName: a name that merely starts with X stays',
        sb.sdLogicalName('Xmas_tree.pat') === 'Xmas_tree'
    );

    const up = extract(studio, 'sdUploadOne', 'arena_studio.html');
    const iCheck = up.indexOf('checkSdFilename');
    const iSend = up.indexOf('encodeSetPatternFile(');
    check('sdUploadOne checks the name before sending any bytes', iCheck > 0 && iCheck < iSend);
    check(
        'a bad name is not retried',
        /retry: false/.test(up) && /r\.retry !== false/.test(studio)
    );
    check(
        'upload warns when the name is already on the card',
        /is already on the SD card/.test(studio)
    );
    check(
        'upload warns when the controller would reject a G6 pattern (partial rig / grid mismatch)',
        /PS\.g6PlaybackWarning\(f\.bytes, rigArena\)/.test(studio) &&
            /Studio\.rigArena = function/.test(studio)
    );
    check(
        'the Designer warns once when saving a partial-G6 pattern',
        /function warnPartialG6Once\(/.test(designer) &&
            /warnPartialG6Once\(\);/.test(
                extract(designer, 'buildPatternDataForSave', 'pattern_editor.html')
            )
    );
    check(
        'the upload opcode is labelled 0x85 (no stale 0x8D)',
        !/0x8D/.test(studio) && /write rejected \(0x85\)/.test(studio)
    );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
}
