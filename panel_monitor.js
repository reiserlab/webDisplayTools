// G6 Panel Serial Monitor — read a panel's USB-CDC log over Web Serial.
//
// A liveness/diagnostic readout for a panel running firmware (USB-serial mode,
// NOT BOOTSEL). The production firmware emits boot + diagnostic text on serial
// (predef status, clk_sys, FATAL …) and does NOT parse commands — so input is
// read-only there. The BCM self-test build DOES expose a command console
// (e0 = ERR glyph, ? = help, p<r>,<c> = pixel, …), which the Send box drives.
//
// Chromium/Edge only (Web Serial). Baud is irrelevant for USB-CDC.

const RP_VID = 0x2e8a;
const BAUD = 115200;

const $ = (id) => document.getElementById(id);
let port = null;
let reader = null;
let keepReading = false;

function log(text, cls) {
    const el = $('log');
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
}
function setStatus(msg, cls) {
    const s = $('status');
    s.textContent = msg;
    s.className = cls || '';
}

function setConnected(on) {
    $('connect-btn').textContent = on ? 'Disconnect' : 'Connect panel (serial)';
    $('send-input').disabled = !on;
    $('send-btn').disabled = !on;
}

async function readLoop() {
    const dec = new TextDecoder();
    try {
        while (keepReading && port && port.readable) {
            reader = port.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break; // reader cancelled
                    if (value) log(dec.decode(value, { stream: true }));
                }
            } finally {
                reader.releaseLock();
                reader = null;
            }
        }
    } catch (err) {
        log(`\n[read error: ${err.message}]\n`, 'status-err');
    }
}

async function connect() {
    try {
        port = await navigator.serial.requestPort({ filters: [{ usbVendorId: RP_VID }] });
        await port.open({ baudRate: BAUD });
    } catch (err) {
        setStatus(
            err.name === 'NotFoundError'
                ? 'No panel selected. Pick the panel’s serial port in the chooser.'
                : `Could not open serial port: ${err.message}`,
            'status-err'
        );
        port = null;
        return;
    }
    keepReading = true;
    setConnected(true);
    const info = port.getInfo ? port.getInfo() : {};
    setStatus('Connected. Tap RUN (reset) on the panel to capture its boot banner.', 'status-ok');
    log(
        `--- connected (VID 0x${(info.usbVendorId || RP_VID).toString(16)}, ${BAUD} baud) ---\n`,
        'status-ok'
    );
    readLoop();
}

async function disconnect() {
    keepReading = false;
    try {
        if (reader) await reader.cancel();
    } catch {
        /* ignore */
    }
    try {
        if (port) await port.close();
    } catch {
        /* ignore */
    }
    port = null;
    setConnected(false);
    setStatus('Disconnected.');
    log('\n--- disconnected ---\n');
}

async function sendLine() {
    const input = $('send-input');
    const text = input.value;
    if (!port || !port.writable) return;
    const writer = port.writable.getWriter();
    try {
        await writer.write(new TextEncoder().encode(text + '\n'));
        log(`> ${text}\n`, 'sent');
        input.value = '';
    } catch (err) {
        log(`\n[write error: ${err.message}]\n`, 'status-err');
    } finally {
        writer.releaseLock();
    }
}

function main() {
    if (!('serial' in navigator)) {
        $('unsupported').style.display = 'block';
        $('app').style.display = 'none';
        return;
    }
    $('connect-btn').addEventListener('click', () => (port ? disconnect() : connect()));
    $('send-btn').addEventListener('click', sendLine);
    $('send-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendLine();
    });
    $('clear-btn').addEventListener('click', () => {
        $('log').textContent = '';
    });
    // Re-cancel cleanly if the panel is unplugged mid-session.
    navigator.serial.addEventListener('disconnect', (e) => {
        if (port && e.target === port) disconnect();
    });
}

main();
