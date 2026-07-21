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
    'Alt entry redirects to a cache-versioned production Studio',
    /arena_studio\.html['"]?\s*\+\s*q\s*\+\s*joiner\s*\+\s*['"]alt_ui=[^'"]+#alt/.test(entry)
);
check(
    'production page recognizes the Alt route before paint',
    studio.includes("location.hash === '#alt'")
);
check(
    'Alt CSS is loaded with a cache version by the shared page',
    /href="css\/arena-studio-alt\.css\?v=[^"]+"/.test(studio)
);
check(
    'Alt controller is loaded with a cache version after the production page wiring',
    /src="js\/arena-studio-alt\.js\?v=[^"]+"/.test(studio)
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

console.log('=== Alt Protocol and global Settings separation ===');
const protocolActionIds = [
    'fmNew',
    'fmOpen',
    'fmOpenLibrary',
    'fmOpenCourse',
    'fmOpenDemo',
    'fmSave',
    'fmSaveAs',
    'fmSaveCopy',
    'fmPromote',
    'fmCopyConditions',
    'fmReset'
];
protocolActionIds.forEach((id) =>
    check('Protocol action retained: #' + id, studio.includes('id="' + id + '"'))
);
const globalSettingIds = [
    'ghBlock',
    'ghSignInBtn',
    'ghSignOutBtn',
    'ghLock',
    'ghRepoInput',
    'ghBenchId',
    'ghPR',
    'ghDirect',
    'ghArchivePatterns',
    'fmLogLevel',
    'sessionRig',
    'sessionRigLock'
];
globalSettingIds.forEach((id) =>
    check('global setting retained: #' + id, studio.includes('id="' + id + '"'))
);
check('Classic keeps its File menu label', /id="fileMenuBtn"[^>]*>File ▾<\/button>/.test(studio));
check(
    'Alt renames the live menu to Protocol',
    alt.includes("protocolMenuBtn.textContent = 'Protocol ▾'")
);
check(
    'Alt constructs an upper-right global Settings control',
    alt.includes("settings.id = 'altSettingsMenu'") &&
        alt.includes("settingsBtn.id = 'altSettingsBtn'") &&
        alt.includes("settingsPanel.id = 'altSettingsPanel'")
);
const altTopbarStart = alt.indexOf('function installTopbar()');
const altTopbarEnd = alt.indexOf('\n    function installRunMode()', altTopbarStart);
const altTopbarBody = alt.slice(altTopbarStart, altTopbarEnd);
check(
    'Alt reparents the live rig and GitHub settings nodes',
    altTopbarBody.includes('rigSection.appendChild(rigSelector)') &&
        altTopbarBody.includes('repoSection.appendChild(ghBlock)') &&
        altTopbarBody.includes('loggingSection.appendChild(logRow)')
);
check('Alt does not clone menu or settings controls', !altTopbarBody.includes('cloneNode'));
check(
    'Alt moves the one wired Edit header into the responsive ribbon flow',
    altTopbarBody.includes("document.querySelector('#editView > .app-header')") &&
        altTopbarBody.includes("editTools.id = 'altEditTools'") &&
        altTopbarBody.includes("editTools.classList.add('alt-edit-tools')") &&
        altTopbarBody.includes('context.appendChild(editTools)')
);
check(
    'Alt keeps identity navigation left and operational controls right',
    altTopbarBody.indexOf('append(navigation, brand)') <
        altTopbarBody.indexOf("append(navigation, $('pdLink'))") &&
        altTopbarBody.indexOf("append(navigation, $('pdLink'))") <
            altTopbarBody.indexOf('append(navigation, otherToolsLink)') &&
        altTopbarBody.includes('actions.append(context, primary)') &&
        altTopbarBody.includes('top.append(navigation, pSpacer, actions)') &&
        altTopbarBody.includes("otherToolsLink.textContent = 'Tools'")
);
check(
    'safety controls stay in the replay-frozen operational group',
    altTopbarBody.indexOf("append(primary, document.querySelector('.safe-label'))") <
        altTopbarBody.indexOf(".querySelectorAll('.topbar > .chip") &&
        altTopbarBody.indexOf("append(primary, document.querySelector('.adv-label'))") <
            altTopbarBody.indexOf(".querySelectorAll('.topbar > .chip")
);
check(
    'Edit header retains every visible editor control',
    ['edTabDesigner', 'edTabYaml', 'dirtyIndicator', 'undoBtn', 'redoBtn', 'settingsToggle'].every(
        (id) => studio.includes('id="' + id + '"')
    )
);
check(
    'Protocol settings stay isolated from global Studio Settings',
    altTopbarBody.includes("const protocolSettings = $('settingsToggle')") &&
        !altTopbarBody.includes('settingsPanel.appendChild(editTools)') &&
        !/(?:settingsPanel|settingsSection)\.appendChild\([^;\n]*protocolSettings/.test(
            altTopbarBody
        )
);
check(
    'Connect hover derives the current bench rig from Studio state',
    altTopbarBody.includes('const rig = Studio.currentRig') &&
        altTopbarBody.includes("connectBtn.addEventListener('pointerenter'") &&
        altTopbarBody.includes("connectBtn.addEventListener('focus'") &&
        altTopbarBody.includes("connectBtn.setAttribute(\n                'data-help'")
);
check(
    'Alt uses the status lamp alone and keeps Connect width stable',
    css.includes('html.arena-alt #statusTxt { display:none; }') &&
        css.includes('inline-size:100px;') &&
        css.includes('min-inline-size:100px;')
);
const connectedButtonStyleStart = css.indexOf('html.arena-alt body.connected .connect {');
const connectedButtonStyle = css.slice(
    connectedButtonStyleStart,
    css.indexOf('}', connectedButtonStyleStart) + 1
);
check(
    'Alt Disconnect stays legible against its connected-state fill',
    connectedButtonStyle.includes('background:var(--accent);') &&
        connectedButtonStyle.includes('border-color:var(--accent);') &&
        connectedButtonStyle.includes('color:var(--bg);') &&
        connectedButtonStyle.includes('font-weight:700;')
);
check(
    'Alt rewrites late Classic menu directions without changing Classic source',
    altTopbarBody.includes('function normalizeAltMenuCopy(value)') &&
        altTopbarBody.includes("['in File ▾ first', 'in Settings first']") &&
        altTopbarBody.includes(
            "['File ▾ → Archive SD patterns', 'Settings → Archive SD patterns']"
        ) &&
        altTopbarBody.includes("['File ▾ → Save', 'Protocol ▾ → Save']") &&
        altTopbarBody.includes('copyObserver.observe(document.body')
);
check(
    'Protocol and Settings menus are mutually exclusive',
    altTopbarBody.includes("protocolMenu.classList.remove('open')") &&
        altTopbarBody.includes(
            "protocolMenuBtn.addEventListener('click', () => setSettingsOpen(false))"
        )
);
const unscopedSettingsSelectors = css
    .split('\n')
    .filter(
        (line) =>
            line.includes('.alt-settings') &&
            !/^\s*html\.arena-alt\b/.test(line) &&
            !/^\s*\/\*/.test(line)
    );
check(
    'new Settings presentation remains Alt-scoped',
    unscopedSettingsSelectors.length === 0,
    unscopedSettingsSelectors.join(' | ')
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
const replayFreezeBody = alt.slice(
    alt.indexOf('function setReplayFrozen(on)'),
    alt.indexOf('function updateReplayTransport')
);
check(
    'replay leaves Protocol and Scope presentation controls interactive',
    replayFreezeBody.includes('.alt-top-primary') &&
        !replayFreezeBody.includes('.topbar,') &&
        !replayFreezeBody.includes('.run-dock') &&
        !replayFreezeBody.includes('.alt-scope-settings') &&
        !css.includes('body.alt-replay-active .run-dock {\n  pointer-events:none;')
);
check(
    'choosing a Protocol action safely ends replay before its original handler runs',
    alt.includes("protocolMenuPanel.addEventListener(\n                'click'") &&
        alt.includes("if (Studio.replayActive && event.target.closest('button')) stopReplay();")
);
check(
    'Protocol popup escapes its ribbon and stays above the replay transport',
    css.includes('html.arena-alt #fileMenu {') &&
        css.includes('z-index:70;') &&
        css.includes('overflow:visible;')
);
check(
    'Replay restores the exact Runner row and keeps it in view',
    alt.includes('function highlightReplayStep(step, instant)') &&
        alt.includes("'[data-trialidx=\"' + step.trialIdxInBlock + '\"]'") &&
        alt.includes('function scrollReplayRowIntoView(row, instant)') &&
        alt.includes('row.scrollIntoView({') &&
        alt.includes("block: 'nearest'") &&
        alt.includes("behavior: instant ? 'auto' : 'smooth'") &&
        alt.includes('updateReplayStepVisual(null, true)')
);
check(
    'Scope resizing keeps the already-active replay step visible',
    alt.includes('replay.sequenceResizeObserver = new ResizeObserver') &&
        alt.includes("sequenceViewport.querySelector('.seqrow.active')") &&
        alt.includes('scrollReplayRowIntoView(active, true)')
);
check(
    'Replay shows step number and condition in its pinned transport',
    alt.includes("'STEP ' + ordinal + ' / ' + total + ' · ' + replay.condition")
);
check(
    'Replay hides live Test affordances and relabels the sequence card',
    alt.includes("document.body.classList.toggle('alt-replay-mode', isReplay)") &&
        alt.includes("? 'Sequence · replay position '") &&
        css.includes('body.alt-replay-mode .seqrow .play { display:none; }')
);
check(
    'Pause and Resume preserve replay state while Stop remains separate',
    alt.includes('class="alt-replay-pause"') &&
        alt.indexOf('class="alt-replay-pause"') < alt.indexOf('class="alt-replay-stop"') &&
        alt.includes('function setReplayPaused(on)') &&
        alt.includes('replay.paused = true') &&
        alt.includes('replay.paused = false') &&
        alt.includes('setOutputInhibited(null)')
);
check(
    'seeking while paused does not silently resume playback',
    alt.includes('const continuePlaying = replay.playing && !replay.paused;') &&
        alt.includes('replay.playing = continuePlaying;') &&
        alt.includes('if (continuePlaying) ensureReplayLoop();') &&
        alt
            .slice(
                alt.indexOf('function seekReplay(targetMs)'),
                alt.indexOf('function setReplayFrozen(on)')
            )
            .includes('syncReplayPauseUi();')
);
check(
    'Pause silences sound without clearing the sound selection',
    studio.includes('function setSoundSuspended(on)') &&
        studio.includes('if (soundSuspended) {') &&
        studio.includes('closeSoundSettings: closeSoundMenu, setSoundSuspended') &&
        alt.includes('Scope.setSoundSuspended(true)') &&
        alt.includes('Scope.setSoundSuspended(false)')
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
    'one-link replay validates and preloads its repo protocol',
    alt.includes("params.get('replay') !== '1'") &&
        alt.includes('UrlState.isSafeRepo(repo)') &&
        alt.includes('UrlState.isSafeRepoPath(path)') &&
        alt.includes("loadReplayRepoSelection('yaml', source.path, context)") &&
        alt.includes("chooseMode('replay')")
);
check(
    'canonical repo URL reuses the open protocol whenever Replay is selected',
    alt.includes('function ensureOpenProtocolForReplay()') &&
        alt.includes('Studio.currentDoc && Studio.currentDoc.repoRef') &&
        alt.includes('UrlState.isSafeRepo(repoRef.repo)') &&
        alt.includes('UrlState.isSafeRepoPath(repoRef.path)') &&
        alt.includes('if (isReplay) ensureOpenProtocolForReplay()')
);
check(
    'replay data picker follows linked protocol provenance before global Settings',
    alt.includes('linkedReplaySource && linkedReplaySource.repo') &&
        alt.includes('Studio.currentDoc.repoRef.repo') &&
        alt.includes('repo,\n            token: Studio.ghToken')
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
check(
    'Scope Tuning opens above the canvas with a viewport-safe fallback',
    alt.includes('const above = r.top - pop.offsetHeight - gap;') &&
        alt.includes('const below = r.bottom + gap;') &&
        alt.includes('above >= edge ? above : Math.max(edge, Math.min(below, maxTop))')
);
check(
    'Scope Tuning keeps its number fields and buttons inside the two-column panel',
    css.includes('grid-template-columns:repeat(2,minmax(0,1fr));') &&
        css.includes('html.arena-alt .alt-scope-settings input[type=number] {') &&
        css.includes('html.arena-alt .alt-scope-settings .pill { width:100%; min-width:0; }')
);
check(
    'Alt footer exposes the v0.67 Alt identity and current stamp without changing Classic',
    alt.includes("const ALT_TOOL_VERSION = 'Arena Studio Alt v0.67';") &&
        alt.includes("const ALT_BUILD_STAMP = '2026-07-13 18:55 ET';") &&
        alt.includes("stampNode.nodeValue = ALT_TOOL_VERSION + ' | ' + ALT_BUILD_STAMP + ' · ';") &&
        alt.includes('Studio.TOOL_VERSION = ALT_TOOL_VERSION;') &&
        studio.includes('Arena Studio v0.67 | 2026-07-21 16:25 ET')
);

console.log('=== scoped presentation ===');
const selectorLines = css.split('\n').filter((line) => /^\s*html\.arena-alt/.test(line));
check(
    'Alt stylesheet has substantial scoped coverage',
    selectorLines.length > 80,
    String(selectorLines.length)
);
check('light theme exists', css.includes('html.arena-alt[data-theme="light"]'));
check(
    'Arena Studio brand uses the Pattern Designer green',
    css.includes('--alt-brand:#00e676;') && css.includes('color:var(--alt-brand);')
);
check(
    'Alt topbar uses one content-driven wrapping ribbon',
    /html\.arena-alt \.topbar\s*\{[^}]*display:flex;[^}]*flex-wrap:wrap;/s.test(css) &&
        css.includes(
            'html.arena-alt .alt-top-primary,\nhtml.arena-alt .alt-top-context {\n  display:contents;'
        ) &&
        css.includes(
            'html.arena-alt .alt-context-left,\nhtml.arena-alt .alt-context-right {\n  display:contents;'
        ) &&
        !css.includes('grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);')
);
check(
    'Edit tools join the shared ribbon only in Edit mode',
    css.includes('html.arena-alt body.editmode .alt-edit-tools { display:contents; }')
);
check(
    'narrow shell compacts labels without disabling natural wrapping',
    !css.includes('flex-wrap:nowrap;') &&
        css.includes('@media (max-width:1065px)') &&
        css.includes('.topbar [data-alt-short]::after') &&
        css.includes('body:not(.editmode) .alt-top-primary .seg') &&
        css.includes('min-width:174px')
);
check(
    'right operation cluster consumes free space without compressing navigation',
    css.includes('html.arena-alt .alt-top-navigation,') &&
        css.includes('html.arena-alt .alt-top-actions {') &&
        css.includes('display:contents;') &&
        css.includes('html.arena-alt .alt-context-spacer {') &&
        css.includes('flex:1 1 0;') &&
        css.includes('min-width:12px;') &&
        css.includes('justify-content:flex-end;')
);
check(
    'desktop density preserves full navigation labels',
    css.includes('@media (max-width:1600px)') &&
        css.includes('body.editmode .alt-edit-tools [data-alt-short]') &&
        !css
            .slice(
                css.indexOf('@media (max-width:1600px)'),
                css.indexOf('@media (max-width:1065px)')
            )
            .includes('.topbar [data-alt-short]') &&
        !altTopbarBody.includes("[$('pdLink'), 'Patterns ↗']") &&
        !altTopbarBody.includes("[$('otherToolsLink'), 'Tools']")
);
check(
    'loaded Edit gives the filename icon priority over a needless second ribbon',
    css.includes('@media (max-width:1400px)') &&
        css.includes('body.editmode .alt-context-left .doc-name') &&
        css.includes('max-width:29px') &&
        css.includes('body.editmode .alt-top-primary .seg { flex-basis:190px; }') &&
        css.includes('inline-size:90px')
);
check(
    'screenshot-width Run keeps actions on row one by compacting only the filename',
    css.includes('@media (max-width:1200px)') &&
        css.includes('html.arena-alt .alt-context-left .doc-name') &&
        css.includes('body:not(.editmode) .alt-top-primary .seg') &&
        css.includes('min-width:230px')
);
check('Scope dock is bounded', css.includes('height:252px'));
check('index exposes Arena Studio Alt', index.includes('href="arena_studio_alt.html"'));

console.log('\n=== Summary ===');
console.log(total + ' checks, ' + failures + ' failures');
if (failures) process.exit(1);
