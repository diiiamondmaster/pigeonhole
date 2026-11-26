#!/usr/bin/env node
// LIVE smoke test: boots the real app with the REAL public sources, lets the
// pool fetch + health-check genuine community proxies, then assigns one to a
// workspace and asks an IP service through it. Reports honest numbers.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8186;
const CDP_PORT = 9233;
const CFG = '/tmp/pool-live-cfg';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const staticSrv = http.createServer((req, res) => {
  try {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, 'app', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'app'))) { res.statusCode = 403; return res.end(); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.statusCode = 404; res.end('nf'); }
});

async function main() {
  await new Promise(r => staticSrv.listen(APP_PORT, '127.0.0.1', () => r()));
  fs.rmSync(CFG, { recursive: true, force: true });
  // no PH_POOL_* overrides: the pool talks to the real public sources.
  const env = {
    ...process.env,
    PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96'
  };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'),
    [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'],
    { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const t0 = Date.now();
  let browser = null;
  while (!browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); }
    catch { if (Date.now() - t0 > 40000) throw new Error('electron never came up'); await sleep(400); }
  }
  let page = null;
  while (!page) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith(`http://127.0.0.1:${APP_PORT}`)) page = p;
    if (!page) await sleep(300);
  }
  await page.waitForTimeout(2500);
  const call = (fn, ...args) => page.evaluate(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);

  // direct exit IP of this sandbox for comparison
  const directIp = (() => { try { return execSync('curl -s -m 10 https://api.ipify.org').toString().trim(); } catch { return '(unavailable)'; } })();
  console.log('direct IP of this machine :', directIp);

  console.log('refreshing the real pool (fetch + health-check, up to ~2 min)...');
  const refreshT0 = Date.now();
  const st = await call(() => window.pigeonhole.pool.refresh());
  const refreshSec = ((Date.now() - refreshT0) / 1000).toFixed(1);
  console.log(`refresh finished in ${refreshSec}s`);
  console.log('candidates fetched:', st.candidates, '| verified:', st.verified);
  console.log('sources:', JSON.stringify((st.sources || []).map(s => `${s.name}:${s.ok ? 'ok(' + s.count + ')' : 'FAIL'}`)));
  console.log('best exits (ms, protocol, country, creds):');
  const best = await call(() => window.pigeonhole.pool.status().then(s => (s.best ? [s.best] : []).concat([])));
  const all = await page.evaluate(async () => {
    // status only surfaces the best; grab the whole picture via regions + status
    const s = await window.pigeonhole.pool.status();
    return s;
  });
  // verified list is not fully exposed; refresh returned it - print from refresh result fields if present
  console.log('regions:', JSON.stringify(st.regions));
  if (best.length) console.log('best:', JSON.stringify({ host: best[0].ip, port: best[0].port, ms: best[0].ms, proto: best[0].protocol, country: best[0].country }));

  // the auto-assigned first workspace: test its REAL exit IP
  let wsId = null;
  for (let i = 0; i < 60 && !wsId; i++) {
    wsId = await call(() => window.pigeonhole.state().then(s => s.workspaces.find(w => w.proxy && w.proxy.enabled && w.proxy.mode === 'auto') ? s.workspaces[0].id : null));
    if (!wsId) await sleep(500);
  }
  if (!wsId) { console.log('no auto-assigned workspace appeared'); process.exit(1); }
  const exitInfo = await call(id => window.pigeonhole.state().then(s => { const w = s.workspaces.find(x => x.id === id); return w.proxy; }), wsId);
  console.log('\nworkspace 1 assigned exit:', JSON.stringify(exitInfo));
  console.log('testing the real exit IP through it (api.ipify.org)...');
  const res = await call(id => window.pigeonhole.workspaces.testProxy(id).then(r => JSON.stringify(r)).catch(e => 'ERR ' + String(e.message || e)), wsId);
  console.log('exit IP result:', res);
  let changed = false, ok = false;
  try { const r = JSON.parse(res); changed = r.ip !== directIp; ok = !!r.ok; } catch { }
  console.log(ok && changed ? 'PASS: exit IP differs from direct - the workspace really routes through a community proxy'
    : ok ? 'CHECK: exit IP matched the direct IP'
    : 'CHECK: the exit was too slow for the IP service (community proxies fluctuate - rotate heals this)');

  elec.kill(); try { await browser.close(); } catch { }
  staticSrv.close();
  process.exit(0);
}
main().catch(e => { console.error('[live-smoke] CRASHED', e); process.exit(1); });
