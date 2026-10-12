/**
 * qwiic-drivers.js — host-side register maps for the Qwiic / STEMMA QT
 * peripherals, driven over the controller's sensor-agnostic I2C bridge
 * (GET_I2C_SCAN 0xB0 / I2C_TRANSFER 0xB1; fw PR #58, 0xC2 feature bit 1
 * `qwiic_i2c`, arena_12-18 jack J2 = Wire1). LAB-214.
 *
 * A port of the firmware repo's tests/qwiic_sensors.py + tests/qwiic_peripherals.py
 * (bench-verified 2026-10-12, docs/development/qwiic-bench-2026-10-12.md there).
 * The firmware knows nothing about any part: every register map lives here.
 *
 *   createBus(send, opts)  transport + async MUTEX. `send(bytes, opts)` resolves
 *                          to the raw response frame (ArenaSession.send).
 *   bus.exclusive(fn)      run a multi-transfer sequence with no other I2C user
 *                          in between (mux select + reads, SHT4x's two legs, IMU
 *                          read + bump). NOT re-entrant: never call exclusive()
 *                          from inside fn. The link FIFO only orders single
 *                          commands; this orders whole sequences.
 *   withDevice(bus, dev, fn)  exclusive() + PCA9548 channel select/restore.
 *   locateDevices(bus)     scan + mux channel map; a PCA9685's all-call shadow
 *                          at 0x70 is never mapped as a mux (decided from MODE1).
 *   KINDS                  THE registry: one entry per supported part (label,
 *                          role, default addresses, identify/setup/read, display
 *                          fields, log columns). Add or drop a part HERE only.
 *
 * Bench quirks kept (do not "simplify" them away):
 *   - SHT4x NACKs a read while measuring: write leg, wait, separate read leg —
 *     never a repeated-start pair. Sensirion CRC-8 checked on every word.
 *   - LSM6DSOX bump latch needs LIR + INT_CLR_ON_READ + INT1_WU routing (the INT1
 *     pin is not wired; the routing is what latches). bumpFlag() reads AND CLEARS:
 *     exactly one owner may call it (the trial logger during runs).
 *   - PCA9685 answers its all-call 0x70 (reads too) until MODE1.ALLCALL is
 *     cleared — the PCA9548's default address. configure() clears it.
 *   - The Servo pHAT's logic is powered from its own USB-C, not the Qwiic 3.3 V:
 *     unpowered = absent from the scan.
 *   - TSL2591 full scale is 36863 at 100 ms integration, 65535 otherwise.
 *
 * LOADING: classic <script src> (window-global `QwiicDrivers` + CommonJS), no ES
 * `export` — same rule as arena-session.js (CLAUDE.md).
 */
(function (global) {
    'use strict';

    const Wire =
        (typeof require === 'function' &&
            (() => {
                try {
                    return require('./arena-wire-g6.js');
                } catch (_) {
                    return null;
                }
            })()) ||
        global.ArenaWireG6;

    const hex2 = (a) => '0x' + (a & 0xff).toString(16).toUpperCase().padStart(2, '0');
    const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const defaultNow = () =>
        typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

    // ── errors ──────────────────────────────────────────────────────────────

    class I2CError extends Error {
        constructor(status, addr, msg) {
            const text = (Wire && Wire.I2C_STATUS_TEXT[status]) || 'status ' + status;
            super('I2C ' + hex2(addr) + ': ' + text + (msg ? ' (' + msg + ')' : ''));
            this.name = 'I2CError';
            this.status = status;
            this.addr = addr;
        }
    }

    /** The flashed firmware variant has no Qwiic jack (arena_10-10 / 2x10 builds). */
    class NoQwiicJack extends Error {
        constructor(msg) {
            super(msg || 'No Qwiic jack on this hardware variant');
            this.name = 'NoQwiicJack';
        }
    }

    // ── bus ─────────────────────────────────────────────────────────────────

    /**
     * @param {(bytes:Uint8Array, opts:object)=>Promise<Uint8Array>} send
     * @param {{sleep?, now?, timeoutMs?, scanTimeoutMs?, sendOpts?}} [opts]
     */
    function createBus(send, opts) {
        const o = opts || {};
        const sleep = o.sleep || defaultSleep;
        const now = o.now || defaultNow;
        const timeoutMs = o.timeoutMs || 1000;
        const scanTimeoutMs = o.scanTimeoutMs || 2000;
        const sendOpts = o.sendOpts || {};
        let tail = Promise.resolve();
        let held = false;

        function exclusive(fn) {
            const run = tail.then(async () => {
                held = true;
                try {
                    return await fn();
                } finally {
                    held = false;
                }
            });
            tail = run.catch(() => {});
            return run;
        }

        async function scan() {
            const d = Wire.decodeI2cScan(
                await send(
                    Wire.encodeGetI2cScan(),
                    Object.assign({}, sendOpts, { timeoutMs: scanTimeoutMs })
                )
            );
            if (!d) throw new Error('GET_I2C_SCAN: no or malformed reply');
            if (d.noJack) throw new NoQwiicJack(d.message);
            if (!d.ok)
                throw new Error(
                    'GET_I2C_SCAN failed: ' +
                        d.statusText +
                        (d.message ? ' (' + d.message + ')' : '')
                );
            return d.addresses;
        }

        /** Write `wbytes` then read `rlen` bytes (repeated start). Throws I2CError. */
        async function xfer(addr, wbytes, rlen) {
            const n = rlen || 0;
            const d = Wire.decodeI2cTransfer(
                await send(
                    Wire.encodeI2cTransfer(addr, wbytes || [], n),
                    Object.assign({}, sendOpts, { timeoutMs })
                )
            );
            if (!d) throw new Error('I2C_TRANSFER ' + hex2(addr) + ': no or malformed reply');
            if (d.noJack) throw new NoQwiicJack(d.message);
            if (!d.ok) throw new I2CError(d.status, addr, d.message);
            if (d.data.length !== n)
                throw new I2CError(5, addr, 'got ' + d.data.length + ' of ' + n + ' bytes');
            return d.data;
        }

        async function ack(addr) {
            try {
                await xfer(addr, [], 0);
                return true;
            } catch (e) {
                if (e instanceof I2CError && e.status === 2) return false;
                throw e;
            }
        }

        const readReg = (addr, reg, n) => xfer(addr, [reg], n === undefined ? 1 : n);
        const writeReg = (addr, reg, data) => xfer(addr, [reg, ...Array.from(data || [])], 0);

        return {
            exclusive,
            get held() {
                return held;
            },
            scan,
            xfer,
            ack,
            readReg,
            writeReg,
            sleep,
            now
        };
    }

    // little-endian helpers over a Uint8Array
    const u16 = (b, i) => b[i] | (b[i + 1] << 8);
    const i16 = (b, i) => {
        const v = u16(b, i);
        return v & 0x8000 ? v - 0x10000 : v;
    };
    const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];

    // ── address book ────────────────────────────────────────────────────────

    const MCP4725_ADDR = 0x60; // the arena's AO DAC — lives on Wire, never on the Qwiic Wire1
    const isMux = (addr) => addr >= 0x70 && addr <= 0x77;

    const ADDRESS_BOOK = {
        0x10: 'VEML7700 lux',
        0x29: 'TSL2591 light',
        0x39: 'AS7343 spectral',
        0x44: 'SHT4x temperature/humidity',
        0x6a: 'LSM6DSOX 6-axis IMU (tilt/bump)',
        0x6b: 'LSM6DSOX 6-axis IMU, SA0 high',
        0x40: 'PCA9685 16-ch PWM / servo driver',
        0x18: 'LIS3DH accelerometer (no driver)',
        0x19: 'LIS3DH accelerometer, SA0 high (no driver)',
        [MCP4725_ADDR]: 'MCP4725 DAC — the arena AO; must NOT be visible on the Qwiic bus'
    };

    function describe(addr) {
        if (isMux(addr))
            return 'PCA9548 8-ch mux (A2..A0 = ' + (addr - 0x70).toString(2).padStart(3, '0') + ')';
        return ADDRESS_BOOK[addr] || 'unknown';
    }

    // ── PCA9548 mux ─────────────────────────────────────────────────────────
    // UNVERIFIED on hardware (no second SHT4x on the 2026-10-12 bench).

    class PCA9548 {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? 0x70 : addr;
        }
        async readMask() {
            return (await this.bus.xfer(this.addr, [], 1))[0];
        }
        async select(mask) {
            await this.bus.xfer(this.addr, [mask & 0xff], 0);
        }
        /** Select channel `ch`, run fn, restore the previous mask. */
        async channel(ch, fn) {
            const previous = await this.readMask();
            await this.select(1 << ch);
            try {
                return await fn();
            } finally {
                await this.select(previous);
            }
        }
        /** {channel: [downstream addrs]} — excludes the root bus. Restores the mask. */
        async channelMap() {
            const previous = await this.readMask();
            try {
                await this.select(0);
                const root = new Set(await this.bus.scan());
                const out = {};
                for (let ch = 0; ch < 8; ch++) {
                    await this.select(1 << ch);
                    out[ch] = (await this.bus.scan())
                        .filter((a) => !root.has(a))
                        .sort((a, b) => a - b);
                }
                return out;
            } finally {
                await this.select(previous);
            }
        }
    }

    /** A located device: {addr, mux: null|addr, channel: null|0..7}. */
    const located = (addr, mux, channel) => ({
        addr,
        mux: mux === undefined ? null : mux,
        channel: channel === undefined ? null : channel
    });
    const where = (dev) =>
        dev.mux == null ? 'root' : 'mux ' + hex2(dev.mux) + ' ch' + dev.channel;
    const sameLocation = (a, b) =>
        a.addr === b.addr &&
        (a.mux == null ? null : a.mux) === (b.mux == null ? null : b.mux) &&
        (a.mux == null || a.channel === b.channel);

    /** Run fn with the device reachable (mux channel selected; no-op for root). Caller holds the bus. */
    async function reach(bus, dev, fn) {
        if (dev.mux == null) return fn();
        return new PCA9548(bus, dev.mux).channel(dev.channel, fn);
    }

    /** exclusive() + reach(): the standard way to talk to one located device. */
    function withDevice(bus, dev, fn) {
        return bus.exclusive(() => reach(bus, dev, fn));
    }

    /** A PCA9548 answers a 1-byte read of its control register. */
    async function muxResponds(bus, addr) {
        try {
            await bus.xfer(addr, [], 1);
            return true;
        } catch (e) {
            if (e instanceof I2CError) return false;
            throw e;
        }
    }

    // ── Sensirion CRC-8 (poly 0x31, init 0xFF) ──────────────────────────────

    function crc8Sensirion(data) {
        let crc = 0xff;
        for (const b of data) {
            crc ^= b;
            for (let i = 0; i < 8; i++)
                crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
        }
        return crc;
    }

    /** [msb lsb crc] × n → {words, ok}. */
    function unpackSensirionWords(frame) {
        const words = [];
        let ok = true;
        for (let i = 0; i < frame.length; i += 3) {
            words.push((frame[i] << 8) | frame[i + 1]);
            ok = ok && crc8Sensirion([frame[i], frame[i + 1]]) === frame[i + 2];
        }
        return { words, ok };
    }

    // ── SHT4x (0x44) ────────────────────────────────────────────────────────

    class SHT4x {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? SHT4x.ADDR : addr;
        }
        async _command(cmd, waitMs, rlen) {
            await this.bus.xfer(this.addr, [cmd], 0); // write leg
            await this.bus.sleep(waitMs);
            return this.bus.xfer(this.addr, [], rlen === undefined ? 6 : rlen); // separate read leg
        }
        async identify() {
            const { words, ok } = unpackSensirionWords(await this._command(SHT4x.CMD_SERIAL, 2));
            return { serial: ((words[0] << 16) | words[1]) >>> 0, crc_ok: ok };
        }
        async softReset() {
            await this.bus.xfer(this.addr, [SHT4x.CMD_SOFT_RESET], 0);
            await this.bus.sleep(2);
        }
        /** Datasheet 4.6; RH clipped to 0..100. */
        static convert(tRaw, rhRaw) {
            const t = -45.0 + (175.0 * tRaw) / 65535.0;
            const rh = Math.min(100.0, Math.max(0.0, -6.0 + (125.0 * rhRaw) / 65535.0));
            return [t, rh];
        }
        async read(cmd) {
            const c = cmd === undefined ? SHT4x.CMD_MEASURE_HIGH : cmd;
            const { words, ok } = unpackSensirionWords(
                await this._command(c, SHT4x.MEASURE_WAIT_MS[c])
            );
            const [t, rh] = SHT4x.convert(words[0], words[1]);
            return { temp_c: t, rh_pct: rh, t_raw: words[0], rh_raw: words[1], crc_ok: ok };
        }
    }
    SHT4x.ADDR = 0x44;
    SHT4x.CMD_MEASURE_HIGH = 0xfd;
    SHT4x.CMD_MEASURE_MED = 0xf6;
    SHT4x.CMD_MEASURE_LOW = 0xe0;
    SHT4x.CMD_SERIAL = 0x89;
    SHT4x.CMD_SOFT_RESET = 0x94;
    SHT4x.MEASURE_WAIT_MS = { 0xfd: 10, 0xf6: 6, 0xe0: 3 };

    // ── LSM6DSOX (0x6A; SA0 high → 0x6B) ────────────────────────────────────

    class LSM6DSOX {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? LSM6DSOX.ADDR : addr;
            this.fsG = 2;
            this.fsDps = 250;
        }
        async identify() {
            const who = (await this.bus.readReg(this.addr, LSM6DSOX.REG_WHO_AM_I))[0];
            return { who_am_i: who, id_ok: who === LSM6DSOX.WHO_AM_I_EXPECTED };
        }
        async configure(o) {
            const c = Object.assign(
                { odr_hz: 104, fs_g: 2, gyro_odr_hz: 104, fs_dps: 250 },
                o || {}
            );
            const L = LSM6DSOX;
            if (!(c.odr_hz in L.ODR_CODE) || !(c.gyro_odr_hz in L.ODR_CODE))
                throw new RangeError('LSM6DSOX: unsupported ODR');
            if (!(c.fs_g in L.FS_XL_CODE) || !(c.fs_dps in L.FS_G_CODE))
                throw new RangeError('LSM6DSOX: unsupported full scale');
            this.fsG = c.fs_g;
            this.fsDps = c.fs_dps;
            await this.bus.writeReg(this.addr, L.REG_CTRL3_C, [L.CTRL3_BDU | L.CTRL3_IF_INC]);
            await this.bus.writeReg(this.addr, L.REG_CTRL1_XL, [
                (L.ODR_CODE[c.odr_hz] << 4) | (L.FS_XL_CODE[c.fs_g] << 2)
            ]);
            await this.bus.writeReg(this.addr, L.REG_CTRL2_G, [
                (L.ODR_CODE[c.gyro_odr_hz] << 4) | (L.FS_G_CODE[c.fs_dps] << 2)
            ]);
            await this.bus.sleep((2.5 / Math.max(c.odr_hz, 12.5) + 0.01) * 1000); // first samples after the ODR change
        }
        get accelGPerLsb() {
            return { 2: 0.061e-3, 4: 0.122e-3, 8: 0.244e-3, 16: 0.488e-3 }[this.fsG];
        }
        get gyroDpsPerLsb() {
            return { 250: 8.75e-3, 500: 17.5e-3, 1000: 35e-3, 2000: 70e-3 }[this.fsDps];
        }
        /** One 14-byte block: temp + gyro + accel. */
        async read() {
            const b = await this.bus.readReg(this.addr, LSM6DSOX.REG_OUT_TEMP_L, 14);
            const v = [];
            for (let i = 0; i < 7; i++) v.push(i16(b, 2 * i));
            const [tempRaw, gx, gy, gz, ax, ay, az] = v;
            const a = [ax, ay, az].map((x) => x * this.accelGPerLsb);
            const g = [gx, gy, gz].map((x) => x * this.gyroDpsPerLsb);
            return Object.assign(
                {
                    accel_g: a,
                    gyro_dps: g,
                    temp_c: 25.0 + tempRaw / 256.0,
                    accel_raw: [ax, ay, az]
                },
                LSM6DSOX.tilt(a)
            );
        }
        /** Inclination from the gravity vector (degrees). |a| ≈ 1 g when still. */
        static tilt(a) {
            const [ax, ay, az] = a;
            const norm = Math.sqrt(ax * ax + ay * ay + az * az);
            const deg = (r) => (r * 180) / Math.PI;
            if (norm === 0)
                return { pitch_deg: NaN, roll_deg: NaN, from_vertical_deg: NaN, accel_norm_g: 0 };
            return {
                pitch_deg: deg(Math.atan2(ax, Math.sqrt(ay * ay + az * az))),
                roll_deg: deg(Math.atan2(ay, az)),
                from_vertical_deg: deg(Math.acos(Math.max(-1, Math.min(1, Math.abs(az) / norm)))),
                accel_norm_g: norm
            };
        }
        /** Latched wake-up "bumped" flag. Threshold resolution FS/64 (31.25 mg at ±2 g). */
        async armBump(thresholdG) {
            const L = LSM6DSOX;
            const lsb = this.fsG / 64.0;
            const ths = Math.max(
                0,
                Math.min(63, Math.round((thresholdG === undefined ? 0.25 : thresholdG) / lsb))
            );
            await this.bus.writeReg(this.addr, L.REG_WAKE_UP_DUR, [0x00]);
            await this.bus.writeReg(this.addr, L.REG_WAKE_UP_THS, [ths]);
            await this.bus.writeReg(this.addr, L.REG_TAP_CFG0, [
                L.TAP_CFG0_LIR | L.TAP_CFG0_INT_CLR_ON_READ
            ]);
            await this.bus.writeReg(this.addr, L.REG_MD1_CFG, [L.MD1_CFG_INT1_WU]); // routing is what latches
            await this.bus.writeReg(this.addr, L.REG_TAP_CFG2, [L.TAP_CFG2_INTERRUPTS_ENABLE]);
            await this.bumpFlag(); // clear anything latched while arming
            return ths;
        }
        async disarmBump() {
            const L = LSM6DSOX;
            await this.bus.writeReg(this.addr, L.REG_TAP_CFG2, [0]);
            await this.bus.writeReg(this.addr, L.REG_MD1_CFG, [0]);
            await this.bus.writeReg(this.addr, L.REG_TAP_CFG0, [0]);
        }
        /** READ-AND-CLEAR. One owner only. */
        async bumpFlag() {
            const src = (await this.bus.readReg(this.addr, LSM6DSOX.REG_WAKE_UP_SRC))[0];
            const axes = [
                ['X', 4],
                ['Y', 2],
                ['Z', 1]
            ]
                .filter(([, bit]) => src & bit)
                .map(([n]) => n)
                .join('');
            return { bumped: !!(src & LSM6DSOX.WAKE_UP_SRC_WU_IA), axes, raw: src };
        }
        async powerOff() {
            await this.disarmBump();
            await this.bus.writeReg(this.addr, LSM6DSOX.REG_CTRL1_XL, [0]);
            await this.bus.writeReg(this.addr, LSM6DSOX.REG_CTRL2_G, [0]);
        }
    }
    Object.assign(LSM6DSOX, {
        ADDR: 0x6a,
        ADDR_ALT: 0x6b,
        WHO_AM_I_EXPECTED: 0x6c,
        REG_WHO_AM_I: 0x0f,
        REG_CTRL1_XL: 0x10,
        REG_CTRL2_G: 0x11,
        REG_CTRL3_C: 0x12,
        REG_WAKE_UP_SRC: 0x1b,
        REG_OUT_TEMP_L: 0x20,
        REG_TAP_CFG0: 0x56,
        REG_TAP_CFG2: 0x58,
        REG_WAKE_UP_THS: 0x5b,
        REG_WAKE_UP_DUR: 0x5c,
        REG_MD1_CFG: 0x5e,
        CTRL3_BDU: 0x40,
        CTRL3_IF_INC: 0x04,
        ODR_CODE: { 0: 0x0, 12.5: 0x1, 26: 0x2, 52: 0x3, 104: 0x4, 208: 0x5, 416: 0x6 },
        FS_XL_CODE: { 2: 0x0, 16: 0x1, 4: 0x2, 8: 0x3 },
        FS_G_CODE: { 250: 0x0, 500: 0x1, 1000: 0x2, 2000: 0x3 },
        TAP_CFG0_LIR: 0x01,
        TAP_CFG0_INT_CLR_ON_READ: 0x40,
        TAP_CFG2_INTERRUPTS_ENABLE: 0x80,
        MD1_CFG_INT1_WU: 0x20,
        WAKE_UP_SRC_WU_IA: 0x08
    });

    // ── TSL2591 (0x29) ──────────────────────────────────────────────────────

    class TSL2591 {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? TSL2591.ADDR : addr;
            this.gain = 'med';
            this.atimeMs = 100;
        }
        _rd(reg, n) {
            return this.bus.readReg(this.addr, TSL2591.CMD | reg, n);
        }
        _wr(reg, v) {
            return this.bus.writeReg(this.addr, TSL2591.CMD | reg, [v]);
        }
        async identify() {
            const v = (await this._rd(TSL2591.REG_ID, 1))[0];
            return { id: v, id_ok: v === TSL2591.ID_EXPECTED };
        }
        async configure(o) {
            const c = Object.assign({ gain: 'med', atime_ms: 100 }, o || {});
            if (!(c.gain in TSL2591.GAIN))
                throw new RangeError('TSL2591 gain must be low|med|high|max');
            if (!(c.atime_ms in TSL2591.ATIME))
                throw new RangeError('TSL2591 atime_ms must be 100..600 in 100s');
            this.gain = c.gain;
            this.atimeMs = Number(c.atime_ms);
            await this._wr(
                TSL2591.REG_CONTROL,
                TSL2591.GAIN[c.gain][0] | TSL2591.ATIME[c.atime_ms]
            );
            await this._wr(TSL2591.REG_ENABLE, TSL2591.ENABLE_PON | TSL2591.ENABLE_AEN);
            await this.bus.sleep(this.atimeMs * 1.2 + 50);
        }
        /** ADC full scale: 36863 at 100 ms integration, 65535 otherwise (datasheet § ALS ADC). */
        static ceilingFor(atimeMs) {
            return Number(atimeMs) === 100 ? 36863 : 65535;
        }
        get ceiling() {
            return TSL2591.ceilingFor(this.atimeMs);
        }
        /** Pure decode, shared by read() and the tests. */
        decode(status, full, ir) {
            const sat = full >= this.ceiling || ir >= this.ceiling;
            const out = {
                full,
                ir,
                visible: full - ir,
                sat,
                valid: !!(status & 0x01),
                lux_approx: null
            };
            if (full > 0 && !sat) {
                const cpl = (this.atimeMs * TSL2591.GAIN[this.gain][1]) / 408.0;
                out.lux_approx = ((full - ir) * (1.0 - ir / full)) / cpl;
            }
            return out;
        }
        async read() {
            const status = (await this._rd(TSL2591.REG_STATUS, 1))[0];
            const b = await this._rd(TSL2591.REG_C0DATAL, 4);
            return this.decode(status, u16(b, 0), u16(b, 2));
        }
        async powerOff() {
            await this._wr(TSL2591.REG_ENABLE, 0);
        }
    }
    Object.assign(TSL2591, {
        ADDR: 0x29,
        CMD: 0xa0,
        REG_ENABLE: 0x00,
        REG_CONTROL: 0x01,
        REG_ID: 0x12,
        REG_STATUS: 0x13,
        REG_C0DATAL: 0x14,
        ID_EXPECTED: 0x50,
        ENABLE_PON: 0x01,
        ENABLE_AEN: 0x02,
        GAIN: { low: [0x00, 1.0], med: [0x10, 25.0], high: [0x20, 428.0], max: [0x30, 9876.0] },
        ATIME: { 100: 0x00, 200: 0x01, 300: 0x02, 400: 0x03, 500: 0x04, 600: 0x05 }
    });

    // ── VEML7700 (0x10) ─────────────────────────────────────────────────────

    class VEML7700 {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? VEML7700.ADDR : addr;
        }
        async read16(reg) {
            return u16(await this.bus.readReg(this.addr, reg, 2), 0);
        }
        async identify() {
            const v = await this.read16(VEML7700.REG_ID);
            // Early silicon has no ID register, so a mismatch is reported, not failed.
            return {
                id_raw: v,
                device_id: v & 0xff,
                device_id_ok: (v & 0xff) === VEML7700.DEVICE_ID_EXPECTED
            };
        }
        async configure() {
            await this.bus.writeReg(this.addr, VEML7700.REG_CONF, le16(VEML7700.CONF_GAIN1_IT100));
            await this.bus.sleep(250); // > 2 integration windows at 100 ms
        }
        async read() {
            const als = await this.read16(VEML7700.REG_ALS);
            const white = await this.read16(VEML7700.REG_WHITE);
            return {
                als,
                white,
                lux_approx: als * VEML7700.LUX_PER_COUNT_GAIN1_IT100,
                sat: als >= 0xffff || white >= 0xffff
            };
        }
    }
    Object.assign(VEML7700, {
        ADDR: 0x10,
        REG_CONF: 0x00,
        REG_ALS: 0x04,
        REG_WHITE: 0x05,
        REG_ID: 0x07,
        CONF_GAIN1_IT100: 0x0000,
        LUX_PER_COUNT_GAIN1_IT100: 0.0576,
        DEVICE_ID_EXPECTED: 0x81
    });

    // ── AS7343 (0x39) ───────────────────────────────────────────────────────

    class AS7343 {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? AS7343.ADDR : addr;
            this.fullScale = 65535;
            this.tintMs = 50.0;
            this.gain = 256;
            this._startedAt = null;
        }
        _wr(reg, v) {
            return this.bus.writeReg(this.addr, reg, Array.isArray(v) ? v : [v]);
        }
        async identify() {
            const A = AS7343;
            await this._wr(A.REG_CFG0, A.CFG0_REG_BANK); // registers < 0x80 need bank 1
            let b;
            try {
                b = await this.bus.readReg(this.addr, A.REG_AUXID, 3);
            } finally {
                await this._wr(A.REG_CFG0, 0x00);
            }
            return { auxid: b[0], revid: b[1], id: b[2], id_ok: b[2] === A.ID_EXPECTED };
        }
        async configure(o) {
            const A = AS7343;
            const c = Object.assign({ gain: 256, atime: 29, astep: 599 }, o || {});
            if (!(c.gain in A.GAIN_CODE))
                throw new RangeError(
                    'AS7343 gain must be one of ' + Object.keys(A.GAIN_CODE).join(', ')
                );
            await this._wr(A.REG_CFG0, 0x00);
            await this._wr(A.REG_ENABLE, A.ENABLE_PON);
            await this._wr(A.REG_ATIME, c.atime);
            await this._wr(A.REG_ASTEP_L, le16(c.astep));
            await this._wr(A.REG_CFG1, A.GAIN_CODE[c.gain]);
            await this._wr(A.REG_CFG20, A.CFG20_AUTO_SMUX_18);
            this.gain = Number(c.gain);
            this.fullScale = Math.min(65535, (c.atime + 1) * (c.astep + 1));
            this.tintMs = ((c.atime + 1) * (c.astep + 1) * A.STEP_US) / 1000.0;
        }
        /** One 18-channel measurement = three SMUX cycles. */
        get frameMs() {
            return 3 * this.tintMs;
        }
        /** Kick off a measurement; the part integrates on its own until collect(). */
        async start() {
            const A = AS7343;
            await this._wr(A.REG_ENABLE, A.ENABLE_PON);
            const status = (await this.bus.readReg(this.addr, A.REG_STATUS, 1))[0];
            await this._wr(A.REG_STATUS, status); // clear sticky flags
            await this._wr(A.REG_ENABLE, A.ENABLE_PON | A.ENABLE_SP_EN);
            this._startedAt = this.bus.now();
        }
        /** ms left before the frame can be valid (callers sleep this WITHOUT holding the bus). */
        remainingMs() {
            if (this._startedAt == null) return 0;
            return Math.max(0, this._startedAt + this.frameMs - this.bus.now());
        }
        /** Poll AVALID, latch + read 18 channels, stop. Caller already slept remainingMs(). */
        async collect(timeoutMs) {
            const A = AS7343;
            const deadline = this.bus.now() + (timeoutMs || 2000);
            let status2;
            try {
                for (;;) {
                    status2 = (await this.bus.readReg(this.addr, A.REG_STATUS2, 1))[0];
                    if (status2 & A.STATUS2_AVALID) break;
                    if (this.bus.now() > deadline) throw new Error('AS7343: AVALID never set');
                    await this.bus.sleep(2);
                }
                const block = await this.bus.readReg(
                    this.addr,
                    A.REG_ASTATUS,
                    1 + 2 * A.CHANNELS.length
                );
                return this.decode(block, status2);
            } finally {
                await this._wr(A.REG_ENABLE, A.ENABLE_PON);
                this._startedAt = null;
            }
        }
        decode(block, status2) {
            const A = AS7343;
            const channels = {};
            A.CHANNELS.forEach((name, i) => (channels[name] = u16(block, 1 + 2 * i)));
            const spectral = {};
            A.SPECTRAL.forEach((k) => (spectral[k] = channels[k]));
            const vis = A.CHANNELS.filter((k) => k.startsWith('VIS')).map((k) => channels[k]);
            const fd = A.CHANNELS.filter((k) => k.startsWith('FD')).map((k) => channels[k]);
            const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
            return {
                channels,
                spectral,
                vis: mean(vis),
                fd: mean(fd),
                sat: Math.max(...Object.values(spectral)) >= this.fullScale,
                sat_vis: Math.max(...vis) >= this.fullScale,
                asat_flags: (status2 & A.STATUS2_ASAT) | (block[0] & 0x80),
                full_scale: this.fullScale,
                tint_ms: this.tintMs
            };
        }
        async powerOff() {
            await this._wr(AS7343.REG_ENABLE, 0);
        }
    }
    Object.assign(AS7343, {
        ADDR: 0x39,
        REG_AUXID: 0x58,
        REG_ENABLE: 0x80,
        REG_ATIME: 0x81,
        REG_STATUS2: 0x90,
        REG_STATUS: 0x93,
        REG_ASTATUS: 0x94,
        REG_CFG0: 0xbf,
        REG_CFG1: 0xc6,
        REG_ASTEP_L: 0xd4,
        REG_CFG20: 0xd6,
        CFG0_REG_BANK: 0x10,
        ENABLE_PON: 0x01,
        ENABLE_SP_EN: 0x02,
        STATUS2_AVALID: 0x40,
        STATUS2_ASAT: 0x18,
        CFG20_AUTO_SMUX_18: 3 << 5,
        ID_EXPECTED: 0x81,
        GAIN_CODE: {
            0.5: 0,
            1: 1,
            2: 2,
            4: 3,
            8: 4,
            16: 5,
            32: 6,
            64: 7,
            128: 8,
            256: 9,
            512: 10,
            1024: 11,
            2048: 12
        },
        STEP_US: 2.78,
        // 18-ch auto-SMUX order (3 cycles × 6 ADCs); VIS = clear, FD = flicker (not light, kept out of sat).
        CHANNELS: [
            'FZ_450',
            'FY_555',
            'FXL_600',
            'NIR_855',
            'VIS0',
            'FD0',
            'F2_425',
            'F3_475',
            'F4_515',
            'F6_640',
            'VIS1',
            'FD1',
            'F1_405',
            'F7_690',
            'F8_745',
            'F5_550',
            'VIS2',
            'FD2'
        ],
        SPECTRAL: [
            'F1_405',
            'F2_425',
            'FZ_450',
            'F3_475',
            'F4_515',
            'F5_550',
            'FY_555',
            'FXL_600',
            'F6_640',
            'F7_690',
            'F8_745',
            'NIR_855'
        ]
    });

    // ── PCA9685 (0x40 default) ──────────────────────────────────────────────

    class PCA9685 {
        constructor(bus, addr) {
            this.bus = bus;
            this.addr = addr === undefined ? PCA9685.ADDR : addr;
            this.freqHz = 200.0; // POR prescale 0x1E
            this.configured = false;
        }
        async identify() {
            const P = PCA9685;
            const mode1 = (await this.bus.readReg(this.addr, P.REG_MODE1))[0];
            const prescale = (await this.bus.readReg(this.addr, P.REG_PRESCALE))[0];
            return {
                mode1,
                prescale,
                freq_hz: P.freqForPrescale(prescale),
                sleeping: !!(mode1 & P.MODE1_SLEEP),
                allcall: !!(mode1 & P.MODE1_ALLCALL)
            };
        }
        static prescaleFor(freqHz) {
            return Math.max(
                3,
                Math.min(255, Math.round(PCA9685.OSC_HZ / (PCA9685.COUNTS * freqHz)) - 1)
            );
        }
        static freqForPrescale(prescale) {
            return PCA9685.OSC_HZ / (PCA9685.COUNTS * (prescale + 1));
        }
        /** Set PWM frequency (prescale only writable in SLEEP), wake, auto-increment, ALLCALL off. */
        async configure(o) {
            const P = PCA9685;
            const freq = (o && o.freq_hz) || 50.0;
            const mode1 =
                (await this.bus.readReg(this.addr, P.REG_MODE1))[0] & ~P.MODE1_RESTART & 0xff;
            await this.bus.writeReg(this.addr, P.REG_MODE1, [
                (mode1 | P.MODE1_SLEEP) & ~P.MODE1_ALLCALL & 0xff
            ]);
            await this.bus.writeReg(this.addr, P.REG_PRESCALE, [P.prescaleFor(freq)]);
            await this.bus.writeReg(this.addr, P.REG_MODE1, [
                (mode1 | P.MODE1_AI) & ~P.MODE1_SLEEP & ~P.MODE1_ALLCALL & 0xff
            ]);
            await this.bus.sleep(1); // oscillator start-up ≥ 500 µs
            await this.bus.writeReg(this.addr, P.REG_MODE1, [
                (mode1 | P.MODE1_AI | P.MODE1_RESTART) & ~P.MODE1_SLEEP & ~P.MODE1_ALLCALL & 0xff
            ]);
            this.freqHz = P.freqForPrescale(P.prescaleFor(freq));
            this.configured = true;
        }
        async setCounts(channel, on, off) {
            if (!(Number.isInteger(channel) && channel >= 0 && channel < PCA9685.CHANNELS))
                throw new RangeError('channel ' + channel + ' out of 0..15');
            await this.bus.writeReg(this.addr, PCA9685.REG_LED0_ON_L + 4 * channel, [
                ...le16(on & 0x1fff),
                ...le16(off & 0x1fff)
            ]);
        }
        async readCounts(channel) {
            const b = await this.bus.readReg(this.addr, PCA9685.REG_LED0_ON_L + 4 * channel, 4);
            return [u16(b, 0), u16(b, 2)];
        }
        pulseToCounts(pulseUs) {
            return Math.max(
                0,
                Math.min(
                    PCA9685.COUNTS - 1,
                    Math.round(pulseUs * 1e-6 * this.freqHz * PCA9685.COUNTS)
                )
            );
        }
        /** Hobby servo: ~1000–2000 µs within a 20 ms (50 Hz) frame. Returns the OFF count. */
        async setPulseUs(channel, pulseUs) {
            const off = this.pulseToCounts(pulseUs);
            await this.setCounts(channel, 0, off);
            return off;
        }
        /** Full OFF (LEDn_OFF_H bit 4): the servo goes limp. */
        async setOff(channel) {
            await this.setCounts(channel, 0, 0x1000);
        }
        async allOff() {
            await this.bus.writeReg(this.addr, PCA9685.REG_ALL_LED_ON_L, [0, 0, 0x00, 0x10]);
        }
        async sleep() {
            const mode1 = (await this.bus.readReg(this.addr, PCA9685.REG_MODE1))[0];
            await this.bus.writeReg(this.addr, PCA9685.REG_MODE1, [
                (mode1 | PCA9685.MODE1_SLEEP) & ~PCA9685.MODE1_RESTART & 0xff
            ]);
        }
    }
    Object.assign(PCA9685, {
        ADDR: 0x40,
        ALLCALL_ADDR: 0x70,
        REG_MODE1: 0x00,
        REG_LED0_ON_L: 0x06,
        REG_ALL_LED_ON_L: 0xfa,
        REG_PRESCALE: 0xfe,
        MODE1_RESTART: 0x80,
        MODE1_AI: 0x20,
        MODE1_SLEEP: 0x10,
        MODE1_ALLCALL: 0x01,
        OSC_HZ: 25000000,
        CHANNELS: 16,
        COUNTS: 4096
    });

    /**
     * The address a PCA9685 is shadowing with its all-call (0x70 while MODE1.ALLCALL
     * is set — reads included), or null. Decided from MODE1, never from a read probe.
     */
    async function pca9685AllcallShadow(bus, scan) {
        if (!scan.includes(PCA9685.ADDR) || !scan.includes(PCA9685.ALLCALL_ADDR)) return null;
        try {
            const mode1 = (await bus.readReg(PCA9685.ADDR, PCA9685.REG_MODE1))[0];
            return mode1 & PCA9685.MODE1_ALLCALL ? PCA9685.ALLCALL_ADDR : null;
        } catch (e) {
            if (e instanceof I2CError) return null;
            throw e;
        }
    }

    /**
     * Scan the root bus, map every real mux's channels. Holds the bus for the whole
     * walk. → { scan: [root addrs], shadow: addr|null, devices: [located…] }.
     */
    function locateDevices(bus) {
        return bus.exclusive(async () => {
            const root = await bus.scan();
            const devices = root.map((a) => located(a));
            const shadow = await pca9685AllcallShadow(bus, root);
            for (const muxAddr of root) {
                if (!isMux(muxAddr) || muxAddr === shadow || !(await muxResponds(bus, muxAddr)))
                    continue;
                const map = await new PCA9548(bus, muxAddr).channelMap();
                for (const ch of Object.keys(map))
                    for (const a of map[ch]) devices.push(located(a, muxAddr, Number(ch)));
            }
            return { scan: root, shadow, devices };
        });
    }

    // ── KINDS registry ──────────────────────────────────────────────────────
    // One entry per supported part — the ONLY place to add or drop one.
    //   category: the short label the Console shows (Servo / PWM, Temp / humidity, …)
    //   role:     env | tilt | light | actuator (consumers pick by role, never by part)
    //   identify: (driver) → {ok, detail, info}            caller holds the bus
    //   setup:    (driver, config, {forRun}) → applied cfg  caller holds the bus
    //   read:     (bus, dev, driver) → reading             takes the bus ITSELF
    //   display:  readout fields [{key, label, unit, digits|fmt}]
    //   columns:  numeric log columns (keys into values())
    //   values:   (reading) → {column: number|null}

    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const simpleRead = (bus, dev, s) => withDevice(bus, dev, () => s.read());

    const KINDS = {
        sht4x: {
            kind: 'sht4x',
            category: 'Temp / humidity',
            label: 'SHT4x',
            title: 'SHT4x temperature / humidity',
            role: 'env',
            addresses: [0x44],
            Driver: SHT4x,
            async identify(s) {
                const r = await s.identify();
                const serial = '0x' + r.serial.toString(16).toUpperCase().padStart(8, '0');
                return {
                    ok: r.crc_ok,
                    detail: 'serial ' + serial + (r.crc_ok ? '' : ' (CRC FAIL)'),
                    info: { serial }
                };
            },
            async setup() {
                return {};
            },
            read: simpleRead,
            display: [
                { key: 'temp_c', label: 'Temperature', unit: '°C', digits: 2 },
                { key: 'rh_pct', label: 'Humidity', unit: '%RH', digits: 1 },
                { key: 'crc_ok', label: 'CRC', fmt: 'okfail' }
            ],
            columns: ['temp_c', 'rh_pct'],
            values: (r) => ({ temp_c: n(r.temp_c), rh_pct: n(r.rh_pct) })
        },
        lsm6dsox: {
            kind: 'lsm6dsox',
            category: 'Accel / tilt / bump',
            label: 'LSM6DSOX',
            title: 'LSM6DSOX IMU — tilt + bump latch',
            role: 'tilt',
            addresses: [0x6a, 0x6b],
            Driver: LSM6DSOX,
            async identify(s) {
                const r = await s.identify();
                return {
                    ok: r.id_ok,
                    detail: 'WHO_AM_I ' + hex2(r.who_am_i) + ' (expect 0x6C)',
                    info: {}
                };
            },
            // Tilt always; the bump latch only when asked (it is read-to-clear: one owner).
            async setup(s, cfg, ctx) {
                await s.configure({ odr_hz: 104 });
                const applied = { odr_hz: 104 };
                if (ctx && ctx.armBump) {
                    applied.bump_g = (cfg && cfg.bump_g) || 0.25;
                    applied.bump_ths = await s.armBump(applied.bump_g);
                }
                return applied;
            },
            read: simpleRead,
            display: [
                { key: 'from_vertical_deg', label: 'Tilt from vertical', unit: '°', digits: 1 },
                { key: 'pitch_deg', label: 'Pitch', unit: '°', digits: 1, signed: true },
                { key: 'roll_deg', label: 'Roll', unit: '°', digits: 1, signed: true },
                { key: 'accel_norm_g', label: '|a|', unit: 'g', digits: 3 },
                { key: 'temp_c', label: 'Die temperature', unit: '°C', digits: 1 }
            ],
            columns: ['from_vertical_deg', 'pitch_deg', 'roll_deg', 'accel_norm_g', 'temp_c'],
            values: (r) => ({
                from_vertical_deg: n(r.from_vertical_deg),
                pitch_deg: n(r.pitch_deg),
                roll_deg: n(r.roll_deg),
                accel_norm_g: n(r.accel_norm_g),
                temp_c: n(r.temp_c)
            }),
            hasBump: true
        },
        tsl2591: {
            kind: 'tsl2591',
            category: 'Light (broadband)',
            label: 'TSL2591',
            title: 'TSL2591 broadband light',
            role: 'light',
            addresses: [0x29],
            Driver: TSL2591,
            async identify(s) {
                const r = await s.identify();
                return { ok: r.id_ok, detail: 'ID ' + hex2(r.id) + ' (expect 0x50)', info: {} };
            },
            async setup(s, cfg) {
                const c = {
                    gain: (cfg && cfg.gain) || 'med',
                    atime_ms: (cfg && cfg.atime_ms) || 100
                };
                await s.configure(c);
                return c;
            },
            read: simpleRead,
            options: {
                gain: { label: 'Gain', values: ['low', 'med', 'high', 'max'], default: 'med' },
                atime_ms: {
                    label: 'Integration (ms)',
                    values: [100, 200, 300, 400, 500, 600],
                    default: 100
                }
            },
            display: [
                { key: 'full', label: 'Full (C0)', unit: 'counts', digits: 0 },
                { key: 'ir', label: 'IR (C1)', unit: 'counts', digits: 0 },
                { key: 'lux_approx', label: 'Lux (approx.)', unit: 'lx', digits: 1 },
                { key: 'sat', label: 'Saturated', fmt: 'flag' }
            ],
            columns: ['full', 'ir', 'lux_approx'],
            values: (r) => ({ full: n(r.full), ir: n(r.ir), lux_approx: n(r.lux_approx) })
        },
        veml7700: {
            kind: 'veml7700',
            category: 'Light (lux)',
            label: 'VEML7700',
            title: 'VEML7700 ambient light',
            role: 'light',
            addresses: [0x10],
            Driver: VEML7700,
            async identify(s) {
                const r = await s.identify();
                // early silicon has no ID register → reported, never failed
                const id = '0x' + r.id_raw.toString(16).toUpperCase().padStart(4, '0');
                return {
                    ok: true,
                    detail:
                        'ID reg ' +
                        id +
                        (r.device_id_ok ? ' ok' : ' (0x81 expected on current silicon)'),
                    info: {}
                };
            },
            async setup(s) {
                await s.configure();
                return { gain: 1, it_ms: 100 };
            },
            read: simpleRead,
            display: [
                { key: 'als', label: 'ALS', unit: 'counts', digits: 0 },
                { key: 'white', label: 'White', unit: 'counts', digits: 0 },
                { key: 'lux_approx', label: 'Lux (approx.)', unit: 'lx', digits: 1 },
                { key: 'sat', label: 'Saturated', fmt: 'flag' }
            ],
            columns: ['als', 'white', 'lux_approx'],
            values: (r) => ({ als: n(r.als), white: n(r.white), lux_approx: n(r.lux_approx) })
        },
        as7343: {
            kind: 'as7343',
            category: 'Light (spectral)',
            label: 'AS7343',
            title: 'AS7343 14-channel spectral',
            role: 'light',
            addresses: [0x39],
            Driver: AS7343,
            async identify(s) {
                const r = await s.identify();
                return {
                    ok: r.id_ok,
                    detail: 'ID ' + hex2(r.id) + ' (expect 0x81) rev ' + hex2(r.revid),
                    info: {}
                };
            },
            async setup(s, cfg) {
                const c = { gain: (cfg && cfg.gain) || 64 };
                await s.configure(c);
                return c;
            },
            // start → release the bus while it integrates (~150 ms) → collect.
            async read(bus, dev, s) {
                await withDevice(bus, dev, () => s.start());
                const wait = s.remainingMs();
                if (wait > 0) await bus.sleep(wait);
                return withDevice(bus, dev, () => s.collect());
            },
            options: { gain: { label: 'Gain', values: [1, 4, 16, 64, 256, 1024], default: 64 } },
            display: [
                { key: 'vis', label: 'Clear (VIS)', unit: 'counts', digits: 0 },
                { key: 'sat', label: 'Saturated', fmt: 'flag' },
                { key: 'spectral', label: 'Spectrum', fmt: 'bars' }
            ],
            columns: ['vis'].concat(AS7343.SPECTRAL),
            values: (r) => {
                const out = { vis: n(r.vis) };
                AS7343.SPECTRAL.forEach((k) => (out[k] = n(r.spectral[k])));
                return out;
            }
        },
        pca9685: {
            kind: 'pca9685',
            category: 'Servo / PWM',
            label: 'PCA9685',
            title: 'PCA9685 servo / PWM driver',
            role: 'actuator',
            addresses: [0x40],
            Driver: PCA9685,
            async identify(s) {
                const r = await s.identify();
                const detail =
                    'MODE1 ' +
                    hex2(r.mode1) +
                    ' prescale ' +
                    r.prescale +
                    ' (' +
                    r.freq_hz.toFixed(0) +
                    ' Hz)' +
                    (r.sleeping ? ' SLEEP' : '') +
                    (r.allcall ? ' ALLCALL' : '');
                return { ok: true, detail, info: { allcall: r.allcall, sleeping: r.sleeping } }; // no ID register
            },
            async setup(s, cfg) {
                const c = { freq_hz: (cfg && cfg.freq_hz) || 50 };
                await s.configure(c);
                return c;
            },
            read: (bus, dev, s) => withDevice(bus, dev, () => s.identify()),
            display: [
                { key: 'freq_hz', label: 'PWM frequency', unit: 'Hz', digits: 2 },
                { key: 'sleeping', label: 'Oscillator', fmt: 'sleep' },
                { key: 'allcall', label: 'All-call 0x70', fmt: 'onoff' }
            ],
            columns: [],
            values: () => ({})
        }
    };

    const KIND_BY_ADDR = {};
    for (const k of Object.values(KINDS)) for (const a of k.addresses) KIND_BY_ADDR[a] = k.kind;

    /** The default kind for an address (the address book), or null. */
    const kindForAddress = (addr) => KIND_BY_ADDR[addr] || null;

    /** Make the driver instance for a kind at an address. */
    function createDriver(bus, kind, addr) {
        const k = KINDS[kind];
        if (!k) throw new Error('unknown Qwiic kind "' + kind + '"');
        return new k.Driver(bus, addr === undefined ? k.addresses[0] : addr);
    }

    /** Identify a located device as `kind` (holds the bus). Never throws: errors → ok:false. */
    async function identifyDevice(bus, dev, kind, driver) {
        const k = KINDS[kind];
        const s = driver || createDriver(bus, kind, dev.addr);
        try {
            const r = await withDevice(bus, dev, () => k.identify(s));
            return Object.assign({ kind, driver: s }, r);
        } catch (e) {
            return { kind, driver: s, ok: false, detail: e.message, info: {}, error: e };
        }
    }

    const QwiicDrivers = {
        I2CError,
        NoQwiicJack,
        createBus,
        withDevice,
        reach,
        located,
        where,
        sameLocation,
        locateDevices,
        pca9685AllcallShadow,
        muxResponds,
        isMux,
        describe,
        hex2,
        MCP4725_ADDR,
        crc8Sensirion,
        unpackSensirionWords,
        SHT4x,
        LSM6DSOX,
        TSL2591,
        VEML7700,
        AS7343,
        PCA9685,
        PCA9548,
        KINDS,
        kindForAddress,
        createDriver,
        identifyDevice
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = QwiicDrivers;
    global.QwiicDrivers = QwiicDrivers;
})(typeof window !== 'undefined' ? window : globalThis);
