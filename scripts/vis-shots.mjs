#!/usr/bin/env node
// Visual harness: sets up proxy state + appearance prefs, screenshots key UI
// states via CDP for visual review (proxy chips, tile dots, duplicate warning,
// appearance tab, extensions tab with Ad Shield level, blocked-ads badge).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8195;
const CDP_PORT = 9231;
const CFG = '/tmp/vis-cfg';
const OUT = ROOT + '/dev-shots';
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
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise(r => staticSrv.listen(APP_PORT, '127.0.0.1', () => r()));
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env,
    PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'),
    [ROOT, '--demo', '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'],
    { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const t0 = Date.now();
  let browser = null;
  while (!browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); }
    catch { if (Date.now() - t0 > 40000) throw new Error('no electron'); await sleep(400); }
  }
  let page = null;
  while (!page) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith(`http://127.0.0.1:${APP_PORT}`)) page = p;
    if (!page) await sleep(300);
  }
  await page.waitForTimeout(2500);
  const call = (fn, ...args) => page.evaluate(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);

  // route workspaces 1+2 through the same proxy (duplicate-exit warning case),
  // workspace 3 through its own
  const wss = await call(() => window.pigeonhole.state().then(s => s.workspaces.map(w => w.id)));
  await call((a, b) => window.pigeonhole.workspaces.setProxy(a, { enabled: true, scheme: 'socks5', host: 'nl.exit.example', port: 1080, username: '', password: '', bypass: '' })
    .then(() => window.pigeonhole.workspaces.setProxy(b, { enabled: true, scheme: 'socks5', host: 'nl.exit.example', port: 1080, username: '', password: '', bypass: '' })), wss[0], wss[1]);
  await call(c => window.pigeonhole.workspaces.setProxy(c, { enabled: true, scheme: 'http', host: 'de.exit.example', port: 8080, username: '', password: '', bypass: '' }), wss[2]);
  await page.waitForTimeout(600);

  // 1) top bar with Proxy chip + net dots on tiles
  await page.screenshot({ path: OUT + '/proxied-topbar.png' });

  // 2) workspace settings with the duplicate warning
  await call(() => window.pigeonhole.state().then(() => { }));
  await page.evaluate(() => { window.__openWs = true; });
  await call(id => import('./app/js/modals.js'), wss[1]).catch(() => { });
  await page.evaluate((id) => { const m = document.querySelector('.ws-tile[data-ws="' + id + '"]'); m && m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); }, wss[1]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/tile-menu.png' });
  // open workspace settings via the chip (workspace 1 active)
  await page.evaluate(() => document.getElementById('wsChip').click());
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/ws-settings-proxy.png' });

  // close modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 3) appearance tab
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => { const tabs = [...document.querySelectorAll('.modal-tabs button')]; const t = tabs.find(b => b.textContent === 'Appearance'); t && t.click(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/appearance-tab.png' });

  // 4) extensions tab (with ad shield level + site rules)
  await page.evaluate(() => { const tabs = [...document.querySelectorAll('.modal-tabs button')]; const t = tabs.find(b => b.textContent === 'Extensions'); t && t.click(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/extensions-tab.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 5) switch to workspace 2 with appearance set to large tiles (also shows trail timing)
  await call(() => window.pigeonhole.settings.set({ tileSize: 'large', uiScale: 'large' }));
  await page.waitForTimeout(400);
  await page.evaluate(() => { const t = document.querySelectorAll('#wsTiles .ws-tile')[1]; t && t.click(); });
  await page.waitForTimeout(260);   // mid-trail
  await page.screenshot({ path: OUT + '/trail-large.png' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/large-tiles.png' });

  // reset appearance
  await call(() => window.pigeonhole.settings.set({ tileSize: 'normal', uiScale: 'normal' }));

  console.log('shots saved');
  elec.kill(); try { await browser.close(); } catch { }
  staticSrv.close();
  process.exit(0);
}
main().catch(e => { console.error('CRASH', e); process.exit(1); });
