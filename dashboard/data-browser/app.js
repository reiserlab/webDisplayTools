'use strict';

const A = window.DashboardAnalysis;
const P = window.DashboardPlots;
const G = window.DashboardGitHub;
const ANALYSIS_AXES_KEY = 'dashboard_analysis_axes';

const state = {
    catalog: [],
    runs: new Map(),
    selectedKeys: new Set(),
    focusKey: '',
    mode: 'single',
    pages: [],
    plotIndex: 0,
    renderedRuns: [],
    analysisAxes: {
        mode: 'manual',
        turningLimit: 300,
        forwardMin: 0,
        forwardMax: 25
    },
    github: {
        branch: 'main',
        user: null,
        repo: '',
        rootItems: [],
        directories: [],
        selectedFolders: []
    },
    viewStart: 0,
    viewWindow: 30,
    traceSet: 'behavior',
    scope: {
        autoY: true,
        smoothWindowS: 0.5,
        ballDiameterMm: 9,
        fixed: { turning: null, forward: null },
        heldScale: {}
    }
};

const els = Object.fromEntries(
    [
        'statusStrip',
        'statusText',
        'courseRepoLink',
        'githubWho',
        'fileInput',
        'urlInput',
        'loadUrlButton',
        'githubRepoInput',
        'githubSignInButton',
        'githubSignOutButton',
        'chooseRigsButton',
        'browseGithubButton',
        'rigSelectionSummary',
        'rigDialog',
        'rigDialogRepo',
        'rigDialogCount',
        'rigFolderList',
        'rigSelectAllButton',
        'rigClearAllButton',
        'rigDialogCloseButton',
        'rigCancelButton',
        'rigApplyButton',
        'repoBaseInput',
        'scanLocalButton',
        'singleModeButton',
        'groupModeButton',
        'focusRunSelect',
        'showIndividualsInput',
        'individualsLabel',
        'renderSelectionButton',
        'groupControls',
        'protocolFilter',
        'genotypeFilter',
        'sexFilter',
        'showAllRunsInput',
        'selectVisibleButton',
        'clearSelectionButton',
        'catalogStatus',
        'catalogSearchInput',
        'runCatalog',
        'metricsGrid',
        'timeReadout',
        'windowReadout',
        'stepBackButton',
        'stepForwardButton',
        'scopeSmoothWin',
        'windowSelect',
        'traceSetSelect',
        'scopeBallDia',
        'scopeTurnLim',
        'scopeFwdLim',
        'scopeAutoY',
        'scopeCanvas',
        'timeSlider',
        'plotTitle',
        'plotDescription',
        'previousPlotButton',
        'plotSelect',
        'nextPlotButton',
        'downloadSvgButton',
        'downloadPngButton',
        'downloadPlotCsvButton',
        'plotSourceLink',
        'analysisAxisMode',
        'analysisTurnLimit',
        'analysisForwardMin',
        'analysisForwardMax',
        'applyAnalysisAxesButton',
        'fitAnalysisAxesButton',
        'analysisContext',
        'analysisWarnings',
        'plotArea',
        'downloadFramesCsvButton',
        'metadataSummary',
        'metadataRaw',
        'stepCount',
        'stepsTable'
    ].map((id) => [id, document.getElementById(id)])
);

function setStatus(kind, text) {
    els.statusStrip.className = `status-strip ${kind || ''}`.trim();
    els.statusText.textContent = text;
}

function escapeHtml(value) {
    return A.safeText(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatNumber(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : '';
}

function safeFilename(value) {
    return (
        A.safeText(value)
            .replace(/[^A-Za-z0-9_.-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'plot'
    );
}

function csvValue(value) {
    const text = A.safeText(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadText(text, filename, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    URL.revokeObjectURL(link.href);
    link.remove();
}

function rowsToCsv(rows, metadata) {
    const output = [];
    for (const [key, value] of Object.entries(metadata || {}))
        output.push(`# ${key}: ${A.safeText(value)}`);
    if (!rows.length) return output.join('\n');
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    output.push(headers.join(','));
    for (const row of rows)
        output.push(headers.map((header) => csvValue(row[header] ?? '')).join(','));
    return output.join('\n');
}

function descriptorByKey(key) {
    return state.catalog.find((descriptor) => descriptor.key === key) || null;
}

function focusedRun() {
    return state.focusKey ? state.runs.get(state.focusKey) || null : null;
}

function rigName(descriptor) {
    return A.safeText(descriptor && (descriptor.folder || descriptor.bench)) || 'unassigned';
}

function experimenterName(descriptor) {
    return (
        A.safeText(descriptor && descriptor.experimenter)
            .replaceAll('_', ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Unknown experimenter'
    );
}

function updateRigSelectionUi() {
    const selected = state.github.selectedFolders;
    const label = selected.length
        ? `Rig folders: ${selected.join(', ')}`
        : G.currentToken()
          ? 'Rig folders: choose folders'
          : 'Rig folders: sign in to choose';
    els.rigSelectionSummary.textContent = label;
    els.rigSelectionSummary.title = label;
    els.browseGithubButton.textContent = selected.length
        ? 'Refresh selected rigs'
        : 'Browse private repo';
}

function resetGithubFolderState() {
    state.github.repo = '';
    state.github.rootItems = [];
    state.github.directories = [];
    state.github.selectedFolders = [];
    updateRigSelectionUi();
}

function analysisAxisBuildOptions() {
    if (state.analysisAxes.mode !== 'manual') {
        return { axisRanges: null, useCourseAxisFloor: false };
    }
    return {
        axisRanges: {
            turning: [-state.analysisAxes.turningLimit, state.analysisAxes.turningLimit],
            forward: [state.analysisAxes.forwardMin, state.analysisAxes.forwardMax]
        },
        useCourseAxisFloor: false
    };
}

function analysisAxisSummary() {
    return state.analysisAxes.mode === 'manual'
        ? `axes turn +/-${state.analysisAxes.turningLimit} deg/s, forward ${state.analysisAxes.forwardMin} to ${state.analysisAxes.forwardMax} mm/s`
        : 'axes fit to selected data';
}

function updateAnalysisAxisUi() {
    els.analysisTurnLimit.value = String(state.analysisAxes.turningLimit);
    els.analysisForwardMin.value = String(state.analysisAxes.forwardMin);
    els.analysisForwardMax.value = String(state.analysisAxes.forwardMax);
    const manual = state.analysisAxes.mode === 'manual';
    els.analysisAxisMode.textContent = manual ? 'Manual' : 'Fit selected';
    els.applyAnalysisAxesButton.classList.toggle('primary', manual);
    els.fitAnalysisAxesButton.classList.toggle('primary', !manual);
}

function saveAnalysisAxes() {
    localStorage.setItem(ANALYSIS_AXES_KEY, JSON.stringify(state.analysisAxes));
}

function loadAnalysisAxes() {
    try {
        const saved = JSON.parse(localStorage.getItem(ANALYSIS_AXES_KEY) || '{}');
        const turningLimit = Number(saved.turningLimit);
        const forwardMin = Number(saved.forwardMin);
        const forwardMax = Number(saved.forwardMax);
        if (Number.isFinite(turningLimit) && turningLimit > 0)
            state.analysisAxes.turningLimit = turningLimit;
        if (Number.isFinite(forwardMin) && Number.isFinite(forwardMax) && forwardMax > forwardMin) {
            state.analysisAxes.forwardMin = forwardMin;
            state.analysisAxes.forwardMax = forwardMax;
        }
        if (saved.mode === 'fit') state.analysisAxes.mode = 'fit';
    } catch (_) {
        /* keep course defaults */
    }
    updateAnalysisAxisUi();
}

function updateGithubUi(user) {
    const tokenPresent = !!G.currentToken();
    state.github.user = user || null;
    els.githubWho.textContent = user
        ? `GitHub @${user.login}`
        : tokenPresent
          ? 'GitHub token available'
          : 'GitHub signed out';
    els.githubWho.classList.toggle('ok', tokenPresent);
    els.githubSignInButton.disabled = tokenPresent;
    els.githubSignOutButton.disabled = !tokenPresent;
    els.chooseRigsButton.disabled = !tokenPresent;
    els.browseGithubButton.disabled = !tokenPresent;
    updateRigSelectionUi();
    try {
        const repo = G.parseRepo(els.githubRepoInput.value);
        els.courseRepoLink.href = `https://github.com/${repo.full}`;
    } catch (_) {
        els.courseRepoLink.href = 'https://github.com/reiserlab/cshl-2026-course';
    }
}

function mergeDescriptor(descriptor) {
    const index = state.catalog.findIndex((item) => item.key === descriptor.key);
    if (index >= 0) state.catalog[index] = { ...state.catalog[index], ...descriptor };
    else state.catalog.push(descriptor);
    state.catalog.sort((a, b) =>
        `${rigName(a)} ${a.protocolFamily} ${a.genotype} ${a.sex} ${a.timestamp}`.localeCompare(
            `${rigName(b)} ${b.protocolFamily} ${b.genotype} ${b.sex} ${b.timestamp}`
        )
    );
}

function addRun(run, descriptorPatch) {
    const descriptor = {
        ...run.descriptor,
        ...descriptorPatch,
        metadata: run.metadata,
        loaded: true
    };
    run.catalogKey = descriptor.key;
    run.descriptor = descriptor;
    state.runs.set(descriptor.key, run);
    mergeDescriptor(descriptor);
    return descriptor;
}

function selectOptions(select, values, current, allLabel) {
    const sorted = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = [
        allLabel ? `<option value="*">${escapeHtml(allLabel)}</option>` : '',
        ...sorted.map(
            (value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
        )
    ].join('');
    if (sorted.includes(current) || current === '*') select.value = current;
    else if (sorted.length) select.value = sorted[0];
}

function rebuildFilters(preferred) {
    const focus = preferred || descriptorByKey(state.focusKey) || {};
    selectOptions(
        els.protocolFilter,
        state.catalog.map((item) => item.protocolFamily),
        focus.protocolFamily || els.protocolFilter.value,
        null
    );
    selectOptions(
        els.genotypeFilter,
        state.catalog.map((item) => item.genotype),
        focus.genotype || els.genotypeFilter.value,
        'ALL'
    );
    selectOptions(
        els.sexFilter,
        state.catalog.map((item) => item.sex),
        focus.sex || els.sexFilter.value,
        'ALL'
    );
}

function matchesGroup(descriptor) {
    const genotype = els.genotypeFilter.value;
    const sex = els.sexFilter.value;
    return (
        descriptor.protocolFamily === els.protocolFilter.value &&
        (genotype === '*' || descriptor.genotype === genotype) &&
        (sex === '*' || descriptor.sex === sex)
    );
}

function descriptorSearchText(descriptor) {
    return [
        descriptor.runId,
        descriptor.protocol,
        descriptor.protocolFamily,
        descriptor.genotype,
        descriptor.sex,
        descriptor.flyNumber,
        descriptor.experimenter,
        descriptor.folder,
        descriptor.bench,
        descriptor.timestamp,
        descriptor.notes
    ]
        .join(' ')
        .toLowerCase();
}

function visibleDescriptors() {
    const search = els.catalogSearchInput.value.trim().toLowerCase();
    return state.catalog.filter((descriptor) => {
        if (search && !descriptorSearchText(descriptor).includes(search)) return false;
        if (state.mode === 'group' && !els.showAllRunsInput.checked && !matchesGroup(descriptor))
            return false;
        return true;
    });
}

function warningText(descriptor) {
    const notes = descriptor.notes || '';
    if (/re-?run|forgot|actually on|failed|bad|mistake/i.test(notes)) return notes;
    return notes;
}

function renderCatalog() {
    const visible = new Set(visibleDescriptors().map((item) => item.key));
    if (!state.catalog.length) {
        els.runCatalog.innerHTML = '<div class="empty-state">No runlogs indexed</div>';
        els.catalogStatus.textContent = 'Open files or connect to the course repository.';
        els.catalogSearchInput.disabled = true;
        els.renderSelectionButton.disabled = true;
        renderFocusOptions();
        return;
    }
    els.catalogSearchInput.disabled = false;
    els.renderSelectionButton.disabled =
        state.mode === 'single' ? !state.focusKey : !state.selectedKeys.size;
    const rigScope = state.github.selectedFolders.length
        ? state.github.selectedFolders.join(', ')
        : 'loaded sources';
    els.catalogStatus.textContent = `${visible.size} shown of ${state.catalog.length} runlogs | ${state.selectedKeys.size} selected | rigs: ${rigScope}`;
    els.runCatalog.innerHTML = state.catalog
        .map((descriptor) => {
            const selected =
                state.mode === 'single'
                    ? descriptor.key === state.focusKey
                    : state.selectedKeys.has(descriptor.key);
            const note = warningText(descriptor);
            const hidden = !visible.has(descriptor.key);
            const date = A.safeText(descriptor.timestamp).slice(0, 10);
            return `
      <div class="run-row ${selected ? 'selected' : ''} ${hidden ? 'hidden-by-group' : ''}" data-key="${escapeHtml(descriptor.key)}">
        <input class="run-select" type="checkbox" data-key="${escapeHtml(descriptor.key)}" ${selected ? 'checked' : ''} aria-label="Select ${escapeHtml(descriptor.runId)}">
        <strong title="${escapeHtml(descriptor.runId)}">${escapeHtml(descriptor.runId)}</strong>
        <span class="run-protocol" title="${escapeHtml(`${rigName(descriptor)} | ${descriptor.protocol}`)}"><span class="run-rig">${escapeHtml(rigName(descriptor))}</span>${escapeHtml(descriptor.protocolFamily)}</span>
        <span class="run-genotype" title="${escapeHtml(descriptor.genotype)}">${escapeHtml(descriptor.genotype)}</span>
        <span class="run-sex">${escapeHtml(descriptor.sex || '?')}</span>
        <span class="run-fly">fly ${escapeHtml(descriptor.flyNumber || '?')}</span>
        <span class="run-note ${note ? 'warning-note' : ''}" title="${escapeHtml(note || descriptor.experimenter)}">${escapeHtml(note || descriptor.experimenter || '')}</span>
        <button class="focus-run" type="button" data-key="${escapeHtml(descriptor.key)}" title="View ${escapeHtml(descriptor.runId)} from ${escapeHtml(date)}">View</button>
      </div>`;
        })
        .join('');
    renderFocusOptions();
}

function renderFocusOptions() {
    if (!state.catalog.length) {
        els.focusRunSelect.innerHTML = '<option value="">No runs available</option>';
        els.focusRunSelect.disabled = true;
        return;
    }
    els.focusRunSelect.disabled = false;
    els.focusRunSelect.innerHTML = [
        '<option value="">Choose a run</option>',
        ...state.catalog.map(
            (descriptor) =>
                `<option value="${escapeHtml(descriptor.key)}">${escapeHtml(`[${rigName(descriptor)}] ${experimenterName(descriptor)} | ${descriptor.protocolFamily} | ${descriptor.genotype} | ${descriptor.sex} | fly ${descriptor.flyNumber || '?'} | ${descriptor.runId}`)}</option>`
        )
    ].join('');
    els.focusRunSelect.value = state.focusKey;
}

function selectDefaultGroup() {
    state.selectedKeys.clear();
    for (const descriptor of state.catalog)
        if (matchesGroup(descriptor)) state.selectedKeys.add(descriptor.key);
    renderCatalog();
}

function setMode(mode) {
    state.mode = mode;
    const grouped = mode === 'group';
    els.singleModeButton.classList.toggle('active', !grouped);
    els.groupModeButton.classList.toggle('active', grouped);
    els.singleModeButton.setAttribute('aria-pressed', String(!grouped));
    els.groupModeButton.setAttribute('aria-pressed', String(grouped));
    els.groupControls.hidden = !grouped;
    els.individualsLabel.textContent = grouped
        ? 'Show individual fly means'
        : 'Show individual trials';
    if (grouped) {
        rebuildFilters();
        selectDefaultGroup();
    } else {
        state.selectedKeys = new Set(state.focusKey ? [state.focusKey] : []);
        renderCatalog();
        if (state.focusKey) renderSelection();
    }
}

async function focusDescriptor(key, renderAnalysis) {
    const descriptor = descriptorByKey(key);
    if (!descriptor) return;
    state.focusKey = key;
    els.focusRunSelect.value = key;
    if (state.mode === 'single') state.selectedKeys = new Set([key]);
    renderCatalog();
    const run = await ensureRun(descriptor);
    state.viewStart = run.frames.length ? run.frames[0].timeS : 0;
    state.scope.heldScale = {};
    renderFocusedRun();
    if (renderAnalysis !== false && state.mode === 'single') await renderSelection();
}

async function parseAndAddText(text, sourceName, descriptorPatch) {
    setStatus('', `Parsing ${sourceName}`);
    const run = A.parseJsonl(text, sourceName, descriptorPatch.path || sourceName, {
        ballDiameterMm: state.scope.ballDiameterMm,
        smoothWindowS: state.scope.smoothWindowS
    });
    const descriptor = addRun(run, descriptorPatch);
    rebuildFilters(descriptor);
    renderCatalog();
    return { run, descriptor };
}

async function ensureRun(descriptor) {
    if (state.runs.has(descriptor.key)) return state.runs.get(descriptor.key);
    let text;
    if (descriptor.sourceType === 'github') {
        setStatus('', `Fetching ${descriptor.runId} from GitHub`);
        text = await G.fetchText(
            els.githubRepoInput.value,
            descriptor.githubPath,
            state.github.branch
        );
    } else if (descriptor.sourceType === 'url') {
        setStatus('', `Fetching ${descriptor.runId}`);
        const response = await fetch(descriptor.url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        text = await response.text();
    } else {
        throw new Error(`No loader for ${descriptor.runId}`);
    }
    const result = await parseAndAddText(text, descriptor.sourceName, descriptor);
    setStatus('ok', `Loaded ${descriptor.runId}`);
    return result.run;
}

async function loadFiles(files) {
    let firstKey = '';
    for (const file of files) {
        const key = `file:${file.name}:${file.size}:${file.lastModified}`;
        const text = await file.text();
        const result = await parseAndAddText(text, file.name, {
            key,
            path: file.name,
            sourceType: 'file'
        });
        if (!firstKey) firstKey = result.descriptor.key;
    }
    if (firstKey) await focusDescriptor(firstKey, true);
}

async function loadUrl(url) {
    if (!url) return;
    setStatus('', `Fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    const sourceName = decodeURIComponent(
        new URL(url, window.location.href).pathname.split('/').pop() || 'runlog.jsonl'
    );
    const key = `url:${new URL(url, window.location.href).href}`;
    const result = await parseAndAddText(text, sourceName, {
        key,
        path: url,
        url,
        sourceType: 'url'
    });
    await focusDescriptor(result.descriptor.key, true);
    setStatus('ok', `Loaded ${result.descriptor.runId}`);
}

function checkedRigFolders() {
    return [...els.rigFolderList.querySelectorAll('input[type="checkbox"]:checked')].map(
        (input) => input.value
    );
}

function updateRigDialogSelection() {
    const count = checkedRigFolders().length;
    els.rigDialogCount.textContent = `${count} of ${state.github.directories.length} selected`;
    els.rigApplyButton.disabled = count === 0;
}

function renderRigDialog() {
    const selected = new Set(state.github.selectedFolders);
    els.rigDialogRepo.textContent = `${state.github.repo}/runlogs`;
    els.rigFolderList.innerHTML = state.github.directories
        .map(
            (directory) => `
        <label class="rig-option" title="View runlogs from ${escapeHtml(directory.path)}">
          <input type="checkbox" value="${escapeHtml(directory.name)}" ${selected.has(directory.name) ? 'checked' : ''}>
          <span>${escapeHtml(directory.name)}</span>
          <small>${escapeHtml(directory.path)}</small>
        </label>`
        )
        .join('');
    updateRigDialogSelection();
}

async function openRigDialog() {
    const repoValue = els.githubRepoInput.value.trim();
    const repo = G.parseRepo(repoValue);
    localStorage.setItem(G.REPO_KEY, repo.full);
    updateGithubUi(state.github.user);
    els.chooseRigsButton.disabled = true;
    els.browseGithubButton.disabled = true;
    setStatus('', `Reading rig folders from ${repo.full}/runlogs`);
    try {
        const info = await G.repoInfo(repo.full);
        state.github.branch = info.default_branch || 'main';
        state.github.repo = repo.full;
        state.github.rootItems = await G.listPath(repo.full, 'runlogs', state.github.branch);
        state.github.directories = state.github.rootItems
            .filter((item) => item.type === 'dir')
            .sort((a, b) => a.name.localeCompare(b.name));
        const available = state.github.directories.map((directory) => directory.name);
        state.github.selectedFolders = G.preferredFolders(repo.full, available);
        renderRigDialog();
        if (!els.rigDialog.open) els.rigDialog.showModal();
        setStatus('ok', `${available.length} rig folders available from ${repo.full}`);
    } finally {
        updateGithubUi(state.github.user);
    }
}

async function browseGithub() {
    const repoValue = els.githubRepoInput.value.trim();
    const repo = G.parseRepo(repoValue);
    if (
        state.github.repo !== repo.full ||
        !state.github.directories.length ||
        !state.github.selectedFolders.length
    ) {
        await openRigDialog();
        return;
    }
    localStorage.setItem(G.REPO_KEY, repo.full);
    updateGithubUi(state.github.user);
    els.chooseRigsButton.disabled = true;
    els.browseGithubButton.disabled = true;
    const selected = new Set(state.github.selectedFolders);
    const directories = state.github.directories.filter((directory) =>
        selected.has(directory.name)
    );
    setStatus('', `Indexing ${state.github.selectedFolders.join(', ')}`);
    try {
        const directFiles = state.github.rootItems.filter(
            (item) => item.type === 'file' && item.name.toLowerCase().endsWith('.jsonl')
        );
        const directoryFiles = await G.mapLimit(directories, 4, async (directory, index) => {
            setStatus('', `Indexing runlog folders ${index + 1}/${directories.length}`);
            const entries = await G.listPath(repo.full, directory.path, state.github.branch);
            return entries.map((item) => ({ ...item, rigFolder: directory.name }));
        });
        const files = [
            ...directFiles.map((item) => ({ ...item, rigFolder: 'runlogs root' })),
            ...directoryFiles.flat()
        ].filter((item) => item.type === 'file' && item.name.toLowerCase().endsWith('.jsonl'));
        const descriptors = await G.mapLimit(
            files,
            4,
            async (item) => {
                const prefix = await G.fetchPrefix(
                    repo.full,
                    item.path,
                    state.github.branch,
                    65536
                );
                const descriptor = A.parseMetadataPrefix(prefix, item.name, item.path);
                return {
                    ...descriptor,
                    key: `github:${repo.full}:${item.path}`,
                    path: item.path,
                    githubPath: item.path,
                    sourceType: 'github',
                    repoFull: repo.full,
                    folder: item.rigFolder,
                    size: item.size
                };
            },
            (done, total) => setStatus('', `Reading run metadata ${done}/${total}`)
        );
        state.catalog = state.catalog.filter(
            (descriptor) => descriptor.sourceType !== 'github' || descriptor.repoFull !== repo.full
        );
        descriptors.forEach(mergeDescriptor);
        const catalogKeys = new Set(state.catalog.map((descriptor) => descriptor.key));
        state.selectedKeys = new Set([...state.selectedKeys].filter((key) => catalogKeys.has(key)));
        if (state.focusKey && !catalogKeys.has(state.focusKey)) state.focusKey = '';
        rebuildFilters();
        renderCatalog();
        renderFocusedRun();
        setStatus(
            'ok',
            `${descriptors.length} private runlogs indexed from ${state.github.selectedFolders.join(', ')}`
        );
    } finally {
        updateGithubUi(state.github.user);
    }
}

function normalizeDirectoryUrl(value) {
    const url = new URL(
        A.safeText(value).trim() || '/cshl-2026-course/runlogs/',
        window.location.href
    );
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.search = '';
    url.hash = '';
    return url;
}

function isParentDirectory(url, directoryUrl) {
    const parent = new URL('../', directoryUrl);
    return url.pathname === parent.pathname || url.pathname === directoryUrl.pathname;
}

async function listDirectoryLinks(directoryUrl) {
    const response = await fetch(directoryUrl.href);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('a')]
        .map((anchor) => new URL(anchor.getAttribute('href'), response.url))
        .filter((url) => !url.search && !url.hash && !isParentDirectory(url, directoryUrl));
}

async function fetchUrlPrefix(url, bytes) {
    const response = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    if (!response.body || !response.body.getReader) return (await response.text()).slice(0, bytes);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
        while (text.length < bytes) {
            const part = await reader.read();
            if (part.done) break;
            text += decoder.decode(part.value, { stream: true });
            if (text.includes('"run_metadata"')) break;
        }
    } finally {
        try {
            await reader.cancel();
        } catch (_) {
            /* already complete */
        }
    }
    return text;
}

async function scanLocal() {
    const base = normalizeDirectoryUrl(els.repoBaseInput.value);
    els.repoBaseInput.value = base.pathname;
    els.scanLocalButton.disabled = true;
    setStatus('', `Scanning ${base.pathname}`);
    try {
        const first = await listDirectoryLinks(base);
        const direct = first.filter((url) => url.pathname.toLowerCase().endsWith('.jsonl'));
        const directories = first.filter((url) => url.pathname.endsWith('/'));
        const childFiles = await Promise.all(
            directories.map(async (directory) =>
                (await listDirectoryLinks(directory)).filter((url) =>
                    url.pathname.toLowerCase().endsWith('.jsonl')
                )
            )
        );
        const files = [...direct, ...childFiles.flat()];
        const descriptors = await G.mapLimit(
            files,
            4,
            async (url) => {
                const sourceName = decodeURIComponent(
                    url.pathname.split('/').pop() || 'runlog.jsonl'
                );
                const prefix = await fetchUrlPrefix(url.href, 65536);
                const descriptor = A.parseMetadataPrefix(prefix, sourceName, url.pathname);
                return {
                    ...descriptor,
                    key: `url:${url.href}`,
                    path: url.pathname,
                    url: url.href,
                    sourceType: 'url'
                };
            },
            (done, total) => setStatus('', `Reading local metadata ${done}/${total}`)
        );
        descriptors.forEach(mergeDescriptor);
        rebuildFilters();
        renderCatalog();
        setStatus('ok', `${descriptors.length} local runlogs indexed`);
    } finally {
        els.scanLocalButton.disabled = false;
    }
}

function analysisWarnings(runs) {
    const warnings = [];
    const families = [...new Set(runs.map((run) => run.protocolInfo.family))];
    const genotypes = [...new Set(runs.map((run) => run.descriptor.genotype))];
    const sexes = [...new Set(runs.map((run) => run.descriptor.sex))];
    const hashes = [...new Set(runs.map((run) => run.descriptor.protocolSha).filter(Boolean))];
    if (families.length > 1)
        warnings.push(
            'Multiple protocol families selected; the dashboard is using generic condition-aligned plots.'
        );
    if (genotypes.length > 1) warnings.push(`Mixed genotypes: ${genotypes.join('; ')}`);
    if (sexes.length > 1) warnings.push(`Mixed sexes: ${sexes.join(', ')}`);
    if (hashes.length > 1)
        warnings.push(
            `${hashes.length} protocol versions are selected. Only matching condition names are combined.`
        );
    const noted = runs.filter((run) =>
        /re-?run|forgot|actually on|failed|bad|mistake/i.test(run.descriptor.notes || '')
    );
    if (noted.length) warnings.push(`Review notes for: ${noted.map((run) => run.id).join(', ')}`);
    const skipped = runs.reduce((sum, run) => sum + run.totalMissingFrames, 0);
    if (skipped) warnings.push(`${skipped} skipped FicTrac frames across the selected runs.`);
    return warnings;
}

async function renderSelection() {
    let descriptors;
    if (state.mode === 'single') {
        const focus = descriptorByKey(state.focusKey);
        descriptors = focus ? [focus] : [];
    } else {
        descriptors = state.catalog.filter((descriptor) => state.selectedKeys.has(descriptor.key));
    }
    if (!descriptors.length) {
        setStatus('warn', 'Select at least one runlog');
        return;
    }
    els.renderSelectionButton.disabled = true;
    const runs = [];
    try {
        for (let index = 0; index < descriptors.length; index += 1) {
            setStatus(
                '',
                `Loading run ${index + 1}/${descriptors.length}: ${descriptors[index].runId}`
            );
            runs.push(await ensureRun(descriptors[index]));
        }
        state.renderedRuns = runs;
        const axisOptions = analysisAxisBuildOptions();
        state.pages = P.buildPages(runs, {
            mode: state.mode,
            showIndividuals: els.showIndividualsInput.checked,
            ...axisOptions
        });
        state.plotIndex = Math.min(state.plotIndex, Math.max(0, state.pages.length - 1));
        renderPlotOptions();
        await renderPlot();
        const warnings = analysisWarnings(runs);
        els.analysisWarnings.hidden = !warnings.length;
        els.analysisWarnings.textContent = warnings.join(' ');
        const label =
            state.mode === 'group'
                ? `${runs.length} fly/run means | ${[...new Set(runs.map((run) => run.descriptor.genotype))].join('; ')} | ${[...new Set(runs.map((run) => run.descriptor.sex))].join(', ')}`
                : sourceLabelForContext(runs[0]);
        els.analysisContext.textContent = `${label} | ${analysisAxisSummary()} | smoothing ${state.scope.smoothWindowS.toFixed(2)} s | ball ${state.scope.ballDiameterMm} mm | ${runs.map((run) => run.id).join(', ')}`;
        setStatus(
            'ok',
            `${state.pages.length} plots built from ${runs.length} runlog${runs.length === 1 ? '' : 's'}`
        );
    } catch (error) {
        setStatus('error', `Analysis failed: ${error.message}`);
        console.error(error);
    } finally {
        els.renderSelectionButton.disabled = false;
    }
}

function sourceLabelForContext(run) {
    const descriptor = run.descriptor;
    return `${descriptor.protocolLabel} | ${descriptor.genotype} | ${descriptor.sex} | fly ${descriptor.flyNumber || '?'} | ${descriptor.runId}`;
}

function renderPlotOptions() {
    if (!state.pages.length) {
        els.plotSelect.innerHTML = '<option>No plots</option>';
        els.plotSelect.disabled = true;
        [
            els.previousPlotButton,
            els.nextPlotButton,
            els.downloadSvgButton,
            els.downloadPngButton,
            els.downloadPlotCsvButton
        ].forEach((element) => {
            element.disabled = true;
        });
        return;
    }
    els.plotSelect.innerHTML = state.pages
        .map(
            (page, index) =>
                `<option value="${index}">${index + 1}. ${escapeHtml(page.title)}</option>`
        )
        .join('');
    els.plotSelect.value = String(state.plotIndex);
    els.plotSelect.disabled = false;
    els.previousPlotButton.disabled = state.plotIndex <= 0;
    els.nextPlotButton.disabled = state.plotIndex >= state.pages.length - 1;
    [els.downloadSvgButton, els.downloadPngButton, els.downloadPlotCsvButton].forEach((element) => {
        element.disabled = false;
    });
}

async function renderPlot() {
    const page = state.pages[state.plotIndex];
    if (!page) {
        els.plotTitle.textContent = 'No analysis loaded';
        els.plotDescription.textContent =
            'Choose one or more runlogs to build trial-aligned plots.';
        els.plotArea.innerHTML = '<div class="empty-state">Protocol-aware plots appear here.</div>';
        return;
    }
    els.plotTitle.textContent = page.title;
    els.plotDescription.textContent = page.description;
    renderPlotOptions();
    if (!window.Plotly) {
        els.plotArea.innerHTML =
            '<div class="empty-state">Plotly could not load. Check the network connection and reload.</div>';
        setStatus('error', 'Interactive plotting library did not load');
        return;
    }
    Plotly.purge(els.plotArea);
    els.plotArea.innerHTML = '';
    await Plotly.react(els.plotArea, page.figure.data, page.figure.layout, {
        responsive: true,
        displaylogo: false,
        scrollZoom: false,
        modeBarButtonsToRemove: ['select2d', 'lasso2d'],
        toImageButtonOptions: { format: 'png', filename: safeFilename(page.title), scale: 2 }
    });
}

function renderMetrics() {
    const run = focusedRun();
    const rows = run
        ? [
              ['Protocol', run.descriptor.protocol],
              ['Run ID', run.id],
              [
                  'Duration',
                  `${formatNumber(run.frames.length ? run.frames[run.frames.length - 1].timeS - run.frames[0].timeS : 0, 1)} s`
              ],
              ['Frames', run.frames.length.toLocaleString()],
              ['Steps', run.steps.length.toLocaleString()],
              ['Skipped frames', run.totalMissingFrames.toLocaleString()]
          ]
        : [
              ['Protocol', '-'],
              ['Run ID', '-'],
              ['Duration', '-'],
              ['Frames', '-'],
              ['Steps', '-'],
              ['Skipped frames', '-']
          ];
    els.metricsGrid.innerHTML = rows
        .map(
            ([label, value]) =>
                `<div class="metric"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`
        )
        .join('');
}

function renderMetadata() {
    const run = focusedRun();
    if (!run) {
        els.metadataSummary.innerHTML = '<div class="empty-state">No focused run</div>';
        els.metadataRaw.textContent = '';
        return;
    }
    const descriptor = descriptorByKey(state.focusKey) || run.descriptor || {};
    const folder = rigName(descriptor);
    const metadataRig = A.safeText(run.metadata.rig_id || run.metadata.bench);
    const rig =
        folder !== 'unassigned' && metadataRig && folder !== metadataRig
            ? `${folder} (metadata: ${metadataRig})`
            : folder !== 'unassigned'
              ? folder
              : metadataRig || 'Not recorded';
    const fields = [
        ['Genotype', run.metadata.genotype],
        ['Fly number', run.metadata.fly_number],
        ['Sex', run.metadata.sex],
        ['Age', run.metadata.age],
        ['Experimenter', experimenterName(descriptor)],
        ['Rig / folder', rig],
        ['Protocol', run.metadata.protocol_filename],
        ['Started', run.metadata.timestamp_start],
        ['Notes', run.metadata.notes || 'None entered'],
        ['Run ID', run.metadata.run_id || run.id],
        ['Source', run.sourcePath]
    ];
    els.metadataSummary.innerHTML = `<dl class="metadata-summary">${fields
        .map(([label, value]) => {
            const valueClass =
                label === 'Genotype'
                    ? 'metadata-primary'
                    : label === 'Notes'
                      ? 'metadata-notes'
                      : '';
            return `<dt>${escapeHtml(label)}</dt><dd class="${valueClass}">${escapeHtml(value ?? 'Not recorded')}</dd>`;
        })
        .join('')}</dl>`;
    els.metadataRaw.textContent = JSON.stringify(run.metadata, null, 2);
}

function renderSteps() {
    const run = focusedRun();
    els.stepCount.textContent = run ? run.steps.length : '0';
    els.stepsTable.innerHTML = run
        ? run.steps
              .map(
                  (step) => `
    <tr>
      <td>${step.index}</td>
      <td>${escapeHtml(step.condition)}</td>
      <td>${formatNumber(step.startMs / 1000, 2)} s</td>
      <td>${formatNumber(step.durationSec, 2)} s</td>
      <td>${(step.frameCount || 0).toLocaleString()}</td>
      <td>${formatNumber(step.meanForward, 2)}</td>
      <td>${formatNumber(step.meanTurning, 2)}</td>
    </tr>`
              )
              .join('')
        : '';
}

function enableRunControls(enabled) {
    [
        els.stepBackButton,
        els.stepForwardButton,
        els.scopeSmoothWin,
        els.windowSelect,
        els.traceSetSelect,
        els.scopeBallDia,
        els.scopeTurnLim,
        els.scopeFwdLim,
        els.scopeAutoY,
        els.timeSlider,
        els.downloadFramesCsvButton
    ].forEach((element) => {
        element.disabled = !enabled;
    });
}

function renderFocusedRun() {
    const run = focusedRun();
    enableRunControls(!!run);
    renderMetrics();
    renderMetadata();
    renderSteps();
    updateSlider();
    renderScope();
}

function runBounds(run) {
    if (!run || !run.frames.length) return { min: 0, max: 0 };
    return { min: run.frames[0].timeS, max: run.frames[run.frames.length - 1].timeS };
}

function selectedWindowSec() {
    const run = focusedRun();
    const bounds = runBounds(run);
    return els.windowSelect.value === 'all'
        ? Math.max(0.1, bounds.max - bounds.min)
        : Number(els.windowSelect.value || 30);
}

function updateSlider() {
    const run = focusedRun();
    const bounds = runBounds(run);
    state.viewWindow = selectedWindowSec();
    const maxStart = Math.max(bounds.min, bounds.max - state.viewWindow);
    state.viewStart = Math.max(bounds.min, Math.min(state.viewStart, maxStart));
    els.timeSlider.min = String(bounds.min);
    els.timeSlider.max = String(maxStart);
    els.timeSlider.step = '0.05';
    els.timeSlider.value = String(state.viewStart);
}

function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(360, Math.floor(rect.height));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
}

function scopeChannels() {
    if (state.traceSet === 'position')
        return [
            {
                key: 'x',
                label: 'x position',
                unit: 'rad',
                color: '#1e90ff',
                value: (frame) => frame.x
            },
            {
                key: 'y',
                label: 'y position',
                unit: 'rad',
                color: '#ff2e2e',
                value: (frame) => frame.y
            },
            {
                key: 'heading',
                label: 'heading',
                unit: 'deg',
                color: '#22e84a',
                value: (frame) => frame.headingDeg,
                fixedRange: [-180, 180]
            }
        ];
    if (state.traceSet === 'stimulus')
        return [
            {
                key: 'index',
                label: 'arena frame',
                unit: 'index',
                color: '#f6bf4f',
                value: (frame) => frame.index
            },
            {
                key: 'gap',
                label: 'frame gap',
                unit: 'frames',
                color: '#f06bd6',
                value: (frame) => frame.frameGap
            },
            {
                key: 'heading',
                label: 'heading',
                unit: 'deg',
                color: '#22e84a',
                value: (frame) => frame.headingDeg,
                fixedRange: [-180, 180]
            }
        ];
    return [
        {
            key: 'turning',
            label: 'turning',
            unit: 'deg/s',
            color: '#1e90ff',
            value: (frame) => frame.turningDegSSmoothed,
            fixedKey: 'turning'
        },
        {
            key: 'forward',
            label: 'forward',
            unit: 'mm/s',
            color: '#ff2e2e',
            value: (frame) => frame.forwardMmSSmoothed,
            fixedKey: 'forward'
        },
        {
            key: 'heading',
            label: 'heading',
            unit: 'deg',
            color: '#22e84a',
            value: (frame) => frame.headingDeg,
            fixedRange: [-180, 180]
        }
    ];
}

function robustScopeRange(values) {
    const sorted = values
        .filter(Number.isFinite)
        .map(Math.abs)
        .sort((a, b) => a - b);
    const limit = sorted.length
        ? Math.max(0.1, sorted[Math.floor((sorted.length - 1) * 0.99)] * 1.12)
        : 1;
    return [-limit, limit];
}

function scopeRange(channel, values) {
    if (channel.fixedRange) return channel.fixedRange;
    const fixed = channel.fixedKey ? state.scope.fixed[channel.fixedKey] : null;
    if (fixed) return [-fixed, fixed];
    if (!state.scope.autoY && state.scope.heldScale[channel.key])
        return state.scope.heldScale[channel.key];
    const range = robustScopeRange(values);
    state.scope.heldScale[channel.key] = range;
    return range;
}

function drawScopeUnderlays(context, run, start, end, xOf, top, bottom) {
    let lastEpochLabelX = -Infinity;
    let lastStepLabelX = -Infinity;
    for (const step of run.steps) {
        const stepStart = step.startMs / 1000;
        const stepEnd = step.endMs / 1000;
        if (stepEnd < start || stepStart > end) continue;
        for (const epoch of step.epochs) {
            const epochStart = epoch.startMs / 1000;
            const epochEnd = epoch.endMs / 1000;
            if (epochEnd < start || epochStart > end) continue;
            context.fillStyle =
                epoch.type === 'opto'
                    ? 'rgba(225, 64, 108, 0.17)'
                    : epoch.type === 'sham'
                      ? 'rgba(150, 160, 168, 0.10)'
                      : 'rgba(65, 180, 99, 0.045)';
            context.fillRect(
                xOf(Math.max(start, epochStart)),
                top,
                Math.max(1, xOf(Math.min(end, epochEnd)) - xOf(Math.max(start, epochStart))),
                bottom - top
            );
            if (epoch.type === 'opto' || epoch.type === 'sham') {
                const labelX = xOf(Math.max(start, epochStart)) + 3;
                if (labelX - lastEpochLabelX > 72) {
                    context.fillStyle = epoch.type === 'opto' ? '#ff779a' : '#aeb7be';
                    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
                    context.fillText(epoch.label, labelX, top + 12);
                    lastEpochLabelX = labelX;
                }
            }
        }
        if (stepStart >= start && stepStart <= end) {
            const x = xOf(stepStart);
            context.strokeStyle = 'rgba(240, 244, 247, 0.72)';
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x, top);
            context.lineTo(x, bottom);
            context.stroke();
            if (
                !/^(blank|start|shutdown|opto_on)/i.test(step.condition) &&
                x - lastStepLabelX > 145
            ) {
                context.fillStyle = '#dce4e9';
                context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
                const label =
                    step.condition.length > 18
                        ? `${step.condition.slice(0, 17)}...`
                        : step.condition;
                context.fillText(
                    label,
                    Math.min(x + 3, xOf(end) - 140),
                    top + 12 + (step.index % 2) * 11
                );
                lastStepLabelX = x;
            }
        }
    }
}

function renderScope() {
    const { context, width, height } = resizeCanvas(els.scopeCanvas);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#030808';
    context.fillRect(0, 0, width, height);
    const run = focusedRun();
    if (!run || !run.frames.length) {
        context.fillStyle = '#9ba8b4';
        context.font = '14px system-ui, sans-serif';
        context.textAlign = 'center';
        context.fillText(
            'Choose a focused run to inspect its full time series',
            width / 2,
            height / 2
        );
        context.textAlign = 'left';
        return;
    }

    const bounds = runBounds(run);
    const start = state.viewStart;
    const end = Math.min(bounds.max, start + state.viewWindow);
    const frames = run.frames.filter((frame) => frame.timeS >= start && frame.timeS <= end);
    const channels = scopeChannels();
    const padLeft = 54;
    const padRight = 8;
    const top = 24;
    const bottom = height - 24;
    const plotWidth = width - padLeft - padRight;
    const rowHeight = (bottom - top) / channels.length;
    const xOf = (time) => padLeft + ((time - start) / Math.max(0.001, end - start)) * plotWidth;
    drawScopeUnderlays(context, run, start, end, xOf, top, bottom);

    channels.forEach((channel, rowIndex) => {
        const rowTop = top + rowIndex * rowHeight;
        const rowBottom = rowTop + rowHeight;
        const range = scopeRange(channel, frames.map(channel.value));
        const yOf = (value) =>
            rowBottom -
            8 -
            ((value - range[0]) / Math.max(1e-9, range[1] - range[0])) * (rowHeight - 16);
        context.strokeStyle = 'rgba(210, 224, 231, 0.15)';
        context.lineWidth = 1;
        for (let grid = 0; grid <= 4; grid += 1) {
            const y = rowTop + (grid / 4) * rowHeight;
            context.beginPath();
            context.moveTo(padLeft, y);
            context.lineTo(width - padRight, y);
            context.stroke();
        }
        for (let grid = 0; grid <= 6; grid += 1) {
            const x = padLeft + (grid / 6) * plotWidth;
            context.beginPath();
            context.moveTo(x, rowTop);
            context.lineTo(x, rowBottom);
            context.stroke();
        }
        if (range[0] < 0 && range[1] > 0) {
            context.strokeStyle = 'rgba(225, 235, 240, 0.28)';
            context.beginPath();
            context.moveTo(padLeft, yOf(0));
            context.lineTo(width - padRight, yOf(0));
            context.stroke();
        }
        context.strokeStyle = channel.color;
        context.lineWidth = 1.15;
        context.beginPath();
        let drawing = false;
        for (const frame of frames) {
            const value = channel.value(frame);
            if (!Number.isFinite(value)) {
                drawing = false;
                continue;
            }
            const x = xOf(frame.timeS);
            const y = yOf(value);
            if (!drawing) context.moveTo(x, y);
            else context.lineTo(x, y);
            drawing = true;
        }
        context.stroke();
        context.fillStyle = channel.color;
        context.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const current = [...frames].reverse().map(channel.value).find(Number.isFinite);
        context.fillText(
            `${channel.label}  ${Number.isFinite(current) ? formatNumber(current, 2) : ''} ${channel.unit}`,
            padLeft + 4,
            rowBottom - 5
        );
        context.fillStyle = '#9ba8b4';
        context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        context.textAlign = 'right';
        context.fillText(formatNumber(range[1], 1), padLeft - 5, rowTop + 11);
        context.fillText(formatNumber(range[0], 1), padLeft - 5, rowBottom - 3);
        context.textAlign = 'left';
    });

    context.fillStyle = '#9ba8b4';
    context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textAlign = 'center';
    for (let tick = 0; tick <= 6; tick += 1) {
        const time = start + (tick / 6) * (end - start);
        context.fillText(`${formatNumber(time, 1)} s`, xOf(time), height - 7);
    }
    context.textAlign = 'left';
    els.timeReadout.textContent = `${formatNumber(start, 1)} - ${formatNumber(end, 1)} s`;
    els.windowReadout.textContent = `window: ${formatNumber(end - start, 1)} s`;
}

function downloadFramesCsv() {
    const run = focusedRun();
    if (!run) return;
    const rows = run.frames.map((frame) => ({
        ms: frame.ms,
        time_s: frame.timeS,
        fc: frame.fc,
        display_index: frame.index,
        x_rad: frame.x,
        y_rad: frame.y,
        heading_rad: frame.hd,
        heading_deg: frame.headingDeg,
        forward_mm_s: frame.forwardMmSSmoothed,
        turning_deg_s: frame.turningDegSSmoothed,
        frame_gap: frame.frameGap,
        step_index: frame.stepIndex ?? '',
        condition: frame.condition || ''
    }));
    const metadata = {
        source_runlog: run.sourcePath,
        smoothing_s: state.scope.smoothWindowS,
        ball_diameter_mm: state.scope.ballDiameterMm
    };
    downloadText(
        rowsToCsv(rows, metadata),
        `${safeFilename(run.id)}_frames.csv`,
        'text/csv;charset=utf-8'
    );
}

async function refreshSignalsAndPlots() {
    for (const run of state.runs.values())
        A.refreshSignals(run, {
            ballDiameterMm: state.scope.ballDiameterMm,
            smoothWindowS: state.scope.smoothWindowS
        });
    state.scope.heldScale = {};
    renderFocusedRun();
    if (state.renderedRuns.length) await renderSelection();
}

els.fileInput.addEventListener('change', async (event) => {
    try {
        await loadFiles([...event.target.files]);
    } catch (error) {
        setStatus('error', error.message);
    }
});

els.loadUrlButton.addEventListener('click', async () => {
    try {
        await loadUrl(els.urlInput.value.trim());
    } catch (error) {
        setStatus('error', `Could not load URL: ${error.message}`);
    }
});

els.githubSignInButton.addEventListener('click', async () => {
    try {
        const user = await G.signIn(els.githubRepoInput.value);
        if (user) {
            updateGithubUi(user);
            setStatus('ok', `Signed in to GitHub as @${user.login}`);
        }
    } catch (error) {
        setStatus('error', `GitHub sign-in failed: ${error.message}`);
    }
});

els.githubSignOutButton.addEventListener('click', () => {
    G.signOut();
    if (els.rigDialog.open) els.rigDialog.close();
    updateGithubUi(null);
    setStatus('', 'GitHub token cleared from this browser');
});

els.githubRepoInput.addEventListener('change', () => {
    try {
        const repo = G.parseRepo(els.githubRepoInput.value);
        localStorage.setItem(G.REPO_KEY, repo.full);
        resetGithubFolderState();
        updateGithubUi(state.github.user);
    } catch (error) {
        setStatus('error', error.message);
    }
});

els.chooseRigsButton.addEventListener('click', async () => {
    try {
        await openRigDialog();
    } catch (error) {
        setStatus('error', `Could not list rig folders: ${error.message}`);
    }
});

els.browseGithubButton.addEventListener('click', async () => {
    try {
        await browseGithub();
    } catch (error) {
        setStatus('error', `GitHub browse failed: ${error.message}`);
    }
});

els.rigFolderList.addEventListener('change', updateRigDialogSelection);

els.rigSelectAllButton.addEventListener('click', () => {
    els.rigFolderList
        .querySelectorAll('input[type="checkbox"]')
        .forEach((input) => (input.checked = true));
    updateRigDialogSelection();
});

els.rigClearAllButton.addEventListener('click', () => {
    els.rigFolderList
        .querySelectorAll('input[type="checkbox"]')
        .forEach((input) => (input.checked = false));
    updateRigDialogSelection();
});

[els.rigDialogCloseButton, els.rigCancelButton].forEach((button) =>
    button.addEventListener('click', () => els.rigDialog.close())
);

els.rigApplyButton.addEventListener('click', async () => {
    const selected = checkedRigFolders();
    if (!selected.length) return;
    state.github.selectedFolders = G.saveFolders(state.github.repo, selected);
    updateRigSelectionUi();
    els.rigDialog.close();
    try {
        await browseGithub();
    } catch (error) {
        setStatus('error', `GitHub browse failed: ${error.message}`);
    }
});

els.scanLocalButton.addEventListener('click', async () => {
    try {
        await scanLocal();
    } catch (error) {
        setStatus('error', `Local scan failed: ${error.message}`);
    }
});

els.singleModeButton.addEventListener('click', () => setMode('single'));
els.groupModeButton.addEventListener('click', () => setMode('group'));

els.focusRunSelect.addEventListener('change', async () => {
    if (!els.focusRunSelect.value) return;
    try {
        await focusDescriptor(els.focusRunSelect.value, true);
    } catch (error) {
        setStatus('error', error.message);
    }
});

[els.protocolFilter, els.genotypeFilter, els.sexFilter].forEach((element) =>
    element.addEventListener('change', selectDefaultGroup)
);
els.showAllRunsInput.addEventListener('change', renderCatalog);
els.catalogSearchInput.addEventListener('input', renderCatalog);

els.selectVisibleButton.addEventListener('click', () => {
    visibleDescriptors().forEach((descriptor) => state.selectedKeys.add(descriptor.key));
    renderCatalog();
});

els.clearSelectionButton.addEventListener('click', () => {
    state.selectedKeys.clear();
    renderCatalog();
});

els.runCatalog.addEventListener('change', (event) => {
    const input = event.target.closest('.run-select');
    if (!input) return;
    const key = input.dataset.key;
    if (state.mode === 'single') {
        focusDescriptor(key, true).catch((error) => setStatus('error', error.message));
        return;
    }
    if (input.checked) state.selectedKeys.add(key);
    else state.selectedKeys.delete(key);
    renderCatalog();
});

els.runCatalog.addEventListener('click', (event) => {
    const button = event.target.closest('.focus-run');
    if (!button) return;
    focusDescriptor(button.dataset.key, state.mode === 'single').catch((error) =>
        setStatus('error', error.message)
    );
});

els.renderSelectionButton.addEventListener('click', renderSelection);
els.showIndividualsInput.addEventListener('change', () => {
    if (state.renderedRuns.length) renderSelection();
});

els.applyAnalysisAxesButton.addEventListener('click', async () => {
    const turningLimit = Number(els.analysisTurnLimit.value);
    const forwardMin = Number(els.analysisForwardMin.value);
    const forwardMax = Number(els.analysisForwardMax.value);
    if (!(turningLimit > 0) || !Number.isFinite(forwardMin) || !(forwardMax > forwardMin)) {
        setStatus(
            'error',
            'Plot axes require a positive turning limit and forward maximum above minimum'
        );
        return;
    }
    state.analysisAxes = { mode: 'manual', turningLimit, forwardMin, forwardMax };
    saveAnalysisAxes();
    updateAnalysisAxisUi();
    if (state.renderedRuns.length) await renderSelection();
    else setStatus('ok', `Saved ${analysisAxisSummary()}`);
});

els.fitAnalysisAxesButton.addEventListener('click', async () => {
    state.analysisAxes.mode = 'fit';
    saveAnalysisAxes();
    updateAnalysisAxisUi();
    if (state.renderedRuns.length) await renderSelection();
    else setStatus('ok', 'Analysis plots will fit shared ranges to the selected data');
});

els.plotSelect.addEventListener('change', async () => {
    state.plotIndex = Number(els.plotSelect.value);
    await renderPlot();
});

els.previousPlotButton.addEventListener('click', async () => {
    if (state.plotIndex <= 0) return;
    state.plotIndex -= 1;
    await renderPlot();
});

els.nextPlotButton.addEventListener('click', async () => {
    if (state.plotIndex >= state.pages.length - 1) return;
    state.plotIndex += 1;
    await renderPlot();
});

els.downloadSvgButton.addEventListener('click', () => {
    const page = state.pages[state.plotIndex];
    if (page && window.Plotly)
        Plotly.downloadImage(els.plotArea, {
            format: 'svg',
            filename: safeFilename(page.title),
            width: 1500,
            height: page.figure.layout.height || 800
        });
});

els.downloadPngButton.addEventListener('click', () => {
    const page = state.pages[state.plotIndex];
    if (page && window.Plotly)
        Plotly.downloadImage(els.plotArea, {
            format: 'png',
            filename: safeFilename(page.title),
            width: 1500,
            height: page.figure.layout.height || 800,
            scale: 2
        });
});

els.downloadPlotCsvButton.addEventListener('click', () => {
    const page = state.pages[state.plotIndex];
    if (!page) return;
    const metadata = {
        plot: page.title,
        mode: state.mode,
        runlogs: state.renderedRuns.map((run) => run.sourcePath).join(' | '),
        analysis_axes: analysisAxisSummary(),
        smoothing_s: state.scope.smoothWindowS,
        ball_diameter_mm: state.scope.ballDiameterMm
    };
    downloadText(
        rowsToCsv(page.csvRows, metadata),
        `${safeFilename(page.title)}.csv`,
        'text/csv;charset=utf-8'
    );
});

els.downloadFramesCsvButton.addEventListener('click', downloadFramesCsv);

els.windowSelect.addEventListener('change', () => {
    updateSlider();
    renderScope();
});
els.traceSetSelect.addEventListener('change', () => {
    state.traceSet = els.traceSetSelect.value;
    state.scope.heldScale = {};
    renderScope();
});
els.timeSlider.addEventListener('input', () => {
    state.viewStart = Number(els.timeSlider.value);
    renderScope();
});
els.stepBackButton.addEventListener('click', () => {
    const bounds = runBounds(focusedRun());
    state.viewStart = Math.max(bounds.min, state.viewStart - state.viewWindow);
    updateSlider();
    renderScope();
});
els.stepForwardButton.addEventListener('click', () => {
    const bounds = runBounds(focusedRun());
    state.viewStart = Math.min(
        Math.max(bounds.min, bounds.max - state.viewWindow),
        state.viewStart + state.viewWindow
    );
    updateSlider();
    renderScope();
});

els.scopeSmoothWin.addEventListener('change', async () => {
    const value = Number(els.scopeSmoothWin.value);
    state.scope.smoothWindowS = Number.isFinite(value) && value > 0 ? value : 0.5;
    els.scopeSmoothWin.value = state.scope.smoothWindowS.toFixed(2);
    await refreshSignalsAndPlots();
});

els.scopeBallDia.addEventListener('change', async () => {
    const value = Number(els.scopeBallDia.value);
    state.scope.ballDiameterMm = Number.isFinite(value) && value > 0 ? value : 9;
    els.scopeBallDia.value = String(state.scope.ballDiameterMm);
    await refreshSignalsAndPlots();
});

function applyFixedLimit(element, key) {
    const value = Number(element.value);
    state.scope.fixed[key] = Number.isFinite(value) && value > 0 ? value : null;
    renderScope();
}

els.scopeTurnLim.addEventListener('change', () => applyFixedLimit(els.scopeTurnLim, 'turning'));
els.scopeFwdLim.addEventListener('change', () => applyFixedLimit(els.scopeFwdLim, 'forward'));
els.scopeAutoY.addEventListener('click', () => {
    state.scope.autoY = !state.scope.autoY;
    els.scopeAutoY.classList.toggle('on', state.scope.autoY);
    els.scopeAutoY.setAttribute('aria-pressed', String(state.scope.autoY));
    if (state.scope.autoY) state.scope.heldScale = {};
    renderScope();
});

document.body.addEventListener('dragover', (event) => event.preventDefault());
document.body.addEventListener('drop', async (event) => {
    event.preventDefault();
    const files = [...((event.dataTransfer && event.dataTransfer.files) || [])].filter((file) =>
        /\.(jsonl|ndjson|json)$/i.test(file.name)
    );
    if (!files.length) return;
    try {
        await loadFiles(files);
    } catch (error) {
        setStatus('error', error.message);
    }
});

window.addEventListener('resize', renderScope);

async function initialize() {
    els.githubRepoInput.value = G.currentRepo();
    loadAnalysisAxes();
    if (window.location.hostname.endsWith('github.io')) {
        els.plotSourceLink.href =
            'https://github.com/reiserlab/webDisplayTools/tree/main/dashboard/data-browser';
    } else {
        els.plotSourceLink.href = 'plot-specs.js';
    }
    updateGithubUi(null);
    renderCatalog();
    renderFocusedRun();
    renderPlotOptions();
    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get('repo');
    if (repoParam) {
        if (repoParam.startsWith('/')) els.repoBaseInput.value = repoParam;
        else {
            els.githubRepoInput.value = repoParam;
            updateGithubUi(null);
        }
    }
    const localRepoParam = params.get('localRepo');
    if (localRepoParam) els.repoBaseInput.value = localRepoParam;
    const data = params.get('data');
    if (data) {
        els.urlInput.value = data;
        try {
            await loadUrl(data);
        } catch (error) {
            setStatus('error', `Could not load URL: ${error.message}`);
        }
    } else if (G.currentToken()) {
        try {
            const user = await G.user();
            updateGithubUi(user);
            setStatus('ok', `GitHub ready as @${user.login}`);
        } catch (error) {
            setStatus('warn', `Stored GitHub token needs attention: ${error.message}`);
        }
    }
}

initialize();
