#!/usr/bin/env node
// v1.0.5 E2E suite - verifies the three fixes of this release against the
// real app (app/ over HTTP + Electron + CDP), driving the real UI:
//   1. dock panels reserve space: an open wizard/vault panel squeezes the
//      active webview left instead of covering the page's right edge
//   2. sign-in popup: a login form triggers the "Sign in as <email>?" pill,
//      Fill & sign in fills the form, Not now sticks only for that page
//   3. sidebar width: exactly as wide as its tiles, at one column and many
//      columns, and collapse-to-zero still works with a fitted width
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8178;
const CDP_PORT = 9223;
const DEV = 'http://127.0.0.1:8123';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};

function startStatic() {
  const dir = path.join(ROOT, 'app');
  const srv = http.createServer((req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(dir, path.normalize(rel));
      if (!file.startsWith(dir)) { res.statusCode = 403; return res.end(); }
      res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch { res.statusCode = 404; res.end('nf'); }
  });
  return new Promise(r => srv.listen(APP_PORT, '127.0.0.1', () => r(srv)));
}

async function bootApp() {
  fs.rmSync('/tmp/e2e105-cfg', { recursive: true, force: true });
  const env = { ...process.env, PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`, XDG_CONFIG_HOME: '/tmp/e2e105-cfg', DISPLAY: process.env.DISPLAY || ':98', ELECTRON_ENABLE_LOGGING: '1' };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const t0 = Date.now();
  let browser = null;
  while (!browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); }
    catch { if (Date.now() - t0 > 40000) throw new Error('electron never came up'); await new Promise(r => setTimeout(r, 400)); }
  }
  let page = null;
  while (!page) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith(`http://127.0.0.1:${APP_PORT}`)) page = p;
    if (!page) await new Promise(r => setTimeout(r, 300));
  }
  await page.waitForTimeout(2200);
  return { browser, page, elec };
}

async function main() {
  const srv = await startStatic();
  const { browser, page, elec } = await bootApp();
  const ev = (fn, args = []) => page.evaluate(fn, args);
  console.log('v1.0.5 fixes - live against the real app\n');

  // ---------- shared helpers (module imports inside the app page) ----------
  const newWs = () => ev(async () => {
    const { refresh } = await import('/js/state.js');
    const { id } = await window.pigeonhole.workspaces.create({});
    await refresh();
    return id;
  });
  const mockState = (wsId, expr) => ev(async ([wsId, expr]) => {
    const Tabs = await import('/js/tabs.js');
    const t = Tabs.list(wsId).find(t => t.active);
    const wv = Tabs.webviewOf(wsId, t);
    return wv.executeJavaScript(expr, false);
  }, [wsId, expr]);

  // ---------- 1. dock panels reserve space ----------
  console.log('== 1. wizard/vault panel reserves space ==');
  {
    const ws = await newWs();
    // wizard open + a real page in the tab so the webview exists
    await ev(async ([ws, url]) => {
      const Tabs = await import('/js/tabs.js');
      const { refresh } = await import('/js/state.js');
      await refresh();
      Tabs.switchWorkspace(ws);
      Tabs.navigate(ws, url);
      const { openWizard } = await import('/js/wizard.js');
      openWizard(ws);
      await new Promise(r => setTimeout(r, 600));   // panel-in + padding transition
    }, [ws, `${DEV}/login-mock.html`]);
    const s1 = await ev(async () => {
      const cs = getComputedStyle(document.querySelector('.ws-view.active'));
      const wvR = document.querySelector('.ws-view.active webview').getBoundingClientRect();
      const pR = document.querySelector('#wizardPanel:not(.hidden)').getBoundingClientRect();
      return { pad: cs.paddingRight, wvRight: wvR.right, panelLeft: pR.left, panelW: pR.width };
    });
    check('active view padded by the panel width while wizard open', s1.pad === '420px', JSON.stringify(s1));
    check('webview ends left of the panel (page never covered)', s1.wvRight <= s1.panelLeft + 1, JSON.stringify(s1));
    await ev(async () => { const { closeWizard } = await import('/js/wizard.js'); closeWizard(); });
    await page.waitForTimeout(450);   // padding transition out
    const s2 = await ev(() => getComputedStyle(document.querySelector('.ws-view.active')).paddingRight);
    check('padding returns to zero when wizard closed', s2 === '0px', s2);
    // vault panel does the same
    await ev(async ([ws]) => {
      const { openVault } = await import('/js/vault.js');
      const { refresh } = await import('/js/state.js');
      await refresh();
      openVault(ws);
    }, [ws]);
    await page.waitForTimeout(450);
    const s3 = await ev(async () => {
      const cs = getComputedStyle(document.querySelector('.ws-view.active'));
      const hidden = document.querySelector('#vaultPanel').classList.contains('hidden');
      return { pad: cs.paddingRight, vaultHidden: hidden };
    });
    check('vault panel also reserves space', s3.vaultHidden === false && s3.pad === '420px', JSON.stringify(s3));
    await ev(async () => { const { closeVault } = await import('/js/vault.js'); closeVault(); });
    await page.waitForTimeout(450);
    const s4 = await ev(() => getComputedStyle(document.querySelector('.ws-view.active')).paddingRight);
    check('padding returns to zero when vault closed', s4 === '0px', s4);
  }

  // ---------- 2. sign-in popup ----------
  console.log('\n== 2. sign-in popup ==');
  {
    // give the workspace an identity through the real wizard UI (existing-email path)
    const ws = await newWs();
    await ev(async ([ws]) => {
      const { refresh } = await import('/js/state.js');
      await refresh();
      const { openWizard } = await import('/js/wizard.js');
      Tabs: {
        const Tabs = await import('/js/tabs.js');
        Tabs.switchWorkspace(ws);
      }
      openWizard(ws);
    }, [ws]);
    await page.getByText('Use an email I already have').click();
    await page.locator('#wizardPanel input[type=email]').fill('someone@fastmail.com');
    await page.locator('#wizardPanel input[type=password]').fill('sup3rsecret!');
    const cont = page.locator('#wizardPanel button:has-text("Continue")').first();
    await cont.click();
    await page.locator('#wizardPanel button:has-text("Save workspace identity")').click();
    await page.waitForTimeout(700);
    const saved = await ev(async ([ws]) => {
      const S = await import('/js/state.js');
      await S.refresh();
      const { closeWizard } = await import('/js/wizard.js');
      closeWizard();
      return (S.workspaces().find(w => w.id === ws) || {}).identity?.email || '';
    }, [ws]);
    check('identity in place for the sign-in test', saved === 'someone@fastmail.com', saved);

    // navigate to the mock login page and wait for the identity poll cycle
    await ev(async ([ws, url]) => {
      const Tabs = await import('/js/tabs.js');
      Tabs.navigate(ws, url);
    }, [ws, `${DEV}/login-mock.html`]);
    await page.waitForTimeout(4200);   // page load + 1.6s poll
    const pop = await page.evaluate(() => {
      const p = document.querySelector('.login-pop');
      if (!p) return { exists: false };
      return { exists: true, text: p.innerText, fill: !![...p.querySelectorAll('button')].find(b => b.textContent === 'Fill & sign in'), notNow: !![...p.querySelectorAll('button')].find(b => b.textContent === 'Not now') };
    });
    check('sign-in popup appears on a login form', pop.exists === true, JSON.stringify(pop));
    check('popup asks with the workspace email', pop.exists && /someone@fastmail\.com/.test(pop.text), JSON.stringify(pop));
    check('popup offers Fill & sign in / Not now', pop.exists && pop.fill && pop.notNow, JSON.stringify(pop));

    // Fill & sign in -> the mock form actually gets the identity
    await page.locator('.login-pop button:has-text("Fill & sign in")').click();
    await page.waitForTimeout(1200);
    const filled = await mockState(ws, `JSON.stringify({ em: document.getElementById('em').value, pw: document.getElementById('pw').value })`);
    const f = JSON.parse(filled);
    check('popup fill typed the email into the form', f.em === 'someone@fastmail.com', filled);
    check('popup fill typed the password into the form', f.pw === 'sup3rsecret!', filled);
    check('popup gone after filling', (await page.locator('.login-pop').count()) === 0);

    // "Not now" sticks for this page only; a fresh page gets a fresh offer
    await ev(async ([ws, url]) => {
      const Tabs = await import('/js/tabs.js');
      Tabs.navigate(ws, url);
    }, [ws, `${DEV}/login-mock.html?q=2`]);
    await page.waitForTimeout(4200);
    check('fresh page gets a fresh sign-in offer', (await page.locator('.login-pop').count()) === 1);
    await page.locator('.login-pop button:has-text("Not now")').click();
    await page.waitForTimeout(3500);   // two more poll cycles on the SAME page
    check('Not now sticks on the same page', (await page.locator('.login-pop').count()) === 0);
  }

  // ---------- 3. sidebar width ----------
  console.log('\n== 3. sidebar exact width ==');
  {
    const one = await ev(async () => {
      const { refresh } = await import('/js/state.js');
      const { renderSidebar } = await import('/js/sidebar.js');
      await refresh();
      renderSidebar();
      await new Promise(r => setTimeout(r, 400));   // let the width transition settle
      return { w: document.getElementById('sidebar').offsetWidth, tiles: document.querySelectorAll('#wsTiles .ws-tile').length };
    });
    check('one workspace (min) width = 74', one.tiles >= 1 && one.w === 74, JSON.stringify(one));

    // pile up workspaces until tiles wrap into several columns
    for (let i = 0; i < 30; i++) await newWs();
    const m = await ev(async () => {
      const { refresh } = await import('/js/state.js');
      const { renderSidebar } = await import('/js/sidebar.js');
      await refresh();
      renderSidebar();
      await new Promise(r => setTimeout(r, 400));   // width transition (0.16s) must finish before measuring
      const sb = document.getElementById('sidebar');
      const sbR = sb.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('#wsTiles .ws-tile')].map(t => t.getBoundingClientRect());
      const xs = [...new Set(tiles.map(r => Math.round(r.left)))].length;
      const right = Math.max(...tiles.map(r => r.right));
      return { w: sb.offsetWidth, sbLeft: sbR.left, cols: xs, tiles: tiles.length, needed: right - sbR.left + 13 + 2, inner: window.innerWidth };
    });
    check('many workspaces wrap into several columns', m.cols >= 2, JSON.stringify({ cols: m.cols, tiles: m.tiles }));
    check('sidebar width is exactly the tiles (no slack)', Math.abs(m.w - Math.max(74, m.needed)) <= 1, JSON.stringify(m));
    check('sidebar never exceeds the 42vw cap', m.w <= Math.floor(m.inner * 0.42) + 1, JSON.stringify(m));

    // collapse still goes to zero with a fitted inline width present
    await page.locator('#collapseBtn').click();
    await page.waitForTimeout(450);
    const col = await ev(() => document.getElementById('sidebar').offsetWidth);
    check('collapse hides the sidebar completely', col <= 1, col);   // width 0 + 1px border
    await page.locator('#expandBtn').click();
    await page.waitForTimeout(450);
    const exp = await ev(() => document.getElementById('sidebar').offsetWidth);
    check('expand restores the exact width', Math.abs(exp - Math.max(74, m.needed)) <= 1, exp);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  fs.rmSync('/tmp/e2e105-cfg', { recursive: true, force: true });
  elec.kill(); srv.close();
  try { await browser.close(); } catch { }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[e2e-v105] CRASHED', e); process.exit(1); });
