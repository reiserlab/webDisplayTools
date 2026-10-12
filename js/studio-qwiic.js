/**
 * studio-qwiic.js — Arena Studio glue for the Qwiic peripherals (LAB-214),
 * DOM-free so it is Node-testable (tests/test-studio-qwiic.js). The register
 * maps live in js/qwiic-drivers.js; this file is about the RIG and the CHECK:
 *
 *   parseRigPeripherals(rigData)   rig YAML `peripherals:` → {list, warnings}.
 *                                  Tolerant like parseRigIo: never throws; a bad
 *                                  entry is dropped with a warning string.
 *   discover(bus)                  scan + mux map + identify every known part
 *                                  (the Console Scan, and step 1 of setup).
 *   checkAgainstScan(declared, d)  BOTH directions: declared-but-missing (error,
 *                                  never retried) and attached-but-undeclared
 *                                  (warning flag; Console-only, never logged).
 *   applySetup(bus, check, opts)   configure the declared, present, identified
 *                                  parts (PCA9685 ALLCALL off, IMU on, …).
 *   chipState(state)               the top-bar / rail chip text + level.
 *   toRigYaml(discovery, opts)     the "Copy as rig YAML" snippet.
 *   formatField(field, reading)    readout text for one KINDS display field.
 *
 * Scan only at SETUP (connect, Console Scan button, run start): GET_I2C_SCAN
 * stalls the controller loop ~10 ms, so never while a display runs.
 *
 * LOADING: classic <script src> after js/qwiic-drivers.js (window-global
 * `StudioQwiic` + CommonJS), no ES `export` (CLAUDE.md).
 */
(function (global) {
    'use strict';

    const Q =
        (typeof require === 'function' &&
            (() => {
                try {
                    return require('./qwiic-drivers.js');
                } catch (_) {
                    return null;
                }
            })()) ||
        global.QwiicDrivers;

    const hex2 = (a) => '0x' + (a & 0xff).toString(16).toUpperCase().padStart(2, '0');
    const POLL_INTERVAL_MIN_S = 0.5;
    const BOARD_BUDGET = 8; // pull-up stack: ~8 Adafruit-class boards (bench 2026-10-12)
    const SERVO_US_DEFAULT = { min_us: 1000, max_us: 2000 };
    const SERVO_US_LIMITS = { min_us: 500, max_us: 2500 };

    /** Location key: same address on a different mux channel is a different device. */
    const locKey = (d) =>
        (d.mux == null ? 'root' : hex2(d.mux) + '.' + d.channel) + ':' + hex2(d.addr);

    function parseAddress(v) {
        if (typeof v === 'number' && Number.isInteger(v)) return v;
        if (typeof v === 'string') {
            const s = v.trim();
            if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
            if (/^\d+$/.test(s)) return parseInt(s, 10);
        }
        return null;
    }

    function parsePoll(raw, label, warnings) {
        const poll = { trialStart: false, intervalS: null, onDemand: false };
        const items =
            raw === undefined || raw === null ? ['on_demand'] : Array.isArray(raw) ? raw : [raw];
        for (const it of items) {
            if (it === 'trial_start') poll.trialStart = true;
            else if (it === 'on_demand') poll.onDemand = true;
            else if (it && typeof it === 'object' && 'interval' in it) {
                const s = Number(it.interval);
                if (!Number.isFinite(s) || s <= 0) {
                    warnings.push(
                        label +
                            ': poll interval "' +
                            it.interval +
                            '" is not a positive number of seconds — ignored'
                    );
                } else if (s < POLL_INTERVAL_MIN_S) {
                    warnings.push(
                        label +
                            ': poll interval ' +
                            s +
                            ' s raised to the ' +
                            POLL_INTERVAL_MIN_S +
                            ' s minimum'
                    );
                    poll.intervalS = POLL_INTERVAL_MIN_S;
                } else poll.intervalS = s;
            } else {
                warnings.push(
                    label +
                        ': unknown poll "' +
                        JSON.stringify(it) +
                        '" — use trial_start | {interval: s} | on_demand'
                );
            }
        }
        if (!poll.trialStart && poll.intervalS == null) poll.onDemand = true;
        return poll;
    }

    function parseChannels(raw, label, warnings) {
        const out = {};
        if (raw === undefined || raw === null) return out;
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            warnings.push(
                label +
                    ': channels must be a mapping {name: channel | {channel, min_us, max_us}} — ignored'
            );
            return out;
        }
        for (const [name, v] of Object.entries(raw)) {
            const spec = typeof v === 'object' && v !== null ? v : { channel: v };
            const ch = Number(spec.channel);
            if (!Number.isInteger(ch) || ch < 0 || ch > 15) {
                warnings.push(label + ': channel "' + name + '" must be 0..15 — dropped');
                continue;
            }
            let min = spec.min_us === undefined ? SERVO_US_DEFAULT.min_us : Number(spec.min_us);
            let max = spec.max_us === undefined ? SERVO_US_DEFAULT.max_us : Number(spec.max_us);
            if (!(min >= SERVO_US_LIMITS.min_us && max <= SERVO_US_LIMITS.max_us && min < max)) {
                warnings.push(
                    label +
                        ': channel "' +
                        name +
                        '" pulse limits must satisfy 500 ≤ min_us < max_us ≤ 2500 — using 1000–2000'
                );
                min = SERVO_US_DEFAULT.min_us;
                max = SERVO_US_DEFAULT.max_us;
            }
            out[name] = { channel: ch, min_us: min, max_us: max };
        }
        return out;
    }

    /**
     * Rig YAML `peripherals:` → { list: [entry…], warnings: [string…] }.
     * entry = { name, kind, address, mux: null|{address, channel}, poll, config, channels }
     */
    function parseRigPeripherals(rigData) {
        const result = { list: [], warnings: [] };
        const raw = rigData && typeof rigData === 'object' ? rigData.peripherals : undefined;
        if (raw === undefined || raw === null) return result;
        if (!Array.isArray(raw)) {
            result.warnings.push('peripherals must be a list — ignored');
            return result;
        }
        const names = new Set();
        const locs = new Set();
        raw.forEach((e, i) => {
            const label = 'peripherals[' + i + ']';
            if (!e || typeof e !== 'object' || Array.isArray(e)) {
                result.warnings.push(label + ': not a mapping — dropped');
                return;
            }
            const kind = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
            const K = Q.KINDS[kind];
            if (!K) {
                result.warnings.push(
                    label +
                        ': unknown kind "' +
                        e.kind +
                        '" (known: ' +
                        Object.keys(Q.KINDS).join(', ') +
                        ') — dropped'
                );
                return;
            }
            let address = e.address === undefined ? K.addresses[0] : parseAddress(e.address);
            if (address === null || address < 0x08 || address > 0x77) {
                result.warnings.push(
                    label +
                        ': address "' +
                        e.address +
                        '" must be a 7-bit address 0x08..0x77 — dropped'
                );
                return;
            }
            if (!K.addresses.includes(address)) {
                result.warnings.push(
                    label +
                        ': ' +
                        K.label +
                        ' at ' +
                        hex2(address) +
                        ' (expected ' +
                        K.addresses.map(hex2).join('/') +
                        ') — kept; check the address straps'
                );
            }
            let mux = null;
            if (e.mux !== undefined && e.mux !== null) {
                const ma =
                    e.mux && typeof e.mux === 'object'
                        ? parseAddress(e.mux.address === undefined ? 0x70 : e.mux.address)
                        : null;
                const mc = e.mux && typeof e.mux === 'object' ? Number(e.mux.channel) : NaN;
                if (ma === null || !Q.isMux(ma) || !Number.isInteger(mc) || mc < 0 || mc > 7) {
                    result.warnings.push(
                        label + ': mux must be {address: 0x70..0x77, channel: 0..7} — dropped'
                    );
                    return;
                }
                mux = { address: ma, channel: mc };
            }
            const name =
                e.name === undefined
                    ? kind + '_' + address.toString(16).padStart(2, '0')
                    : String(e.name);
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
                result.warnings.push(
                    label +
                        ': name "' +
                        name +
                        '" must be letters/digits/underscore, starting with a letter — dropped'
                );
                return;
            }
            if (names.has(name)) {
                result.warnings.push(label + ': duplicate name "' + name + '" — dropped');
                return;
            }
            const key = locKey({
                addr: address,
                mux: mux && mux.address,
                channel: mux && mux.channel
            });
            if (locs.has(key)) {
                result.warnings.push(
                    label +
                        ': "' +
                        name +
                        '" is at the same address/mux channel as an earlier entry (' +
                        key +
                        ') — dropped'
                );
                return;
            }
            let poll = parsePoll(e.poll, label + ' (' + name + ')', result.warnings);
            if (K.role === 'actuator' && (poll.trialStart || poll.intervalS != null)) {
                result.warnings.push(
                    label + ' (' + name + '): ' + K.label + ' is an actuator — poll ignored'
                );
                poll = { trialStart: false, intervalS: null, onDemand: true };
            }
            let config = {};
            if (e.config !== undefined && e.config !== null) {
                if (typeof e.config === 'object' && !Array.isArray(e.config))
                    config = Object.assign({}, e.config);
                else
                    result.warnings.push(
                        label + ' (' + name + '): config must be a mapping — ignored'
                    );
            }
            const channels =
                kind === 'pca9685'
                    ? parseChannels(e.channels, label + ' (' + name + ')', result.warnings)
                    : {};
            names.add(name);
            locs.add(key);
            result.list.push({ name, kind, address, mux, poll, config, channels });
        });
        if (result.list.length > BOARD_BUDGET) {
            result.warnings.push(
                result.list.length +
                    ' peripherals declared: beyond ~' +
                    BOARD_BUDGET +
                    ' boards the bus pull-ups stack below the I2C 3 mA floor (bench 2026-10-12) — cut pull-up jumpers or use the mux'
            );
        }
        return result;
    }

    const declaredLoc = (p) => ({
        addr: p.address,
        mux: p.mux ? p.mux.address : null,
        channel: p.mux ? p.mux.channel : null
    });

    /**
     * Scan + mux map + identify every known part. Holds the bus per step, never
     * applies configuration. → { at, scan, shadow, devices: [{dev, key, kind, label,
     * where, ident: {ok, detail, info}|null, driver}], error }
     */
    async function discover(bus) {
        const out = { at: Date.now(), scan: [], shadow: null, devices: [], error: null };
        let loc;
        try {
            loc = await Q.locateDevices(bus);
        } catch (e) {
            out.error = e;
            return out;
        }
        out.scan = loc.scan;
        out.shadow = loc.shadow;
        for (const dev of loc.devices) {
            const item = {
                dev,
                key: locKey(dev),
                kind: null,
                label: Q.describe(dev.addr),
                where: Q.where(dev),
                ident: null,
                driver: null
            };
            if (dev.addr === loc.shadow && dev.mux == null) {
                item.label = 'PCA9685 all-call address (MODE1.ALLCALL set) — not a mux';
                item.shadow = true;
            } else if (Q.isMux(dev.addr) && dev.mux == null) {
                item.mux = true;
            } else {
                const kind = Q.kindForAddress(dev.addr);
                if (kind) {
                    const r = await Q.identifyDevice(bus, dev, kind);
                    item.kind = kind;
                    item.label = Q.KINDS[kind].label;
                    item.driver = r.driver;
                    item.ident = { ok: r.ok, detail: r.detail, info: r.info || {} };
                }
                if (dev.addr === Q.MCP4725_ADDR) item.wiringError = true;
            }
            out.devices.push(item);
        }
        return out;
    }

    /**
     * Compare the rig's declaration with what is on the bus — both directions.
     * → { entries: [{decl, status: ok|missing|id_fail|wrong_location, detail, item}],
     *     undeclared: [item…], counts, ok }
     */
    function checkAgainstScan(declared, discovery) {
        const list = declared || [];
        const devices = (discovery && discovery.devices) || [];
        const used = new Set();
        const whereOf = (decl) =>
            connectionText({
                mux: decl.mux ? decl.mux.address : null,
                channel: decl.mux ? decl.mux.channel : null
            });
        // Pass 1: exact location matches claim their devices first, so a same-address
        // device elsewhere is only offered to entries that found nothing.
        const exact = list.map((decl) => {
            const it = devices.find((d) => Q.sameLocation(d.dev, declaredLoc(decl)));
            if (it) used.add(it.key);
            return it || null;
        });
        const entries = list.map((decl, i) => {
            const K = Q.KINDS[decl.kind];
            const where = whereOf(decl);
            const item = exact[i];
            if (item) {
                if (item.ident && !item.ident.ok) {
                    return {
                        decl,
                        item,
                        status: 'id_fail',
                        detail:
                            K.label +
                            ' ' +
                            hex2(decl.address) +
                            ' answered but failed its ID check: ' +
                            item.ident.detail
                    };
                }
                return {
                    decl,
                    item,
                    status: 'ok',
                    detail:
                        K.label +
                        ' ' +
                        hex2(decl.address) +
                        ' @ ' +
                        where +
                        (item.ident ? ' — ' + item.ident.detail : '')
                };
            }
            const elsewhere = devices.find(
                (d) => d.dev.addr === decl.address && !used.has(d.key) && !d.shadow
            );
            if (elsewhere) {
                used.add(elsewhere.key);
                return {
                    decl,
                    item: elsewhere,
                    status: 'wrong_location',
                    detail:
                        K.label +
                        ' ' +
                        hex2(decl.address) +
                        ' declared @ ' +
                        where +
                        ' but found @ ' +
                        connectionText(elsewhere.dev)
                };
            }
            const hint =
                K.role === 'actuator'
                    ? ' (self-powered boards such as the Servo pHAT vanish from the bus when their own supply is off)'
                    : '';
            return {
                decl,
                item: null,
                status: 'missing',
                detail:
                    K.label +
                    ' ' +
                    hex2(decl.address) +
                    ' (' +
                    decl.name +
                    ') declared in the rig YAML but not on the Qwiic bus' +
                    hint
            };
        });
        // Muxes that carry a declared device are implicitly declared; the PCA9685 shadow is not a device.
        const declaredMuxes = new Set(list.filter((p) => p.mux).map((p) => p.mux.address));
        const undeclared = devices.filter(
            (it) => !used.has(it.key) && !it.shadow && !(it.mux && declaredMuxes.has(it.dev.addr))
        );
        const counts = {
            declared: list.length,
            ok: entries.filter((e) => e.status === 'ok').length,
            missing: entries.filter((e) => e.status === 'missing').length,
            idFail: entries.filter((e) => e.status === 'id_fail').length,
            wrongLocation: entries.filter((e) => e.status === 'wrong_location').length,
            undeclared: undeclared.length,
            devices: devices.filter((it) => !it.shadow).length
        };
        return { entries, undeclared, counts, ok: counts.ok === counts.declared };
    }

    /**
     * Configure the declared parts that are present and identified. Holds the bus
     * per device; failures are recorded, never thrown.
     * opts.armBump: arm the LSM6DSOX latch (the run-start owner does this, PR 2).
     * → { applied: {name: cfg}, errors: [{name, message}] }
     */
    async function applySetup(bus, check, opts) {
        const o = opts || {};
        const out = { applied: {}, errors: [] };
        for (const e of (check && check.entries) || []) {
            if (e.status !== 'ok' || !e.item || !e.item.driver) continue;
            const K = Q.KINDS[e.decl.kind];
            try {
                out.applied[e.decl.name] = await Q.withDevice(bus, e.item.dev, () =>
                    K.setup(e.item.driver, e.decl.config, {
                        armBump: !!o.armBump && e.decl.poll.trialStart
                    })
                );
            } catch (err) {
                out.errors.push({ name: e.decl.name, message: err.message });
            }
        }
        return out;
    }

    /**
     * Chip for the top bar / Console rail.
     * state = { available: bool, reason?, declared: [...], check?, discovery? }
     * → { text, level: off|ok|warn|err, title }
     */
    function chipState(state) {
        const s = state || {};
        if (!s.available)
            return {
                text: 'Qwiic —',
                level: 'off',
                title: s.reason || 'no Qwiic I2C bridge on this controller'
            };
        if (s.discovery && s.discovery.error) {
            return { text: 'Qwiic: scan failed', level: 'err', title: s.discovery.error.message };
        }
        const c = s.check;
        if (!c) return { text: 'Qwiic …', level: 'off', title: 'not scanned yet' };
        const n = c.counts;
        const und = n.undeclared ? ' · ' + n.undeclared + ' undeclared' : '';
        const bad = c.entries.filter((e) => e.status !== 'ok');
        if (bad.length) {
            const first = bad[0];
            const K = Q.KINDS[first.decl.kind];
            const what =
                first.status === 'missing'
                    ? 'missing'
                    : first.status === 'id_fail'
                      ? 'failed ID'
                      : 'wrong mux channel';
            return {
                text:
                    'Qwiic: ' +
                    K.label +
                    ' ' +
                    hex2(first.decl.address) +
                    ' ' +
                    what +
                    (bad.length > 1 ? ' +' + (bad.length - 1) : '') +
                    und,
                level: 'err',
                title: bad.map((e) => e.detail).join('\n')
            };
        }
        if (!n.declared) {
            return {
                text: 'Qwiic: ' + n.devices + ' device' + (n.devices === 1 ? '' : 's') + und,
                level: n.undeclared ? 'warn' : 'ok',
                title: n.undeclared
                    ? 'Attached but not in the rig YAML — Console → Qwiic → Copy as rig YAML'
                    : 'Qwiic bus scanned'
            };
        }
        return {
            text: 'Qwiic ✓ ' + n.ok + '/' + n.declared + und,
            level: n.undeclared ? 'warn' : 'ok',
            title: n.undeclared
                ? n.undeclared +
                  ' attached device(s) not in the rig YAML — Console → Qwiic → Copy as rig YAML'
                : 'every declared peripheral is on the bus'
        };
    }

    const SUGGESTED_POLL = { env: 'trial_start', tilt: 'trial_start', light: 'on_demand' };

    /**
     * "Copy as rig YAML": a `peripherals:` snippet from a discovery. opts.only:
     * an array of items (e.g. check.undeclared) to emit just those entries.
     */
    function toRigYaml(discovery, opts) {
        const o = opts || {};
        const items = o.only || (discovery && discovery.devices) || [];
        const lines = ['peripherals:'];
        const used = new Set();
        for (const it of items) {
            if (it.shadow || it.mux) continue;
            if (!it.kind) {
                lines.push(
                    '  # ' + hex2(it.dev.addr) + ' @ ' + it.where + ': ' + it.label + ' — no driver'
                );
                continue;
            }
            const K = Q.KINDS[it.kind];
            let name = it.kind + '_' + it.dev.addr.toString(16).padStart(2, '0');
            if (it.dev.mux != null) name += '_m' + it.dev.channel;
            while (used.has(name)) name += '_';
            used.add(name);
            lines.push('  - name: ' + name);
            lines.push('    kind: ' + it.kind);
            lines.push('    address: ' + hex2(it.dev.addr));
            if (it.dev.mux != null)
                lines.push(
                    '    mux: {address: ' + hex2(it.dev.mux) + ', channel: ' + it.dev.channel + '}'
                );
            if (SUGGESTED_POLL[K.role]) lines.push('    poll: ' + SUGGESTED_POLL[K.role]);
            if (it.kind === 'pca9685') {
                lines.push('    config: {freq_hz: 50}');
                lines.push('    channels: {servo0: {channel: 0, min_us: 1000, max_us: 2000}}');
            }
        }
        return lines.join('\n') + '\n';
    }

    /** Readout text for one KINDS display field. */
    function formatField(field, reading) {
        const v = reading ? reading[field.key] : undefined;
        if (v === undefined || v === null) return '—';
        switch (field.fmt) {
            case 'okfail':
                return v ? 'ok' : 'FAIL';
            case 'flag':
                return v ? 'SATURATED' : 'no';
            case 'onoff':
                return v ? 'on' : 'off';
            case 'sleep':
                return v ? 'asleep (not configured)' : 'running';
            case 'bars':
                return '';
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
        const digits = field.digits === undefined ? 2 : field.digits;
        const text = (field.signed && v >= 0 ? '+' : '') + v.toFixed(digits);
        return field.unit ? text + ' ' + field.unit : text;
    }

    /**
     * How the device is reached, for people: "direct" (on the controller's own
     * Qwiic chain — the drivers call it "root") or "mux 0x70 · ch 2" (behind a
     * PCA9548 channel, only needed for two identical fixed-address parts).
     */
    function connectionText(dev) {
        return dev.mux == null ? 'direct' : 'mux ' + hex2(dev.mux) + ' · ch ' + dev.channel;
    }

    /** Short category label: "Temp / humidity", "Servo / PWM", "I2C mux", … */
    function categoryOf(item) {
        if (item.kind) return Q.KINDS[item.kind].category;
        if (item.shadow) return '(PCA9685 all-call)';
        if (item.mux) return 'I2C mux';
        return 'unknown';
    }

    /** One device's label: "Temp / humidity · SHT4x · 0x44 · direct (env)". */
    function deviceLabel(item, declaredName) {
        const base =
            categoryOf(item) +
            ' · ' +
            (item.kind ? Q.KINDS[item.kind].label : item.label) +
            ' · ' +
            hex2(item.dev.addr) +
            ' · ' +
            connectionText(item.dev);
        return declaredName ? base + ' (' + declaredName + ')' : base;
    }

    const StudioQwiic = {
        parseRigPeripherals,
        discover,
        checkAgainstScan,
        applySetup,
        chipState,
        toRigYaml,
        formatField,
        deviceLabel,
        connectionText,
        categoryOf,
        locKey,
        parseAddress,
        BOARD_BUDGET,
        POLL_INTERVAL_MIN_S,
        SERVO_US_DEFAULT,
        SERVO_US_LIMITS
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = StudioQwiic;
    global.StudioQwiic = StudioQwiic;
})(typeof window !== 'undefined' ? window : globalThis);
