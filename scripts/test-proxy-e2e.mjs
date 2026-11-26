#!/usr/bin/env node
// Per-workspace proxy ROUTING E2E. Proves that setProxy actually diverts a
// workspace's page traffic through its proxy (the #1 beta complaint):
//   P1  page request for the workspace arrives at the proxy in absolute form
//   P2  the page round-trips (fake proxy forwards it) so the user sees content
//   P3  disabling the proxy returns the workspace to a direct connection
//   P4  exit-IP test channel (ph:ws-test-proxy) answers through the proxy
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8183;      // serves app/ (the chrome)
const SITE_PORT = 8190;     // origin the webview will load
const PROXY_PORT = 8191;    // fake HTTP proxy
const CDP_PORT = 9227;
const CFG = '/tmp/proxy-cfg';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// NOTE: bypass uses "<-loopback>" (not "<local>"): Chromium always bypasses
// loopback hosts implicitly; <-loopback> removes that implicit bypass so the
// request to 127.0.0.1 MUST go through the fake proxy. This is what makes
// P1/P2 a genuine routing proof.

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- fake HTTP proxy: records absolute-form requests, forwards them ----
const proxyLog = [];
const proxySrv = http.createServer((req, res) => {
  const target = req.url;   // absolute form ("http://host/path") when proxied
  proxyLog.push(target);
  if (/^https?:\/\/127\.0\.0\.1:(8190)/.test(target || '')) {
    if (target.includes('/ip')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ip: '203.0.113.7' }));
    }
    return http.get(target, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end('proxy upstream error'); });
  }
  res.writeHead(403); res.end('fake proxy: only test origins');
});

// ---- static servers ----
const staticSrv = (dir) => http.createServer((req, res) => {
  try {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(dir, path.normalize(rel));
    if (!file.startsWith(dir)) { res.statusCode = 403; return res.end(); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.statusCode = 404; res.end('nf'); }
});

async function bootApp() {
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env,
    PH_E2E: '1', PH_POOL_OFF: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':99', ELECTRON_ENABLE_LOGGING: '1'
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
  await page.waitForTimeout(2200);
  return { browser, page, elec };
}

async function main() {
  await new Promise(r => proxySrv.listen(PROXY_PORT, '127.0.0.1', () => r()));
  await new Promise(r => staticSrv(path.join(ROOT, 'app')).listen(APP_PORT, '127.0.0.1', () => r()));
  const siteSrv = staticSrv(path.join(ROOT, 'dev'));
  await new Promise(r => siteSrv.listen(SITE_PORT, '127.0.0.1', () => r()));
  // make sure the target origin exists for the webview to load
  const pageFile = path.join(ROOT, 'dev', 'proxy-target.html');
  const hadPage = fs.existsSync(pageFile);
  if (!hadPage) fs.writeFileSync(pageFile, '<!doctype html><html><body><h1 id="mk">proxied-ok</h1></body></html>');

  const { browser, page, elec } = await bootApp();
  const call = (fn, ...args) => page.evaluate(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);

  const wsId = await call(() => window.pigeonhole.state().then(s => s.workspaces[0].id));
  check('a workspace exists for the test', !!wsId, String(wsId));

  // non-empty bypass list: keeps 127.0.0.1 OUT of Chromium's <local> bypass
  // so the request really has to pass the fake proxy.
  console.log('\n== P1/P2. routing a page through the workspace proxy ==');
  await call((id, port) => window.pigeonhole.workspaces.setProxy(id, {
    enabled: true, scheme: 'http', host: '127.0.0.1', port,
    username: '', password: '', bypass: '<-loopback>'
  }), wsId, PROXY_PORT);
  await page.evaluate(url => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(url);
  }, `http://127.0.0.1:${SITE_PORT}/proxy-target.html`);

  let landed = false, sawContent = false;
  for (let i = 0; i < 25 && !(landed && sawContent); i++) {
    await sleep(300);
    landed = proxyLog.some(u => String(u).includes(`127.0.0.1:${SITE_PORT}/proxy-target`));
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
      if (p.url().startsWith(`http://127.0.0.1:${SITE_PORT}`)) {
        sawContent = sawContent || /proxied-ok/.test(await p.evaluate(() => document.body.innerText).catch(() => ''));
      }
    }
  }
  check('P1: the page request arrived at the proxy (absolute form)', landed, JSON.stringify(proxyLog));
  check('P2: the page loaded through the proxy round-trip', sawContent);

  console.log('\n== P3. disabling the proxy restores direct ==');
  await call(id => window.pigeonhole.workspaces.setProxy(id, { enabled: false }), wsId);
  const before = proxyLog.length;
  await page.evaluate(url => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(url + '?direct=1');
  }, `http://127.0.0.1:${SITE_PORT}/proxy-target.html`);
  await sleep(1500);
  const extra = proxyLog.slice(before).filter(u => String(u).includes('direct=1'));
  check('P3: after disable no request hits the proxy anymore', extra.length === 0, JSON.stringify(extra));

  console.log('\n== P4. exit-IP channel (added with the beta.2 proxy work) ==');
  await call((id, port) => window.pigeonhole.workspaces.setProxy(id, {
    enabled: true, scheme: 'http', host: '127.0.0.1', port,
    username: '', password: '', bypass: '<-loopback>'
  }), wsId, PROXY_PORT);
  const ipRes = await call((id, u) => window.pigeonhole.workspaces.testProxy(id, u)
    .then(r => JSON.stringify(r)).catch(e => 'ERR ' + String(e.message || e)), wsId, `http://127.0.0.1:${SITE_PORT}/ip`);
  let ipOk = false;
  try { ipOk = JSON.parse(ipRes).ip === '203.0.113.7'; } catch { }
  check('P4: testProxy answers the exit IP through the proxy', ipOk, ipRes);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (!hadPage) try { fs.rmSync(pageFile); } catch { }
  elec.kill(); try { await browser.close(); } catch { }
  proxySrv.close(); siteSrv.close(); staticSrv(path.join(ROOT, 'app')).close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[proxy-test] CRASHED', e); process.exit(1); });
