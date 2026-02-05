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

// Generate the output JavaScript file
function generateOutput(sortedConfigs) {
    return `/**
 * Arena Configurations
 * Auto-generated from maDisplayTools/configs/arenas/
 * Last updated: ${new Date().toISOString()}
 *
 * DO NOT EDIT MANUALLY - regenerate with: node scripts/generate-arena-configs.js
 */

const STANDARD_CONFIGS = ${JSON.stringify(sortedConfigs, null, 2)};

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
    module.exports = { STANDARD_CONFIGS, PANEL_SPECS, getConfig, getConfigsByGeneration };
}

// Browser global export (for non-module scripts)
if (typeof window !== 'undefined') {
    window.STANDARD_CONFIGS = STANDARD_CONFIGS;
    window.PANEL_SPECS = PANEL_SPECS;
    window.getConfig = getConfig;
    window.getConfigsByGeneration = getConfigsByGeneration;
}

// ES6 module export
export { STANDARD_CONFIGS, PANEL_SPECS, getConfig, getConfigsByGeneration };
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

    // Generate output
    const output = generateOutput(sortedConfigs);

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
