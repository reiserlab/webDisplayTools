#!/usr/bin/env node
/**
 * test-qwiic-drivers.js — js/qwiic-drivers.js against a simulated Qwiic bus
 * (no hardware). Vectors ported from the firmware repo's
 * tests/test_qwiic_sensors_unit.py + tests/test_qwiic_peripherals_unit.py, plus
 * the bench quirks (SHT4x two-leg read, LSM6DSOX latch, PCA9685 all-call shadow),
 * the bus mutex, and mux location. LAB-214.
 *
 *   pixi run node tests/test-qwiic-drivers.js
 */
'use strict';

const Q = require('../js/qwiic-drivers.js');
const Wire = require('../js/arena-wire-g6.js');

let failures = 0;
let total = 0;
function ok(name, cond, info) {
    total++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? ' — ' + info : ''}`);
    if (!cond) failures++;
}
const close = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);
const hex = (b) =>
    Array.from(b)
        .map((x) => x.toString(16).padStart(2, '0'))
        .join(' ');

// ── simulated bus ───────────────────────────────────────────────────────────
// Register-file device: a write sets the pointer (first byte) and stores the rest
// with auto-increment; a read returns bytes from the pointer. Pointer keys are the
// raw bytes written, so TSL2591's CMD bit is just part of the key.
class RegDevice {
    constructor(regs) {
        this.regs = Object.assign({}, regs || {});
        this.ptr = 0;
        this.writes = [];
    }
    write(w) {
        if (!w.length) return;
        this.ptr = w[0];
        for (let i = 1; i < w.length; i++) this.regs[(w[0] + i - 1) & 0xff] = w[i];
        if (w.length > 1) this.writes.push([w[0], ...w.slice(1)]);
        this.onWrite && this.onWrite(w);
    }
    read(n) {
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.readByte((this.ptr + i) & 0xff));
        return out;
    }
    readByte(reg) {
        return this.regs[reg] === undefined ? 0 : this.regs[reg];
    }
}

// SHT4x: command byte → 6-byte frame; NACKs a read while "measuring" if read in
// the same transfer as the command (repeated start).
class ShtDevice {
    constructor(tRaw, rhRaw, serial) {
        this.t = tRaw;
        this.rh = rhRaw;
        this.serial = serial;
        this.pending = null;
    }
    word(v) {
        const b = [(v >> 8) & 0xff, v & 0xff];
        return [...b, Q.crc8Sensirion(b)];
    }
    write(w) {
        if (!w.length) return; // the read leg (plain read) carries no command
        if (w[0] === 0x89)
            this.pending = [...this.word(this.serial >>> 16), ...this.word(this.serial & 0xffff)];
        else this.pending = [...this.word(this.t), ...this.word(this.rh)];
    }
    read(n) {
        return (this.pending || []).slice(0, n);
    }
}

// PCA9548: one control register; channel k exposes `channels[k]` devices.
class MuxDevice {
    constructor(channels) {
        this.mask = 0;
        this.channels = channels || {};
    }
    write(w) {
        if (w.length) this.mask = w[0];
    }
    read() {
        return [this.mask];
    }
}

function createSim(devices, opts) {
    const o = opts || {};
    const log = [];
    function visible() {
        const out = new Map(Object.entries(devices).map(([a, d]) => [Number(a), d]));
        for (const [a, d] of Object.entries(devices)) {
            if (d instanceof MuxDevice) {
                for (let ch = 0; ch < 8; ch++) {
                    if (!(d.mask & (1 << ch))) continue;
                    for (const [ca, cd] of Object.entries(d.channels[ch] || {}))
                        out.set(Number(ca), cd);
                }
            }
        }
        // PCA9685 at 0x40 with ALLCALL set also answers 0x70 (reads return MODE1).
        const pca = out.get(0x40);
        if (pca && pca.isPca && pca.regs[0x00] & 0x01 && !out.has(0x70)) {
            out.set(0x70, { write() {}, read: (n) => new Array(n).fill(pca.regs[0x00]) });
        }
        return out;
    }
    const reply = (status, cmd, payload) =>
        Uint8Array.from([2 + payload.length, status, cmd, ...payload]);
    async function send(bytes) {
        const b = Array.from(bytes);
        log.push(hex(b));
        if (o.noJack)
            return reply(
                1,
                b[1],
                Array.from(Buffer.from('No Qwiic jack on this hardware variant'))
            );
        if (b[1] === 0xb0) {
            const addrs = [...visible().keys()]
                .filter((a) => a >= 0x08 && a <= 0x77)
                .sort((x, y) => x - y);
            return reply(0, 0xb0, [addrs.length, ...addrs]);
        }
        if (b[1] === 0xb1) {
            const addr = b[2];
            const wlen = b[3];
            const w = b.slice(4, 4 + wlen);
            const rlen = b[4 + wlen];
            const dev = visible().get(addr);
            if (!dev) return reply(2, 0xb1, Array.from(Buffer.from('I2C address NACK')));
            if (dev instanceof ShtDevice && wlen > 0 && rlen > 0)
                return reply(2, 0xb1, Array.from(Buffer.from('I2C address NACK')));
            dev.write(w);
            return reply(0, 0xb1, rlen ? dev.read(rlen) : []);
        }
        return reply(1, b[1], []);
    }
    return { send, log, devices };
}

const noSleep = () => Promise.resolve();

(async () => {
    console.log('\n=== vectors ported from the Python unit tests ===');
    ok('Sensirion CRC datasheet vector 0xBEEF → 0x92', Q.crc8Sensirion([0xbe, 0xef]) === 0x92);
    ok('Sensirion CRC 0x0000 → 0x81', Q.crc8Sensirion([0, 0]) === 0x81);
    {
        const g = Q.unpackSensirionWords([0xbe, 0xef, 0x92, 0, 0, 0x81]);
        ok('unpack words good', g.ok && g.words[0] === 0xbeef && g.words[1] === 0);
        ok(
            'unpack words flags a bad CRC',
            !Q.unpackSensirionWords([0xbe, 0xef, 0x93, 0, 0, 0x81]).ok
        );
    }
    {
        let [t, rh] = Q.SHT4x.convert(0, 0);
        ok('SHT4x convert 0,0 → -45 °C, RH clipped 0', t === -45 && rh === 0);
        [t, rh] = Q.SHT4x.convert(0xffff, 0xffff);
        ok('SHT4x convert max → 130 °C, RH clipped 100', close(t, 130) && rh === 100);
        [t, rh] = Q.SHT4x.convert(0x62ac, 0x8e85);
        ok(
            'SHT4x bench frame 2026-10-12 → 22.45 °C 63.6 %RH',
            close(t, 22.45, 0.01) && close(rh, 63.6, 0.1),
            t.toFixed(2) + ' ' + rh.toFixed(1)
        );
    }
    {
        const T = Q.LSM6DSOX.tilt;
        const flat = T([0, 0, 1]);
        ok(
            'tilt flat',
            close(flat.from_vertical_deg, 0) &&
                close(flat.pitch_deg, 0) &&
                close(flat.roll_deg, 0) &&
                close(flat.accel_norm_g, 1)
        );
        const edge = T([1, 0, 0]);
        ok('tilt on edge = 90°', close(edge.from_vertical_deg, 90) && close(edge.pitch_deg, 90));
        ok(
            'tilt upside down = 0° (inclination, not orientation)',
            close(T([0, 0, -1]).from_vertical_deg, 0)
        );
        const r = (10 * Math.PI) / 180;
        ok('tilt 10°', close(T([Math.sin(r), 0, Math.cos(r)]).from_vertical_deg, 10, 1e-9));
        ok('tilt zero vector → NaN', Number.isNaN(T([0, 0, 0]).pitch_deg));
        const imu = new Q.LSM6DSOX(null);
        ok('LSM6DSOX 1 g at ±2 g', close(16393 * imu.accelGPerLsb, 1.0, 0.001));
        ok('LSM6DSOX gyro 8.75 mdps/LSB', close(imu.gyroDpsPerLsb, 8.75e-3));
    }
    {
        const P = Q.PCA9685;
        ok('PCA9685 prescale 50 Hz = 121', P.prescaleFor(50) === 121);
        ok('PCA9685 prescale 121 = 50.03 Hz', close(P.freqForPrescale(121), 50.03, 0.01));
        ok(
            'PCA9685 prescale clamps 3..255',
            P.prescaleFor(10000) === 3 && P.prescaleFor(1) === 255
        );
        const pwm = new P(null);
        pwm.freqHz = P.freqForPrescale(121);
        ok('PCA9685 1500 µs → 307 counts', pwm.pulseToCounts(1500) === 307);
        ok(
            'PCA9685 pulse clamps 0..4095',
            pwm.pulseToCounts(0) === 0 && pwm.pulseToCounts(1e6) === 4095
        );
    }
    {
        const T = Q.TSL2591;
        ok('TSL2591 ceiling 36863 at 100 ms', T.ceilingFor(100) === 36863);
        ok(
            'TSL2591 ceiling 65535 otherwise',
            [200, 300, 400, 500, 600].every((a) => T.ceilingFor(a) === 65535)
        );
        const s = new T(null);
        const atCeil = s.decode(1, 36863, 10);
        ok(
            'TSL2591 saturated at the ceiling (not 0xFFFF)',
            atCeil.sat && atCeil.lux_approx === null
        );
        const below = s.decode(1, 36862, 10);
        ok('TSL2591 just below ceiling → lux', !below.sat && below.lux_approx !== null);
        ok('TSL2591 IR-only saturation', s.decode(1, 5000, 36863).sat);
        s.atimeMs = 200;
        ok('TSL2591 40000 counts at 200 ms not saturated', !s.decode(1, 40000, 10).sat);
        s.atimeMs = 100;
        const dark = s.decode(1, 0, 0);
        ok('TSL2591 dark is not saturated, lux null', !dark.sat && dark.lux_approx === null);
    }

    console.log('\n=== bus ===');
    {
        const sim = createSim({ 0x10: new RegDevice({ 0x07: 0x81 }) });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const scan = await bus.scan();
        ok('scan', scan.join(',') === '16');
        ok('ack present', (await bus.ack(0x10)) === true);
        ok('ack absent → false (address NACK)', (await bus.ack(0x44)) === false);
        let err = null;
        try {
            await bus.readReg(0x44, 0x00, 1);
        } catch (e) {
            err = e;
        }
        ok(
            'NACK → I2CError status 2',
            err instanceof Q.I2CError && err.status === 2 && /0x44: address NACK/.test(err.message),
            err && err.message
        );
        const nj = Q.createBus(createSim({}, { noJack: true }).send, { sleep: noSleep });
        let e2 = null;
        try {
            await nj.scan();
        } catch (e) {
            e2 = e;
        }
        ok('no-jack firmware → NoQwiicJack', e2 instanceof Q.NoQwiicJack);
        let e3 = null;
        try {
            await nj.xfer(0x10, [0], 1);
        } catch (e) {
            e3 = e;
        }
        ok('no-jack on transfer → NoQwiicJack', e3 instanceof Q.NoQwiicJack);
    }

    console.log('\n=== mutex ===');
    {
        // Two sequences that both sleep mid-way must not interleave their transfers.
        const sim = createSim({ 0x10: new RegDevice(), 0x29: new RegDevice() });
        const bus = Q.createBus(sim.send, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
        const a = bus.exclusive(async () => {
            await bus.xfer(0x10, [1], 0);
            await bus.sleep(15);
            await bus.xfer(0x10, [2], 0);
        });
        const b = bus.exclusive(async () => {
            await bus.xfer(0x29, [3], 0);
            await bus.sleep(1);
            await bus.xfer(0x29, [4], 0);
        });
        await Promise.all([a, b]);
        const order = sim.log.map((l) => l.split(' ')[2]).join(',');
        ok('exclusive sequences never interleave', order === '10,10,29,29', order);
        const failing = bus.exclusive(async () => {
            throw new Error('boom');
        });
        let threw = false;
        try {
            await failing;
        } catch (_) {
            threw = true;
        }
        const after = await bus.exclusive(async () => 'next');
        ok('a throwing sequence releases the bus', threw && after === 'next' && bus.held === false);
    }

    console.log('\n=== SHT4x two-leg read (bench quirk) ===');
    {
        const sim = createSim({ 0x44: new ShtDevice(0x62ac, 0x8e85, 0x14dcf709) });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const s = new Q.SHT4x(bus);
        const id = await s.identify();
        ok('SHT4x serial + CRC', id.serial === 0x14dcf709 && id.crc_ok, id.serial.toString(16));
        sim.log.length = 0;
        const r = await s.read();
        ok(
            'SHT4x read = separate write leg then read leg',
            sim.log.join(' | ') === '05 b1 44 01 fd 00 | 04 b1 44 00 06',
            sim.log.join(' | ')
        );
        ok('SHT4x reading', close(r.temp_c, 22.45, 0.01) && close(r.rh_pct, 63.6, 0.1) && r.crc_ok);
    }

    console.log('\n=== LSM6DSOX bump latch (bench quirk) ===');
    {
        const imu = new RegDevice({ 0x0f: 0x6c });
        // WAKE_UP_SRC clears on read only with LIR + INT_CLR_ON_READ + INT1_WU routing.
        imu.readByte = function (reg) {
            const v = this.regs[reg] || 0;
            if (reg === 0x1b && (this.regs[0x56] & 0x41) === 0x41 && this.regs[0x5e] & 0x20)
                this.regs[0x1b] = 0;
            return v;
        };
        // accel block: z = +1 g (16393 LSB at ±2 g), temp raw 0 → 25 °C
        Object.assign(imu.regs, { 0x26: 0, 0x27: 0, 0x2c: 16393 & 0xff, 0x2d: 16393 >> 8 });
        const sim = createSim({ 0x6a: imu });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const s = new Q.LSM6DSOX(bus);
        ok('identify WHO_AM_I 0x6C', (await s.identify()).id_ok);
        await s.configure();
        ok(
            'configure: BDU+IF_INC, 104 Hz ±2 g',
            imu.regs[0x12] === 0x44 && imu.regs[0x10] === 0x40
        );
        const ths = await s.armBump(0.25);
        ok('armBump: threshold 8 LSB at ±2 g', ths === 8 && imu.regs[0x5b] === 8);
        ok('armBump: LIR + INT_CLR_ON_READ', imu.regs[0x56] === 0x41);
        ok('armBump: INT1_WU routing (what latches)', imu.regs[0x5e] === 0x20);
        ok('armBump: interrupts enabled', imu.regs[0x58] === 0x80);
        imu.regs[0x1b] = 0x08 | 0x04; // WU_IA + X
        const b1 = await s.bumpFlag();
        ok('bumpFlag reports the event + axis', b1.bumped && b1.axes === 'X');
        const b2 = await s.bumpFlag();
        ok('bumpFlag cleared on read', !b2.bumped);
        const r = await s.read();
        ok(
            'read: |a| ≈ 1 g flat, die 25 °C',
            close(r.accel_norm_g, 1, 0.002) && close(r.from_vertical_deg, 0, 0.1) && r.temp_c === 25
        );
    }

    console.log('\n=== PCA9685 all-call shadow + servo ===');
    {
        const pca = new RegDevice({ 0x00: 0x11, 0xfe: 30 });
        pca.isPca = true;
        const sim = createSim({ 0x40: pca });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const loc = await Q.locateDevices(bus);
        ok('scan sees 0x40 and its 0x70 shadow', loc.scan.join(',') === '64,112');
        ok('0x70 recognized as the all-call shadow', loc.shadow === 0x70);
        ok(
            'no mux channels mapped through the shadow',
            loc.devices.every((d) => d.mux === null) && loc.devices.length === 2
        );
        const s = new Q.PCA9685(bus);
        const id = await s.identify();
        ok(
            'identify: POR MODE1 0x11 SLEEP+ALLCALL, prescale 30 ≈ 197 Hz',
            id.sleeping && id.allcall && Math.round(id.freq_hz) === 197
        );
        await s.configure({ freq_hz: 50 });
        ok(
            'configure: prescale 121, ALLCALL cleared, awake, AI',
            pca.regs[0xfe] === 121 &&
                !(pca.regs[0x00] & 0x01) &&
                !(pca.regs[0x00] & 0x10) &&
                pca.regs[0x00] & 0x20
        );
        ok('after configure 0x70 leaves the scan', (await bus.scan()).join(',') === '64');
        const off = await s.setPulseUs(0, 1500);
        const counts = await s.readCounts(0);
        ok(
            '1500 µs → OFF 307 written + read back',
            off === 307 && counts[1] === 307 && counts[0] === 0
        );
        await s.setOff(0);
        ok('setOff sets the full-OFF bit', (await s.readCounts(0))[1] === 0x1000);
        let threw = false;
        try {
            await s.setPulseUs(16, 1500);
        } catch (_) {
            threw = true;
        }
        ok('channel 16 rejected', threw);
    }

    console.log('\n=== PCA9548 mux location (unverified on hardware) ===');
    {
        const sht = new ShtDevice(0x62ac, 0x8e85, 1);
        const mux = new MuxDevice({ 2: { 0x44: sht } });
        const sim = createSim({ 0x70: mux, 0x29: new RegDevice({ 0xb2: 0x50 }) });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const loc = await Q.locateDevices(bus);
        const behind = loc.devices.find((d) => d.addr === 0x44);
        ok(
            'device behind mux ch2 located',
            behind && behind.mux === 0x70 && behind.channel === 2,
            behind && Q.where(behind)
        );
        ok('mux mask restored after the walk', mux.mask === 0);
        const r = await Q.withDevice(bus, behind, () => new Q.SHT4x(bus).read());
        ok('read through the mux', close(r.temp_c, 22.45, 0.01) && mux.mask === 0);
        ok(
            'where() text',
            Q.where(behind) === 'mux 0x70 ch2' && Q.where({ addr: 1, mux: null }) === 'root'
        );
    }

    console.log('\n=== light sensors ===');
    {
        const tsl = new RegDevice({
            0xb2: 0x50,
            0xb3: 0x01,
            0xb4: 1000 & 0xff,
            0xb5: 1000 >> 8,
            0xb6: 100,
            0xb7: 0
        });
        // VEML7700 registers are 16-bit words; the sim's flat byte file only needs ID 0x0081.
        const veml = new RegDevice({ 0x07: 0x81, 0x08: 0x00 });
        const sim = createSim({ 0x29: tsl, 0x10: veml });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const t = new Q.TSL2591(bus);
        ok('TSL2591 identify', (await t.identify()).id_ok);
        await t.configure({ gain: 'high', atime_ms: 200 });
        ok(
            'TSL2591 configure CONTROL = gain high | 200 ms',
            tsl.regs[0xa1] === 0x21 && tsl.regs[0xa0] === 0x03
        );
        const r = await t.read();
        ok(
            'TSL2591 read full/ir/visible',
            r.full === 1000 && r.ir === 100 && r.visible === 900 && !r.sat && r.valid
        );
        const v = new Q.VEML7700(bus);
        ok('VEML7700 id ok', (await v.identify()).device_id_ok);
    }
    {
        const as = new RegDevice({ 0x5a: 0x81, 0x59: 0x01, 0x58: 0x02 });
        as.readByte = function (reg) {
            if (reg === 0x90) return 0x40; // AVALID
            if (reg === 0x94) return 0x00; // ASTATUS
            if (reg >= 0x95 && reg < 0x95 + 36) {
                const i = (reg - 0x95) >> 1; // channel i = 100 * (i+1)
                const v = 100 * (i + 1);
                return (reg - 0x95) & 1 ? v >> 8 : v & 0xff;
            }
            return this.regs[reg] || 0;
        };
        const sim = createSim({ 0x39: as, 0x44: new ShtDevice(0x62ac, 0x8e85, 1) });
        const bus = Q.createBus(sim.send, {
            sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30)))
        });
        const s = new Q.AS7343(bus);
        const id = await s.identify();
        ok(
            'AS7343 identify via bank 1, bank restored',
            id.id_ok && id.revid === 1 && as.regs[0xbf] === 0
        );
        await s.configure({ gain: 64 });
        ok(
            'AS7343 configure: gain code 7, 18-ch SMUX, 50 ms',
            as.regs[0xc6] === 7 && as.regs[0xd6] === 0x60 && close(s.tintMs, 50.04, 0.01)
        );
        // While the AS7343 integrates, another bus user gets in (read releases the bus).
        const dev = Q.located(0x39);
        let shtDoneWhileIntegrating = false;
        const pAs = Q.KINDS.as7343.read(bus, dev, s);
        const pSht = Q.withDevice(bus, Q.located(0x44), () => new Q.SHT4x(bus).read()).then(() => {
            shtDoneWhileIntegrating = s._startedAt !== null;
        });
        const [r] = await Promise.all([pAs, pSht]);
        ok('AS7343 read hands the bus back during integration', shtDoneWhileIntegrating);
        ok(
            'AS7343 decode: FZ_450 = ch0 = 100, F1_405 = ch12 = 1300',
            r.channels.FZ_450 === 100 && r.spectral.F1_405 === 1300
        );
        ok('AS7343 VIS = mean of VIS0/1/2', close(r.vis, (500 + 1100 + 1700) / 3));
        ok('AS7343 not saturated', !r.sat);
    }

    console.log('\n=== KINDS registry ===');
    {
        const kinds = Object.keys(Q.KINDS);
        ok(
            'kinds',
            kinds.join(',') === 'sht4x,lsm6dsox,tsl2591,veml7700,as7343,pca9685',
            kinds.join(',')
        );
        ok(
            'every kind has role/label/display/columns/values',
            kinds.every((k) => {
                const e = Q.KINDS[k];
                return (
                    e.role &&
                    e.label &&
                    Array.isArray(e.display) &&
                    Array.isArray(e.columns) &&
                    typeof e.values === 'function' &&
                    typeof e.read === 'function'
                );
            })
        );
        ok(
            'roles',
            Q.KINDS.sht4x.role === 'env' &&
                Q.KINDS.lsm6dsox.role === 'tilt' &&
                Q.KINDS.pca9685.role === 'actuator' &&
                ['tsl2591', 'veml7700', 'as7343'].every((k) => Q.KINDS[k].role === 'light')
        );
        ok(
            'kindForAddress',
            Q.kindForAddress(0x44) === 'sht4x' &&
                Q.kindForAddress(0x6b) === 'lsm6dsox' &&
                Q.kindForAddress(0x55) === null
        );
        ok(
            'describe flags the AO DAC',
            /must NOT/.test(Q.describe(0x60)) && /PCA9548/.test(Q.describe(0x71))
        );
        const sim = createSim({ 0x44: new ShtDevice(1, 2, 0xabcdef01) });
        const bus = Q.createBus(sim.send, { sleep: noSleep });
        const idr = await Q.identifyDevice(bus, Q.located(0x44), 'sht4x');
        ok('identifyDevice sht4x', idr.ok && idr.info.serial === '0xABCDEF01', idr.detail);
        const bad = await Q.identifyDevice(bus, Q.located(0x6a), 'lsm6dsox');
        ok(
            'identifyDevice on an absent part → ok:false, never throws',
            !bad.ok && /NACK/.test(bad.detail)
        );
        ok('lsm6dsox values exclude the bump flag', !Q.KINDS.lsm6dsox.columns.includes('bumped'));
    }

    console.log(`\n=== Summary ===\n${total - failures} / ${total} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
