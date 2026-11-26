#!/usr/bin/env node
// Content-script injection E2E for the Video Speed and Ad Shield extensions.
// Boots the real app, navigates the active guest webview to a local page
// with a <video> and a tracker subresource, then verifies in the GUEST page:
//   I1  window.__phVSC exists and is enabled (controller wired)
//   I2  applyRate(2) actually doubles the video's playbackRate
//   I3  toggling Video Speed off live-disables it in the open page
//   I4  window.__phAds exists with the cosmetic style active at Standard
//   I5  the tracker subresource request got cancelled and the blocked
//       counter incremented (doubleclick.net is on the basic list)
//   I6  per-site "off" rule removes the cosmetic layer live
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8185;
const SITE_PORT = 8186;
const CDP_PORT = 9229;
const CFG = '/tmp/inj-cfg';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

const TARGET = `<!doctype html><html><body>
<h1 id="mk">inject-target</h1>
<video id="v" width="320" height="180"></video>
<script>
  // tracker fetch: doubleclick.net is on the Ad Shield basic list, so this
  // request must be cancelled before any DNS happens
  fetch('https://doubleclick.net/ping?e2e=1').then(r => { window.__fetched = 'ok'; }).catch(e => { window.__fetched = 'blocked'; });
  fetch('https://criteo.com/ping?e2e=1').then(r => { window.__fetched2 = 'ok'; }).catch(e => { window.__fetched2 = 'blocked'; });
</script>
</body></html>`;

async function bootApp() {
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env,
    PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
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
  // serve app/ and the target page
  await new Promise(r => staticSrv(path.join(ROOT, 'app')).listen(APP_PORT, '127.0.0.1', () => r()));
  const site = staticSrv(path.join(ROOT, 'dev'));
  await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', () => r()));
  const targetFile = path.join(ROOT, 'dev', 'inject-target.html');
  const had = fs.existsSync(targetFile);
  fs.writeFileSync(targetFile, TARGET);

  const { browser, page, elec } = await bootApp();
  const call = (fn, ...args) => page.evaluate(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);

  const wsId = await call(() => window.pigeonhole.state().then(s => s.workspaces[0].id));
  await page.evaluate(url => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(url);
  }, `http://127.0.0.1:${SITE_PORT}/inject-target.html`);

  // find the guest page in the CDP browser and wait for load + injection
  let guest = null, waited = 0;
  while (waited < 20000) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
      if (p.url().startsWith(`http://127.0.0.1:${SITE_PORT}`)) guest = p;
    }
    if (guest) {
      const ready = await guest.evaluate(() => !!(window.__phVSC || window.__phAds)).catch(() => false);
      if (ready) break;
    }
    await sleep(400); waited += 400;
  }
  check('guest page loaded with content scripts injected', !!guest && waited < 20000);

  console.log('\n== I1/I2. Video Speed wiring ==');
  const vsc = await guest.evaluate(() => ({ on: window.__phVSC?.enabled, v: !!document.querySelector('video') })).catch(() => null);
  check('I1: __phVSC present and enabled', vsc?.on === true, JSON.stringify(vsc));
  const rate = await guest.evaluate(() => { window.__phVSC.applyRate(2); const v = document.querySelector('video'); return v && v.playbackRate; }).catch(() => null);
  check('I2: applyRate(2) doubles playbackRate', rate === 2, String(rate));

  console.log('\n== I3. live toggle off ==');
  await call(() => window.pigeonhole.extensions.setEnabled('videospeed', false));
  let off = null;
  for (let i = 0; i < 10 && off !== false; i++) {
    await sleep(300);
    off = await guest.evaluate(() => window.__phVSC ? window.__phVSC.enabled : null).catch(() => null);
  }
  check('I3: toggling off disables VSC in the open page', off === false, String(off));
  await call(() => window.pigeonhole.extensions.setEnabled('videospeed', true));

  console.log('\n== I4. Ad Shield cosmetic layer ==');
  const ads = await guest.evaluate(() => ({
    present: !!window.__phAds,
    active: window.__phAds ? window.__phAds.active() : false,
    style: !!document.getElementById('ph-adshield')
  })).catch(() => null);
  check('I4: __phAds present + cosmetic style active at Standard', ads?.present === true && ads?.active === true, JSON.stringify(ads));

  console.log('\n== I5. tracker requests cancelled + counter fed ==');
  let fetched = null;
  for (let i = 0; i < 10; i++) { await sleep(300); fetched = await guest.evaluate(() => window.__fetched || null).catch(() => null); if (fetched) break; }
  check('I5: doubleclick fetch was blocked by Ad Shield', fetched === 'blocked', String(fetched));
  const counts = await call(() => window.pigeonhole.extensions.adsCount());
  check('I5: blocked counter >= 1', (counts?.total || 0) >= 1, JSON.stringify(counts));

  console.log('\n== I6. per-site off removes the cosmetic layer ==');
  await call(o => window.pigeonhole.extensions.setConfig({ site: { origin: o, level: 'off' } }), `http://127.0.0.1:${SITE_PORT}`);
  let gone = null;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    gone = await guest.evaluate(() => window.__phAds ? !window.__phAds.active() : true).catch(() => null);
    if (gone === true) break;
  }
  check('I6: site rule "off" strips the cosmetic CSS live', gone === true, String(gone));
  // cleanup: reset site rules and back to standard
  await call(() => window.pigeonhole.extensions.setConfig({ resetSites: true }));

  if (!had) try { fs.rmSync(targetFile); } catch { }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  elec.kill(); try { await browser.close(); } catch { }
  staticSrv(path.join(ROOT, 'app')).close(); site.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[inject-test] CRASHED', e); process.exit(1); });
