#!/usr/bin/env node
// Quick check: does the workspace-settings modal body actually scroll to the
// bottom (proxy hint reachable) instead of clipping behind the footer?
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8196, CDP_PORT = 9232, CFG = '/tmp/modal-cfg';
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

await new Promise(r => staticSrv.listen(APP_PORT, '127.0.0.1', () => r()));
fs.rmSync(CFG, { recursive: true, force: true });
const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'),
  [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'],
  { env: { ...process.env, PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`, XDG_CONFIG_HOME: CFG, DISPLAY: ':96' }, stdio: ['ignore', 'ignore', 'ignore'] });
let browser = null;
const t0 = Date.now();
while (!browser) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); } catch { if (Date.now() - t0 > 40000) throw new Error('no electron'); await sleep(400); } }
let page = null;
while (!page) { for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith(`http://127.0.0.1:${APP_PORT}`)) page = p; if (!page) await sleep(300); }
await page.waitForTimeout(2200);

// open workspace settings for the active workspace (chip click = focusNetwork)
await page.evaluate(() => document.getElementById('wsChip').click());
await page.waitForTimeout(700);
const r = await page.evaluate(() => {
  const body = document.querySelector('.modal-body');
  const foot = document.querySelector('.modal-foot');
  const secs = [...body.querySelectorAll('.section')];
  const net = secs.find(s => s.querySelector('h3')?.textContent === 'Network');
  const netRect = net.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const hint = [...document.querySelectorAll('.modal-body .hint')].pop();
  const footRect = foot.getBoundingClientRect();
  const hintRect = hint.getBoundingClientRect();
  return {
    networkInView: netRect.top >= bodyRect.top - 2 && netRect.top < bodyRect.bottom,
    netTopVsBodyTop: Math.round(netRect.top - bodyRect.top),
    flashApplied: net.classList.contains('flash'),
    scrollable: body.scrollHeight > body.clientHeight,
    scrollDiff: body.scrollHeight - body.clientHeight,
    fullyVisible: hintRect.bottom <= footRect.top + 1,
    overflowY: getComputedStyle(body).overflowY
  };
});
console.log(JSON.stringify(r, null, 2));
await page.screenshot({ path: ROOT + '/dev-shots/ws-settings-focused.png' });
elec.kill(); try { await browser.close(); } catch { }
staticSrv.close(); process.exit(0);
