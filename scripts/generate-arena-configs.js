#!/usr/bin/env node
/**
 * generate-arena-configs.js
 *
 * Parses arena YAML configs from maDisplayTools and generates js/arena-configs.js
 *
 * Usage:
 *   node scripts/generate-arena-configs.js [config-dir]
 *
 * If config-dir is not specified, looks for:
 *   1. temp_configs/ (CI/CD fetched configs)
 *   2. ../maDisplayTools/configs/arenas/ (local development)
 */

const fs = require('fs');
const path = require('path');

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
                    currentSection[key] = arrayContent.split(',').map(v => {
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
        const coverageDeg = Math.round(360 * installedCols / cols);
        coverage = `${coverageDeg}°`;
    }

    // Include column order if CCW (non-default)
    const orderSuffix = arena.column_order === 'ccw' ? ' CCW' : '';

    return `${gen}${orderSuffix} (${rows}×${cols}) - ${coverage}`;
}

// Find config directory
function findConfigDir() {
    // Check command line argument
    if (process.argv[2]) {
        return process.argv[2];
    }

    // Check for CI/CD fetched configs
    const ciDir = path.join(process.cwd(), 'temp_configs');
    if (fs.existsSync(ciDir)) {
        return ciDir;
    }

    // Check for local maDisplayTools
    const localDir = path.join(process.cwd(), '..', 'maDisplayTools', 'configs', 'arenas');
    if (fs.existsSync(localDir)) {
        return localDir;
    }

    console.error('Error: Could not find config directory.');
    console.error('Provide path as argument or ensure temp_configs/ or ../maDisplayTools/configs/arenas/ exists.');
    process.exit(1);
}

// Parse arena registry index.yaml to build ARENA_REGISTRY
function parseArenaRegistry(registryDir) {
    const indexFile = path.join(registryDir, 'index.yaml');
    if (!fs.existsSync(indexFile)) {
        console.warn('Warning: arena_registry/index.yaml not found, using empty registry');
        return {};
    }

    const content = fs.readFileSync(indexFile, 'utf8');
    const registry = {};
    let currentGen = null;

    for (const line of content.split('\n')) {
        if (line.trim().startsWith('#') || line.trim() === '') continue;
        if (line.match(/^version:/)) continue;

        // Generation section header (e.g., "G41:" or "G6:")
        const sectionMatch = line.match(/^(\w+):$/);
        if (sectionMatch) {
            // Map YAML keys to generation names: G41 -> G4.1, G4 -> G4, G6 -> G6
            const key = sectionMatch[1];
            if (key === 'G41') currentGen = 'G4.1';
            else currentGen = key;
            registry[currentGen] = {};
            continue;
        }

        // Arena ID entry (e.g., "  1: G41_2x12_cw")
        const entryMatch = line.match(/^\s+(\d+):\s*(\S+)/);
        if (entryMatch && currentGen) {
            registry[currentGen][parseInt(entryMatch[1])] = entryMatch[2];
        }
    }

    return registry;
}

// Main
function main() {
    const configDir = findConfigDir();
    const outputFile = path.join(process.cwd(), 'js', 'arena-configs.js');

    console.log(`Reading configs from: ${configDir}`);

    // Also find registry directory (sibling of arenas/)
    const registryDir = path.join(path.dirname(configDir), 'arena_registry');
    const arenaRegistry = parseArenaRegistry(registryDir);
    console.log(`  Arena registry: ${JSON.stringify(arenaRegistry)}`);

    const configs = {};
    const files = fs.readdirSync(configDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

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
        .forEach(key => {
            sortedConfigs[key] = configs[key];
        });

    // Format ARENA_REGISTRY as readable JS
    const registryLines = [];
    for (const [gen, entries] of Object.entries(arenaRegistry)) {
        const items = Object.entries(entries).map(([id, name]) => `${id}: '${name}'`).join(', ');
        registryLines.push(`    '${gen}': { ${items} }`);
    }
    const registryStr = registryLines.join(',\n');

    // Generate output
    const output = `/**
 * Arena Configurations
 * Auto-generated from maDisplayTools/configs/arenas/ and arena_registry/
 * Last updated: ${new Date().toISOString()}
 *
 * DO NOT EDIT MANUALLY - regenerate with: node scripts/generate-arena-configs.js
 */

const STANDARD_CONFIGS = ${JSON.stringify(sortedConfigs, null, 2)};

// Generation ID registry (from maDisplayTools/configs/arena_registry/generations.yaml)
const GENERATIONS = {
    0: { name: 'unspecified', panel_size: null },
    1: { name: 'G3', panel_size: 8 },
    2: { name: 'G4', panel_size: 16 },
    3: { name: 'G4.1', panel_size: 16 },
    4: { name: 'G6', panel_size: 20 },
    5: { name: 'G5', panel_size: null, deprecated: true }
};

// Arena ID registry — per-generation namespaces (from maDisplayTools/configs/arena_registry/index.yaml)
const ARENA_REGISTRY = {
${registryStr}
};

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

    // Ensure js/ directory exists
    const jsDir = path.dirname(outputFile);
    if (!fs.existsSync(jsDir)) {
        fs.mkdirSync(jsDir, { recursive: true });
    }

    fs.writeFileSync(outputFile, output);
    console.log(`\nGenerated ${outputFile} with ${Object.keys(sortedConfigs).length} configs`);
}

main();
