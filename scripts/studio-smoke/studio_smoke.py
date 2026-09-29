#!/usr/bin/env python3
"""Arena Studio browser smoke test — layout, themes, contrast, console errors.

    pixi run studio-smoke                      # all checks, screenshots to a temp dir
    pixi run studio-smoke --compare origin/main   # + Dark computed-colour diff vs a git ref
    pixi run studio-smoke --no-axe --widths 1024,1440

Serves the repo on a free localhost port, drives a throwaway headless Chrome/Edge profile
(real clicks + keys), loads `?p=full_experiment`, and FAILS (exit 1) on:
  * layout — horizontal page overflow, top-bar items off-screen, overlapping or clipped
    Console panels, a Protocol ▾ / ⚙ Settings menu not fully on screen (per width);
  * console errors (network 404s from course-repo protocol lookups are ignored);
  * a theme that doesn't apply, or axe-core colour-contrast violations beyond the known
    deliberately-faint closed-loop label (axe is fetched from cdnjs; skipped offline);
  * the replay interlock freezing the wrong ⚙ Settings parts; the old-browser notice.
Needs a local Chrome or Edge, so it is NOT part of `pixi run test` / CI. Screenshots are kept
(path printed at the end); the throwaway Chrome profile and local server are always cleaned up. Use it after any
change to arena_studio.html's layout, menus or colours (CLAUDE.md → Arena Studio).
"""
import argparse
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import find_chrome, open_page  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
THEMES = ['dark', 'light', 'contrast', 'night', 'cvd']
AXE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js'
AXE_ALLOW = {'#rbClosedLoop'}  # "closed-loop" label: faint by design until a loop is active
IGNORE_ERR = ('favicon.ico', 'raw.githubusercontent.com', 'api.github.com', AXE_URL)
FIXTURE = '/tests/fixtures/arena_studio_alt_replay.jsonl'

METRICS = r"""(()=>{
  const vw=innerWidth, vh=innerHeight, tb=document.querySelector('.topbar');
  const vis=[...tb.children].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;});
  const inVp=(sel)=>{const e=document.querySelector(sel); if(!e) return null; const r=e.getBoundingClientRect();
    return r.width? (r.left>=0&&r.top>=0&&r.right<=vw+0.5&&r.bottom<=vh+0.5) : null;};
  const open=[...document.querySelectorAll('#cStage .panel.open')].map(p=>[p.dataset.panel,p.getBoundingClientRect()]);
  const overlaps=[]; for(let i=0;i<open.length;i++) for(let j=i+1;j<open.length;j++){const a=open[i][1],b=open[j][1];
    if(a.width&&b.width&&a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1) overlaps.push(open[i][0]+'×'+open[j][0]);}
  const clipped=[...document.querySelectorAll('#cStage .panel.open :is(button,input,select)')].filter(e=>{
    const r=e.getBoundingClientRect(), p=e.closest('.panel').getBoundingClientRect(); return r.width>0&&(r.right>p.right+1||r.left<p.left-1);})
    .map(e=>e.closest('.panel').dataset.panel+':'+(e.id||e.dataset.cmd||e.textContent.trim().slice(0,12)));
  return {overflowX:document.documentElement.scrollWidth-vw, offRight:vis.filter(e=>e.getBoundingClientRect().right>vw+0.5).map(e=>e.id||e.className),
    overlaps, clipped, settingsInVp:inVp('#settingsMenu.open .menu'), protocolInVp:inVp('#fileMenu.open .menu')};
})()"""

AXE_RUN = """(async()=>{
  if(!window.axe){ await new Promise((ok,bad)=>{const s=document.createElement('script'); s.src=%s; s.onload=ok; s.onerror=bad; document.head.appendChild(s);}); }
  const r=await axe.run(document,{runOnly:{type:'rule',values:['color-contrast']},resultTypes:['violations']});
  const v=r.violations[0]; return v? v.nodes.map(n=>({t:n.target.join(' '), m:((n.any[0]||{}).message||'').slice(0,160)})) : [];
})()""" % json.dumps(AXE_URL)

COMPUTED = r"""(()=>{const out={}, cnt={}; const props=['color','backgroundColor','borderTopColor','boxShadow'];
  const norm=v=>v.replace(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/g,(m,r,g,b,a)=>
    'rgba('+[r,g,b].map(x=>Math.round(x*255)).join(', ')+', '+(a==null?1:+(+a).toFixed(3))+')')
    .replace(/rgb\((\d+), (\d+), (\d+)\)/g,'rgba($1, $2, $3, 1)').replace(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/g,(m,r,g,b,a)=>'rgba('+r+', '+g+', '+b+', '+(+(+a).toFixed(3))+')');
  document.querySelectorAll('body *').forEach(e=>{ if(e.closest('svg')||/^(SCRIPT|OPTION)$/.test(e.tagName)) return;
    let k=e.id?'#'+e.id:null; if(!k){const c=[...e.classList].sort().join('.'); if(!c) return; const b=e.tagName.toLowerCase()+'.'+c; cnt[b]=(cnt[b]||0)+1; k=b+'@'+cnt[b];}
    const cs=getComputedStyle(e); out[k]=norm(props.map(p=>cs[p]).join('|')); }); return out;})()"""


class Report:
    def __init__(self):
        self.failures, self.warnings = [], []

    def check(self, ok, msg, detail=''):
        print(('  ok    ' if ok else '  FAIL  ') + msg + ('' if ok or not detail else ' — ' + str(detail)[:300]))
        if not ok:
            self.failures.append(msg)

    def warn(self, msg):
        print('  warn  ' + msg)
        self.warnings.append(msg)


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def fresh(p, base, w, h, theme=None, query='?p=full_experiment', page='arena_studio.html'):
    await p.size(w, h)
    await p.goto(f'{base}/{page}', settle=0.3)
    await p.js("localStorage.clear(); sessionStorage.clear(); %s true" % (
        "localStorage.setItem('studio_ui_theme', %s);" % json.dumps(theme) if theme else ''))
    p.errors.clear()
    await p.goto(f'{base}/{page}{query}', settle=2.4)


async def mode(p, m):
    await p.js("document.querySelector('#modeSeg [data-mode=\"%s\"]').click(); true" % m)
    await asyncio.sleep(0.5)


def errors_of(p):
    return [e for e in p.errors if not any(s in e for s in IGNORE_ERR)]


async def run(args):
    rep = Report()
    out = args.out or tempfile.mkdtemp(prefix='studio-smoke-')
    os.makedirs(out, exist_ok=True)
    chrome = find_chrome(args.chrome)  # fail fast, before anything is started
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    server = b = ref_page = None
    profile = tempfile.mkdtemp(prefix='studio-smoke-chrome-')
    try:
        # Everything acquired from here on is released in `finally`, even when the
        # server, Chrome or the DevTools connection fails to come up.
        server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1',
                                   '--directory', REPO], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        b, p = await open_page(chrome, free_port(), profile)
        time.sleep(0.3)
        widths = [int(x) for x in args.widths.split(',')]
        print(f'== layout ({", ".join(map(str, widths))} px; Run / Edit / Console / menus) ==')
        for w in widths:
            h = 1080 if w >= 1920 else 900
            await fresh(p, base, w, h)
            for view in ('run', 'edit', 'console', 'console-all'):
                if view != 'run':
                    await mode(p, 'console' if view.startswith('console') else view)
                if view == 'console-all':
                    await p.js("document.querySelectorAll('#cRail .rail-btn:not(.sel)').forEach(b=>b.click()); true")
                    await asyncio.sleep(0.3)
                m = await p.js(METRICS)
                bad = {k: v for k, v in m.items() if (k == 'overflowX' and v > 0) or (k in ('offRight', 'overlaps', 'clipped') and v)}
                rep.check(not bad, f'{w}px {view}: no overflow / off-screen / overlap / clipping', bad)
                await p.shot(os.path.join(out, f'layout_{w}_{view}.jpg'))
            await mode(p, 'run')
            for btn, key in (('#settingsMenuBtn', 'settingsInVp'), ('#fileMenuBtn', 'protocolInVp')):
                await p.click(btn)
                m = await p.js(METRICS)
                rep.check(m[key] is True, f'{w}px {btn[1:]} opens fully on screen', m[key])
                await p.key('Escape', 'Escape', 27)
            rep.check(not errors_of(p), f'{w}px no console errors', errors_of(p))

        print('== themes (1440 px) ==')
        for t in args.themes.split(','):
            await fresh(p, base, 1440, 900, theme=t)
            attr = await p.js("document.documentElement.getAttribute('data-ui-theme')")
            sel = await p.js("document.getElementById('uiTheme').value")
            rep.check(attr == t and sel == t, f'{t}: applied before paint + dropdown in sync', (attr, sel))
            for view in ('run', 'edit', 'console'):
                await mode(p, view)
                await p.shot(os.path.join(out, f'theme_{t}_{view}.jpg'))
                if args.no_axe:
                    continue
                try:
                    nodes = await p.js(AXE_RUN)
                except Exception as e:  # noqa: BLE001 — offline / blocked CDN
                    rep.warn(f'axe unavailable ({str(e)[:80]}) — contrast not measured')
                    args.no_axe = True
                    continue
                extra = [n for n in nodes if n['t'] not in AXE_ALLOW]
                rep.check(not extra, f'{t} {view}: no colour-contrast violations (axe)', extra[:5])
            rep.check(not errors_of(p), f'{t}: no console errors', errors_of(p))

        print('== replay interlock + old-browser notice ==')
        await fresh(p, base, 1440, 900, query='')
        await p.js("(async()=>{const t=await (await fetch(%s)).text(); await Studio.replay.startFromFile(new File([t],'smoke.jsonl'),{gesture:false,autoplay:false}); return true;})()" % json.dumps(FIXTURE))
        await asyncio.sleep(1.2)
        st = await p.js("['#ghBlock','#fmLogRow','#sessionRigLock','#fileMenu','#settingsMenu','#uiThemeRow'].map(s=>{const e=document.querySelector(s); return !!(e&&e.closest('[inert]'));})")
        rep.check(st[:4] == [True] * 4 and st[4:] == [False, False],
                  'replay freezes rig / GitHub / logging / Protocol ▾ but not ⚙ Settings or Display', st)
        await p.js('Studio.replay.stop(); true')
        await asyncio.sleep(0.3)
        rep.check(not await p.js("!!document.querySelector('#ghBlock').closest('[inert]')"), 'replay stop releases the interlock')
        sid = (await p.send('Page.addScriptToEvaluateOnNewDocument', {'source':
            "const _s=CSS.supports.bind(CSS); CSS.supports=(a,b)=>/color-mix/.test(String(b||a))?false:_s(a,b);"}))['identifier']
        await p.goto(f'{base}/arena_studio.html', settle=2)
        txt = await p.js("(document.getElementById('browserNotice') || {}).textContent || ''")
        rep.check('too old' in txt, 'browser without color-mix() gets a persistent update notice', txt[:80])
        await p.send('Page.removeScriptToEvaluateOnNewDocument', {'identifier': sid})

        if args.compare:
            print(f'== Dark computed colours vs {args.compare} (informational) ==')
            src = subprocess.run(['git', 'show', f'{args.compare}:arena_studio.html'], cwd=REPO,
                                 capture_output=True, text=True, check=True).stdout
            ref_page = f'_smoke_ref_{os.getpid()}.html'
            with open(os.path.join(REPO, ref_page), 'w', encoding='utf-8') as f:
                f.write(src)
            for view in ('run', 'edit', 'console'):
                snap = {}
                for page in (ref_page, 'arena_studio.html'):
                    await fresh(p, base, 1440, 900, page=page)
                    if view != 'run':
                        await mode(p, view)
                    snap[page] = await p.js(COMPUTED)
                a, c = snap[ref_page], snap['arena_studio.html']
                diffs = [k for k in a if k in c and a[k] != c[k]]
                print(f'  {view}: {len(diffs)} of {len([k for k in a if k in c])} shared elements differ'
                      + (': ' + ', '.join(diffs[:12]) + (' …' if len(diffs) > 12 else '') if diffs else ''))
    finally:
        if b:
            b.close()
        if server:
            server.terminate()
            try:
                server.wait(5)
            except subprocess.TimeoutExpired:
                server.kill()
        if ref_page and os.path.exists(os.path.join(REPO, ref_page)):
            os.remove(os.path.join(REPO, ref_page))
        shutil.rmtree(profile, ignore_errors=True)  # the throwaway Chrome profile; screenshots are kept
    print(f'\nscreenshots: {out}')
    print(f'{len(rep.failures)} failure(s), {len(rep.warnings)} warning(s)')
    return 1 if rep.failures else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--widths', default='760,1024,1280,1440,1920')
    ap.add_argument('--themes', default=','.join(THEMES))
    ap.add_argument('--no-axe', action='store_true', help='skip the axe-core contrast pass (offline)')
    ap.add_argument('--compare', metavar='REF', help='also diff Dark computed colours against this git ref')
    ap.add_argument('--out', help='screenshot directory (default: a new temp dir)')
    ap.add_argument('--chrome', help='Chrome/Edge executable (default: auto-detect or $CHROME)')
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == '__main__':
    main()
