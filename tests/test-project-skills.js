#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const skillNames = ['g6-orientation', 'protocol-yaml', 'g6-pattern-maker'];

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function frontmatter(text, label) {
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert(match, `${label}: missing YAML frontmatter`);
    const fields = {};
    for (const line of match[1].split('\n')) {
        const separator = line.indexOf(':');
        assert(separator > 0, `${label}: malformed frontmatter line: ${line}`);
        fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return fields;
}

for (const name of skillNames) {
    const canonicalPath = `.agents/skills/${name}/SKILL.md`;
    const wrapperPath = `.claude/skills/${name}/SKILL.md`;
    const canonical = read(canonicalPath);
    const wrapper = read(wrapperPath);
    const canonicalMeta = frontmatter(canonical, canonicalPath);
    const wrapperMeta = frontmatter(wrapper, wrapperPath);

    assert.strictEqual(canonicalMeta.name, name, `${canonicalPath}: name must match directory`);
    assert(canonicalMeta.description, `${canonicalPath}: description is required`);
    assert.strictEqual(wrapperMeta.name, canonicalMeta.name, `${wrapperPath}: name drifted`);
    assert.strictEqual(
        wrapperMeta.description,
        canonicalMeta.description,
        `${wrapperPath}: description drifted from canonical skill`
    );
    assert(
        wrapper.includes(`../../../.agents/skills/${name}/SKILL.md`),
        `${wrapperPath}: wrapper does not route to canonical skill`
    );
    assert(
        wrapper.split('\n').length <= 16,
        `${wrapperPath}: wrapper contains duplicated guidance`
    );

    const openaiYaml = read(`.agents/skills/${name}/agents/openai.yaml`);
    assert(
        openaiYaml.includes(`$${name}`),
        `${name}: default prompt must invoke the skill by name`
    );
}

const patternTool = read('.agents/skills/g6-pattern-maker/scripts/g6_pattern_tool.js');
assert(!patternTool.includes('/Users/'), 'pattern compiler contains a machine-specific user path');
assert(
    patternTool.includes('addAncestors(__dirname)'),
    'pattern compiler must discover webDisplayTools relative to its installed location'
);

const legacyValidator = read('.claude/skills/protocol-yaml/bin/validate-protocol.mjs');
assert(
    legacyValidator.includes('.agents/skills/protocol-yaml/scripts/validate-protocol.mjs'),
    'legacy protocol validator does not forward to the canonical validator'
);

const fixture = 'tests/fixtures/v3_g6_2x10_smoke.yaml';
for (const validator of [
    '.agents/skills/protocol-yaml/scripts/validate-protocol.mjs',
    '.claude/skills/protocol-yaml/bin/validate-protocol.mjs'
]) {
    const result = spawnSync(
        process.execPath,
        ['--import', './tests/vendor-yaml.register.mjs', validator, fixture],
        { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(
        result.status,
        0,
        `${validator} failed:\n${result.stdout}\n${result.stderr}`
    );
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-project-skill-'));
try {
    for (const panelRows of [2, 3, 4]) {
        const specPath = path.join(temp, `bar-${panelRows}x10.json`);
        const outDir = path.join(temp, `out-${panelRows}x10`);
        fs.writeFileSync(
            specPath,
            JSON.stringify({
                name: `portable_bar_${panelRows}x10`,
                arena: { generation: 'G6', panel_rows: panelRows, panel_columns: 10 },
                encoding: { gs_levels: 16, duty_cycle: 128 },
                canvas: { background: 0 },
                frame_count: 1,
                layers: [
                    {
                        type: 'rect',
                        x_deg: 0,
                        y_deg: 0,
                        width_deg: 18,
                        height_px: panelRows * 20,
                        value: 15
                    }
                ],
                assertions: { allowed_values: [0, 15], expected_frame_count: 1 }
            })
        );
        const generated = spawnSync(
            process.execPath,
            [
                '.agents/skills/g6-pattern-maker/scripts/g6_pattern_tool.js',
                'generate',
                specPath,
                outDir
            ],
            { cwd: root, encoding: 'utf8' }
        );
        assert.strictEqual(
            generated.status,
            0,
            `pattern compiler failed for ${panelRows}x10:\n${generated.stdout}\n${generated.stderr}`
        );
        assert(
            fs.existsSync(path.join(outDir, `portable_bar_${panelRows}x10.pat`)),
            `pattern compiler did not emit ${panelRows}x10 PAT file`
        );
    }

    const audit = spawnSync(
        process.execPath,
        ['.agents/skills/g6-pattern-maker/scripts/g6_pattern_tool.js', 'audit-library', temp],
        { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(audit.status, 0, `pattern library audit failed:\n${audit.stderr}`);
    const manifest = JSON.parse(audit.stdout);
    assert.strictEqual(manifest.file_count, 3, 'pattern library audit missed generated files');
    assert.strictEqual(
        manifest.unique_sha256_count,
        3,
        'generated geometry patterns should differ'
    );

    const score = spawnSync(
        process.execPath,
        [
            '.agents/skills/g6-pattern-maker/scripts/g6_pattern_tool.js',
            'score-library',
            path.join(temp, 'out-2x10'),
            path.join(temp, 'out-2x10')
        ],
        { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(score.status, 0, `pattern library scorer failed:\n${score.stderr}`);
    const report = JSON.parse(score.stdout);
    assert.strictEqual(report.matched_count, 1, 'pattern library scorer missed generated file');
    assert.strictEqual(report.decoded_equal_count, 1, 'self-comparison must decode exactly');
    assert.strictEqual(report.mean_pixel_agreement, 1, 'self-comparison must have full agreement');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Project skills: canonical layout, Claude wrappers, validators, and G6 geometry pass.');
