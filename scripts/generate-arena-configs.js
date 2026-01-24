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
    let coverage = '360°';
    if (arena.panels_installed && Array.isArray(arena.panels_installed)) {
        // Detect if panels_installed uses column indices or panel indices
        // Column indices: all values < num_cols
        // Panel indices: some values >= num_cols (include row offsets)
        const maxIndex = Math.max(...arena.panels_installed);
        const isColumnIndices = maxIndex < cols;

        let installedCols;
        if (isColumnIndices) {
            // panels_installed is column indices (0-indexed)
            installedCols = arena.panels_installed.length;
        } else {
            // panels_installed is panel indices - count unique columns
            const uniqueCols = new Set(arena.panels_installed.map(p => p % cols));
            installedCols = uniqueCols.size;
        }

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

// Main
function main() {
    const configDir = findConfigDir();
    const outputFile = path.join(process.cwd(), 'js', 'arena-configs.js');

    console.log(`Reading configs from: ${configDir}`);

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

    // Generate output
    const output = `/**
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
        pixels_per_panel: 8
    },
    'G4': {
        panel_width_mm: 40.45,
        panel_height_mm: 40.45,
        panel_depth_mm: 18,
        pixels_per_panel: 16
    },
    'G4.1': {
        panel_width_mm: 40,
        panel_height_mm: 40,
        panel_depth_mm: 6.35,
        pixels_per_panel: 16
    },
    'G6': {
        panel_width_mm: 45.4,
        panel_height_mm: 45.4,
        panel_depth_mm: 3.45,
        pixels_per_panel: 20
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
