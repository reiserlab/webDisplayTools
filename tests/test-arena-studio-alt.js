#!/usr/bin/env node
'use strict';

/**
 * Structural parity checks for Arena Studio Alt.
 *
 * Alt deliberately redirects into arena_studio.html and moves the live nodes.
 * This makes production wiring the shared implementation instead of maintaining
 * a fragile copied page. These checks protect that invariant and its safety seam.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const studio = fs.readFileSync(path.join(root, 'arena_studio.html'), 'utf8');
const entry = fs.readFileSync(path.join(root, 'arena_studio_alt.html'), 'utf8');
const alt = fs.readFileSync(path.join(root, 'js', 'arena-studio-alt.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'arena-studio-alt.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pixi = fs.readFileSync(path.join(root, 'pixi.toml'), 'utf8');

let total = 0;
let failures = 0;
function check(name, condition, detail) {
    total++;
    if (condition) console.log('  PASS  ' + name);
    else {
        failures++;
        console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
    }
}

console.log('=== single-source parity ===');
check(
    'Alt entry redirects to the production Studio',
    /arena_studio\.html['"]?\s*\+\s*q\s*\+\s*['"]#alt/.test(entry)
);
check(
    'production page recognizes the Alt route before paint',
    studio.includes("location.hash === '#alt'")
);
check('Alt CSS is loaded by the shared page', studio.includes('href="css/arena-studio-alt.css"'));
check(
    'Alt controller is loaded after the production page wiring',
    studio.includes('src="js/arena-studio-alt.js"')
);
check(
    'Alt does not embed or iframe a second Studio',
    !/<iframe\b/i.test(entry) && !/<iframe\b/i.test(alt)
);
check(
    'file launch explains the supported localhost path',
    entry.includes("location.protocol === 'file:'") &&
        entry.includes('pixi run serve') &&
        studio.includes('studioFileLaunchGuard') &&
        pixi.includes('serve = "python -m http.server 8000 --bind 127.0.0.1"')
);

console.log('=== original control surface retained ===');
const requiredIds = [
    'connectBtn',
    'modeSeg',
    'fileMenu',
    'btnRunExp',
    'btnTestExp',
    'btnStopRun',
    'rbConnBtn',
    'btnLedOff',
    'btnStopDock',
    'btnAllOn',
    'btnAllOff',
    'scopeSpan',
    'scopeWin',
    'scopeTurnLim',
    'scopeFwdLim',
    'scopeAutoY',
    'scopeClear',
    'scopeSound',
    'scopeSoundCfg',
    'cRail',
    'cStage'
];
requiredIds.forEach((id) =>
    check('shared source retains #' + id, studio.includes('id="' + id + '"'))
);
const panels = ['patterns', 'trial', 'step', 'test', 'io', 'led', 'fw', 'fictrac'];
panels.forEach((name) => {
    check(
        'Console visibility button retained: ' + name,
        studio.includes('class="rail-btn') && studio.includes('data-panel="' + name + '"')
    );
    check(
        'Console module retained: ' + name,
        studio.includes('class="panel') && studio.includes('data-panel="' + name + '"')
    );
});
check(
    'Alt rearranges existing nodes instead of cloning their listeners',
    /appendChild\(node\)|\.append\(liveBtn, replayBtn\)/.test(alt)
);

// The Console uses one delegated click listener. Protect the complete action
// vocabulary, not only a hand-picked button subset: every data-cmd in the shared
// markup must still have one handler in that production dispatcher.
const consoleCommands = Array.from(
    new Set(Array.from(studio.matchAll(/data-cmd="([^"]+)"/g), (match) => match[1]))
).sort();
const handlerStart = studio.indexOf('const handlers = {');
const handlerEnd = studio.indexOf('\n    };', handlerStart);
const handlerBody = studio.slice(handlerStart, handlerEnd);
const consoleHandlers = Array.from(
    new Set(Array.from(handlerBody.matchAll(/^\s{8}([A-Za-z0-9_]+)\s*:/gm), (match) => match[1]))
).sort();
check(
    'Console delegated handler table is discoverable',
    handlerStart >= 0 && handlerEnd > handlerStart
);
check(
    'every retained Console data-cmd has exactly one production handler',
    JSON.stringify(consoleCommands) === JSON.stringify(consoleHandlers),
    'commands=' + consoleCommands.length + ', handlers=' + consoleHandlers.length
);
const directButtons = [
    'connectBtn',
    'btnRunExp',
    'btnTestExp',
    'btnStopRun',
    'btnStopDock',
    'btnAllOn',
    'btnAllOff',
    'btnLedOff'
];
directButtons.forEach((id) =>
    check(
        'shared production listener retained: #' + id,
        studio.includes("$('" + id + "').addEventListener('click'") ||
            studio.includes("$('" + id + "') && $('" + id + "').addEventListener('click'")
    )
);

console.log('=== added safety and replay seams ===');
check('replay parser loaded', /src="js\/runlog-replay\.js(?:\?[^\"]+)?"/.test(studio));
check('runtime controls loaded', studio.includes('src="js/runtime-controls.js"'));
check('viewer protocol loaded', studio.includes('src="js/arena-replay-viewer-protocol.js"'));
check(
    'runtime resolver reaches runSequence',
    studio.includes('resolveCondition: typeof Studio.resolveRuntimeCondition')
);
check(
    'replay asserts the hardware-output interlock',
    alt.includes("setOutputInhibited('Arena Studio replay')")
);
check(
    'hardware interlock is asserted before either replay file is read',
    alt.indexOf("setOutputInhibited('Arena Studio replay')") < alt.indexOf('replay.yamlFile.text()')
);
check('replay always clears the interlock on stop', alt.includes('setOutputInhibited(null)'));
check(
    'replay transport exposes sonification and sound settings controls',
    alt.includes('class="alt-replay-sound"') && alt.includes('class="alt-replay-sound-config"')
);
check(
    'replay Scope keeps sound enabled across seeks',
    !studio
        .slice(
            studio.indexOf('function setReplayMode(on)'),
            studio.indexOf('function setReplayClock')
        )
        .includes('setSound(false)')
);
check(
    'Scope exposes sound controls to the replay transport',
    studio.includes('setSoundEnabled: setSound') &&
        studio.includes('getSoundEnabled') &&
        studio.includes('openSoundSettings: openSoundMenu')
);
check(
    'replay sound settings remain interactive while hardware controls are inert',
    !alt
        .slice(
            alt.indexOf('function setReplayFrozen(on)'),
            alt.indexOf('function updateReplayTransport')
        )
        .includes('.scope-sound-menu')
);
check(
    'replay sound is opt-in and Stop mutes it immediately',
    alt
        .slice(alt.indexOf('async function startReplay()'), alt.indexOf('function stopReplay()'))
        .includes('Scope.setSoundEnabled(false)') &&
        alt
            .slice(
                alt.indexOf('function stopReplay()'),
                alt.indexOf('function installUnloadSafety()')
            )
            .includes('Scope.setSoundEnabled(false)') &&
        alt
            .slice(
                alt.indexOf('function stopReplay()'),
                alt.indexOf('function installUnloadSafety()')
            )
            .includes('Scope.closeSoundSettings()')
);
check(
    'armed FicTrac frame application blocks replay entry',
    alt.includes('bridge && bridge.apply')
);
check(
    'keyboard and pointer input are frozen with inert',
    alt.includes("node.setAttribute('inert', '')")
);
check('runtime Apply is logged to JSONL', alt.includes('bridge.log(requested)'));
check(
    'a final-trial pending Apply is logged as unapplied',
    alt.includes('runtime_control_apply_unapplied') && alt.includes('run-ended-before-next-trial')
);
check('runtime control source docs are linked', alt.includes('flow-control-counter-proposal.md'));
check('3D viewer is opened as a movable popup', alt.includes("'arena-studio-alt-replay-viewer'"));
check(
    'optional PAT files support arbitrary local protocols',
    alt.includes('suppliedPatternSource')
);
check(
    'replay YAML and JSONL can be selected directly from the course repo',
    alt.includes('data-repo-pick="yaml"') &&
        alt.includes('data-repo-pick="log"') &&
        alt.includes("listReplayRepoPath(context, 'runlogs')")
);
check(
    'repo replay sources support anonymous public reads and retain provenance',
    alt.includes('token: Studio.ghToken ? Studio.ghToken() : null') &&
        alt.includes('protocolOptions.repoRef') &&
        alt.includes('repo: replay.yamlRepo.full')
);
check(
    'repo replay patterns are selection-owned and ready before the YAML is accepted',
    alt.includes('await loadReplayRepoPatternSources(context, path)') &&
        alt.includes('replay.repoPatternSources') &&
        alt.indexOf('repoPatternSource(trial.patternName)') <
            alt.indexOf('Studio.webBytesForName(trial.patternName)')
);
check(
    'declared YAML pattern library beats stale generic catalog sources',
    alt.indexOf('() => fetchDeclaredPattern(trial.patternName)') <
        alt.indexOf('Studio.webBytesForName && Studio.webBytesForName(trial.patternName)') &&
        alt.includes('for (const source of sources)')
);
check(
    'last replay source choice wins over delayed repo fetches',
    alt.includes('sourceTokens: { yaml: 0, log: 0 }') &&
        alt.includes('generation !== replay.sourceTokens[kind]')
);
check(
    'replay cannot start while a repo replacement is pending',
    alt.includes('sourcePending: { yaml: false, log: false }') &&
        alt.includes('replay.sourcePending.yaml || replay.sourcePending.log') &&
        alt.includes('function updateReplayStartAvailability()')
);
const repoSelectionBody = alt.slice(
    alt.indexOf('async function loadReplayRepoSelection'),
    alt.indexOf('async function pickReplayYamlFromRepo')
);
check(
    'failed replacement keeps the last valid replay pair and restores Start',
    !repoSelectionBody.includes('replay.yamlFile = null') &&
        repoSelectionBody.includes('updateReplayStartAvailability()')
);
check(
    'replay source changes cannot land after replay starts',
    alt
        .slice(
            alt.indexOf('function setReplaySource'),
            alt.indexOf('async function loadReplayRepoSelection')
        )
        .includes('if (Studio.replayActive) return false') &&
        alt
            .slice(
                alt.indexOf('async function startReplay()'),
                alt.indexOf('function stopReplay()')
            )
            .includes('replay.sourceTokens.yaml++') &&
        alt
            .slice(
                alt.indexOf('async function startReplay()'),
                alt.indexOf('function stopReplay()')
            )
            .includes('replay.sourceTokens.log++')
);
check(
    'operator-supplied PAT files override bundled patterns with the same name',
    alt.indexOf('suppliedPatternSource(trial.patternName)') <
        alt.indexOf('Studio.webBytesForName(trial.patternName)')
);
check(
    'declared pattern libraries are same-origin constrained',
    alt.includes('url.origin !== location.origin')
);
check(
    'invalid runtime inputs are reported through the card status',
    alt.indexOf('try {', alt.indexOf('function applyRuntimeChanges()')) <
        alt.indexOf('runtimeValue(runtimeUi.definitions[name], input)')
);
check(
    'production Studio defaults to full Scope annotations',
    studio.includes("const altScope = document.documentElement.classList.contains('arena-alt')") &&
        studio.includes(": 'full';")
);
check(
    'clean Scope keeps every boundary but reduces labels',
    studio.includes('visibleConds.forEach((c) => {') &&
        studio.includes('labelConds.forEach((c) => {')
);
check(
    'replay trial parameters restore Scope direction and closed-loop annotations',
    studio.includes("s.op === 'trialParams'") &&
        studio.includes('last.closedLoop = md === 3 || md === 4;')
);

console.log('=== scoped presentation ===');
const selectorLines = css.split('\n').filter((line) => /^\s*html\.arena-alt/.test(line));
check(
    'Alt stylesheet has substantial scoped coverage',
    selectorLines.length > 80,
    String(selectorLines.length)
);
check('light theme exists', css.includes('html.arena-alt[data-theme="light"]'));
check('Scope dock is bounded', css.includes('height:252px'));
check('index exposes Arena Studio Alt', index.includes('href="arena_studio_alt.html"'));

console.log('\n=== Summary ===');
console.log(total + ' checks, ' + failures + ' failures');
if (failures) process.exit(1);
