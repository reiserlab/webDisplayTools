#!/usr/bin/env node
/**
 * test-studio-qwiic.js — js/studio-qwiic.js (rig `peripherals:` parser, the
 * scan-vs-YAML check in both directions, setup, chip, YAML snippet, readout
 * formatting) + the arena_studio.html Qwiic panel wiring. LAB-214.
 *
 *   pixi run node tests/test-studio-qwiic.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SQ = require('../js/studio-qwiic.js');
const Q = require('../js/qwiic-drivers.js');

let failures = 0;
let total = 0;
function ok(name, cond, info) {
    total++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? ' — ' + info : ''}`);
    if (!cond) failures++;
}

// Discovery fixture without touching a bus: what SQ.discover() returns.
const item = (addr, kind, extra) =>
    Object.assign(
        {
            dev: Q.located(addr, extra && extra.mux, extra && extra.channel),
            key: SQ.locKey(Q.located(addr, extra && extra.mux, extra && extra.channel)),
            kind,
            label: kind ? Q.KINDS[kind].label : Q.describe(addr),
            where: Q.where(Q.located(addr, extra && extra.mux, extra && extra.channel)),
            ident: kind ? { ok: !(extra && extra.idFail), detail: 'id', info: {} } : null,
            driver: null
        },
        extra && extra.flags
    );

(async () => {
    console.log('\n=== parseRigPeripherals ===');
    {
        const none = SQ.parseRigPeripherals({ name: 'x' });
        ok(
            'no peripherals: → empty, no warnings',
            none.list.length === 0 && none.warnings.length === 0
        );
        ok('null rig → empty', SQ.parseRigPeripherals(null).list.length === 0);
        ok(
            'not a list → warning',
            SQ.parseRigPeripherals({ peripherals: { a: 1 } }).warnings.length === 1
        );

        const r = SQ.parseRigPeripherals({
            peripherals: [
                { name: 'env', kind: 'sht4x', address: '0x44', poll: 'trial_start' },
                {
                    name: 'tilt',
                    kind: 'LSM6DSOX',
                    address: 0x6a,
                    poll: ['trial_start', { interval: 1.0 }],
                    config: { bump_g: 0.3 }
                },
                { kind: 'tsl2591' },
                {
                    name: 'env2',
                    kind: 'sht4x',
                    mux: { address: '0x70', channel: 2 },
                    poll: { interval: 0.1 }
                },
                {
                    name: 'servo',
                    kind: 'pca9685',
                    poll: 'trial_start',
                    channels: { gate: 0, door: { channel: 3, min_us: 900, max_us: 2100 }, bad: 22 }
                }
            ]
        });
        const by = Object.fromEntries(r.list.map((p) => [p.name, p]));
        ok('five entries kept', r.list.length === 5, r.list.map((p) => p.name).join(','));
        ok(
            'hex string address',
            by.env.address === 0x44 && by.env.poll.trialStart && !by.env.poll.onDemand
        );
        ok(
            'kind is case-insensitive; poll list',
            by.tilt.kind === 'lsm6dsox' && by.tilt.poll.trialStart && by.tilt.poll.intervalS === 1
        );
        ok('config passes through', by.tilt.config.bump_g === 0.3);
        ok(
            'default name + address + on_demand',
            by.tsl2591_29 && by.tsl2591_29.address === 0x29 && by.tsl2591_29.poll.onDemand
        );
        ok(
            'mux parsed; same address on a mux channel is a different device',
            by.env2.mux.address === 0x70 && by.env2.mux.channel === 2
        );
        ok(
            'interval below 0.5 s raised + warned',
            by.env2.poll.intervalS === 0.5 && r.warnings.some((w) => /minimum/.test(w))
        );
        ok(
            'actuator poll ignored + warned',
            by.servo.poll.onDemand &&
                !by.servo.poll.trialStart &&
                r.warnings.some((w) => /actuator/.test(w))
        );
        ok(
            'servo channels: bare int, spec, bad dropped',
            by.servo.channels.gate.channel === 0 &&
                by.servo.channels.gate.min_us === 1000 &&
                by.servo.channels.door.min_us === 900 &&
                !by.servo.channels.bad &&
                r.warnings.some((w) => /bad/.test(w))
        );

        const bad = SQ.parseRigPeripherals({
            peripherals: [
                'nope',
                { kind: 'bme280' },
                { kind: 'sht4x', address: 0x99 },
                { kind: 'sht4x', mux: { address: 0x40, channel: 1 } },
                { kind: 'sht4x', name: '9lives' },
                { kind: 'sht4x', name: 'a' },
                { kind: 'sht4x', name: 'a', mux: { channel: 1 } },
                { kind: 'sht4x', name: 'b' },
                { kind: 'sht4x', address: 0x45, name: 'c', poll: 'every_second' }
            ]
        });
        ok(
            'malformed entries dropped, never thrown',
            bad.list.map((p) => p.name).join(',') === 'a,c',
            bad.list.map((p) => p.name).join(',')
        );
        ok('a warning per problem', bad.warnings.length >= 9, bad.warnings.length + ' warnings');
        ok(
            'unknown kind names the known kinds',
            bad.warnings.some((w) => /unknown kind "bme280".*sht4x/.test(w))
        );
        ok(
            'duplicate location dropped',
            bad.warnings.some((w) => /same address\/mux channel/.test(w))
        );
        ok(
            'off-book address kept with a strap warning',
            bad.warnings.some((w) => /0x45.*straps/.test(w))
        );
        ok(
            'unknown poll warned',
            bad.warnings.some((w) => /unknown poll/.test(w))
        );

        const many = SQ.parseRigPeripherals({
            peripherals: Array.from({ length: 9 }, (_, i) => ({
                kind: 'sht4x',
                name: 's' + i,
                mux: { address: 0x70, channel: i % 8 },
                address: i < 8 ? 0x44 : 0x45
            }))
        });
        ok(
            '> 8 boards → pull-up budget warning (no cap)',
            many.list.length === 9 && many.warnings.some((w) => /pull-ups/.test(w))
        );
    }

    console.log('\n=== checkAgainstScan — both directions ===');
    {
        const declared = SQ.parseRigPeripherals({
            peripherals: [
                { name: 'env', kind: 'sht4x', poll: 'trial_start' },
                { name: 'tilt', kind: 'lsm6dsox', poll: 'trial_start' },
                { name: 'servo', kind: 'pca9685' },
                { name: 'env2', kind: 'sht4x', mux: { address: 0x70, channel: 2 } }
            ]
        }).list;
        const disc = {
            scan: [0x29, 0x44, 0x6a, 0x70],
            shadow: null,
            devices: [
                item(0x29, 'tsl2591'),
                item(0x44, 'sht4x'),
                item(0x6a, 'lsm6dsox', { idFail: true }),
                item(0x70, null, { flags: { mux: true } }),
                item(0x44, 'sht4x', { mux: 0x70, channel: 5 })
            ]
        };
        const c = SQ.checkAgainstScan(declared, disc);
        const st = Object.fromEntries(c.entries.map((e) => [e.decl.name, e.status]));
        ok('present + identified → ok', st.env === 'ok');
        ok('answered but failed ID → id_fail', st.tilt === 'id_fail');
        ok(
            'declared, not on the bus → missing (with the self-powered hint)',
            st.servo === 'missing' && /own supply/.test(c.entries[2].detail)
        );
        ok('declared behind ch2, found behind ch5 → wrong_location', st.env2 === 'wrong_location');
        ok(
            'attached but undeclared → flagged',
            c.undeclared.length === 1 && c.undeclared[0].dev.addr === 0x29,
            c.undeclared.map((u) => u.key).join(',')
        );
        ok(
            'a mux carrying a declared device is not "undeclared"',
            !c.undeclared.some((u) => u.mux)
        );
        ok(
            'counts',
            c.counts.ok === 1 &&
                c.counts.missing === 1 &&
                c.counts.idFail === 1 &&
                c.counts.wrongLocation === 1 &&
                c.counts.undeclared === 1 &&
                !c.ok
        );

        const shadowDisc = {
            scan: [0x40, 0x70],
            shadow: 0x70,
            devices: [item(0x40, 'pca9685'), item(0x70, null, { flags: { shadow: true } })]
        };
        const c2 = SQ.checkAgainstScan(
            [
                {
                    name: 'servo',
                    kind: 'pca9685',
                    address: 0x40,
                    mux: null,
                    poll: {},
                    config: {},
                    channels: {}
                }
            ],
            shadowDisc
        );
        ok('PCA9685 all-call shadow is never "undeclared"', c2.ok && c2.undeclared.length === 0);
        const c3 = SQ.checkAgainstScan([], {
            scan: [0x44],
            shadow: null,
            devices: [item(0x44, 'sht4x')]
        });
        ok('nothing declared → every device undeclared', c3.counts.undeclared === 1 && c3.ok);

        const chipErr = SQ.chipState({ available: true, check: c });
        ok(
            'chip: red, names the first problem, counts undeclared',
            chipErr.level === 'err' &&
                /SHT4x 0x44|LSM6DSOX 0x6A/.test(chipErr.text) &&
                /\+2/.test(chipErr.text) &&
                /1 undeclared/.test(chipErr.text),
            chipErr.text
        );
        const okDisc = {
            scan: [0x44, 0x6a, 0x29],
            shadow: null,
            devices: [item(0x44, 'sht4x'), item(0x6a, 'lsm6dsox'), item(0x29, 'tsl2591')]
        };
        const c4 = SQ.checkAgainstScan(declared.slice(0, 2), okDisc);
        const chipWarn = SQ.chipState({ available: true, check: c4 });
        ok(
            'chip: amber "✓ 2/2 · 1 undeclared"',
            chipWarn.level === 'warn' && chipWarn.text === 'Qwiic ✓ 2/2 · 1 undeclared',
            chipWarn.text
        );
        const chipOk = SQ.chipState({
            available: true,
            check: SQ.checkAgainstScan(declared.slice(0, 2), {
                scan: [],
                shadow: null,
                devices: okDisc.devices.slice(0, 2)
            })
        });
        ok(
            'chip: green "✓ 2/2"',
            chipOk.level === 'ok' && chipOk.text === 'Qwiic ✓ 2/2',
            chipOk.text
        );
        ok('chip: off without the bridge', SQ.chipState({ available: false }).level === 'off');
        ok(
            'chip: nothing declared, devices found → amber count',
            SQ.chipState({ available: true, check: c3 }).text === 'Qwiic: 1 device · 1 undeclared'
        );

        const yaml = SQ.toRigYaml(disc);
        ok(
            'YAML snippet: entries for known parts, mux line, poll by role',
            /- name: tsl2591_29\n    kind: tsl2591\n    address: 0x29\n    poll: on_demand/.test(
                yaml
            ) &&
                /mux: \{address: 0x70, channel: 5\}/.test(yaml) &&
                /kind: sht4x\n    address: 0x44\n    poll: trial_start/.test(yaml),
            yaml
        );
        ok(
            'YAML snippet parses back to the same devices',
            (() => {
                const YAML = require('../js/vendor/yaml/browser/dist/index.js');
                const back = SQ.parseRigPeripherals(YAML.parse(yaml));
                return back.warnings.length === 0 && back.list.length === 4;
            })()
        );
        ok(
            'YAML snippet: only the undeclared',
            SQ.toRigYaml(disc, { only: c.undeclared }).split('- name:').length === 2
        );
    }

    console.log('\n=== applySetup + discover on a simulated bus ===');
    {
        // Tiny register-file sim: SHT4x at 0x44 (no ID needed beyond the serial) + LSM6DSOX at 0x6A.
        const regs = { 0x6a: { 0x0f: 0x6c } };
        let shtPending = [];
        const word = (v) => {
            const b = [(v >> 8) & 0xff, v & 0xff];
            return [...b, Q.crc8Sensirion(b)];
        };
        const ptr = {};
        const reply = (status, cmd, payload) =>
            Uint8Array.from([2 + payload.length, status, cmd, ...payload]);
        const send = async (bytes) => {
            const b = Array.from(bytes);
            if (b[1] === 0xb0) return reply(0, 0xb0, [2, 0x44, 0x6a]);
            const addr = b[2];
            const w = b.slice(4, 4 + b[3]);
            const rlen = b[4 + b[3]];
            if (addr === 0x44) {
                if (w.length) shtPending = [...word(0x1234), ...word(0x5678)];
                return reply(0, 0xb1, shtPending.slice(0, rlen));
            }
            if (addr !== 0x6a) return reply(2, 0xb1, []);
            const r = regs[addr];
            if (w.length) {
                ptr[addr] = w[0];
                w.slice(1).forEach((v, i) => (r[w[0] + i] = v));
            }
            return reply(
                0,
                0xb1,
                Array.from({ length: rlen }, (_, i) => r[ptr[addr] + i] || 0)
            );
        };
        const bus = Q.createBus(send, { sleep: () => Promise.resolve() });
        const d = await SQ.discover(bus);
        ok(
            'discover identifies both parts',
            d.devices.length === 2 && d.devices.every((it) => it.ident && it.ident.ok),
            d.devices.map((it) => it.label + ':' + (it.ident && it.ident.detail)).join(' | ')
        );
        const declared = SQ.parseRigPeripherals({
            peripherals: [
                { name: 'env', kind: 'sht4x' },
                { name: 'tilt', kind: 'lsm6dsox', poll: 'trial_start', config: { bump_g: 0.5 } }
            ]
        }).list;
        const check = SQ.checkAgainstScan(declared, d);
        const res = await SQ.applySetup(bus, check, { armBump: false });
        ok(
            'setup configures the IMU without arming the bump latch',
            res.applied.tilt &&
                res.applied.tilt.odr_hz === 104 &&
                !('bump_ths' in res.applied.tilt) &&
                regs[0x6a][0x10] === 0x40 &&
                !regs[0x6a][0x5e]
        );
        const res2 = await SQ.applySetup(bus, check, { armBump: true });
        ok(
            'armBump (run-start owner) arms only trial_start devices',
            res2.applied.tilt.bump_ths === 16 &&
                regs[0x6a][0x5e] === 0x20 &&
                res2.errors.length === 0
        );
        const nj = await SQ.discover(
            Q.createBus(async (b) =>
                reply(1, b[1], Array.from(Buffer.from('No Qwiic jack on this hardware variant')))
            )
        );
        ok(
            'discover on a jack-less board → error, no throw',
            nj.error && nj.error.name === 'NoQwiicJack'
        );
        ok(
            'chip after a failed scan',
            SQ.chipState({ available: true, discovery: nj }).level === 'err'
        );
    }

    console.log('\n=== formatField ===');
    {
        ok(
            'number + unit',
            SQ.formatField({ key: 't', unit: '°C', digits: 2 }, { t: 22.456 }) === '22.46 °C'
        );
        ok(
            'signed',
            SQ.formatField({ key: 'p', unit: '°', digits: 1, signed: true }, { p: 3 }) === '+3.0 °'
        );
        ok('null → dash', SQ.formatField({ key: 'lux', unit: 'lx' }, { lux: null }) === '—');
        ok('flag', SQ.formatField({ key: 's', fmt: 'flag' }, { s: true }) === 'SATURATED');
        ok('okfail', SQ.formatField({ key: 'c', fmt: 'okfail' }, { c: false }) === 'FAIL');
        ok(
            'every KINDS display field formats a sample',
            Object.values(Q.KINDS).every((k) =>
                k.display.every((f) => typeof SQ.formatField(f, {}) === 'string')
            )
        );
        ok(
            'deviceLabel: category · part · addr · connection (name)',
            SQ.deviceLabel(item(0x44, 'sht4x'), 'env') ===
                'Temp / humidity · SHT4x · 0x44 · direct (env)'
        );
        ok(
            'connectionText: direct / mux · ch',
            SQ.connectionText(Q.located(0x44)) === 'direct' &&
                SQ.connectionText(Q.located(0x44, 0x70, 2)) === 'mux 0x70 · ch 2'
        );
        ok(
            'categoryOf: every kind has a category; mux + shadow labelled',
            Object.keys(Q.KINDS).every((k) => SQ.categoryOf({ kind: k }).length > 2) &&
                SQ.categoryOf({ mux: true }) === 'I2C mux' &&
                /all-call/.test(SQ.categoryOf({ shadow: true }))
        );
    }

    console.log('\n=== arena_studio.html wiring ===');
    {
        const html = fs.readFileSync(path.join(__dirname, '..', 'arena_studio.html'), 'utf8');
        const idx = (s) => html.indexOf(s);
        ok(
            'drivers + glue load as classic scripts after the wire module, before arena-link',
            idx('<script src="js/qwiic-drivers.js"') > idx('<script src="js/arena-wire-g6.js') &&
                idx('<script src="js/studio-qwiic.js"') >
                    idx('<script src="js/qwiic-drivers.js"') &&
                idx('<script src="js/arena-link.js"') > idx('<script src="js/studio-qwiic.js"')
        );
        ok(
            'ONE Qwiic panel + rail button',
            (html.match(/<section class="panel" data-panel="qwiic">/g) || []).length === 1 &&
                /class="rail-btn" data-panel="qwiic"/.test(html)
        );
        for (const id of [
            'cQwStatus',
            'cQwSel',
            'cQwOut',
            'cQwFlags',
            'cQwTable',
            'cQwLive',
            'cQwRate',
            'cQwYaml',
            'cQwCsv',
            'cQwBump',
            'cQwServo',
            'cQwSvCh',
            'cQwSvUs',
            'qwiicChip',
            'cQwSum'
        ]) {
            ok('element #' + id, html.includes('id="' + id + '"'));
        }
        for (const cmd of [
            'cqwscan',
            'cqwread',
            'cqwlive',
            'cqwcsv',
            'cqwyaml',
            'cqwbumparm',
            'cqwbumpcheck',
            'cqwsvgo',
            'cqwsvcenter',
            'cqwsvrelease',
            'cqwsvalloff'
        ]) {
            ok(
                'button + handler ' + cmd,
                html.includes('data-cmd="' + cmd + '"') &&
                    new RegExp('\\n\\s+' + cmd + ': ').test(html)
            );
        }
        ok(
            'quiet reads: the bus uses session.send with silent:true',
            /QD\.createBus\(\(b, o\) => session\.send\(b, o\), \{ sendOpts: \{ silent: true \} \}\)/.test(
                html
            )
        );
        ok(
            'scan refused during a run',
            /session\.running\) return \{ ok: false, reason: what === 'scan' \? 'refused — a run is active/.test(
                html
            )
        );
        ok(
            'connect-time setup scan from initFromController',
            /initFromController[\s\S]{0,900}Studio\.qwiicSetup\(\)/.test(html)
        );
        ok(
            'setup does not arm the bump latch (one owner: the run)',
            /SQ\.applySetup\(qwBus\(\), check, \{ armBump: false \}\)/.test(html)
        );
        ok(
            'disconnect resets the Qwiic state',
            /Studio\.qwiicReset\(\); \/\/ never carry/.test(html)
        );
        ok(
            'rig change re-checks without rescanning',
            /Studio\.qwiicRecheck\(\); \/\/ re-compare/.test(html)
        );
        ok(
            'rig fetch parses peripherals alongside io',
            /peripherals: SQ \? SQ\.parseRigPeripherals\(data\)/.test(html) &&
                /Studio\.fetchRigPeripherals = async function/.test(html)
        );
        ok(
            'one device at a time: radio rows in the scan table, no dropdown',
            /name="cQwPick"/.test(html) && !/id="cQwDev"/.test(html) && /tr\.qw-pick/.test(html)
        );
        ok(
            'Live stop restores the idle status (no sticky "live · N Hz")',
            /if \(was\) qwSetStatus\(qw\.idleStatus/.test(html) &&
                /if \(qw\.live\) qwSetStatus\('live · '/.test(html)
        );
        ok(
            'clicking a device reads it; Live keeps running across selections',
            /function qwSelect\(key\) \{[\s\S]{0,200}qwReadSelected\(\);/.test(html) &&
                !/qwStopLive\('device changed'\)/.test(html)
        );
        ok(
            'servo follows the slider while dragging (single-flight)',
            /const svLive = liveSender\(\(\) => qwServo\('go', \{ quiet: true \}\)\)/.test(html)
        );
        ok(
            'live level / duty / LED sliders go through liveSender',
            /const restreamLive = liveSender\(/.test(html) &&
                /const ledLive = liveSender\(/.test(html)
        );
        ok(
            'stream frames are sized to the firmware geometry (0xCB), not just 20 panels',
            /function streamTarget\(\)/.test(html) &&
                /Wire\.encodeStreamFrame\(payload, \{ panels \}\)/.test(html)
        );
        ok(
            'Test display color banks A–D via PanelColor.bankAt',
            ['cbank0', 'cbank1', 'cbank2', 'cbank3'].every((c) =>
                html.includes('data-cmd="' + c + '"')
            ) &&
                /function genBank\(k, level\)/.test(html) &&
                html.includes('<script src="js/panel-color.js"')
        );
        ok(
            'undeclared devices flagged in table + selection',
            /⚠ undeclared/.test(html) && /not in the rig YAML/.test(html)
        );
        ok(
            'HELP rail + chip + PANEL_HELP entries',
            html.includes(`'.rail-btn[data-panel="qwiic"]':`) &&
                html.includes(`'#qwiicChip':`) &&
                /\n\s+qwiic: 'Sensors on the Qwiic connector/.test(html)
        );
        ok('panel order rule', html.includes('.panel[data-panel="qwiic"]{order:10}'));
    }

    console.log('\n=== bench rigs + arena configs ===');
    {
        const YAML = require('../js/vendor/yaml/browser/dist/index.js');
        const AC = require('../js/arena-configs.js');
        const root = path.join(__dirname, '..');
        const index = JSON.parse(
            fs.readFileSync(path.join(root, 'configs/rigs/index.json'), 'utf8')
        );
        const cases = [
            {
                rig: 'g6_1x12of18_bench',
                arena: 'G6_1x12of18',
                rows: 1,
                cols: 18,
                installed: 12,
                id: 7,
                offset: -60,
                peripherals: 6
            },
            {
                rig: 'g6_3x10of14',
                arena: 'G6_3x10of14',
                rows: 3,
                cols: 14,
                installed: 10,
                id: 8,
                offset: -51.4286,
                peripherals: 0
            }
        ];
        for (const c of cases) {
            const cfg = AC.getConfig(c.arena);
            ok(
                c.arena + ': registered with geometry',
                !!cfg &&
                    cfg.arena.num_rows === c.rows &&
                    cfg.arena.num_cols === c.cols &&
                    cfg.arena.columns_installed.length === c.installed
            );
            ok(
                c.arena + ': arena ID ' + c.id,
                AC.getArenaId('G6', c.arena) === c.id && AC.getArenaName('G6', c.id) === c.arena
            );
            // Installed panels centered at the front: the gap's middle sits at the back (south).
            const alpha = 360 / c.cols;
            const gapMid = (c.installed + (c.cols - c.installed) / 2) * alpha; // degrees from column 0's edge
            ok(
                c.arena + ': offset centers the gap at the back',
                Math.abs(((((-gapMid + cfg.arena.angle_offset_deg) % 360) + 360) % 360) - 0) <
                    0.01 ||
                    Math.abs(((((-gapMid + cfg.arena.angle_offset_deg) % 360) + 360) % 360) - 360) <
                        0.01
            );
            const entry = index.rigs.find((r) => r.name === c.rig);
            ok(
                c.rig + ': index entry → arena + path',
                entry &&
                    entry.arena === c.arena &&
                    entry.path === './configs/rigs/' + c.rig + '.yaml'
            );
            const rig = YAML.parse(
                fs.readFileSync(path.join(root, 'configs/rigs', c.rig + '.yaml'), 'utf8')
            );
            ok(c.rig + ': rig arena', rig.arena === c.arena);
            const per = SQ.parseRigPeripherals(rig);
            ok(
                c.rig + ': peripherals parse clean (' + c.peripherals + ')',
                per.warnings.length === 0 && per.list.length === c.peripherals,
                per.warnings.join('; ')
            );
        }
    }

    console.log(`\n=== Summary ===\n${total - failures} / ${total} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
