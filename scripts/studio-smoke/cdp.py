"""Minimal Chrome DevTools Protocol driver for the Arena Studio smoke test.

Headless Chrome + the `websockets` package pixi already provides (no npm, no Playwright).
One page, real mouse/keyboard input, screenshots, console-error capture.
"""
import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

import websockets

CHROME_CANDIDATES = [
    os.environ.get('CHROME', ''),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
]


def find_chrome(explicit=None):
    if explicit:  # an explicit choice never silently falls back to auto-detection
        if os.path.isfile(explicit) or shutil.which(explicit):
            return explicit if os.path.isfile(explicit) else shutil.which(explicit)
        raise SystemExit(f'--chrome {explicit!r} not found')
    for c in CHROME_CANDIDATES:
        if not c:
            continue
        if os.path.isfile(c):
            return c
        found = shutil.which(c)
        if found:
            return found
    raise SystemExit('Chrome/Edge not found — pass --chrome PATH or set $CHROME')


class Browser:
    def __init__(self, chrome, port, profile):
        self.chrome, self.port, self.profile = chrome, port, profile
        self.proc = None

    def launch(self):
        self.proc = subprocess.Popen(
            [self.chrome, '--headless=new', f'--remote-debugging-port={self.port}',
             f'--user-data-dir={self.profile}', '--no-first-run', '--no-default-browser-check',
             '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(150):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/list') as r:
                    pages = [t for t in json.load(r) if t.get('type') == 'page']
                    if pages:
                        return pages[0]['webSocketDebuggerUrl']
            except Exception:  # noqa: BLE001 — Chrome still starting
                pass
            time.sleep(0.1)
        raise RuntimeError('headless Chrome did not start')

    def close(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except Exception:  # noqa: BLE001
                self.proc.kill()


class Page:
    def __init__(self, ws):
        self.ws, self.id, self.pending, self.events, self.errors = ws, 0, {}, [], []

    async def start(self):
        self.task = asyncio.create_task(self._reader())
        for m in ('Page.enable', 'Runtime.enable', 'Log.enable'):
            await self.send(m)

    async def _reader(self):
        async for msg in self.ws:
            m = json.loads(msg)
            if 'id' in m and m['id'] in self.pending:
                self.pending.pop(m['id']).set_result(m)
                continue
            self.events.append(m)
            meth, p = m.get('method'), m.get('params', {})
            if meth == 'Runtime.exceptionThrown':
                d = p.get('exceptionDetails', {})
                self.errors.append('exception: ' + (d.get('exception', {}).get('description') or d.get('text', ''))[:300])
            elif meth == 'Runtime.consoleAPICalled' and p.get('type') == 'error':
                self.errors.append('console.error: ' + ' '.join(str(a.get('value', a.get('description', ''))) for a in p.get('args', []))[:300])
            elif meth == 'Log.entryAdded' and p.get('entry', {}).get('level') == 'error':
                e = p['entry']
                self.errors.append('log: ' + (e.get('text', '') + ' ' + e.get('url', ''))[:300])

    async def send(self, method, params=None, timeout=60):
        self.id += 1
        fut = asyncio.get_event_loop().create_future()
        self.pending[self.id] = fut
        await self.ws.send(json.dumps({'id': self.id, 'method': method, 'params': params or {}}))
        r = await asyncio.wait_for(fut, timeout)
        if 'error' in r:
            raise RuntimeError(method + ': ' + json.dumps(r['error']))
        return r.get('result', {})

    async def js(self, expr):
        r = await self.send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True,
                                                 'returnByValue': True, 'userGesture': True})
        if 'exceptionDetails' in r:
            raise RuntimeError('JS: ' + json.dumps(r['exceptionDetails'])[:600])
        return r['result'].get('value')

    async def size(self, w, h):
        await self.send('Emulation.setDeviceMetricsOverride',
                        {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': False})

    async def goto(self, url, settle=2.0):
        self.events.clear()
        await self.send('Page.navigate', {'url': url})
        t0 = time.time()
        while time.time() - t0 < 20 and not any(e.get('method') == 'Page.loadEventFired' for e in self.events):
            await asyncio.sleep(0.05)
        await asyncio.sleep(settle)

    async def shot(self, path, fmt='jpeg'):
        r = await self.send('Page.captureScreenshot', {'format': fmt, **({'quality': 80} if fmt == 'jpeg' else {})})
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))

    async def click(self, selector):
        c = await self.js(f"""(()=>{{const e=document.querySelector({json.dumps(selector)}); if(!e) return null;
            const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];}})()""")
        if not c:
            raise RuntimeError('no element ' + selector)
        for kind in ('mouseMoved', 'mousePressed', 'mouseReleased'):
            await self.send('Input.dispatchMouseEvent', {'type': kind, 'x': c[0], 'y': c[1],
                                                         'button': 'none' if kind == 'mouseMoved' else 'left',
                                                         'clickCount': 0 if kind == 'mouseMoved' else 1})
        await asyncio.sleep(0.15)

    async def key(self, key, code, vk):
        for t in ('keyDown', 'keyUp'):
            await self.send('Input.dispatchKeyEvent', {'type': t, 'key': key, 'code': code, 'windowsVirtualKeyCode': vk})
        await asyncio.sleep(0.12)


async def open_page(chrome, port, profile):
    """Launch Chrome and attach; on ANY failure after launch, kill Chrome before re-raising."""
    b = Browser(chrome, port, profile)
    try:
        ws = await websockets.connect(b.launch(), max_size=64 * 1024 * 1024)
        p = Page(ws)
        await p.start()
    except BaseException:
        b.close()
        raise
    return b, p


if __name__ == '__main__':
    print(find_chrome(sys.argv[1] if len(sys.argv) > 1 else None))
