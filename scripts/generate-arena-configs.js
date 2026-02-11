#!/usr/bin/env node
/**
 * generate-arena-configs.js
 *
 * Parses arena YAML configs from maDisplayTools and generates js/arena-configs.js
 *
 * Usage:
 *   node scripts/generate-arena-configs.js [config-dir]
 *
 * Config sources (in order of priority):
 *   1. Command-line argument path
 *   2. temp_configs/ (CI/CD fetched configs)
 *   3. ../maDisplayTools/configs/arenas/ (local development)
 *   4. GitHub: reiserlab/maDisplayTools feature/g6-tools branch (fallback download)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// GitHub configuration for fallback download
const GITHUB_REPO = 'reiserlab/maDisplayTools';
const GITHUB_BRANCH = 'feature/g6-tools';
const GITHUB_CONFIG_PATH = 'configs/arenas';
const GITHUB_REGISTRY_PATH = 'configs/arena_registry';

// Simple YAML parser for our arena config format
function parseYAML(yamlText) {
    const config = {};
    let currentSection = config;

    const lines = yamlText.split('\n');
    for (const line of lines) {
        // Skip comments and empty lines
        if (line.trim().startsWith('#') || line.trim() === '') continue;

        // Check for section (arena:)
        if (line.match(/^(\w+):$/)) {
            const sectionName = line.match(/^(\w+):$/)[1];
            config[sectionName] = {};
            currentSection = config[sectionName];
            continue;
        }

        // Check for key: value pairs (indented)
        const kvMatch = line.match(/^\s+(\w+):\s*(.+?)(?:\s*#.*)?$/);
        if (kvMatch) {
            const key = kvMatch[1];
            let value = kvMatch[2].trim();

            // Handle different value types
            if (value === 'null') {
                currentSection[key] = null;
            } else if (value.startsWith('[') && value.endsWith(']')) {
                // Array
                const arrayContent = value.slice(1, -1);
                if (arrayContent.trim() === '') {
                    currentSection[key] = [];
                } else {
                    currentSection[key] = arrayContent.split(',').map((v) => {
                        v = v.trim();
                        const num = parseFloat(v);
                        return isNaN(num) ? v.replace(/^"|"$/g, '') : num;
                    });
                }
            } else if (value.startsWith('"') && value.endsWith('"')) {
                // Quoted string
                currentSection[key] = value.slice(1, -1);
            } else if (!isNaN(parseFloat(value))) {
                // Number
                currentSection[key] = parseFloat(value);
            } else {
                // Unquoted string
                currentSection[key] = value;
            }
            continue;
        }

        // Check for top-level key: value
        const topKvMatch = line.match(/^(\w+):\s*(.+?)(?:\s*#.*)?$/);
        if (topKvMatch) {
            const key = topKvMatch[1];
            let value = topKvMatch[2].trim();

            if (value.startsWith('"') && value.endsWith('"')) {
                config[key] = value.slice(1, -1);
            } else {
                config[key] = value;
            }
            currentSection = config;
        }
    }

    return config;
}

/**
 * Parse generations.yaml — maps numeric IDs to generation info
 * Format: top-level "generations:" section with numeric keys (0, 1, 2, ...)
 * each containing { name, panel_size, deprecated? }
 */
function parseGenerationsYAML(yamlText) {
    const generations = {};
    let currentId = null;

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Match generation ID line (2-space indent, numeric key only)
        const idMatch = line.match(/^  (\d+):$/);
        if (idMatch) {
            currentId = parseInt(idMatch[1]);
            generations[currentId] = {};
            continue;
        }

        // Non-numeric key at 2-space indent (e.g., "  6-7:") — reset context
        if (line.match(/^  \S+:/) && !line.match(/^    /)) {
            currentId = null;
            continue;
        }

        // Match property under a generation (4-space indent)
        if (currentId !== null) {
            const propMatch = line.match(/^    (\w+):\s*(.+?)(?:\s*#.*)?$/);
            if (propMatch) {
                const key = propMatch[1];
                let value = propMatch[2].trim();

                if (value === 'null') value = null;
                else if (value === 'true') value = true;
                else if (value === 'false') value = false;
                else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
                else if (!isNaN(parseFloat(value))) value = parseFloat(value);

                generations[currentId][key] = value;
                continue;
            }
        }

        // Non-indented lines reset context (e.g., "generations:" header, "version: 1")
        if (!line.startsWith(' ')) {
            currentId = null;
        }
    }

    return generations;
}

/**
 * Parse index.yaml — maps generation keys to arena ID→name mappings
 * Format: top-level generation keys (G4, G41, G6) with numeric sub-keys
 * Uses generations data to map YAML keys (G41) to canonical names (G4.1)
 */
function parseRegistryIndexYAML(yamlText, generations) {
    const registry = {};

    // Build mapping from YAML-safe keys (G41) to canonical names (G4.1)
    const yamlKeyToName = {};
    for (const gen of Object.values(generations)) {
        if (gen.name) {
            yamlKeyToName[gen.name] = gen.name;
            yamlKeyToName[gen.name.replace('.', '')] = gen.name;
        }
    }

    let currentGen = null;

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Match generation section header (top-level key, no value)
        const genMatch = line.match(/^(\w[\w.]*):$/);
        if (genMatch) {
            const yamlKey = genMatch[1];
            const canonicalName = yamlKeyToName[yamlKey];
            if (canonicalName) {
                currentGen = canonicalName;
                registry[currentGen] = {};
            } else {
                currentGen = null;
            }
            continue;
        }

        // Match arena ID → name mapping (indented)
        if (currentGen) {
            const arenaMatch = line.match(/^\s+(\d+):\s*(\S+)/);
            if (arenaMatch) {
                const arenaId = parseInt(arenaMatch[1]);
                const arenaName = arenaMatch[2];
                registry[currentGen][arenaId] = arenaName;
            }
        }

        // Top-level key:value lines (like "version: 1") reset context
        if (!line.startsWith(' ') && !line.match(/^(\w[\w.]*):$/)) {
            currentGen = null;
        }
    }

    return registry;
}

// Generate human-readable label from config
function generateLabel(parsed) {
    if (!parsed.arena) return 'Unknown';

    const arena = parsed.arena;
    const gen = arena.generation || 'Unknown';
    const rows = arena.num_rows || 1;
    const cols = arena.num_cols || 1;

    // Calculate coverage
    // Support both new field name (columns_installed) and old field name (panels_installed) for backward compatibility
    let coverage = '360°';
    const columnsInstalled = arena.columns_installed || arena.panels_installed;
    if (columnsInstalled && Array.isArray(columnsInstalled)) {
        // columns_installed is always column indices (0-indexed)
        const installedCols = columnsInstalled.length;
        const coverageDeg = Math.round((360 * installedCols) / cols);
        coverage = `${coverageDeg}°`;
    }

    // Include column order if CCW (non-default)
    const orderSuffix = arena.column_order === 'ccw' ? ' CCW' : '';

    return `${gen}${orderSuffix} (${rows}×${cols}) - ${coverage}`;
}

/**
 * Make an HTTPS GET request and return the response body
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Response body
 */
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'webDisplayTools-config-generator'
            }
        };

        https
            .get(url, options, (res) => {
                // Handle redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    httpsGet(res.headers.location).then(resolve).catch(reject);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    return;
                }

                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => resolve(data));
                res.on('error', reject);
            })
            .on('error', reject);
    });
}

/**
 * Fetch the list of YAML files from GitHub API
 * @returns {Promise<Array<{name: string, download_url: string}>>}
 */
async function fetchGitHubFileList() {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_CONFIG_PATH}?ref=${GITHUB_BRANCH}`;
    console.log(`  Fetching file list from GitHub API...`);

    const response = await httpsGet(apiUrl);
    const files = JSON.parse(response);

    // Filter for YAML files only
    return files
        .filter((f) => f.type === 'file' && (f.name.endsWith('.yaml') || f.name.endsWith('.yml')))
        .map((f) => ({
            name: f.name,
            download_url: f.download_url
        }));
}

/**
 * Download YAML files from GitHub to a temporary directory
 * @returns {Promise<string>} Path to temp directory with downloaded files
 */
async function downloadFromGitHub() {
    console.log(`Downloading configs from GitHub: ${GITHUB_REPO}@${GITHUB_BRANCH}`);

    // Create temp directory
    const tempDir = path.join(process.cwd(), 'temp_configs');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Get list of YAML files
    const files = await fetchGitHubFileList();

    if (files.length === 0) {
        throw new Error('No YAML files found in GitHub repository');
    }

    console.log(`  Found ${files.length} YAML files`);

    // Download each file
    for (const file of files) {
        console.log(`  Downloading: ${file.name}`);
        const content = await httpsGet(file.download_url);
        fs.writeFileSync(path.join(tempDir, file.name), content);
    }

    console.log(`  Downloaded to: ${tempDir}`);
    return tempDir;
}

/**
 * Find config directory, downloading from GitHub if necessary
 * @returns {Promise<string>} Path to config directory
 */
async function findConfigDir() {
    // Check command line argument
    if (process.argv[2]) {
        const argDir = process.argv[2];
        if (fs.existsSync(argDir)) {
            return argDir;
        }
        console.error(`Warning: Specified directory not found: ${argDir}`);
    }

    // Check for CI/CD fetched configs
    const ciDir = path.join(process.cwd(), 'temp_configs');
    if (fs.existsSync(ciDir)) {
        const yamlFiles = fs
            .readdirSync(ciDir)
            .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (yamlFiles.length > 0) {
            console.log('Using existing temp_configs/ directory');
            return ciDir;
        }
    }

    // Check for local maDisplayTools
    const localDir = path.join(process.cwd(), '..', 'maDisplayTools', 'configs', 'arenas');
    if (fs.existsSync(localDir)) {
        const yamlFiles = fs
            .readdirSync(localDir)
            .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (yamlFiles.length > 0) {
            console.log('Using local maDisplayTools configs');
            return localDir;
        }
    }

    // Fallback: download from GitHub
    console.log('Local configs not found, downloading from GitHub...');
    try {
        return await downloadFromGitHub();
    } catch (err) {
        console.error(`Error downloading from GitHub: ${err.message}`);
        console.error('\nCould not find config directory. Options:');
        console.error(
            '  1. Provide path as argument: node scripts/generate-arena-configs.js <path>'
        );
        console.error('  2. Ensure ../maDisplayTools/configs/arenas/ exists locally');
        console.error('  3. Check network connection for GitHub download');
        process.exit(1);
    }
}

/**
 * Download registry files (generations.yaml, index.yaml) from GitHub
 * @param {string} targetDir - Parent directory to create arena_registry/ in
 * @returns {Promise<string>} Path to registry directory
 */
async function downloadRegistryFromGitHub(targetDir) {
    const registryDir = path.join(targetDir, 'arena_registry');
    if (!fs.existsSync(registryDir)) {
        fs.mkdirSync(registryDir, { recursive: true });
    }

    const baseUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_REGISTRY_PATH}`;
    const files = ['generations.yaml', 'index.yaml'];

    for (const file of files) {
        console.log(`  Downloading: arena_registry/${file}`);
        const content = await httpsGet(`${baseUrl}/${file}`);
        fs.writeFileSync(path.join(registryDir, file), content);
    }

    return registryDir;
}

/**
 * Parse registry files from a directory
 * @param {string} dir - Directory containing generations.yaml and index.yaml
 * @returns {{generations: Object, arenaRegistry: Object}}
 */
function parseRegistryFiles(dir) {
    const genText = fs.readFileSync(path.join(dir, 'generations.yaml'), 'utf8');
    const idxText = fs.readFileSync(path.join(dir, 'index.yaml'), 'utf8');

    const generations = parseGenerationsYAML(genText);
    const arenaRegistry = parseRegistryIndexYAML(idxText, generations);

    return { generations, arenaRegistry };
}

/**
 * Load registry data (generations + arena index) from local files or GitHub
 * @param {string} configDir - The arena configs directory (used to find sibling registry dir)
 * @returns {Promise<{generations: Object, arenaRegistry: Object}>}
 */
async function loadRegistryData(configDir) {
    // Candidate directories for registry files
    const candidates = [
        // Sibling to configDir (local maDisplayTools: configs/arenas/ → configs/arena_registry/)
        path.join(configDir, '..', 'arena_registry'),
        // Subdirectory of configDir (temp_configs/ → temp_configs/arena_registry/)
        path.join(configDir, 'arena_registry'),
        // Absolute local path
        path.join(process.cwd(), '..', 'maDisplayTools', 'configs', 'arena_registry')
    ];

    for (const dir of candidates) {
        const genFile = path.join(dir, 'generations.yaml');
        const idxFile = path.join(dir, 'index.yaml');
        if (fs.existsSync(genFile) && fs.existsSync(idxFile)) {
            console.log(`Reading registry from: ${dir}`);
            return parseRegistryFiles(dir);
        }
    }

    // Fallback: download from GitHub
    console.log('Registry files not found locally, downloading from GitHub...');
    try {
        const registryDir = await downloadRegistryFromGitHub(configDir);
        return parseRegistryFiles(registryDir);
    } catch (err) {
        console.error(`Error downloading registry from GitHub: ${err.message}`);
        console.error('\nCould not find registry files (generations.yaml, index.yaml). Options:');
        console.error('  1. Ensure ../maDisplayTools/configs/arena_registry/ exists locally');
        console.error('  2. Check network connection for GitHub download');
        process.exit(1);
    }
}

/**
 * Format GENERATIONS object as JavaScript source
 */
function formatGenerationsJS(generations) {
    const ids = Object.keys(generations).map(Number).sort((a, b) => a - b);
    const lines = ids.map((id) => {
        const gen = generations[id];
        const props = [`name: '${gen.name}'`, `panel_size: ${gen.panel_size}`];
        if (gen.deprecated) props.push('deprecated: true');
        return `    ${id}: { ${props.join(', ')} }`;
    });
    return `{\n${lines.join(',\n')}\n}`;
}

/**
 * Format ARENA_REGISTRY object as JavaScript source
 */
function formatArenaRegistryJS(registry) {
    const lines = Object.entries(registry).map(([gen, arenas]) => {
        const arenaEntries = Object.entries(arenas)
            .sort(([a], [b]) => parseInt(a) - parseInt(b))
            .map(([id, name]) => `${id}: '${name}'`);
        const padding = ' '.repeat(Math.max(1, 6 - gen.length));
        return `    '${gen}':${padding}{ ${arenaEntries.join(', ')} }`;
    });
    return `{\n${lines.join(',\n')}\n}`;
}

// Generate the output JavaScript file
function generateOutput(sortedConfigs, registryData) {
    const { generations, arenaRegistry } = registryData;

    return `/**
 * Arena Configurations
 * Auto-generated from maDisplayTools/configs/arenas/
 * Last updated: ${new Date().toISOString()}
 *
 * DO NOT EDIT MANUALLY - regenerate with: node scripts/generate-arena-configs.js
 */

const STANDARD_CONFIGS = ${JSON.stringify(sortedConfigs, null, 2)};

// Generation ID registry (from maDisplayTools/configs/arena_registry/generations.yaml)
const GENERATIONS = ${formatGenerationsJS(generations)};

// Arena ID registry — per-generation namespaces (from maDisplayTools/configs/arena_registry/index.yaml)
const ARENA_REGISTRY = ${formatArenaRegistryJS(arenaRegistry)};

/**
 * Get generation name from ID
 * @param {number} id - Generation ID (0-7)
 * @returns {string} Generation name or 'unknown'
 */
function getGenerationName(id) {
    return GENERATIONS[id] ? GENERATIONS[id].name : 'unknown';
}

/**
 * Get generation ID from name
 * @param {string} name - Generation name (e.g., 'G6', 'G4.1')
 * @returns {number} Generation ID or 0
 */
function getGenerationId(name) {
    for (const [id, gen] of Object.entries(GENERATIONS)) {
        if (gen.name === name) return parseInt(id);
    }
    return 0;
}

/**
 * Get arena config name from generation and arena ID
 * @param {string} generation - Generation name (e.g., 'G6', 'G4')
 * @param {number} arenaId - Arena ID
 * @returns {string|null} Arena config name or null
 */
function getArenaName(generation, arenaId) {
    const genRegistry = ARENA_REGISTRY[generation];
    if (!genRegistry) return null;
    return genRegistry[arenaId] || null;
}

/**
 * Get arena ID from generation and config name
 * @param {string} generation - Generation name (e.g., 'G6', 'G4')
 * @param {string} arenaName - Arena config name (e.g., 'G6_2x10')
 * @returns {number} Arena ID or 0
 */
function getArenaId(generation, arenaName) {
    const genRegistry = ARENA_REGISTRY[generation];
    if (!genRegistry) return 0;
    for (const [id, name] of Object.entries(genRegistry)) {
        if (name === arenaName) return parseInt(id);
    }
    return 0;
}

// Panel specifications by generation
const PANEL_SPECS = {
    'G3': {
        panel_width_mm: 32,
        panel_height_mm: 32,
        panel_depth_mm: 18,
        pixels_per_panel: 8,
        led_type: 'round',
        led_diameter_mm: 3.0  // 3mm diameter round (4mm pitch)
    },
    'G4': {
        panel_width_mm: 40.45,
        panel_height_mm: 40.45,
        panel_depth_mm: 18,
        pixels_per_panel: 16,
        led_type: 'round',
        led_diameter_mm: 1.9  // 1.9mm diameter round
    },
    'G4.1': {
        panel_width_mm: 40,
        panel_height_mm: 40,
        panel_depth_mm: 6.35,
        pixels_per_panel: 16,
        led_type: 'rect',      // 0603 SMD at 45 degrees
        led_width_mm: 1.6,
        led_height_mm: 0.8
    },
    'G6': {
        panel_width_mm: 45.4,
        panel_height_mm: 45.4,
        panel_depth_mm: 3.45,
        pixels_per_panel: 20,
        led_type: 'rect',      // 0402 SMD at 45 degrees
        led_width_mm: 1.0,
        led_height_mm: 0.5
    }
};

// Helper to get config by name
function getConfig(name) {
    return STANDARD_CONFIGS[name] || null;
}

// Helper to list all config names grouped by generation
function getConfigsByGeneration() {
    const groups = { 'G6': [], 'G4.1': [], 'G4': [], 'G3': [] };

    for (const [name, config] of Object.entries(STANDARD_CONFIGS)) {
        const gen = config.arena?.generation;
        if (gen && groups[gen]) {
            groups[gen].push({ name, ...config });
        }
    }

    return groups;
}

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        STANDARD_CONFIGS, PANEL_SPECS, GENERATIONS, ARENA_REGISTRY,
        getConfig, getConfigsByGeneration,
        getGenerationName, getGenerationId, getArenaName, getArenaId
    };
}

// Browser global export (for non-module scripts)
if (typeof window !== 'undefined') {
    window.STANDARD_CONFIGS = STANDARD_CONFIGS;
    window.PANEL_SPECS = PANEL_SPECS;
    window.GENERATIONS = GENERATIONS;
    window.ARENA_REGISTRY = ARENA_REGISTRY;
    window.getConfig = getConfig;
    window.getConfigsByGeneration = getConfigsByGeneration;
    window.getGenerationName = getGenerationName;
    window.getGenerationId = getGenerationId;
    window.getArenaName = getArenaName;
    window.getArenaId = getArenaId;
}

// ES6 module export
export {
    STANDARD_CONFIGS, PANEL_SPECS, GENERATIONS, ARENA_REGISTRY,
    getConfig, getConfigsByGeneration,
    getGenerationName, getGenerationId, getArenaName, getArenaId
};
`;
}

// Main
async function main() {
    const configDir = await findConfigDir();
    const outputFile = path.join(process.cwd(), 'js', 'arena-configs.js');

    console.log(`Reading configs from: ${configDir}`);

    const configs = {};
    const files = fs
        .readdirSync(configDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    if (files.length === 0) {
        console.error('Error: No YAML files found in config directory.');
        process.exit(1);
    }

    for (const file of files) {
        const content = fs.readFileSync(path.join(configDir, file), 'utf8');
        const parsed = parseYAML(content);
        const name = file.replace(/\.ya?ml$/, '');

        configs[name] = {
            label: generateLabel(parsed),
            description: parsed.description || '',
            arena: parsed.arena
        };

        console.log(`  Parsed: ${name} -> ${configs[name].label}`);
    }

    // Sort configs by generation then by name
    const sortedConfigs = {};
    const sortOrder = ['G6', 'G4.1', 'G4', 'G3'];

    Object.keys(configs)
        .sort((a, b) => {
            const genA = configs[a].arena?.generation || '';
            const genB = configs[b].arena?.generation || '';
            const orderA = sortOrder.indexOf(genA);
            const orderB = sortOrder.indexOf(genB);
            if (orderA !== orderB) return orderA - orderB;
            return a.localeCompare(b);
        })
        .forEach((key) => {
            sortedConfigs[key] = configs[key];
        });

    // Load registry data (generations + arena index)
    const registryData = await loadRegistryData(configDir);
    console.log(`  Loaded ${Object.keys(registryData.generations).length} generations, ${Object.values(registryData.arenaRegistry).reduce((n, g) => n + Object.keys(g).length, 0)} arena registry entries`);

    // Generate output
    const output = generateOutput(sortedConfigs, registryData);

    // Ensure js/ directory exists
    const jsDir = path.dirname(outputFile);
    if (!fs.existsSync(jsDir)) {
        fs.mkdirSync(jsDir, { recursive: true });
    }

    fs.writeFileSync(outputFile, output);
    console.log(`\nGenerated ${outputFile} with ${Object.keys(sortedConfigs).length} configs`);
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
