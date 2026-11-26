#!/usr/bin/env node
// Self-updater E2E. Boots the real app against a mock GitHub API:
//   /api/new  -> release v9.9.9 with a Windows zip asset
//   /api/old  -> release v0.0.1 (older than the dev build)
//   /zip      -> ~3 MB of incompressible bytes served with content-length
// Asserts the full event chain (available -> progress -> ready), the
// pending-update marker, the temp zip on disk, the dev-install guard and the
// no-update path.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8177;
const API_PORT = 8188;
const CDP_PORT = 9222;
const CFG = '/tmp/upd-cfg';
const PENDING = CFG + '/Pigeonhole/pending-update.json';   // userData = $XDG_CONFIG_HOME/<productName>
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- mock GitHub API + asset server ----
const ZIP_BYTES = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < ZIP_BYTES.length; i++) ZIP_BYTES[i] = (i * 31 + 7) & 0xff; // incompressible
const api = http.createServer((req, res) => {
  const route = (req.url || '').split('?')[0];
  if (route === '/api/new') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', body: 'The mock release notes',
      assets: [{ name: 'Pigeonhole-9.9.9-win-x64.zip', size: ZIP_BYTES.length, browser_download_url: `http://127.0.0.1:${API_PORT}/zip` }]
    }));
  } else if (route === '/api/old') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      tag_name: 'v0.0.1', body: 'old', assets: [{ name: 'Pigeonhole-0.0.1-win-x64.zip', size: 12, browser_download_url: `http://127.0.0.1:${API_PORT}/zip` }]
    }));
  } else if (route === '/api/list') {
    // beta channel feed: newest release is a pre-release; an older stable follows
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([
      {
        tag_name: 'v9.9.9-beta.1', prerelease: true, body: 'the mock beta',
        assets: [{ name: 'Pigeonhole-9.9.9-beta.1-win-x64.zip', size: ZIP_BYTES.length, browser_download_url: `http://127.0.0.1:${API_PORT}/zip` }]
      },
      {
        tag_name: 'v9.9.8', prerelease: false, body: 'stable but older',
        assets: [{ name: 'Pigeonhole-9.9.8-win-x64.zip', size: ZIP_BYTES.length, browser_download_url: `http://127.0.0.1:${API_PORT}/zip` }]
      }
    ]));
  } else if (route === '/zip') {
    res.setHeader('content-length', String(ZIP_BYTES.length));
    res.setHeader('content-type', 'application/zip');
    res.end(ZIP_BYTES);
  } else { res.statusCode = 404; res.end('nf'); }
});

// ---- static server for app/ (same pattern as e2e-suite) ----
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

async function bootApp(updateApi, listApi) {
  const env = {
    ...process.env,
    PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    PH_UPDATE_API: `http://127.0.0.1:${API_PORT}${updateApi}`,
    ...(listApi ? { PH_UPDATE_LIST_API: `http://127.0.0.1:${API_PORT}${listApi}` } : {}),
    PH_UPDATE_DELAY: '600',
    XDG_CONFIG_HOME: '/tmp/upd-cfg', DISPLAY: process.env.DISPLAY || ':96'
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
  await page.waitForTimeout(1500);
  return { browser, page, elec };
}

async function main() {
  await new Promise(r => api.listen(API_PORT, '127.0.0.1', () => r()));
  await new Promise(r => staticSrv.listen(APP_PORT, '127.0.0.1', () => r()));

  console.log('\n== U1. update found -> downloaded -> ready ==');
  {
    fs.rmSync(CFG, { recursive: true, force: true });
    const { browser, page, elec } = await bootApp('/api/new');
    const waitEv = async (type, ms = 25000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const got = await page.evaluate(t => (window.__upd || []).some(e => e.type === t), type);
        if (got) return true;
        await sleep(400);
      }
      return false;
    };
    check('update-available event fires', await waitEv('update-available'));
    check('download progress reported', await waitEv('update-download-progress'));
    check('update-ready event fires', await waitEv('update-ready'));
    const evs = await page.evaluate(() => (window.__upd || []).map(e => e.type));
    check('event order sane', evs.indexOf('update-available') < evs.indexOf('update-ready'), evs.join(','));
    const ready = await page.evaluate(() => (window.__upd || []).find(e => e.type === 'update-ready')?.payload);
    check('ready payload names v9.9.9', ready?.latest === '9.9.9', JSON.stringify(ready));
    // marker + temp zip on disk
    check('pending-update.json written', fs.existsSync(PENDING));
    if (fs.existsSync(PENDING)) {
      const p = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
      check('marker points at the zip + version', p.version === '9.9.9' && fs.existsSync(p.zip), JSON.stringify(p));
    }
    const zip = path.join(os.tmpdir(), 'pigeonhole-Pigeonhole-9.9.9-win-x64.zip');
    check('zip landed in temp at the right size', fs.existsSync(zip) && fs.statSync(zip).size === ZIP_BYTES.length, zip);
    // dev guard: install refuses in unpackaged builds
    const install = await page.evaluate(() => window.pigeonhole.updates.install('restart'));
    check('install blocked in dev build', install && install.ok === false && /dev/i.test(install.error || ''), JSON.stringify(install));
    elec.kill(); try { await browser.close(); } catch { }
    await sleep(800);
  }

  console.log('\n== U2. no update path (older tag) stays silent ==');
  {
    fs.rmSync(CFG, { recursive: true, force: true });
    const { browser, page, elec } = await bootApp('/api/old');
    await page.waitForTimeout(6000);   // delay 600ms + generous margin
    const evs = await page.evaluate(() => (window.__upd || []).map(e => e.type));
    check('no update events on an older release', (evs || []).length === 0, JSON.stringify(evs));
    elec.kill(); try { await browser.close(); } catch { }
    await sleep(800);
  }

  console.log('\n== U3. reconcile re-arms a pending update on next boot ==');
  {
    // seed a pending marker with a fake zip, boot with the old-release API:
    // reconcile must still announce ready
    fs.rmSync(CFG, { recursive: true, force: true });
    fs.mkdirSync(CFG + '/Pigeonhole', { recursive: true });
    const fakeZip = path.join(os.tmpdir(), 'pigeonhole-fake-9.8.0.zip');
    fs.writeFileSync(fakeZip, 'fakezip');
    fs.writeFileSync(PENDING, JSON.stringify({ zip: fakeZip, version: '9.8.0', size: 7 }));
    const { browser, page, elec } = await bootApp('/api/old');
    await page.waitForTimeout(3000);
    const ready = await page.evaluate(() => (window.__upd || []).find(e => e.type === 'update-ready')?.payload);
    check('stale pending update re-announced', ready?.latest === '9.8.0', JSON.stringify(ready));
    elec.kill(); try { await browser.close(); } catch { }
  }

  console.log('\n== U4. beta channel picks the pre-release from the list feed ==');
  {
    fs.rmSync(CFG, { recursive: true, force: true });
    // seed the store with the beta toggle on; the stable endpoint (/api/old)
    // would say "up to date", so any update event proves the beta feed was used
    fs.mkdirSync(CFG + '/Pigeonhole', { recursive: true });
    fs.writeFileSync(CFG + '/Pigeonhole/pigeonhole-store.json', JSON.stringify({
      version: 1, settings: { betaUpdates: true }, ui: { sidebarCollapsed: false, activeWsId: null },
      nextWsNum: 1, workspaces: [], tabs: {}, history: {}
    }));
    const { browser, page, elec } = await bootApp('/api/old', '/api/list');
    const waitEv = async (type, ms = 25000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const got = await page.evaluate(t => (window.__upd || []).some(e => e.type === t), type);
        if (got) return true;
        await sleep(400);
      }
      return false;
    };
    check('beta update-available fires', await waitEv('update-available'));
    check('beta update-ready fires', await waitEv('update-ready'));
    const avail = await page.evaluate(() => (window.__upd || []).find(e => e.type === 'update-available')?.payload);
    check('beta payload names v9.9.9-beta.1', avail?.latest === '9.9.9-beta.1', JSON.stringify(avail));
    check('beta payload is on the beta channel', avail?.channel === 'beta', JSON.stringify(avail));
    check('beta payload flagged prerelease', avail?.prerelease === true, JSON.stringify(avail));
    elec.kill(); try { await browser.close(); } catch { }
    await sleep(800);
  }

  console.log('\n== U5. stable channel ignores the pre-release feed ==');
  {
    fs.rmSync(CFG, { recursive: true, force: true });
    // beta toggle off: the list endpoint exists but is never consulted; the
    // stable endpoint (/api/old) is older than the dev build -> silence
    const { browser, page, elec } = await bootApp('/api/old', '/api/list');
    await page.waitForTimeout(6000);
    const evs = await page.evaluate(() => (window.__upd || []).map(e => e.type));
    check('no update events with beta off', (evs || []).length === 0, JSON.stringify(evs));
    elec.kill(); try { await browser.close(); } catch { }
    await sleep(800);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  api.close(); staticSrv.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[updater-test] CRASHED', e); process.exit(1); });
