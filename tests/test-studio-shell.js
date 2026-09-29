#!/usr/bin/env node
/**
 * Static contract for the Arena Studio top-bar / Console shell (LAB-158 ports
 * from the Alt study): the Protocol ▾ menu holds protocol actions only; the
 * ⚙ Settings menu holds the Studio (bench) settings — session rig, GitHub +
 * storage, run logging; the Console Tools rail is an accessible checklist; the
 * scope toggles show their state in text + aria-pressed; replay freezes the new
 * menu too. Reads the page source (no DOM), like the other Studio markup checks.
 *
 * Run: node tests/test-studio-shell.js   (wired into `pixi run test`)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const studio = fs.readFileSync(path.join(root, 'arena_studio.html'), 'utf8');
const replay = fs.readFileSync(path.join(root, 'js/studio-replay.js'), 'utf8');

let totalChecks = 0;
let failures = 0;
function check(name, ok, detail) {
    totalChecks++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
}
// Markup between two anchors (the top bar is flat, so the next sibling's id
// bounds a menu's contents).
function between(startMarker, endMarker) {
    const a = studio.indexOf(startMarker);
    const b = studio.indexOf(endMarker, a + 1);
    return a >= 0 && b > a ? studio.slice(a, b) : '';
}

console.log('=== Protocol ▾ menu ===');
check('menu button reads "Protocol ▾"', /id="fileMenuBtn"[^>]*>Protocol ▾<\/button>/.test(studio));
const protocolMenu = between('<div class="filemenu" id="fileMenu">', 'id="safeModeChip"');
check('Protocol menu markup found', protocolMenu.length > 0);
[
    'fmNew',
    'fmOpen',
    'fmOpenLibrary',
    'fmOpenCourse',
    'fmReplay',
    'fmSave',
    'fmSaveAs',
    'fmReset',
    'fmSoak'
].forEach((id) => check('Protocol menu keeps #' + id, protocolMenu.includes('id="' + id + '"')));
['ghBlock', 'fmLogLevel', 'sessionRig'].forEach((id) =>
    check('Protocol menu no longer holds #' + id, !protocolMenu.includes('id="' + id + '"'))
);
check(
    'section heads: Open protocol / Save & share / Protocol tools',
    protocolMenu.includes('>Open protocol<') &&
        protocolMenu.includes('>Save &amp; share<') &&
        protocolMenu.includes('>Protocol tools<')
);
check(
    'the separator before Soak hides with it in safe mode',
    protocolMenu.includes('id="fmSoakSep"') &&
        studio.includes('body.safemode #fmSoak,body.safemode #fmSoakSep{display:none}')
);

console.log('=== ⚙ Settings menu ===');
const settingsMenu = between(
    '<div class="filemenu settings-menu" id="settingsMenu">',
    'id="helpBtn"'
);
check('Settings menu markup found', settingsMenu.length > 0);
[
    'settingsMenuBtn',
    'sessionRig',
    'sessionRigLock',
    'ghBlock',
    'ghSignInBtn',
    'ghRepoInput',
    'ghBenchId',
    'ghPR',
    'ghDirect',
    'ghArchivePatterns',
    'fmLogLevel'
].forEach((id) => check('Settings menu holds #' + id, settingsMenu.includes('id="' + id + '"')));
check(
    'each moved control exists exactly once (moved, not cloned)',
    ['sessionRig', 'sessionRigLock', 'ghBlock', 'fmLogLevel'].every(
        (id) => studio.split('id="' + id + '"').length === 2
    )
);
const topbar = between('<div class="topbar">', 'id="fileInput"');
check(
    'the rig selector has no permanent top-bar slot (only inside ⚙ Settings)',
    topbar.split('class="rigsel"').length === 2 && settingsMenu.includes('class="rigsel"')
);
check(
    'a read-only rig tag stays in the top bar, filled by syncRigContext and opening ⚙ Settings',
    topbar.indexOf('id="rigTag"') > -1 &&
        topbar.indexOf('id="rigTag"') < topbar.indexOf('id="settingsMenu"') &&
        studio.includes("const tag = $('rigTag');") &&
        studio.includes("$('rigTag').addEventListener('click', openSettingsAtRig);")
);
check(
    'both menu buttons are disclosure buttons (aria-expanded + aria-controls, kept in sync)',
    /id="fileMenuBtn" aria-expanded="false" aria-controls="fileMenuPanel"/.test(studio) &&
        /id="settingsMenuBtn" aria-expanded="false" aria-controls="settingsMenuPanel"/.test(
            studio
        ) &&
        !/id="(fileMenuBtn|settingsMenuBtn)"[^>]*aria-haspopup/.test(studio) &&
        studio.includes("b.setAttribute('aria-expanded', open ? 'true' : 'false')") &&
        studio.includes("$('fileMenuBtn').setAttribute('aria-expanded'")
);
check(
    'old browsers without CSS color-mix() get a persistent notice',
    studio.includes("CSS.supports('color', 'color-mix(in srgb, red, blue)')") &&
        studio.includes("n.id = 'browserNotice';") &&
        studio.includes('.browser-notice{')
);
check(
    'Protocol and Settings menus close each other',
    studio.includes('setSettingsOpen(false); // the two top-bar menus are mutually exclusive') &&
        studio.includes(
            "$('fileMenu').classList.remove('open');\n        setSettingsOpen(!$('settingsMenu')"
        )
);
check(
    'Connect names the bench rig (hover + Help) now the selector is off the top bar',
    studio.includes('function syncRigContext()') && studio.includes("'data-help'")
);
check(
    'Edit toolbar says "Protocol settings" (distinct from ⚙ Settings)',
    /id="settingsToggle"[^>]*>⚙ Protocol settings ▾<\/button>/.test(studio)
);

console.log('=== copy: no stale "File ▾" directions ===');
const staleStudio = (studio.match(/File ▾/g) || []).length;
const staleReplay = (replay.match(/File ▾/g) || []).length;
check('arena_studio.html has no "File ▾"', staleStudio === 0, staleStudio + ' left');
check('js/studio-replay.js has no "File ▾"', staleReplay === 0, staleReplay + ' left');
check(
    'no user text points at a top-bar rig selector',
    !/rig (shown )?in the top bar|selector in the top bar/.test(studio)
);

console.log('=== Console Tools checklist ===');
const railRows = Array.from(
    studio.matchAll(/<div class="rail-btn( sel)?" data-panel="([a-z]+)"([^>]*)>/g)
);
check('nine rail rows', railRows.length === 9, String(railRows.length));
railRows.forEach((m) => {
    const sel = !!m[1];
    const attrs = m[3];
    check(
        'rail row ' + m[2] + ' is role=checkbox with aria-checked=' + sel,
        /role="checkbox"/.test(attrs) && attrs.includes('aria-checked="' + sel + '"')
    );
});
check(
    'setOpen keeps aria-checked in sync; Space/Enter toggle a row',
    studio.includes("r.setAttribute('aria-checked',o?'true':'false')") &&
        studio.includes("if(e.key===' '||e.key==='Enter'){ e.preventDefault(); b.click(); }")
);
check(
    'checked state is drawn with a ✓, not a border colour alone',
    studio.includes(".console-view .rail-btn.sel::before{content:'✓'")
);

console.log('=== Console two columns ===');
check(
    'wide stage is a 2-column dense grid; compact tools take one column',
    studio.includes('grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-flow:row dense') &&
        studio.includes(
            '.console-view .stage>.panel[data-panel="io"],.console-view .stage>.panel[data-panel="fw"]{grid-column:auto}'
        )
);

console.log('=== Run view + Scope ===');
check('Run view is capped at 1500 px', /\.run-view\{[^}]*max-width:1500px/.test(studio));
check(
    'auto-Y and sound show their state in text + aria-pressed',
    studio.includes('id="scopeAutoY" aria-pressed="false"') &&
        studio.includes("auto.textContent = cfg.autoY ? 'auto-Y: on' : 'auto-Y: off'") &&
        studio.includes('id="scopeSound" aria-pressed="false"') &&
        studio.includes("btn.textContent = snd.on ? '♪ sound: on' : '♪ sound: off'")
);
check('sound settings is labelled, not a bare ▾', />sound settings ▾<\/button>/.test(studio));
check(
    'labels: full/clean pill, remembered under the Studio key (default full)',
    studio.includes('id="scopeLabels"') &&
        studio.includes("'studio_scope_labels'") &&
        studio.includes("storedAnnotation === 'clean' ? 'clean' : 'full'")
);

console.log('=== replay ===');
const freeze = replay.slice(
    replay.indexOf('const FREEZE_SELECTORS'),
    replay.indexOf('];', replay.indexOf('const FREEZE_SELECTORS'))
);
check(
    'replay freezes the Protocol menu and the bench/repo/logging parts of ⚙ Settings',
    [
        "'#fileMenu'",
        "'#settingsMenu .rigsel'",
        "'#ghBlock'",
        "'#fmLogRow'",
        "'#sessionRigLock'"
    ].every((sel) => freeze.includes(sel))
);
check(
    '…but not the whole ⚙ Settings menu, so Display (theme) stays usable during replay',
    !/'#settingsMenu'/.test(freeze) && !/'#uiTheme/.test(freeze)
);
check(
    'replay re-pins the current step when the sequence viewport resizes',
    replay.includes('new ResizeObserver(') &&
        replay.includes("seqViewport.querySelector('.seqrow.active')")
);
check(
    're-pin scrolls only the sequence list (never the Run column / replay transport)',
    replay.includes('seqViewport.scrollTop') &&
        !/seqViewport[\s\S]{0,400}scrollIntoView/.test(
            replay.slice(
                replay.indexOf('const seqViewport'),
                replay.indexOf('}).observe(seqViewport)')
            )
        )
);

console.log('=== colour tokens (every stylesheet colour is a token) ===');
// Parse the token blocks: :root (Dark) and, when present, :root[data-ui-theme="…"].
const styleStart = studio.indexOf('<style>\n  :root{');
const styleEnd = studio.indexOf('</style>', styleStart);
const css = studio.slice(styleStart, styleEnd);
function block(sel) {
    const a = css.indexOf(sel);
    if (a < 0) return null;
    const b = css.indexOf('\n  }', a);
    const out = {};
    for (const m of css.slice(a, b).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
}
const tokens = { dark: block(':root{') };
const usedVars = new Set(Array.from(studio.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]));
const definedVars = new Set(Array.from(studio.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]));
const undefinedVars = [...usedVars].filter((v) => !definedVars.has(v));
check(
    'every var(--…) the page uses is defined',
    undefinedVars.length === 0,
    undefinedVars.join(' ')
);

// No stray colour literals in the stylesheet rules — only :root/theme token blocks,
// var() fallbacks and the release-tier badge may spell a colour.
const tokenBlockSpans = [];
for (const m of css.matchAll(/:root(\[data-ui-theme="\w+"\])?\{/g)) {
    tokenBlockSpans.push([m.index, css.indexOf('\n  }', m.index)]);
}
const islandStart = css.indexOf(
    '.edit-view, .confirm-modal-backdrop, .ps-modal-backdrop, .anchor-popover, #miniToast {'
);
const stray = [];
css.split('\n').forEach((line, i, arr) => {
    const offset = arr.slice(0, i).join('\n').length;
    if (tokenBlockSpans.some(([a, b]) => offset >= a && offset <= b)) return;
    if (/wdt-ch-next/.test(line)) return;
    const code = line.split('/*')[0].replace(/var\(--[\w-]+,\s*#[0-9a-fA-F]{3,6}\)/g, '');
    const m = code.match(/#[0-9a-fA-F]{6}\b|rgba?\(\s*\d/);
    if (m) stray.push(i + ': ' + line.trim().slice(0, 60));
});
check(
    'no hard-coded colours left in stylesheet rules',
    stray.length === 0,
    stray.slice(0, 5).join(' | ')
);
check(
    'the Edit view inherits the page theme (its token island uses theme tokens)',
    islandStart > 0 && /--surface-2: var\(--ed-surface2\);/.test(css) && !/--bg: #0f1419;/.test(css)
);
check(
    'Scope canvas + Analog In chart read their colours from the theme',
    studio.includes("turning_deg_s: read('--trace-turn'") &&
        studio.includes('colors: aiChartColors()') &&
        studio.includes("(root.getAttribute('data-ui-theme') || 'dark')")
);

console.log('=== visibility themes (⚙ Settings → Display) ===');
const THEMES = ['dark', 'light', 'contrast', 'night', 'cvd'];
const themeSelect = between('<select id="uiTheme"', '</select>');
check('Appearance dropdown lives in ⚙ Settings', settingsMenu.includes('id="uiTheme"'));
check(
    'dropdown offers the five themes + Match this computer',
    THEMES.concat('system').every((t) => themeSelect.includes('<option value="' + t + '"'))
);
check(
    'stored theme is applied in <head> before first paint (own key, skipped on the Alt route)',
    studio.indexOf("localStorage.getItem('studio_ui_theme')") > -1 &&
        studio.indexOf("localStorage.getItem('studio_ui_theme')") < studio.indexOf('<body>') &&
        studio.includes("setAttribute('data-ui-theme', t)")
);

THEMES.slice(1).forEach((t) => (tokens[t] = block(':root[data-ui-theme="' + t + '"]{')));
const themeTokenNames = Object.keys(tokens.dark).filter(
    (k) =>
        ![
            '--mono',
            '--head',
            '--surface-2',
            '--text-dim',
            '--err',
            '--error',
            '--caution'
        ].includes(k)
);
THEMES.slice(1).forEach((t) => {
    const missing = themeTokenNames.filter((k) => !(tokens[t] && k in tokens[t]));
    check('theme "' + t + '" defines every colour token', missing.length === 0, missing.join(' '));
});
// WCAG 2.x contrast of the opaque token pairs. Text ≥ 4.5 (AA); High contrast ≥ 7 (AAA);
// Focus rings + control edges ≥ 3.
// Colours are #hex or rgba(); a translucent foreground is composited over its opaque
// background first. Anything else THROWS, so a token the test can't read fails loudly
// instead of passing vacuously.
function rgbOf(c) {
    const s = String(c).trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
        const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
        return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
    }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] == null ? 1 : +m[4] };
    throw new Error('unparseable colour: ' + s);
}
function lumRgb(rgb) {
    const l = rgb.map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}
function lum(c) {
    return lumRgb(rgbOf(c).rgb);
}
function ratio(fg, bg) {
    const b = rgbOf(bg);
    if (b.a !== 1) throw new Error('background must be opaque: ' + bg);
    const f = rgbOf(fg);
    const rgb = f.rgb.map((v, i) => v * f.a + b.rgb[i] * (1 - f.a));
    const x = lumRgb(rgb);
    const y = lumRgb(b.rgb);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const TEXT_PAIRS = [
    ['--text', '--bg'],
    ['--text', '--surface'],
    ['--dim', '--surface'],
    ['--accent', '--surface'],
    ['--on-accent', '--accent'],
    ['--danger', '--surface'],
    ['--on-danger', '--danger'],
    ['--warn', '--surface'],
    ['--beta', '--surface'],
    ['--replay', '--surface'],
    ['--on-replay', '--replay'],
    ['--seg-on-fg', '--seg-on-bg'],
    ['--help-fg', '--help'],
    ['--tip-fg', '--tip-bg'],
    ['--term-rx', '--term-bg'],
    ['--term-tx', '--term-bg'],
    ['--danger-text', '--surface'],
    ['--led-text', '--surface']
];
THEMES.slice(1).forEach((t) => {
    const T = tokens[t];
    const low = [];
    const measure = (fg, bg, need) => {
        try {
            const r = ratio(T[fg], T[bg]);
            if (!(r >= need)) low.push(fg + '/' + bg + ' ' + r.toFixed(2) + '<' + need);
        } catch (e) {
            low.push(fg + '/' + bg + ' ' + e.message);
        }
    };
    TEXT_PAIRS.forEach(([fg, bg]) => measure(fg, bg, t === 'contrast' ? 7 : 4.5));
    [
        ['--edge', '--surface'],
        ['--focus', '--bg']
    ].forEach(([fg, bg]) => measure(fg, bg, 3));
    check('theme "' + t + '" meets its WCAG contrast targets', low.length === 0, low.join('; '));
});
check(
    'Night is genuinely dim: body text luminance ≤ 0.3 (Dark ≈ 0.84)',
    lum(tokens.night['--text']) <= 0.3
);
check(
    'Night palette emits no blue: every opaque Night token has B ≤ 0x10',
    Object.values(tokens.night)
        .filter((v) => /^#[0-9a-f]{6}$/i.test(v))
        .every((v) => parseInt(v.slice(5, 7), 16) <= 0x10)
);
check(
    'Night maps pattern previews to red only',
    studio.includes('<filter id="uiNightRed"') &&
        studio.includes(
            ':root[data-ui-theme="night"] :is(.thumb, .pat-preview) :is(img, canvas)'
        ) &&
        !/:root\[data-ui-theme="night"\] (img|canvas)\b/.test(studio) &&
        studio.includes('filter:url(#uiNightRed)')
);
console.log('\n=== Summary ===');
console.log(`${totalChecks - failures} / ${totalChecks} checks passed`);
process.exit(failures ? 1 : 0);
