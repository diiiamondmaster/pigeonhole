#!/usr/bin/env node
// beta.5 visual harness: screenshots of the new UI against the mock mail API.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8203;
const MAIL_PORT = 8204;
const CDP_PORT = 9243;
const CFG = '/tmp/vis5-cfg';
const OUT = ROOT + '/dev-shots';
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  try {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, 'app', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'app'))) { res.statusCode = 403; return res.end(); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.statusCode = 404; res.end('nf'); }
});

const mailSrv = http.createServer((req, res) => {
  const j = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = []; req.on('data', c => body.push(c)); req.on('end', () => {
    const data = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};
    if (req.url.startsWith('/domains')) return j(200, { 'hydra:member': [{ domain: 'mocktest.com', isActive: true }] });
    if (req.url === '/accounts') return j(201, { id: 'accmock1', address: data.address });
    if (req.url === '/token') return j(200, { token: 'tokmock', id: 'accmock1' });
    if (req.url.startsWith('/messages/msgmock1')) return j(200, {
      id: 'msgmock1', from: { address: 'no-reply@github.test', name: 'GitHub' }, subject: '[GitHub] Please verify your email address',
      text: 'Almost done! Verify your email to finish setting up your account. https://verify.mocksite.test/confirm?t=abc123',
      html: ['<a href="https://verify.mocksite.test/confirm?t=abc123">Verify email address</a>']
    });
    if (req.url.startsWith('/messages')) return j(200, { 'hydra:member': [
      { id: 'msgmock1', from: { address: 'no-reply@github.test' }, subject: '[GitHub] Please verify your email address', intro: 'Almost done! Verify your email to finish...', seen: false, hasAttachments: false, createdAt: new Date().toISOString() },
      { id: 'msgmock2', from: { address: 'news@newsletter.test' }, subject: 'Welcome to the weekly digest', intro: 'You are subscribed. Here is what happened...', seen: true, hasAttachments: false, createdAt: new Date(Date.now() - 3600e3).toISOString() }
    ] });
    j(404, {});
  });
});

async function main() {
  await new Promise(r => srv.listen(APP_PORT, '127.0.0.1', r));
  await new Promise(r => mailSrv.listen(MAIL_PORT, '127.0.0.1', r));
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env, PH_E2E: '1', PH_POOL_OFF: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    PH_MAIL_API: `http://127.0.0.1:${MAIL_PORT}`, PH_MAIL_API_2: `http://127.0.0.1:${MAIL_PORT}`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const t0 = Date.now();
  let browser = null;
  while (!browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); }
    catch { if (Date.now() - t0 > 40000) throw new Error('no electron'); await new Promise(r => setTimeout(r, 400)); }
  }
  let page = null;
  while (!page) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith(`http://127.0.0.1:${APP_PORT}`)) page = p;
    if (!page) await new Promise(r => setTimeout(r, 300));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(2600);
  const ev = (fn, ...args) => page.evaluate(fn, ...args);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // a few extra workspaces so the sidebar shows tiles + bars
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await ev(async () => {
    const { refresh } = await import('/js/state.js');
    const { id } = await window.pigeonhole.workspaces.create({});
    await refresh();
    return id;
  }));
  await ev(async ([ids]) => {
    const Tabs = await import('/js/tabs.js');
    for (const id of ids) { Tabs.switchWorkspace(id); await new Promise(r => setTimeout(r, 420)); }
  }, [ids]);

  // 1. wizard path step (instant card first)
  await ev(async ([wsId]) => {
    const Tabs = await import('/js/tabs.js');
    const { openWizard } = await import('/js/wizard.js');
    Tabs.switchWorkspace(wsId);
    openWizard(wsId);
  }, [ids[3]]);
  await sleep(600);
  await page.screenshot({ path: OUT + '/beta5-wizard-path.png' });

  // 2. instant creation -> inbox with two messages, first expanded
  const r = await ev(async ([wsId]) => {
    const { refresh } = await import('/js/state.js');
    const { driveInstantFlow } = await import('/js/wizard.js');
    await refresh();
    return driveInstantFlow(wsId, { local: 'nova.falcon42' });
  }, [ids[3]]);
  await sleep(400);
  await ev(async () => { document.querySelector('#wizardPanel .msg-row')?.click(); await new Promise(r => setTimeout(r, 500)); });
  await sleep(300);
  await page.screenshot({ path: OUT + '/beta5-instant-inbox.png' });

  // 3. provider list (new registry: Proton, Atomic, Mailfence, Tuta)
  await ev(async () => {
    const { openWizardAt } = await import('/js/wizard.js');
    const S = await import('/js/state.js');
    openWizardAt(S.getActiveWsId(), 'provider');
  });
  await sleep(500);
  await page.screenshot({ path: OUT + '/beta5-providers.png' });

  // 4. sidebar with recency bars (several tiles at different fades)
  await ev(async () => { document.querySelector('#wizardPanel .panel-head button')?.click(); });
  await ev(async ([ids]) => {
    const Tabs = await import('/js/tabs.js');
    Tabs.switchWorkspace(ids[1]); await new Promise(r => setTimeout(r, 500));
    Tabs.switchWorkspace(ids[0]); await new Promise(r => setTimeout(r, 500));
  }, [ids]);
  await sleep(400);
  await page.screenshot({ path: OUT + '/beta5-sidebar-bars.png' });

  console.log('shots saved:', JSON.stringify({ r: r.address }));
  try { await browser.close(); } catch { }
  elec.kill('SIGKILL');
  process.exit(0);
}

main().catch(e => { console.error('vis harness crashed:', e); process.exit(1); });
