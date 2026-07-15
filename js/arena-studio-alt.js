/**
 * Arena Studio Alt — presentation + replay/runtime-control integration.
 *
 * The Alt page intentionally loads the production Arena Studio and rearranges
 * its existing DOM nodes. Moving a node keeps every original listener and ID,
 * so this file adds a calmer shell without forking the experiment-control UI.
 * All behavior is gated by `html.arena-alt`.
 */
(function () {
    'use strict';

    if (!document.documentElement.classList.contains('arena-alt')) return;

    const $ = (id) => document.getElementById(id);
    const Studio = window.Studio;
    const Scope = window.Scope;
    const ReplayLib = window.RunlogReplay;
    const RuntimeControls = window.RuntimeControls;
    const ViewerProtocol = window.ArenaReplayViewerProtocol;
    if (!Studio || !Scope) return;

    const DOC_URL =
        'https://github.com/reiserlab/webDisplayTools/blob/main/docs/development/flow-control-counter-proposal.md';
    const LED_OFF_MV = (window.ArenaRunnerG6 && window.ArenaRunnerG6.LED_OFF_MV) || 5000;
    const ALT_TOOL_VERSION = 'Arena Studio Alt v0.67';
    const ALT_BUILD_STAMP = '2026-07-13 18:55 ET';
    // `replay=1` is an Alt-only launch convenience. Capture it before the
    // production URL canonicalizer intentionally removes unknown parameters.
    // The repo/path still pass through the shared URL-state validators.
    const linkedReplaySource = (() => {
        const params = new URLSearchParams(location.search);
        const UrlState = window.StudioUrlState;
        const repo = params.get('repo');
        const path = params.get('p');
        if (
            params.get('replay') !== '1' ||
            !UrlState ||
            !UrlState.isSafeRepo(repo) ||
            !UrlState.isSafeRepoPath(path)
        ) {
            return null;
        }
        return { repo, path };
    })();

    const runtimeUi = {
        card: null,
        body: null,
        status: null,
        reason: null,
        apply: null,
        inputs: new Map(),
        definitions: {},
        validation: null,
        docKey: null,
        dirty: false
    };

    const replay = {
        yamlFile: null,
        logFile: null,
        patternFiles: new Map(),
        parsed: null,
        timeline: [],
        index: 0,
        startMs: 0,
        endMs: 0,
        currentMs: 0,
        speed: 1,
        playing: false,
        paused: false,
        raf: null,
        lastWall: 0,
        condition: '—',
        step: null,
        stepIndex: null,
        stepTotal: null,
        sequenceSteps: [],
        sequenceResizeObserver: null,
        trial: null,
        ledOn: false,
        frame: 0,
        patternFrames: 0,
        patternToken: 0,
        patternCache: new Map(),
        ui: {},
        viewer: null,
        viewerReady: false,
        viewerSession: null,
        viewerOrigin: null,
        viewerMessageBound: false,
        seekRaf: null,
        loadToken: 0,
        seeking: false,
        displayMode: 'off',
        frozen: new Map(),
        yamlRepoPath: null,
        logRepoPath: null,
        yamlRepo: null,
        logRepo: null,
        repoPatternSources: new Map(),
        sourceTokens: { yaml: 0, log: 0 },
        sourcePending: { yaml: false, log: false }
    };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function formatClock(ms) {
        const sec = Math.max(0, Number(ms) || 0) / 1000;
        const min = Math.floor(sec / 60);
        return String(min).padStart(2, '0') + ':' + (sec - min * 60).toFixed(2).padStart(5, '0');
    }

    function patternLogicalName(name) {
        return String(name || '')
            .split(/[\\/]/)
            .pop()
            .replace(/^\d+_/, '')
            .replace(/\.pat$/i, '')
            .toLowerCase();
    }

    function normalizeHash(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/^sha256:/, '');
    }

    async function sha256(text) {
        if (!window.crypto || !crypto.subtle) return null;
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
    }

    function replayRepoContext() {
        const GitHub = window.StudioGitHub;
        const settings = Studio.courseSettings && Studio.courseSettings();
        const docRepo =
            (Studio.currentDoc && Studio.currentDoc.repoRef && Studio.currentDoc.repoRef.repo) ||
            (linkedReplaySource && linkedReplaySource.repo);
        const match =
            window.StudioUrlState && window.StudioUrlState.isSafeRepo(docRepo)
                ? /^([^/]+)\/(.+)$/.exec(docRepo)
                : null;
        const repo = match
            ? { owner: match[1], name: match[2], full: docRepo }
            : settings && settings.repo;
        if (!GitHub || !settings || !repo) {
            throw new Error('The course repo is not configured in Settings.');
        }
        return {
            GitHub,
            settings,
            repo,
            token: Studio.ghToken ? Studio.ghToken() : null
        };
    }

    function repoReadMessage(path, status, token) {
        if ((status === 401 || status === 403 || status === 404) && !token) {
            return path + ' is unavailable (HTTP ' + status + '). Sign in if the repo is private.';
        }
        return path + ' returned HTTP ' + status + '.';
    }

    async function listReplayRepoPath(context, path) {
        const response = await context.GitHub.run(
            fetch,
            context.GitHub.reqGetContents(
                context.repo.owner,
                context.repo.name,
                path,
                null,
                context.token
            )
        );
        if (!response.ok || !Array.isArray(response.data)) {
            throw new Error(repoReadMessage(path, response.status, context.token));
        }
        return response.data;
    }

    async function fetchReplayRepoFile(context, path, kind) {
        const response = await context.GitHub.runBytes(
            fetch,
            context.GitHub.reqGetContentsRaw(
                context.repo.owner,
                context.repo.name,
                path,
                null,
                context.token
            )
        );
        if (!response.ok) {
            throw new Error(repoReadMessage(path, response.status, context.token));
        }
        const name = path.split('/').pop();
        const type = kind === 'yaml' ? 'text/yaml' : 'application/x-ndjson';
        const file = new File([response.bytes], name, { type });
        const patterns =
            kind === 'yaml' ? await loadReplayRepoPatternSources(context, path) : new Map();
        return {
            file,
            path,
            repo: {
                owner: context.repo.owner,
                name: context.repo.name,
                full: context.repo.full
            },
            patterns
        };
    }

    async function loadReplayRepoPatternSources(context, yamlPath) {
        const dir = yamlPath.replace(/\.ya?ml$/i, '') + '_patterns';
        const response = await context.GitHub.run(
            fetch,
            context.GitHub.reqGetContents(
                context.repo.owner,
                context.repo.name,
                dir,
                null,
                context.token
            )
        );
        if (response.status === 404) return new Map();
        if (!response.ok || !Array.isArray(response.data)) {
            throw new Error(repoReadMessage(dir, response.status, context.token));
        }
        const sources = new Map();
        response.data
            .filter((entry) => entry && entry.type === 'file' && /\.pat$/i.test(entry.name))
            .forEach((entry) => {
                const source = async () => {
                    const currentToken = Studio.ghToken ? Studio.ghToken() : null;
                    const raw = await context.GitHub.runBytes(
                        fetch,
                        context.GitHub.reqGetContentsRaw(
                            context.repo.owner,
                            context.repo.name,
                            entry.path,
                            null,
                            currentToken
                        )
                    );
                    if (!raw.ok) {
                        throw new Error(repoReadMessage(entry.path, raw.status, currentToken));
                    }
                    return raw.bytes.buffer.slice(
                        raw.bytes.byteOffset,
                        raw.bytes.byteOffset + raw.bytes.byteLength
                    );
                };
                sources.set(entry.name.toLowerCase(), source);
                sources.set(patternLogicalName(entry.name), source);
            });
        return sources;
    }

    function updateReplayStartAvailability() {
        if (!replay.ui.start) return;
        replay.ui.start.disabled = Boolean(
            Studio.replayActive ||
            !replay.yamlFile ||
            !replay.logFile ||
            replay.sourcePending.yaml ||
            replay.sourcePending.log
        );
    }

    function setReplaySource(kind, file, repoSource, generation) {
        if (Studio.replayActive) return false;
        if (generation != null && generation !== replay.sourceTokens[kind]) return false;
        replay.sourcePending[kind] = false;
        if (kind === 'yaml') {
            replay.yamlFile = file;
            replay.yamlRepoPath = (repoSource && repoSource.path) || null;
            replay.yamlRepo = (repoSource && repoSource.repo) || null;
            replay.repoPatternSources = (repoSource && repoSource.patterns) || new Map();
            replay.patternCache.clear();
            replay.patternToken++;
        } else {
            replay.logFile = file;
            replay.logRepoPath = (repoSource && repoSource.path) || null;
            replay.logRepo = (repoSource && repoSource.repo) || null;
        }
        const label = replay.ui[kind + 'Name'];
        if (label) label.textContent = file.name + (repoSource ? ' · repo' : '');
        updateReplayStartAvailability();
        setReplayStatus(
            replay.yamlFile && !replay.logFile
                ? 'Protocol ready · choose its JSONL run log.'
                : 'Ready to replay ' + (replay.logFile ? replay.logFile.name : 'run log') + '.'
        );
        return true;
    }

    async function loadReplayRepoSelection(kind, path, context) {
        if (Studio.replayActive) return;
        const generation = ++replay.sourceTokens[kind];
        replay.sourcePending[kind] = true;
        // Keep the last committed pair intact while a replacement downloads.
        // Start is temporarily disabled, then restored on failure; a late result
        // can never overwrite a newer local/repo choice because of the token.
        updateReplayStartAvailability();
        try {
            setReplayStatus('Fetching ' + path + ' from ' + context.repo.full + '…');
            const source = await fetchReplayRepoFile(context, path, kind);
            setReplaySource(kind, source.file, source, generation);
        } catch (error) {
            if (generation !== replay.sourceTokens[kind]) return;
            replay.sourcePending[kind] = false;
            updateReplayStartAvailability();
            setReplayStatus(error && error.message ? error.message : String(error), true);
        }
    }

    function openProtocolReplaySource() {
        const UrlState = window.StudioUrlState;
        const repoRef = Studio.currentDoc && Studio.currentDoc.repoRef;
        if (
            repoRef &&
            UrlState &&
            UrlState.isSafeRepo(repoRef.repo) &&
            UrlState.isSafeRepoPath(repoRef.path)
        ) {
            return { repo: repoRef.repo, path: repoRef.path };
        }
        return linkedReplaySource;
    }

    async function ensureOpenProtocolForReplay() {
        if (Studio.replayActive || replay.yamlFile || replay.sourcePending.yaml) return;
        const source = openProtocolReplaySource();
        if (!source) {
            setReplayStatus('Open a protocol or choose a replay YAML, then choose its JSONL log.');
            return;
        }
        const GitHub = window.StudioGitHub;
        const match = /^([^/]+)\/(.+)$/.exec(source.repo);
        if (!GitHub || !match) {
            setReplayStatus('The open course protocol could not be prepared for replay.', true);
            return;
        }
        const context = {
            GitHub,
            settings: Studio.courseSettings ? Studio.courseSettings() : {},
            repo: {
                owner: match[1],
                name: match[2],
                full: source.repo
            },
            token: Studio.ghToken ? Studio.ghToken() : null
        };
        await loadReplayRepoSelection('yaml', source.path, context);
    }

    async function pickReplayYamlFromRepo() {
        try {
            const context = replayRepoContext();
            if (!Studio.showPicker)
                throw new Error('The repo picker is unavailable; reload Studio.');
            setReplayStatus('Listing course protocols…');
            const sources = [];
            if (context.settings.benchId) {
                sources.push({
                    label: 'This bench — ' + context.settings.benchId,
                    path: 'protocols/' + context.settings.benchId
                });
            }
            sources.push({ label: 'Shared protocols', path: 'protocols/shared' });
            const results = await Promise.all(
                sources.map(async (source) => {
                    try {
                        return {
                            source,
                            entries: await listReplayRepoPath(context, source.path),
                            error: null
                        };
                    } catch (error) {
                        return { source, entries: [], error };
                    }
                })
            );
            const items = [];
            results.forEach((result) => {
                items.push({ header: result.source.label });
                const files = result.entries
                    .filter(
                        (entry) => entry && entry.type === 'file' && /\.ya?ml$/i.test(entry.name)
                    )
                    .sort((a, b) => a.name.localeCompare(b.name));
                if (files.length) {
                    files.forEach((entry) =>
                        items.push({ label: entry.name, sub: entry.path, value: entry.path })
                    );
                } else {
                    items.push({
                        note: result.error
                            ? result.error.message
                            : 'No protocol YAML files in this source.'
                    });
                }
            });
            Studio.showPicker('Replay protocol — ' + context.repo.full, items, (path) =>
                loadReplayRepoSelection('yaml', path, context)
            );
        } catch (error) {
            setReplayStatus(error && error.message ? error.message : String(error), true);
        }
    }

    async function pickReplayLogFromRepo() {
        try {
            const context = replayRepoContext();
            if (!Studio.showPicker)
                throw new Error('The repo picker is unavailable; reload Studio.');
            setReplayStatus('Listing runlog sources…');
            const root = await listReplayRepoPath(context, 'runlogs');
            const dirs = root
                .filter((entry) => entry && entry.type === 'dir')
                .sort((a, b) => {
                    const current = context.settings.benchId;
                    if (current && a.name === current) return -1;
                    if (current && b.name === current) return 1;
                    return a.name.localeCompare(b.name, undefined, { numeric: true });
                });
            if (!dirs.length)
                throw new Error('No runlog folders were found in ' + context.repo.full + '.');
            Studio.showPicker(
                'Replay data — choose a rig or bench',
                dirs.map((entry) => ({
                    label: entry.name,
                    sub:
                        context.settings.benchId && entry.name === context.settings.benchId
                            ? 'configured bench'
                            : entry.path,
                    value: entry.path
                })),
                async (dir) => {
                    try {
                        setReplayStatus('Listing ' + dir + '…');
                        const entries = await listReplayRepoPath(context, dir);
                        const logs = entries
                            .filter(
                                (entry) =>
                                    entry &&
                                    entry.type === 'file' &&
                                    /\.(jsonl|ndjson)$/i.test(entry.name)
                            )
                            .sort((a, b) => b.name.localeCompare(a.name));
                        Studio.showPicker(
                            'Replay data — ' + dir,
                            logs.map((entry) => ({
                                label: entry.name,
                                sub: entry.path,
                                value: entry.path
                            })),
                            (path) => loadReplayRepoSelection('log', path, context)
                        );
                    } catch (error) {
                        setReplayStatus(
                            error && error.message ? error.message : String(error),
                            true
                        );
                    }
                }
            );
        } catch (error) {
            setReplayStatus(error && error.message ? error.message : String(error), true);
        }
    }

    function installIdentityAndTheme() {
        document.title = 'Arena Studio Alt';
        const brand = document.querySelector('.brand');
        if (brand) brand.textContent = 'Arena Studio';

        const footer = document.querySelector('footer .foot-left');
        if (footer) {
            const stampNode = Array.from(footer.childNodes).find(
                (node) =>
                    node.nodeType === 3 && /Arena Studio v[0-9.]+\s*\|/.test(node.nodeValue || '')
            );
            if (stampNode) stampNode.nodeValue = ALT_TOOL_VERSION + ' | ' + ALT_BUILD_STAMP + ' · ';
            if (!footer.querySelector('.alt-footer-mark')) {
                footer.appendChild(document.createTextNode(' · '));
                footer.appendChild(el('span', 'alt-footer-mark', 'ALT INTERFACE'));
            }
        }
        Studio.TOOL_VERSION = ALT_TOOL_VERSION;

        const saved = localStorage.getItem('arena_studio_alt_theme');
        document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';

        // Keep the user-facing address on the named Alt entry point. The loaded
        // document remains the production Studio, and future URL-state writes
        // preserve this pathname.
        try {
            const altPath = location.pathname.replace(
                /arena_studio\.html$/,
                'arena_studio_alt.html'
            );
            history.replaceState(history.state, '', altPath + location.search);
        } catch (_) {}
    }

    function installTopbar() {
        const top = document.querySelector('.topbar');
        if (!top || top.querySelector('.alt-top-primary')) return;

        const primary = el('div', 'alt-top-primary');
        const context = el('div', 'alt-top-context');
        const navigation = el('div', 'alt-top-navigation');
        const actions = el('div', 'alt-top-actions');
        const pSpacer = el('span', 'alt-context-spacer');
        const brand = document.querySelector('.brand');
        const contextLeft = el('div', 'alt-context-left');
        const editTools = document.querySelector('#editView > .app-header');
        if (editTools) {
            editTools.id = 'altEditTools';
            editTools.classList.add('alt-edit-tools');
        }

        const theme = el('button', 'alt-theme-btn');
        theme.type = 'button';
        theme.title = 'Switch between the charcoal instrument panel and warm light enamel';
        const lamp = el('span', 'alt-theme-lamp');
        const themeText = el('span', '', 'Light');
        theme.append(lamp, themeText);
        function syncThemeLabel() {
            const isLight = document.documentElement.dataset.theme === 'light';
            themeText.textContent = isLight ? 'Dark' : 'Light';
            theme.setAttribute('aria-label', 'Use ' + (isLight ? 'dark' : 'light') + ' theme');
        }
        theme.addEventListener('click', () => {
            const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = next;
            localStorage.setItem('arena_studio_alt_theme', next);
            syncThemeLabel();
        });
        syncThemeLabel();

        // Alt keeps document operations and application configuration visibly
        // separate. The production IDs and live nodes are moved, never cloned,
        // so every existing handler remains the single source of behaviour.
        const protocolMenu = $('fileMenu');
        const protocolMenuBtn = $('fileMenuBtn');
        if (protocolMenuBtn) {
            protocolMenuBtn.textContent = 'Protocol ▾';
            protocolMenuBtn.title = 'Create, open, save, share, or reset the current protocol';
            protocolMenuBtn.setAttribute('aria-label', 'Protocol menu');
            protocolMenuBtn.setAttribute(
                'data-help',
                'Protocol actions — create, open, save, share, or reset the current YAML document.'
            );
        }
        const protocolMenuPanel = protocolMenu && protocolMenu.querySelector('.menu');
        if (protocolMenuPanel) {
            const openHead = protocolMenuPanel.querySelector('.menu-head');
            if (openHead) openHead.textContent = 'Open protocol';
            const addHead = (beforeId, label) => {
                const before = $(beforeId);
                if (
                    !before ||
                    protocolMenuPanel.querySelector('[data-alt-head="' + beforeId + '"]')
                )
                    return;
                const head = el('div', 'menu-head edit-only', label);
                head.dataset.altHead = beforeId;
                protocolMenuPanel.insertBefore(head, before);
            };
            addHead('fmSave', 'Save & share');
            addHead('fmCopyConditions', 'Protocol tools');
        }

        const settings = el('div', 'alt-settings-menu');
        settings.id = 'altSettingsMenu';
        const settingsBtn = el('button', 'alt-settings-btn', '⚙');
        settingsBtn.id = 'altSettingsBtn';
        settingsBtn.type = 'button';
        settingsBtn.title = 'Studio settings — rig, GitHub, run logging, and appearance';
        settingsBtn.setAttribute('aria-label', 'Studio settings');
        settingsBtn.setAttribute('aria-haspopup', 'dialog');
        settingsBtn.setAttribute('aria-expanded', 'false');
        settingsBtn.setAttribute(
            'data-help',
            'Studio settings — the bench rig, GitHub destination, run logging, and appearance. These do not change the protocol YAML.'
        );

        const settingsPanel = el('div', 'alt-settings-panel');
        settingsPanel.id = 'altSettingsPanel';
        settingsPanel.setAttribute('role', 'dialog');
        settingsPanel.setAttribute('aria-label', 'Studio settings');
        settingsPanel.hidden = true;
        const settingsHead = el('div', 'alt-settings-head');
        settingsHead.appendChild(el('span', '', 'STUDIO SETTINGS'));
        const settingsClose = el('button', 'alt-settings-close', '×');
        settingsClose.type = 'button';
        settingsClose.setAttribute('aria-label', 'Close Studio settings');
        settingsClose.title = 'Close Studio settings';
        settingsHead.appendChild(settingsClose);
        settingsPanel.appendChild(settingsHead);

        const settingsSection = (label, className) => {
            const section = el('section', 'alt-settings-section ' + (className || ''));
            section.appendChild(el('div', 'alt-settings-kicker', label));
            settingsPanel.appendChild(section);
            return section;
        };
        const rigSection = settingsSection('Bench & connection', 'alt-settings-rig');
        const rigSelector = document.querySelector('.rigsel');
        if (rigSelector) rigSection.appendChild(rigSelector);

        const repoSection = settingsSection('GitHub & storage', 'alt-settings-repo');
        const ghBlock = $('ghBlock');
        const trailingProtocolSep =
            ghBlock &&
            ghBlock.previousElementSibling &&
            ghBlock.previousElementSibling.classList.contains('sep')
                ? ghBlock.previousElementSibling
                : null;
        const logLevel = $('fmLogLevel');
        const logRow = logLevel && logLevel.closest('.gh-row');
        if (ghBlock) repoSection.appendChild(ghBlock);
        if (trailingProtocolSep) trailingProtocolSep.remove();

        const loggingSection = settingsSection('Run logging', 'alt-settings-logging');
        if (logRow) loggingSection.appendChild(logRow);

        const appearanceSection = settingsSection('Appearance', 'alt-settings-appearance');
        appearanceSection.appendChild(theme);
        settings.append(settingsBtn, settingsPanel);

        function setSettingsOpen(open) {
            settings.classList.toggle('open', open);
            settingsPanel.hidden = !open;
            settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open && protocolMenu) protocolMenu.classList.remove('open');
        }
        settingsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            setSettingsOpen(!settings.classList.contains('open'));
        });
        settingsClose.addEventListener('click', () => {
            setSettingsOpen(false);
            settingsBtn.focus();
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('#altSettingsMenu')) setSettingsOpen(false);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !settings.classList.contains('open')) return;
            setSettingsOpen(false);
            settingsBtn.focus();
        });
        if (protocolMenuBtn)
            protocolMenuBtn.addEventListener('click', () => setSettingsOpen(false));
        // The Protocol dropdown remains inspectable during replay. Choosing a
        // document-changing action is an explicit handoff: end replay first,
        // release its output interlock, then let the original wired handler run.
        if (protocolMenuPanel) {
            protocolMenuPanel.addEventListener(
                'click',
                (event) => {
                    if (Studio.replayActive && event.target.closest('button')) stopReplay();
                },
                true
            );
        }
        const openProtocolButton = $('openProtoBtn');
        if (openProtocolButton) {
            openProtocolButton.addEventListener(
                'click',
                () => {
                    if (Studio.replayActive) stopReplay();
                },
                true
            );
        }

        // The rig selector no longer consumes permanent top-bar space. Surface
        // the selected bench context whenever Connect is hovered or focused.
        const connectBtn = $('connectBtn');
        const sessionRig = $('sessionRig');
        function currentRigLabel() {
            const rig = Studio.currentRig;
            if (rig && rig.name) return String(rig.name);
            if (sessionRig) {
                const selected = sessionRig.options && sessionRig.options[sessionRig.selectedIndex];
                if (selected && selected.textContent) return selected.textContent.trim();
                if (sessionRig.value) return sessionRig.value;
            }
            return 'no rig selected';
        }
        function syncConnectContext() {
            if (!connectBtn) return;
            const rigLabel = currentRigLabel();
            const connected = document.body.classList.contains('connected');
            const action = connected ? 'Disconnect from' : 'Connect to';
            const detail =
                action +
                ' ' +
                rigLabel +
                ' — one shared bench rig is used by Run, Edit, and Console';
            connectBtn.title = detail;
            connectBtn.setAttribute('aria-label', action + ' ' + rigLabel);
            connectBtn.setAttribute(
                'data-help',
                action +
                    ' the arena USB port. Current rig: ' +
                    rigLabel +
                    '. Chrome or Edge is required for Web Serial.'
            );
            settingsBtn.title =
                'Studio settings — rig: ' + rigLabel + '; GitHub, run logging, and appearance';
        }
        if (connectBtn) {
            connectBtn.addEventListener('pointerenter', syncConnectContext);
            connectBtn.addEventListener('focus', syncConnectContext);
        }
        if (sessionRig) {
            sessionRig.addEventListener('change', syncConnectContext);
            new MutationObserver(syncConnectContext).observe(sessionRig, {
                childList: true,
                subtree: true,
                attributes: true
            });
        }
        new MutationObserver(syncConnectContext).observe(document.body, {
            attributes: true,
            attributeFilter: ['class']
        });
        syncConnectContext();

        // Distinguish the editor's YAML-backed settings from the global Studio
        // settings above. This is a label-only Alt change; its original handler
        // and drawer remain untouched.
        const protocolSettings = $('settingsToggle');
        if (protocolSettings) {
            protocolSettings.textContent = '⚙ Protocol settings ▾';
            protocolSettings.dataset.altShort = '⚙ Protocol';
            protocolSettings.setAttribute('aria-label', 'Protocol settings');
            protocolSettings.title =
                'Show or hide settings stored in this protocol YAML — name, experimenter, rig, and pattern set';
            protocolSettings.setAttribute(
                'data-help',
                'Settings stored in this protocol YAML — name, experimenter, date, rig, pattern set, and plugins.'
            );
        }

        const shortLabels = [
            [$('safeModeChip'), '🛡'],
            [$('advLockChip'), '🔓'],
            [$('undoBtn'), '↶'],
            [$('redoBtn'), '↷'],
            [$('dirtyIndicator'), '●']
        ];
        const otherToolsLink = $('otherToolsLink');
        if (otherToolsLink) otherToolsLink.textContent = 'Tools';
        shortLabels.forEach(([node, label]) => {
            if (node) node.dataset.altShort = label;
        });
        if ($('undoBtn')) $('undoBtn').setAttribute('aria-label', 'Undo');
        if ($('redoBtn')) $('redoBtn').setAttribute('aria-label', 'Redo');

        // Translate Classic's menu directions wherever they surface in Alt,
        // including late banners/modals and dynamically rendered help. Text and
        // attributes are edited in place so their original listeners stay wired.
        const altCopyPairs = [
            [
                'Check the rig shown in the top bar matches your bench.',
                'Hover Connect to confirm the rig matches your bench.'
            ],
            ['File ▾ → Run logging', 'Settings → Run logging'],
            ['File ▾ → Bench id', 'Settings → Bench id'],
            ['File ▾ → sign in', 'Settings → sign in'],
            ['File ▾ → Archive SD patterns', 'Settings → Archive SD patterns'],
            ['File ▾ → "Archive SD patterns…"', 'Settings → "Archive SD patterns…"'],
            ['Sign in again from File ▾', 'Sign in again from Settings'],
            ['course repo (File ▾)', 'course repo (Settings)'],
            ['GitHub settings below', 'GitHub settings in Studio Settings'],
            ['in File ▾ first', 'in Settings first'],
            ['File ▾ → Save', 'Protocol ▾ → Save'],
            ['File ▾', 'Protocol ▾'],
            ['rig shown in the top bar', 'rig in Studio Settings'],
            ['bench rig in the top bar', 'bench rig in Studio Settings'],
            [
                'the shared, locked selector in the top bar',
                'the shared, locked selector in Studio Settings'
            ],
            ['Change the rig there', 'Change it in Studio Settings']
        ];
        function normalizeAltMenuCopy(value) {
            let next = String(value == null ? '' : value);
            altCopyPairs.forEach(([from, to]) => {
                next = next.split(from).join(to);
            });
            return next;
        }
        function replaceText(root) {
            if (!root) return;
            Array.from(root.childNodes || []).forEach((node) => {
                if (node.nodeType === 3) {
                    const value = normalizeAltMenuCopy(node.nodeValue);
                    if (value !== node.nodeValue) node.nodeValue = value;
                } else if (!/^(SCRIPT|STYLE)$/i.test(node.nodeName || '')) {
                    replaceText(node);
                }
            });
        }
        function replaceAttributes(root) {
            if (!root || root.nodeType !== 1) return;
            const nodes = [root].concat(Array.from(root.querySelectorAll('[title],[data-help]')));
            nodes.forEach((node) => {
                ['title', 'data-help'].forEach((attribute) => {
                    if (!node.hasAttribute(attribute)) return;
                    const before = node.getAttribute(attribute);
                    const after = normalizeAltMenuCopy(before);
                    if (after !== before) node.setAttribute(attribute, after);
                });
            });
        }
        function replaceCopy(root) {
            if (!root) return;
            if (root.nodeType === 3) {
                const value = normalizeAltMenuCopy(root.nodeValue);
                if (value !== root.nodeValue) root.nodeValue = value;
                return;
            }
            if (root.nodeType !== 1) return;
            replaceText(root);
            replaceAttributes(root);
        }
        replaceCopy(document.body);
        const copyObserver = new MutationObserver((records) => {
            records.forEach((record) => {
                if (record.type === 'characterData') replaceCopy(record.target);
                else if (record.type === 'attributes') replaceAttributes(record.target);
                else Array.from(record.addedNodes || []).forEach(replaceCopy);
            });
        });
        copyObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['title', 'data-help']
        });

        const append = (host, node) => {
            if (node) host.appendChild(node);
        };
        append(navigation, brand);
        append(navigation, $('pdLink'));
        append(navigation, otherToolsLink);

        // Move safety controls before collecting the remaining top-level chips;
        // once a node enters the detached context group, document.querySelector
        // can no longer recover it for the operational (replay-frozen) group.
        append(primary, document.querySelector('.safe-label'));
        append(primary, document.querySelector('.adv-label'));

        append(contextLeft, document.querySelector('.status'));
        append(contextLeft, $('docName'));
        document
            .querySelectorAll('.topbar > .chip, .topbar > .plug-hover, .topbar > .arena')
            .forEach((node) => contextLeft.appendChild(node));
        append(contextLeft, $('runInline'));
        append(contextLeft, $('openProtoBtn'));
        append(contextLeft, $('fileMenu'));

        append(primary, $('modeSeg'));
        append(primary, $('connectBtn'));
        primary.appendChild(settings);
        append(primary, $('helpBtn'));

        context.appendChild(contextLeft);
        if (editTools) context.appendChild(editTools);

        // Keep any future production controls visible instead of dropping them.
        Array.from(top.children).forEach((node) => {
            if (
                node !== primary &&
                node !== context &&
                !node.classList.contains('sep-v') &&
                !node.classList.contains('spacer')
            ) {
                contextLeft.appendChild(node);
            }
        });
        top.querySelectorAll(':scope > .sep-v, :scope > .spacer').forEach((node) => node.remove());
        actions.append(context, primary);
        top.append(navigation, pSpacer, actions);
    }

    function installRunMode() {
        const card = document.querySelector('.launch-card');
        if (!card || card.querySelector('.alt-run-modebar')) return;

        const original = Array.from(card.childNodes);
        const modebar = el('div', 'alt-run-modebar');
        modebar.appendChild(el('span', 'alt-section-label', 'RUNNER MODE'));
        const liveBtn = el('button', 'alt-run-mode', 'Live');
        liveBtn.type = 'button';
        liveBtn.dataset.altRunMode = 'live';
        liveBtn.setAttribute('aria-pressed', 'true');
        const replayBtn = el('button', 'alt-run-mode', 'Replay');
        replayBtn.type = 'button';
        replayBtn.dataset.altRunMode = 'replay';
        replayBtn.setAttribute('aria-pressed', 'false');
        modebar.append(liveBtn, replayBtn);

        const livePane = el('div', 'alt-live-pane');
        original.forEach((node) => livePane.appendChild(node));
        const replayPane = el('div', 'alt-replay-pane');
        replayPane.hidden = true;
        replayPane.innerHTML =
            '<div class="alt-replay-grid">' +
            '<div class="alt-replay-file"><button type="button" data-pick="yaml">YAML</button><button type="button" class="alt-replay-repo" data-repo-pick="yaml" title="Choose a protocol directly from the configured course repo">Repo</button><span data-name="yaml">choose protocol…</span><input type="file" accept=".yaml,.yml" hidden></div>' +
            '<div class="alt-replay-file"><button type="button" data-pick="log">JSONL</button><button type="button" class="alt-replay-repo" data-repo-pick="log" title="Choose a runlog directly from the configured course repo">Repo</button><span data-name="log">choose run log…</span><input type="file" accept=".jsonl,.ndjson,.json,.txt" hidden></div>' +
            '<div class="alt-replay-file"><button type="button" data-pick="patterns">PATs</button><span data-name="patterns">optional pattern files…</span><input type="file" accept=".pat" multiple hidden></div>' +
            '</div>' +
            '<div class="alt-replay-options">' +
            '<label>speed <select data-replay-speed><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>' +
            '<label><input type="checkbox" data-replay-viewer checked> open 3D arena window</label>' +
            '<span class="alt-runtime-status" data-replay-status>Load the immutable YAML and its JSONL run log.</span>' +
            '<button type="button" class="alt-replay-start" disabled>Start replay</button>' +
            '</div>';

        card.append(modebar, livePane, replayPane);
        replay.ui.liveBtn = liveBtn;
        replay.ui.replayBtn = replayBtn;
        replay.ui.livePane = livePane;
        replay.ui.replayPane = replayPane;
        replay.ui.start = replayPane.querySelector('.alt-replay-start');
        replay.ui.status = replayPane.querySelector('[data-replay-status]');
        replay.ui.speedLoader = replayPane.querySelector('[data-replay-speed]');
        replay.ui.viewerCheck = replayPane.querySelector('[data-replay-viewer]');
        replay.ui.yamlName = replayPane.querySelector('[data-name="yaml"]');
        replay.ui.logName = replayPane.querySelector('[data-name="log"]');

        // The shared sequence heading describes the live-only Test buttons. In
        // Replay it instead identifies the same card as the playback position;
        // only this leading text node changes, so the wired document summary is
        // preserved and Classic remains untouched.
        const sequenceHeading = document.querySelector('.seqlist h3');
        const sequenceHeadingText =
            sequenceHeading &&
            Array.from(sequenceHeading.childNodes).find((node) => node.nodeType === 3);
        const liveSequenceHeading = sequenceHeadingText ? sequenceHeadingText.nodeValue : null;

        function chooseMode(mode) {
            if (Studio.replayActive && mode !== 'replay') return;
            const isReplay = mode === 'replay';
            document.body.classList.toggle('alt-replay-mode', isReplay);
            liveBtn.setAttribute('aria-pressed', String(!isReplay));
            replayBtn.setAttribute('aria-pressed', String(isReplay));
            livePane.hidden = isReplay;
            replayPane.hidden = !isReplay;
            if (sequenceHeadingText) {
                sequenceHeadingText.nodeValue = isReplay
                    ? 'Sequence · replay position '
                    : liveSequenceHeading;
            }
            if (isReplay) ensureOpenProtocolForReplay();
        }
        liveBtn.addEventListener('click', () => chooseMode('live'));
        replayBtn.addEventListener('click', () => chooseMode('replay'));

        replayPane.querySelectorAll('.alt-replay-file').forEach((box) => {
            const input = box.querySelector('input');
            const kind = box.querySelector('button').dataset.pick;
            box.querySelector('button').addEventListener('click', () => input.click());
            input.addEventListener('change', () => {
                if (Studio.replayActive) return;
                const file = input.files && input.files[0];
                if (!file) return;
                if (kind === 'yaml' || kind === 'log') {
                    const generation = ++replay.sourceTokens[kind];
                    replay.sourcePending[kind] = false;
                    setReplaySource(kind, file, null, generation);
                } else {
                    replay.patternFiles.clear();
                    const files = Array.from(input.files || []);
                    files.forEach((pat) => {
                        replay.patternFiles.set(pat.name.toLowerCase(), pat);
                        replay.patternFiles.set(patternLogicalName(pat.name), pat);
                    });
                    box.querySelector('span').textContent = files.length
                        ? files.length + ' pattern file' + (files.length === 1 ? '' : 's')
                        : 'optional pattern files…';
                }
            });
        });
        replayPane.querySelectorAll('[data-repo-pick]').forEach((button) => {
            button.addEventListener('click', () => {
                if (button.dataset.repoPick === 'yaml') pickReplayYamlFromRepo();
                else pickReplayLogFromRepo();
            });
        });
        replay.ui.speedLoader.addEventListener('change', () => {
            replay.speed = Number(replay.ui.speedLoader.value) || 1;
        });
        replay.ui.start.addEventListener('click', startReplay);

        if (linkedReplaySource) {
            chooseMode('replay');
        }
    }

    function installReplayTransport() {
        const runView = $('runView');
        if (!runView || runView.querySelector('.alt-replay-transport')) return;
        const bar = el('div', 'alt-replay-transport');
        bar.hidden = true;
        bar.innerHTML =
            '<span class="alt-replay-badge">REPLAY</span>' +
            '<span class="alt-replay-title">—</span>' +
            '<input class="alt-replay-slider" type="range" min="0" max="0" step="10" value="0" aria-label="Replay time">' +
            '<span class="alt-replay-clock">00:00.00 / 00:00.00</span>' +
            '<select class="alt-replay-speed" aria-label="Replay speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>' +
            '<span class="alt-replay-sound-controls" role="group" aria-label="Replay sound">' +
            '<button type="button" class="alt-replay-sound" aria-pressed="false" title="Sonify replayed FicTrac behavior: turning controls pitch and movement controls volume">♪ Sound</button>' +
            '<button type="button" class="alt-replay-sound-config" aria-label="Replay sound settings" title="Configure pitch, volume, waveform, scale, and response ranges">▾</button>' +
            '</span>' +
            '<button type="button" class="alt-replay-open-viewer">3D view</button>' +
            '<button type="button" class="alt-replay-pause" aria-pressed="false">Ⅱ Pause</button>' +
            '<button type="button" class="alt-replay-stop">■ Stop</button>';
        runView.insertBefore(bar, runView.firstChild);
        replay.ui.transport = bar;
        replay.ui.title = bar.querySelector('.alt-replay-title');
        replay.ui.slider = bar.querySelector('.alt-replay-slider');
        replay.ui.clock = bar.querySelector('.alt-replay-clock');
        replay.ui.speed = bar.querySelector('.alt-replay-speed');
        replay.ui.sound = bar.querySelector('.alt-replay-sound');
        replay.ui.soundConfig = bar.querySelector('.alt-replay-sound-config');
        replay.ui.openViewer = bar.querySelector('.alt-replay-open-viewer');
        replay.ui.pause = bar.querySelector('.alt-replay-pause');
        replay.ui.stop = bar.querySelector('.alt-replay-stop');
        replay.ui.speed.addEventListener('change', () => {
            replay.speed = Number(replay.ui.speed.value) || 1;
            replay.ui.speedLoader.value = String(replay.speed);
            replay.lastWall = performance.now();
        });
        const syncSound = () => {
            const on = Boolean(Scope.getSoundEnabled && Scope.getSoundEnabled());
            replay.ui.sound.setAttribute('aria-pressed', String(on));
            replay.ui.sound.title = on
                ? replay.paused
                    ? 'Replay sonification is selected and will resume with playback'
                    : 'Replay sonification is on; click to mute'
                : 'Sonify replayed FicTrac behavior: turning controls pitch and movement controls volume';
        };
        replay.ui.syncSound = syncSound;
        replay.ui.sound.addEventListener('click', () => {
            if (!Scope.setSoundEnabled) return;
            Scope.setSoundEnabled(!(Scope.getSoundEnabled && Scope.getSoundEnabled()));
            syncSound();
        });
        replay.ui.soundConfig.addEventListener('click', (event) => {
            event.stopPropagation();
            if (document.querySelector('.scope-sound-menu.open')) {
                if (Scope.closeSoundSettings) Scope.closeSoundSettings();
            } else if (Scope.openSoundSettings) {
                Scope.openSoundSettings(replay.ui.soundConfig);
            }
        });
        document.addEventListener('scope-sound-change', syncSound);
        if (!Scope.setSoundEnabled) {
            replay.ui.sound.disabled = true;
            replay.ui.soundConfig.disabled = true;
        }
        syncSound();
        replay.ui.slider.addEventListener('input', () => {
            const target = replay.startMs + Number(replay.ui.slider.value || 0);
            const continuePlaying = replay.playing && !replay.paused;
            if (replay.seekRaf) cancelAnimationFrame(replay.seekRaf);
            replay.seekRaf = requestAnimationFrame(() => {
                replay.seekRaf = null;
                seekReplay(target);
                replay.lastWall = performance.now();
                replay.playing = continuePlaying;
                if (continuePlaying) ensureReplayLoop();
            });
        });
        replay.ui.openViewer.addEventListener('click', () => openViewer(true));
        replay.ui.pause.addEventListener('click', toggleReplayPause);
        replay.ui.stop.addEventListener('click', stopReplay);
        syncReplayPauseUi();

        // The Scope dock is user-resizable. If it grows during a long replay
        // step, the sequence viewport shrinks without another step-start event.
        // Re-apply Classic's nearest-row rule so the active step stays visible.
        const sequenceViewport = $('seqBody');
        if (sequenceViewport && window.ResizeObserver && !replay.sequenceResizeObserver) {
            replay.sequenceResizeObserver = new ResizeObserver(() => {
                if (!Studio.replayActive) return;
                const active = sequenceViewport.querySelector('.seqrow.active');
                if (!active) return;
                requestAnimationFrame(() => scrollReplayRowIntoView(active, true));
            });
            replay.sequenceResizeObserver.observe(sequenceViewport);
        }
    }

    function installScopeControls() {
        const controls = $('scopeCtrls');
        if (!controls || controls.querySelector('.alt-scope-settings-btn')) return;
        const span = $('scopeSpan');
        const spanLabel = span && span.closest('label');
        if (spanLabel) spanLabel.classList.add('alt-scope-span');

        const annotation = el('button', 'alt-scope-annotation-btn');
        annotation.type = 'button';
        const syncAnnotation = () => {
            const mode = Scope.getAnnotationMode ? Scope.getAnnotationMode() : 'clean';
            annotation.textContent = 'labels: ' + mode;
            annotation.title =
                mode === 'clean'
                    ? 'Clean annotations show only the current trial label; every boundary and hover detail remains available'
                    : 'Full annotations show as many trial labels and glyphs as fit';
        };
        annotation.addEventListener('click', () => {
            const now = Scope.getAnnotationMode ? Scope.getAnnotationMode() : 'clean';
            if (Scope.setAnnotationMode)
                Scope.setAnnotationMode(now === 'clean' ? 'full' : 'clean');
            syncAnnotation();
        });
        syncAnnotation();

        const settingsBtn = el('button', 'alt-scope-settings-btn', 'Tuning ▾');
        settingsBtn.type = 'button';
        const pop = el('div', 'alt-scope-settings');
        pop.hidden = true;
        const moveIds = ['scopeWin', 'scopeTurnLim', 'scopeFwdLim'];
        moveIds.forEach((id) => {
            const input = $(id);
            const label = input && input.closest('label');
            if (label) pop.appendChild(label);
        });
        ['scopeAutoY', 'scopeClear', 'scopeSound', 'scopeSoundCfg'].forEach((id) => {
            const node = $(id);
            if (node) pop.appendChild(node);
        });
        document.body.appendChild(pop);
        settingsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            pop.hidden = !pop.hidden;
            if (!pop.hidden) {
                const r = settingsBtn.getBoundingClientRect();
                pop.style.left =
                    Math.max(
                        12,
                        Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 12)
                    ) + 'px';
                const gap = 7;
                const edge = 12;
                const above = r.top - pop.offsetHeight - gap;
                const below = r.bottom + gap;
                const maxTop = innerHeight - pop.offsetHeight - edge;
                pop.style.top =
                    (above >= edge ? above : Math.max(edge, Math.min(below, maxTop))) + 'px';
            }
        });
        pop.addEventListener('click', (event) => event.stopPropagation());
        document.addEventListener('click', () => {
            pop.hidden = true;
        });
        const status = $('scopeStatus');
        controls.insertBefore(annotation, status || null);
        controls.insertBefore(settingsBtn, status || null);
    }

    function installRuntimeCard() {
        const panel = $('metaPanel');
        if (!panel || runtimeUi.card) return;
        const card = el('div', 'mp-card alt-runtime-card');
        const heading = el('h4', '', 'Runtime controls');
        const link = el('a', 'srclink', 'proposal ↗');
        link.href = DOC_URL;
        link.target = '_blank';
        link.rel = 'noopener';
        link.title =
            'Dynamic-variable proposal: explicit Apply, next-trial boundary, logged provenance, unchanged YAML';
        heading.append(document.createTextNode(' '), link);
        const body = el('div', 'alt-runtime-body');
        const status = el('div', 'alt-runtime-status');
        card.append(heading, body, status);
        const cards = panel.querySelectorAll('.mp-card');
        panel.insertBefore(card, cards[1] || null);
        runtimeUi.card = card;
        runtimeUi.body = body;
        runtimeUi.status = status;
        renderRuntimeControls(true);
    }

    function protocolDocKey() {
        const doc = Studio.currentDoc;
        return doc && doc.experiment
            ? [
                  doc.filename,
                  doc.sha256 || '',
                  Object.keys(doc.experiment.runtime_controls || {}).join(',')
              ].join('|')
            : 'none';
    }

    function renderRuntimeControls(force) {
        if (!runtimeUi.body) return;
        const key = protocolDocKey();
        if (!force && key === runtimeUi.docKey) {
            updateRuntimeUi();
            return;
        }
        runtimeUi.docKey = key;
        runtimeUi.inputs.clear();
        runtimeUi.body.textContent = '';
        runtimeUi.validation = null;
        runtimeUi.definitions = {};
        runtimeUi.dirty = false;

        const protocol = Studio.currentDoc && Studio.currentDoc.experiment;
        if (!protocol || !RuntimeControls) {
            runtimeUi.body.appendChild(
                el('div', 'alt-runtime-empty', 'Open a protocol to inspect its exposed variables.')
            );
            runtimeUi.status.textContent = 'The source YAML remains immutable.';
            return;
        }
        const report = RuntimeControls.validateRuntimeControls(protocol);
        runtimeUi.validation = report;
        runtimeUi.definitions = report.controls || {};
        const names = Object.keys(runtimeUi.definitions);
        if (!report.ok) {
            const box = el('div', 'alt-runtime-empty');
            box.textContent =
                'Runtime declarations need attention: ' +
                report.errors.map((e) => e.message).join(' · ');
            runtimeUi.body.appendChild(box);
            runtimeUi.status.textContent = 'The experiment will use its YAML defaults.';
            return;
        }
        if (!names.length) {
            runtimeUi.body.appendChild(
                el(
                    'div',
                    'alt-runtime-empty',
                    'No runtime_controls are declared in this YAML. Ordinary variables stay fixed.'
                )
            );
            runtimeUi.status.textContent =
                'Designed for a minimal set (typically one or two controls).';
            return;
        }

        const planned = Studio.runtimeControlSession
            ? Studio.runtimeControlSession.getPlannedValues()
            : Object.fromEntries(
                  names.map((name) => [name, runtimeUi.definitions[name].default_value])
              );
        names.forEach((name) => {
            const def = runtimeUi.definitions[name];
            const row = el('div', 'alt-runtime-row');
            const label = el('div', 'alt-runtime-name');
            label.textContent = def.label || name;
            if (def.description) label.title = def.description;
            const unit = el('span', 'alt-runtime-unit', def.units || def.type);
            label.append(document.createTextNode(' '), unit);
            let input;
            if (def.type === 'boolean') {
                input = document.createElement('select');
                input.innerHTML =
                    '<option value="true">true</option><option value="false">false</option>';
                input.value = String(Boolean(planned[name]));
            } else if (def.type === 'enum') {
                input = document.createElement('select');
                (def.values || []).forEach((value) => {
                    const option = document.createElement('option');
                    option.value = JSON.stringify(value);
                    option.textContent = String(value);
                    input.appendChild(option);
                });
                input.value = JSON.stringify(planned[name]);
            } else {
                input = document.createElement('input');
                input.type = 'number';
                input.min = String(def.minimum);
                input.max = String(def.maximum);
                input.step = def.type === 'integer' ? '1' : 'any';
                input.value = String(planned[name]);
            }
            input.dataset.runtimeName = name;
            input.addEventListener('input', () => {
                runtimeUi.dirty = true;
                updateRuntimeUi();
            });
            row.append(label, input, el('span', 'alt-runtime-unit', 'planned'));
            runtimeUi.inputs.set(name, input);
            runtimeUi.body.appendChild(row);
        });

        const reason = document.createElement('input');
        reason.className = 'alt-runtime-reason';
        reason.placeholder = 'optional reason';
        reason.maxLength = 240;
        const apply = el('button', 'alt-runtime-apply', 'Apply');
        apply.type = 'button';
        apply.addEventListener('click', applyRuntimeChanges);
        const actions = el('div', 'alt-runtime-row');
        actions.append(reason, apply, el('span', 'alt-runtime-unit', 'next trial'));
        runtimeUi.body.appendChild(actions);
        runtimeUi.reason = reason;
        runtimeUi.apply = apply;
        updateRuntimeUi();
    }

    function runtimeValue(def, input) {
        if (def.type === 'boolean') return input.value === 'true';
        if (def.type === 'enum') return JSON.parse(input.value);
        if (!input.value.trim() || !input.validity.valid || !Number.isFinite(input.valueAsNumber)) {
            throw new Error((def.label || def.name) + ' requires a valid number in range.');
        }
        const value = input.valueAsNumber;
        return def.type === 'integer' ? Math.trunc(value) : value;
    }

    function updateRuntimeUi() {
        if (!runtimeUi.status) return;
        const session = Studio.runtimeControlSession;
        const running = Boolean(Studio.session && Studio.session.running);
        if (runtimeUi.apply) runtimeUi.apply.disabled = !(session && running && runtimeUi.dirty);
        if (!Object.keys(runtimeUi.definitions).length) return;
        if (Studio.runtimeControlEndedWithPending) {
            runtimeUi.status.textContent =
                'Not applied · the run ended before another trial boundary.';
            return;
        }
        if (!session) {
            runtimeUi.status.textContent = 'Defaults shown · Apply becomes available during a run.';
        } else if (session.hasPending()) {
            runtimeUi.status.innerHTML =
                '<span class="alt-runtime-pending">Pending · applies atomically at next trial</span>';
        } else if (running) {
            runtimeUi.status.textContent = 'Active · changes persist until Apply is used again.';
        } else {
            runtimeUi.status.textContent =
                'Run ended · complete resolved parameters are in the log.';
        }
    }

    function applyRuntimeChanges() {
        const session = Studio.runtimeControlSession;
        if (!session || !Studio.session || !Studio.session.running) return;
        try {
            const planned = session.getPlannedValues();
            const changes = {};
            for (const [name, input] of runtimeUi.inputs) {
                const value = runtimeValue(runtimeUi.definitions[name], input);
                if (!Object.is(value, planned[name])) changes[name] = value;
            }
            const operator = (($('mExp') && $('mExp').value) || 'Arena Studio operator').trim();
            const requested = session.stageApply(changes, {
                operator,
                reason: runtimeUi.reason && runtimeUi.reason.value
            });
            if (Studio.activeRunLog) {
                Studio.activeRunLog.event('runtime-control-requested', { request: requested });
            }
            const bridge = Studio.session.bridge;
            if (bridge && bridge.logging && bridge.log) bridge.log(requested);
            if (Studio.rawLog) {
                Studio.rawLog(
                    'runtime Apply queued for next trial: ' +
                        requested.changes
                            .map((c) => c.variable + ' ' + c.old_value + '→' + c.new_value)
                            .join(', '),
                    'info'
                );
            }
            runtimeUi.dirty = false;
            if (runtimeUi.reason) runtimeUi.reason.value = '';
            updateRuntimeUi();
        } catch (error) {
            runtimeUi.status.textContent = error && error.message ? error.message : String(error);
        }
    }

    function installRuntimeHooks() {
        Studio.prepareRuntimeControls = function (runId) {
            const doc = Studio.currentDoc;
            const protocol = doc && doc.experiment;
            Studio.runtimeControlSession = null;
            Studio.runtimeControlEndedWithPending = null;
            if (!protocol || !RuntimeControls) return null;
            const report = RuntimeControls.validateRuntimeControls(protocol);
            if (!report.ok || !Object.keys(report.controls || {}).length) {
                renderRuntimeControls(true);
                return null;
            }
            const yamlHash = doc.sha256 || 'unhashed-' + String(doc.filename || 'protocol');
            const session = RuntimeControls.createRuntimeControlSession({
                protocol,
                sessionId: runId,
                yamlId: doc.filename || 'protocol.yaml',
                yamlHash
            });
            Studio.runtimeControlSession = session;
            if (Studio.activeRunLog) {
                Studio.activeRunLog.meta.runtime_controls = session.getControlDefinitions();
                Studio.activeRunLog.meta.runtime_control_initial_values = session.getActiveValues();
                Studio.activeRunLog.meta.runtime_control_yaml_id = doc.filename || null;
                Studio.activeRunLog.meta.runtime_control_yaml_hash = yamlHash;
            }
            renderRuntimeControls(true);
            return session;
        };

        Studio.resolveRuntimeCondition = async function (conditionName, context) {
            const session = Studio.runtimeControlSession;
            if (!session) return context.condition;
            const record = session.beginTrial({
                trialIndex: context.index,
                trialId: 'trial-' + String(context.index + 1).padStart(4, '0'),
                conditionName
            });
            return {
                condition: Object.assign({}, context.condition, {
                    commands: record.resolved_commands
                }),
                runtimeRecord: record
            };
        };

        if (Studio.session && Studio.session.on) {
            Studio.session.on('runstatus', (status) => {
                if (!status) return;
                if (
                    status.phase === 'runtime-control-applied' ||
                    status.phase === 'trial-resolved'
                ) {
                    const session = Studio.runtimeControlSession;
                    if (session) {
                        const planned = session.getPlannedValues();
                        for (const [name, input] of runtimeUi.inputs)
                            input.value =
                                runtimeUi.definitions[name].type === 'enum'
                                    ? JSON.stringify(planned[name])
                                    : String(planned[name]);
                    }
                    runtimeUi.dirty = false;
                }
                updateRuntimeUi();
            });
        }

        const originalRunStatus = Studio.onRunStatus;
        if (typeof originalRunStatus === 'function' && !originalRunStatus._arenaAltRuntimeWrapped) {
            const wrappedStatus = function (status) {
                if (
                    status &&
                    (status.phase === 'sequence-complete' || status.phase === 'aborted') &&
                    Studio.runtimeControlSession &&
                    Studio.runtimeControlSession.hasPending()
                ) {
                    const pending = Studio.runtimeControlSession.getPendingRequests();
                    Studio.runtimeControlEndedWithPending = pending;
                    const payload = {
                        reason: 'run-ended-before-next-trial',
                        pending_requests: pending
                    };
                    if (Studio.activeRunLog)
                        Studio.activeRunLog.event('runtime-control-unapplied', payload);
                    const bridge = Studio.session && Studio.session.bridge;
                    if (bridge && bridge.logging && bridge.log) {
                        bridge.log(
                            Object.assign({ event: 'runtime_control_apply_unapplied' }, payload)
                        );
                    }
                    if (Studio.rawLog)
                        Studio.rawLog(
                            'runtime Apply was not used: run ended before another trial',
                            'warn'
                        );
                }
                return originalRunStatus.apply(this, arguments);
            };
            wrappedStatus._arenaAltRuntimeWrapped = true;
            Studio.onRunStatus = wrappedStatus;
        }

        const originalSync = Studio.syncFromEditor;
        if (typeof originalSync === 'function' && !originalSync._arenaAltWrapped) {
            const wrapped = async function () {
                const result = await originalSync.apply(this, arguments);
                renderRuntimeControls();
                return result;
            };
            wrapped._arenaAltWrapped = true;
            Studio.syncFromEditor = wrapped;
        }
    }

    function setReplayStatus(message, isError) {
        if (!replay.ui.status) return;
        replay.ui.status.textContent = message;
        replay.ui.status.style.color = isError ? 'var(--danger)' : '';
    }

    function makeViewerSession() {
        return 'alt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function bindViewerMessages() {
        if (replay.viewerMessageBound) return;
        replay.viewerMessageBound = true;
        window.addEventListener('message', (event) => {
            if (!replay.viewer || !ViewerProtocol || !ViewerProtocol.validateFromViewer) return;
            const validation = ViewerProtocol.validateFromViewer(event, {
                viewerWindow: replay.viewer,
                expectedOrigin: replay.viewerOrigin,
                sessionId: replay.viewerSession
            });
            if (!validation.ok) return;
            if (validation.message.type === 'ready') {
                replay.viewerReady = true;
                sendViewerInit();
            } else if (validation.message.type === 'close') {
                replay.viewer = null;
                replay.viewerReady = false;
            }
        });
    }

    function openViewer(userGesture) {
        if (!ViewerProtocol || !Studio.replayActive) return null;
        if (replay.viewer && !replay.viewer.closed) {
            replay.viewer.focus();
            if (replay.viewerReady) sendViewerInit();
            return replay.viewer;
        }
        replay.viewerSession = makeViewerSession();
        replay.viewerOrigin = location.origin === 'null' ? 'null' : location.origin;
        const target =
            'arena_replay_viewer.html?session=' +
            encodeURIComponent(replay.viewerSession) +
            '&origin=' +
            encodeURIComponent(replay.viewerOrigin);
        replay.viewerReady = false;
        replay.viewer = window.open(
            target,
            'arena-studio-alt-replay-viewer',
            'popup=yes,width=880,height=720,resizable=yes'
        );
        if (!replay.viewer) {
            setReplayStatus(
                'Replay is running; the browser blocked the optional 3D window.',
                false
            );
        } else if (userGesture) {
            replay.viewer.focus();
        }
        bindViewerMessages();
        return replay.viewer;
    }

    function viewerTargetOrigin() {
        return replay.viewerOrigin === 'null' ? '*' : replay.viewerOrigin;
    }

    function postViewer(type, payload) {
        if (!replay.viewerReady || !replay.viewer || replay.viewer.closed || !ViewerProtocol)
            return false;
        try {
            replay.viewer.postMessage(
                ViewerProtocol.makeMessage(
                    ViewerProtocol.OPENER_SOURCE,
                    type,
                    replay.viewerSession,
                    payload || {}
                ),
                viewerTargetOrigin()
            );
            return true;
        } catch (_) {
            return false;
        }
    }

    function arenaConfigName() {
        return (
            (Studio.currentRig && Studio.currentRig.arenaConfig) ||
            (Studio.currentDoc && Studio.currentDoc.rig && Studio.currentDoc.rig.arenaConfig) ||
            'G6_2x10'
        );
    }

    function viewerState() {
        return {
            elapsedMs: replay.currentMs - replay.startMs,
            condition: replay.condition,
            frame: replay.frame,
            ledOn: replay.ledOn,
            displayMode: replay.displayMode
        };
    }

    function sendViewerInit() {
        const payload = {
            arenaConfigName: arenaConfigName(),
            patternName: replay.trial && replay.trial.patternName,
            state: viewerState()
        };
        const cached = replay.trial && replay.patternCache.get(replay.trial.patternName);
        if (cached && cached.bytes) payload.patternBytes = cached.bytes;
        else payload.pattern = null;
        postViewer('init', payload);
    }

    function sendViewerState() {
        postViewer('state', viewerState());
    }

    function closeViewer() {
        if (replay.viewer && !replay.viewer.closed) {
            postViewer('close', { reason: 'replay-stopped' });
            try {
                replay.viewer.close();
            } catch (_) {}
        }
        replay.viewer = null;
        replay.viewerReady = false;
    }

    function trialForCondition(name) {
        const exp = Studio.currentDoc && Studio.currentDoc.experiment;
        const condition = exp && (exp.conditions || []).find((item) => item.name === name);
        const command =
            condition &&
            (condition.commands || []).find(
                (item) => item.type === 'controller' && item.command_name === 'trialParams'
            );
        if (!command)
            return { condition: name, patternName: null, mode: 0, frameRate: 0, frameIndex: 0 };
        return {
            condition: name,
            patternName: command.pattern || null,
            mode: Number(command.mode) || 2,
            frameRate: Number(command.frame_rate) || 0,
            frameIndex: Number(command.frame_index) || 0,
            startMs: replay.currentMs
        };
    }

    function asArrayBuffer(value) {
        if (value instanceof ArrayBuffer) return value.slice(0);
        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        return null;
    }

    function suppliedPatternSource(name) {
        const raw = String(name || '')
            .split(/[\\/]/)
            .pop()
            .toLowerCase();
        const file =
            replay.patternFiles.get(raw) || replay.patternFiles.get(patternLogicalName(raw));
        return file ? () => file.arrayBuffer() : null;
    }

    function repoPatternSource(name) {
        const raw = String(name || '')
            .split(/[\\/]/)
            .pop()
            .toLowerCase();
        return (
            replay.repoPatternSources.get(raw) ||
            replay.repoPatternSources.get(patternLogicalName(raw)) ||
            null
        );
    }

    async function fetchDeclaredPattern(name) {
        const exp = Studio.currentDoc && Studio.currentDoc.experiment;
        const library = exp && exp.experiment_info && exp.experiment_info.pattern_library;
        if (typeof library !== 'string' || !library.trim()) return null;
        const safe = library.trim().replace(/^\.\//, '').replace(/\/+$/, '');
        if (!safe || safe.includes('..') || /^[a-z]+:/i.test(safe) || safe.startsWith('/'))
            return null;
        const raw = String(name || '')
            .split(/[\\/]/)
            .pop();
        const candidates = [raw];
        if (!/\.pat$/i.test(raw)) candidates.push(raw + '.pat');
        for (const filename of candidates) {
            try {
                const url = new URL(safe + '/' + filename, location.href);
                if (url.origin !== location.origin) continue;
                const response = await fetch(url.href);
                if (response.ok) return response.arrayBuffer();
            } catch (_) {}
        }
        return null;
    }

    async function loadReplayPattern(trial) {
        const token = ++replay.patternToken;
        replay.patternFrames = 0;
        replay.frame = Math.max(0, trial.frameIndex || 0);
        if (!trial.patternName) {
            if (replay.viewerReady)
                postViewer('pattern', {
                    pattern: null,
                    arenaConfigName: arenaConfigName(),
                    state: viewerState()
                });
            return;
        }
        let cached = replay.patternCache.get(trial.patternName);
        if (!cached) {
            // Replay source precedence is provenance-first. A stale catalog entry
            // from an earlier Studio document must not beat the selected YAML's
            // own pattern_library. If one source is missing or malformed, try the
            // next source instead of rendering a permanently blank arena.
            const sources = [
                suppliedPatternSource(trial.patternName),
                repoPatternSource(trial.patternName),
                Studio.currentDoc && Studio.currentDoc.experiment
                    ? () => fetchDeclaredPattern(trial.patternName)
                    : null,
                Studio.webBytesForName && Studio.webBytesForName(trial.patternName)
            ].filter(Boolean);
            for (const source of sources) {
                try {
                    const bytes = asArrayBuffer(await source());
                    const parsed =
                        bytes && window.PatParser && window.PatParser.parsePatFile(bytes);
                    if (bytes && parsed) {
                        cached = { bytes, parsed, frames: parsed.numFrames };
                        replay.patternCache.set(trial.patternName, cached);
                        break;
                    }
                } catch (_) {}
            }
        }
        if (token !== replay.patternToken || replay.trial !== trial) return;
        replay.patternFrames = (cached && cached.frames) || 0;
        if (replay.patternFrames) replay.frame = positiveModulo(replay.frame, replay.patternFrames);
        if (replay.viewerReady) {
            const payload = {
                patternName: trial.patternName,
                arenaConfigName: arenaConfigName(),
                state: viewerState()
            };
            if (cached && cached.bytes) payload.patternBytes = cached.bytes;
            else payload.pattern = null;
            postViewer('pattern', payload);
        }
    }

    function positiveModulo(value, base) {
        if (!(base > 0)) return Math.max(0, Math.floor(Number(value) || 0));
        return ((Math.floor(value) % base) + base) % base;
    }

    function updateOpenLoopFrame(ms) {
        const t = replay.trial;
        if (!t || t.mode !== 2 || !replay.patternFrames || !t.frameRate) return;
        const frames = ((ms - t.startMs) / 1000) * t.frameRate;
        replay.frame = positiveModulo(t.frameIndex + Math.floor(frames), replay.patternFrames);
    }

    function replaySelectorValue(value) {
        return String(value == null ? '' : value).replace(/["\\]/g, '\\$&');
    }

    function replayStepFromStatus(status, name) {
        const hasIndex = status && status.index != null;
        const index = hasIndex ? Number(status.index) : NaN;
        const nominal = Number.isInteger(index) && index >= 0 ? replay.sequenceSteps[index] : null;
        return Object.assign({}, nominal || {}, (status && status.step) || {}, {
            conditionName: name
        });
    }

    function scrollReplayRowIntoView(row, instant) {
        if (!row) return;
        try {
            row.scrollIntoView({
                block: 'nearest',
                behavior: instant ? 'auto' : 'smooth'
            });
        } catch (_) {}
    }

    // Mirror Classic's exact Runner row lookup. JSONL flattens `step` to a
    // condition name, so the logged run index is joined back to the protocol's
    // nominal flattened step. Randomized blocks still match by the logged name
    // inside the correct block, just as Classic's fallback does.
    function highlightReplayStep(step, instant) {
        document
            .querySelectorAll('.seqrow.active')
            .forEach((row) => row.classList.remove('active'));
        let row = null;
        if (step && typeof step === 'object') {
            const seqIndex = step.seqIdx;
            if (typeof seqIndex === 'number') {
                if (step.kind === 'ref') {
                    row = document.querySelector(
                        '.seqrow[data-seqidx="' + seqIndex + '"][data-role="ref"]'
                    );
                } else if (step.kind === 'iti') {
                    row = document.querySelector(
                        '.seqrow[data-seqidx="' + seqIndex + '"][data-role="iti"]'
                    );
                } else if (step.kind === 'block-trial') {
                    const base = '.seqrow[data-seqidx="' + seqIndex + '"][data-role="trial"]';
                    if (!step.randomize && typeof step.trialIdxInBlock === 'number') {
                        row = document.querySelector(
                            base + '[data-trialidx="' + step.trialIdxInBlock + '"]'
                        );
                    }
                    if (!row && step.conditionName) {
                        row = document.querySelector(
                            base + '[data-cond="' + replaySelectorValue(step.conditionName) + '"]'
                        );
                    }
                }
            }
        }
        if (!row) {
            const name = step && typeof step === 'object' ? step.conditionName : step;
            if (name) {
                row = document.querySelector(
                    '.seqrow[data-cond="' + replaySelectorValue(name) + '"]'
                );
            }
        }
        if (row) {
            row.classList.add('active');
            scrollReplayRowIntoView(row, instant);
        }
    }

    function updateReplayStepVisual(status, instant) {
        if (status) {
            const name =
                (status.step && status.step.conditionName) ||
                status.condition ||
                status.conditionName ||
                replay.condition;
            replay.condition = name || '—';
            replay.step = replayStepFromStatus(status, replay.condition);
            if (status.index != null && Number.isInteger(Number(status.index)))
                replay.stepIndex = Number(status.index);
            if (status.total != null && Number.isFinite(Number(status.total)))
                replay.stepTotal = Number(status.total);
        }
        if (!replay.step || !replay.condition || replay.condition === '—') return;

        highlightReplayStep(replay.step, instant);
        const ordinal = replay.stepIndex == null ? null : replay.stepIndex + 1;
        const total = replay.stepTotal;
        const label =
            ordinal != null && total
                ? 'STEP ' + ordinal + ' / ' + total + ' · ' + replay.condition
                : 'STEP · ' + replay.condition;
        if (replay.ui.title) {
            replay.ui.title.textContent = label;
            replay.ui.title.title = replay.logFile ? replay.logFile.name : '';
        }
        const progress = ordinal != null && total ? Math.round((ordinal / total) * 100) : null;
        if (progress != null) {
            const bar = $('rpBar');
            const inlineBar = $('runInlineBar');
            if (bar) bar.style.width = progress + '%';
            if (inlineBar) inlineBar.style.width = progress + '%';
        }
        const stepReadout = $('rpStep');
        if (stepReadout && ordinal != null && total)
            stepReadout.textContent = 'step ' + ordinal + ' / ' + total;
        const inlineText = $('runInlineTxt');
        if (inlineText) inlineText.textContent = '▸ ' + replay.condition;
    }

    function processReplayItem(item) {
        replay.currentMs = item.ms;
        if (Scope.setReplayClock) Scope.setReplayClock(item.ms);
        if (item.kind === 'sample') {
            Scope.pushSample(Object.assign({}, item.sample, { __replay: true }));
            if (
                replay.trial &&
                (replay.trial.mode === 3 || replay.trial.mode === 4) &&
                Number.isFinite(Number(item.sample.idx))
            ) {
                replay.frame = positiveModulo(
                    Number(item.sample.idx),
                    replay.patternFrames || Number.MAX_SAFE_INTEGER
                );
            }
        } else if (item.kind === 'frame') {
            replay.frame = positiveModulo(
                item.index,
                replay.patternFrames || Number.MAX_SAFE_INTEGER
            );
        } else if (item.kind === 'status') {
            const status = Object.assign({}, item.status, { replayMs: item.ms });
            Scope.onRunStatus(status);
            const name =
                (status.step && status.step.conditionName) ||
                status.condition ||
                status.conditionName ||
                null;
            if (status.phase === 'step-start' && name) {
                updateReplayStepVisual(status, replay.seeking);
                replay.trial = trialForCondition(name);
                replay.trial.startMs = item.ms;
                replay.frame = replay.trial.frameIndex;
                if (!replay.seeking) loadReplayPattern(replay.trial);
            }
            if (status.phase === 'command' && status.op === 'trialParams' && replay.trial) {
                const p = status.params || {};
                if (Number.isFinite(Number(p.mode))) replay.trial.mode = Number(p.mode);
                if (Number.isFinite(Number(p.frameRate)))
                    replay.trial.frameRate = Number(p.frameRate);
                if (Number.isFinite(Number(p.initPos))) replay.trial.frameIndex = Number(p.initPos);
                replay.trial.startMs = item.ms;
                replay.displayMode = 'pattern';
            } else if (status.phase === 'command' && status.op === 'setAnalogOut') {
                const mv = Number(status.value);
                replay.ledOn = mv > 0 && mv < LED_OFF_MV;
            } else if (status.phase === 'command' && status.op === 'setFramePosition') {
                replay.frame = positiveModulo(
                    Number(status.value),
                    replay.patternFrames || Number.MAX_SAFE_INTEGER
                );
            } else if (status.phase === 'command' && status.op === 'allOn') {
                replay.displayMode = 'all-on';
            } else if (
                status.phase === 'command' &&
                (status.op === 'allOff' || status.op === 'stopDisplay')
            ) {
                replay.displayMode = 'off';
                replay.ledOn = false;
            } else if (status.phase === 'led-activation') {
                replay.ledOn = Boolean(status.on);
            } else if (status.phase === 'sequence-complete' || status.phase === 'aborted') {
                replay.displayMode = 'off';
                replay.ledOn = false;
            }
        }
        updateOpenLoopFrame(item.ms);
    }

    function resetReplayProjection() {
        Scope.setReplayMode(true);
        Scope.start();
        replay.index = 0;
        replay.condition = '—';
        replay.step = null;
        replay.stepIndex = null;
        replay.stepTotal = null;
        replay.trial = null;
        replay.ledOn = false;
        replay.displayMode = 'off';
        replay.frame = 0;
        replay.patternFrames = 0;
        replay.patternToken++;
        document
            .querySelectorAll('.seqrow.active')
            .forEach((row) => row.classList.remove('active'));
    }

    function primeReplayState(cutoff) {
        const events = (replay.parsed && replay.parsed.events) || [];
        for (const event of events) {
            if (event.ms >= cutoff) break;
            const status = event.status || {};
            const name =
                (status.step && status.step.conditionName) ||
                status.condition ||
                status.conditionName ||
                null;
            if (status.phase === 'step-start' && name) {
                replay.condition = name;
                replay.step = replayStepFromStatus(status, name);
                if (status.index != null && Number.isInteger(Number(status.index)))
                    replay.stepIndex = Number(status.index);
                if (status.total != null && Number.isFinite(Number(status.total)))
                    replay.stepTotal = Number(status.total);
                replay.trial = trialForCondition(name);
                replay.trial.startMs = event.ms;
                replay.frame = replay.trial.frameIndex;
            }
            if (status.phase === 'command' && status.op === 'trialParams' && replay.trial) {
                const p = status.params || {};
                if (Number.isFinite(Number(p.mode))) replay.trial.mode = Number(p.mode);
                if (Number.isFinite(Number(p.frameRate)))
                    replay.trial.frameRate = Number(p.frameRate);
                if (Number.isFinite(Number(p.initPos))) replay.trial.frameIndex = Number(p.initPos);
                replay.trial.startMs = event.ms;
                replay.displayMode = 'pattern';
            } else if (status.phase === 'command' && status.op === 'setAnalogOut') {
                const mv = Number(status.value);
                replay.ledOn = mv > 0 && mv < LED_OFF_MV;
            } else if (status.phase === 'command' && status.op === 'setFramePosition') {
                replay.frame = Math.max(0, Number(status.value) || 0);
            } else if (status.phase === 'command' && status.op === 'allOn') {
                replay.displayMode = 'all-on';
            } else if (
                (status.phase === 'command' &&
                    (status.op === 'allOff' || status.op === 'stopDisplay')) ||
                status.phase === 'sequence-complete' ||
                status.phase === 'aborted'
            ) {
                replay.displayMode = 'off';
                replay.ledOn = false;
            } else if (status.phase === 'led-activation') {
                replay.ledOn = Boolean(status.on);
            }
        }
        const samples = (replay.parsed && replay.parsed.samples) || [];
        let lo = 0,
            hi = samples.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (samples[mid].ms < cutoff) lo = mid + 1;
            else hi = mid;
        }
        const prior = lo > 0 ? samples[lo - 1] : null;
        if (
            prior &&
            replay.trial &&
            (replay.trial.mode === 3 || replay.trial.mode === 4) &&
            Number.isFinite(Number(prior.idx))
        )
            replay.frame = Math.max(0, Number(prior.idx));
    }

    function seekReplay(targetMs) {
        if (!replay.timeline.length) return;
        const target = Math.max(
            replay.startMs,
            Math.min(replay.endMs, Number(targetMs) || replay.startMs)
        );
        resetReplayProjection();
        const spanSeconds = Number(($('scopeSpan') || {}).value) || 60;
        const cutoff = Math.max(replay.startMs, target - spanSeconds * 1000 - 1500);
        primeReplayState(cutoff);
        replay.index = ReplayLib.seekIndex(replay.timeline, cutoff);
        if (replay.trial && cutoff > replay.startMs) {
            Scope.onRunStatus({
                phase: 'step-start',
                step: { conditionName: replay.condition },
                replayMs: cutoff
            });
            Scope.onRunStatus({
                phase: 'trial-running',
                params: {
                    mode: replay.trial.mode,
                    frameRate: replay.trial.frameRate,
                    initPos: replay.trial.frameIndex
                },
                replayMs: cutoff
            });
            if (replay.ledOn)
                Scope.onRunStatus({ phase: 'led-activation', on: true, replayMs: cutoff });
        }
        replay.seeking = true;
        while (
            replay.index < replay.timeline.length &&
            replay.timeline[replay.index].ms <= target
        ) {
            processReplayItem(replay.timeline[replay.index++]);
        }
        replay.seeking = false;
        // If the seek window began in the middle of a long step there was no
        // step-start item to process. Restore the primed row and keep it visible.
        updateReplayStepVisual(null, true);
        replay.currentMs = target;
        if (Scope.setReplayClock) Scope.setReplayClock(target);
        updateOpenLoopFrame(target);
        updateReplayTransport();
        syncReplayPauseUi();
        if (replay.trial) loadReplayPattern(replay.trial);
        sendViewerState();
    }

    function setReplayFrozen(on) {
        const targets = document.querySelectorAll(
            '.alt-top-primary, .run-main, .meta-panel, .edit-view, .console-view, ' +
                '.picker-overlay, .rlup-overlay'
        );
        if (on) {
            replay.frozen.clear();
            targets.forEach((node) => {
                replay.frozen.set(node, node.hasAttribute('inert'));
                node.setAttribute('inert', '');
            });
        } else {
            for (const [node, wasInert] of replay.frozen) {
                if (!wasInert) node.removeAttribute('inert');
            }
            replay.frozen.clear();
        }
    }

    function updateReplayTransport() {
        const elapsed = Math.max(0, replay.currentMs - replay.startMs);
        const duration = Math.max(0, replay.endMs - replay.startMs);
        if (replay.ui.slider) replay.ui.slider.value = String(elapsed);
        if (replay.ui.clock)
            replay.ui.clock.textContent = formatClock(elapsed) + ' / ' + formatClock(duration);
    }

    function syncReplayPauseUi() {
        if (!replay.ui.pause) return;
        const atEnd = replay.endMs > replay.startMs && replay.currentMs >= replay.endMs;
        replay.ui.pause.textContent = replay.paused ? (atEnd ? '↻ Replay' : '▶ Resume') : 'Ⅱ Pause';
        replay.ui.pause.setAttribute('aria-pressed', String(replay.paused));
        replay.ui.pause.disabled =
            !Studio.replayActive || Boolean(replay.ui.slider && replay.ui.slider.disabled);
        replay.ui.pause.title = replay.paused
            ? atEnd
                ? 'Replay again from the beginning'
                : 'Resume from the current replay time'
            : 'Pause without ending this replay';
    }

    function setReplayPaused(on) {
        if (!Studio.replayActive) return;
        const pause = !!on;
        if (pause) {
            replay.paused = true;
            replay.playing = false;
            replay.lastWall = 0;
            if (replay.raf) cancelAnimationFrame(replay.raf);
            replay.raf = null;
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(true);
        } else {
            if (replay.currentMs >= replay.endMs) seekReplay(replay.startMs);
            replay.paused = false;
            replay.playing = true;
            replay.lastWall = performance.now();
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
            ensureReplayLoop();
        }
        syncReplayPauseUi();
        if (replay.ui.syncSound) replay.ui.syncSound();
    }

    function toggleReplayPause() {
        setReplayPaused(!replay.paused);
    }

    function ensureReplayLoop() {
        if (!Studio.replayActive || replay.raf) return;
        replay.raf = requestAnimationFrame(replayTick);
    }

    function replayTick(now) {
        replay.raf = null;
        if (!Studio.replayActive || !replay.playing) return;
        if (!replay.lastWall) replay.lastWall = now;
        const delta = Math.min(250, Math.max(0, now - replay.lastWall));
        replay.lastWall = now;
        const target = Math.min(replay.endMs, replay.currentMs + delta * replay.speed);
        while (
            replay.index < replay.timeline.length &&
            replay.timeline[replay.index].ms <= target
        ) {
            processReplayItem(replay.timeline[replay.index++]);
        }
        replay.currentMs = target;
        if (Scope.setReplayClock) Scope.setReplayClock(target);
        updateOpenLoopFrame(target);
        updateReplayTransport();
        sendViewerState();
        if (target >= replay.endMs) {
            replay.playing = false;
            replay.paused = true;
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(true);
            syncReplayPauseUi();
            if (replay.ui.syncSound) replay.ui.syncSound();
        } else ensureReplayLoop();
    }

    async function startReplay() {
        if (Studio.replayActive || !replay.yamlFile || !replay.logFile) return;
        if (replay.sourcePending.yaml || replay.sourcePending.log) {
            setReplayStatus('Wait for the selected repo files to finish loading.', true);
            return;
        }
        if (Studio.session && Studio.session.running) {
            setReplayStatus('Stop the live experiment before entering replay.', true);
            return;
        }
        const bridge = Studio.session && Studio.session.bridge;
        if (bridge && bridge.apply) {
            setReplayStatus(
                'Turn off FicTrac closed-loop “activate” before entering replay.',
                true
            );
            return;
        }
        if (!Studio.session || typeof Studio.session.setOutputInhibited !== 'function') {
            setReplayStatus(
                'Replay safety interlock is unavailable; reload this Studio build.',
                true
            );
            return;
        }

        try {
            // Invalidate any picker callback that was opened before Start. The
            // source setters also refuse mutations while replay is active.
            replay.sourceTokens.yaml++;
            replay.sourceTokens.log++;
            // Latch + inert are synchronous and precede every file read. No live
            // control can slip into the parse window after the initial check.
            Studio.session.setOutputInhibited('Arena Studio replay');
            Studio.replayActive = true;
            replay.paused = false;
            updateReplayStartAvailability();
            // Replay audio is always opt-in from the pinned transport. Besides
            // avoiding surprise audio, the explicit click satisfies Web Audio's
            // user-gesture requirement in every supported browser.
            if (Scope.closeSoundSettings) Scope.closeSoundSettings();
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
            if (Scope.setSoundEnabled) Scope.setSoundEnabled(false);
            const token = ++replay.loadToken;
            setReplayFrozen(true);
            document.body.classList.add('alt-replay-active');
            replay.ui.transport.hidden = false;
            replay.ui.title.textContent = 'loading replay…';
            replay.ui.slider.disabled = true;
            replay.ui.slider.min = '0';
            replay.ui.slider.max = '0';
            replay.ui.slider.value = '0';
            updateReplayTransport();
            syncReplayPauseUi();

            // Popup creation must stay inside the user gesture. It waits for the
            // validated ready handshake while the two local files are parsed.
            if (replay.ui.viewerCheck && replay.ui.viewerCheck.checked) openViewer(true);
            const [yamlText, logText] = await Promise.all([
                replay.yamlFile.text(),
                replay.logFile.text()
            ]);
            if (token !== replay.loadToken || !Studio.replayActive) return;
            const yamlHash = await sha256(yamlText);
            if (token !== replay.loadToken || !Studio.replayActive) return;
            const parsed = ReplayLib.parseRunLog(logText);
            const timeline = ReplayLib.buildTimeline(parsed);
            if (!timeline.length)
                throw new Error('The run log contains no replayable events or samples.');
            const protocolOptions = { landIn: 'run' };
            if (replay.yamlRepoPath && replay.yamlRepo) {
                protocolOptions.repoRef = {
                    repo: replay.yamlRepo.full,
                    path: replay.yamlRepoPath
                };
            }
            const loaded = await Studio.loadProtocol(
                yamlText,
                replay.yamlFile.name,
                'replay',
                protocolOptions
            );
            if (token !== replay.loadToken || !Studio.replayActive) return;
            if (!loaded) throw new Error('The YAML could not be loaded.');

            replay.parsed = parsed;
            replay.timeline = timeline;
            replay.sequenceSteps =
                window.ArenaRunnerG6 && Studio.currentDoc && Studio.currentDoc.experiment
                    ? window.ArenaRunnerG6.flattenStructure(Studio.currentDoc.experiment).steps
                    : [];
            replay.index = 0;
            replay.startMs = timeline.startMs;
            replay.endMs = timeline.endMs;
            replay.currentMs = replay.startMs;
            replay.speed = Number(replay.ui.speedLoader.value) || 1;
            replay.patternCache.clear();
            replay.ui.speed.value = String(replay.speed);
            replay.ui.slider.min = '0';
            replay.ui.slider.max = String(Math.max(0, timeline.durationMs));
            replay.ui.slider.value = '0';
            replay.ui.slider.disabled = false;
            replay.ui.title.textContent = replay.logFile.name;

            const loggedHash = normalizeHash(parsed.protocolSha256);
            const mismatch = loggedHash && yamlHash && loggedHash !== normalizeHash(yamlHash);
            setReplayStatus(
                mismatch
                    ? 'Warning: YAML SHA-256 differs from this log; replaying the supplied pair.'
                    : 'Replay loaded · ' +
                          parsed.samples.length +
                          ' behavior samples · ' +
                          parsed.events.length +
                          ' events.',
                mismatch
            );

            if (Studio.setDockView) Studio.setDockView('scope');
            seekReplay(replay.startMs);
            replay.paused = false;
            replay.playing = true;
            replay.lastWall = performance.now();
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
            syncReplayPauseUi();
            ensureReplayLoop();
            if (replay.viewerReady) sendViewerInit();
        } catch (error) {
            setReplayStatus(error && error.message ? error.message : String(error), true);
            stopReplay();
        }
    }

    function stopReplay() {
        replay.loadToken++;
        replay.playing = false;
        replay.paused = false;
        if (replay.raf) cancelAnimationFrame(replay.raf);
        if (replay.seekRaf) cancelAnimationFrame(replay.seekRaf);
        replay.raf = null;
        replay.seekRaf = null;
        replay.displayMode = 'off';
        replay.ledOn = false;
        replay.step = null;
        replay.stepIndex = null;
        replay.stepTotal = null;
        replay.sequenceSteps = [];
        sendViewerState();
        closeViewer();
        Studio.replayActive = false;
        updateReplayStartAvailability();
        document.body.classList.remove('alt-replay-active');
        setReplayFrozen(false);
        if (replay.ui.transport) replay.ui.transport.hidden = true;
        if (replay.ui.slider) replay.ui.slider.disabled = false;
        if (Scope.closeSoundSettings) Scope.closeSoundSettings();
        if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
        if (Scope.setSoundEnabled) Scope.setSoundEnabled(false);
        if (Scope.setReplayMode) Scope.setReplayMode(false);
        syncReplayPauseUi();
        document
            .querySelectorAll('.seqrow.active')
            .forEach((row) => row.classList.remove('active'));
        if (Studio.session && Studio.session.setOutputInhibited) {
            try {
                Studio.session.setOutputInhibited(null);
            } catch (_) {}
        }
    }

    function installUnloadSafety() {
        window.addEventListener('pagehide', () => {
            replay.loadToken++;
            replay.playing = false;
            replay.paused = false;
            if (replay.raf) cancelAnimationFrame(replay.raf);
            replay.displayMode = 'off';
            replay.ledOn = false;
            if (Scope.closeSoundSettings) Scope.closeSoundSettings();
            if (Scope.setSoundSuspended) Scope.setSoundSuspended(false);
            if (Scope.setSoundEnabled) Scope.setSoundEnabled(false);
            sendViewerState();
            closeViewer();
            setReplayFrozen(false);
            if (Studio.session && Studio.session.setOutputInhibited) {
                try {
                    Studio.session.setOutputInhibited(null);
                } catch (_) {}
            }
        });
    }

    function init() {
        installIdentityAndTheme();
        installTopbar();
        installRunMode();
        installReplayTransport();
        installScopeControls();
        installRuntimeCard();
        installRuntimeHooks();
        installUnloadSafety();
        renderRuntimeControls(true);
        window.ArenaStudioAlt = {
            startReplay,
            stopReplay,
            setReplayPaused,
            toggleReplayPause,
            seekReplay,
            openViewer,
            replay,
            renderRuntimeControls
        };
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
