#!/usr/bin/env node
// v1.1.0-beta.5 E2E suite. Boots the real app against a local MOCK of the
// mail.tm API (PH_MAIL_API env override) and verifies:
//   B1  instant address: mailbox created via API, identity saved, provider
//       recorded, disposable record stored, live inbox lists the mock mail
//   B2  inbox UI renders the message, and its verification link opens a real
//       tab in the workspace
//   B3  renumber on delete: numbers compact to 1..N, next create is N+1
//   B4  reorder IPC: full permutation renumbers 1..N
//   B5  drag-to-reorder: real pointer drag moves a tile (numbers follow)
//   B6  recency bars: active tile bar is 'on', previous fades, no net-dots
//   B7  fullscreen IPC toggles both ways
//   B8  gconsent script: picks Reject-all-style buttons, ignores other hosts
// plus the wizard's guided path still works against the provider mock page
// (regression: the new path card did not break the old flow).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8201;
const MAIL_PORT = 8202;
const DEV = 'http://127.0.0.1:8123';
const CDP_PORT = 9239;
const CFG = '/tmp/beta5-cfg';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- static server for the chrome ----------
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

// ---------- mock mail.tm API ----------
const mail = {
  created: null,
  msg: {
    id: 'msgmock1', from: { address: 'verify@mocksite.test', name: 'MockSite' },
    subject: 'Confirm your email', intro: 'Welcome! Confirm to finish signup.',
    seen: false, hasAttachments: false, createdAt: new Date().toISOString()
  }
};
const mailSrv = http.createServer((req, res) => {
  const j = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const data = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};
    if (req.url.startsWith('/domains')) {
      return j(200, { 'hydra:member': [{ domain: 'mocktest.com', isActive: true }] });
    }
    if (req.url === '/accounts') {
      if (mail.created) return j(422, { 'hydra:description': 'This address already exists' });
      mail.created = { id: 'accmock1', address: data.address };
      return j(201, mail.created);
    }
    if (req.url === '/token') {
      if (data.address !== mail.created?.address) return j(401, { message: 'bad credentials' });
      return j(200, { token: 'tokmock', id: mail.created.id });
    }
    if (req.url.startsWith('/messages/msgmock1')) {
      return j(200, {
        id: 'msgmock1', from: mail.msg.from, subject: mail.msg.subject,
        text: 'Confirm your email: https://verify.mocksite.test/confirm?t=abc123 done.',
        html: ['<a href="https://verify.mocksite.test/confirm?t=abc123">Confirm</a>']
      });
    }
    if (req.url.startsWith('/messages')) {
      return j(200, { 'hydra:member': [mail.msg] });
    }
    j(404, { message: 'no route' });
  });
});

async function bootApp() {
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env,
    PH_E2E: '1', PH_POOL_OFF: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    PH_MAIL_API: `http://127.0.0.1:${MAIL_PORT}`,
    PH_MAIL_API_2: `http://127.0.0.1:${MAIL_PORT}`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
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
  await page.waitForTimeout(2400);
  return { browser, page, elec };
}

async function main() {
  await new Promise(r => srv.listen(APP_PORT, '127.0.0.1', r));
  await new Promise(r => mailSrv.listen(MAIL_PORT, '127.0.0.1', r));
  const { browser, page, elec } = await bootApp();
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  const newWs = () => ev(async () => {
    const { refresh } = await import('/js/state.js');
    const { id } = await window.pigeonhole.workspaces.create({});
    await refresh();
    return id;
  });
  const driveInstant = (wsId, local) => ev(async ([wsId, local]) => {
    const { refresh } = await import('/js/state.js');
    const { driveInstantFlow } = await import('/js/wizard.js');
    await refresh();
    return driveInstantFlow(wsId, { local });
  }, [wsId, local]);

  // ============ B1: instant address end-to-end ============
  console.log('\n== B1. instant address (mock mail.tm API) ==');
  {
    const ws = await newWs();
    const r = await driveInstant(ws, 'tester777');
    check('mailbox created at mock API', mail.created?.address === 'tester777@mocktest.com', JSON.stringify(mail.created));
    check('wizard advanced to inbox step', r.step === 'inbox', r.step + ' err=' + r.error);
    check('address recorded on workspace', r.disposable?.address === 'tester777@mocktest.com' && r.disposable?.api === 'mail.tm', JSON.stringify(r.disposable));
    check('identity saved with instant provider', r.identity?.email === 'tester777@mocktest.com' && /Instant/.test(r.identity?.provider || ''), JSON.stringify(r.identity));
    check('live inbox lists the mock mail', (r.msgs || []).some(m => m.subject === 'Confirm your email'), JSON.stringify(r.msgs));
  }

  // ============ B2: inbox UI + verification link opens a tab ============
  console.log('\n== B2. inbox UI + link opens a workspace tab ==');
  {
    const state = await ev(async () => {
      const S = await import('/js/state.js');
      const wsId = S.getActiveWsId();
      return { wsId, hasItem: !!document.querySelector('#wizardPanel .msg-item'), msgSubj: document.querySelector('#wizardPanel .msg-subj')?.textContent || '' };
    });
    check('inbox message rendered in panel', state.hasItem && /Confirm your email/.test(state.msgSubj), JSON.stringify(state));
    // open the message detail, click the verification link button
    const link = await ev(async () => {
      document.querySelector('#wizardPanel .msg-row')?.click();
      await new Promise(r => setTimeout(r, 600));
      const btn = [...document.querySelectorAll('#wizardPanel .msg-links button')][0];
      if (!btn) return null;
      btn.click();
      await new Promise(r => setTimeout(r, 700));
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      return Tabs.list(S.getActiveWsId()).map(t => t.url);
    });
    check('verification link opened a workspace tab', (link || []).some(u => /verify\.mocksite\.test/.test(u) || /verify\.mocksite\.test/.test(decodeURIComponent(u))), JSON.stringify(link));
  }

  // ============ B3: renumber on delete ============
  console.log('\n== B3. numbering compacts after delete ==');
  {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await newWs());
    const before = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.num));
    check('fresh workspaces number 1..N', before.join() === '1,2,3,4,5', before.join());
    await ev(async ([id]) => { await window.pigeonhole.workspaces.remove(id); }, [ids[1]]);
    await sleep(400);
    const after = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.num));
    check('numbers compact to 1..N after delete', after.join() === '1,2,3,4', after.join());
    const nid = await newWs();
    const nums2 = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.num));
    check('next create continues at N+1', nums2.join() === '1,2,3,4,5' && nid, nums2.join());
  }

  // ============ B4: reorder IPC ============
  console.log('\n== B4. reorder IPC renumbers ==');
  {
    const r = await ev(async () => {
      const S = await import('/js/state.js');
      const ids = S.workspaces().map(w => w.id);
      const perm = [ids[4], ids[0], ids[1], ids[2], ids[3]];   // rotate: last becomes first
      await window.pigeonhole.workspaces.reorder(perm);
      await S.refresh();
      return S.workspaces().map(w => [w.id.slice(0, 8), w.num]);
    });
    check('full permutation renumbers 1..N', r.every(([, n], i) => n === i + 1), JSON.stringify(r));
    // sanity: a bogus order is rejected
    const bad = await ev(async () => {
      try { await window.pigeonhole.workspaces.reorder(['ws-bogus']); return 'accepted'; }
      catch { return 'rejected'; }
    });
    check('bogus order rejected by IPC', bad === 'rejected', bad);
  }

  // ============ B5: drag to reorder (real pointer gesture) ============
  console.log('\n== B5. drag tile reorders ==');
  {
    const before = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.id));
    const boxes = await ev(() => [...document.querySelectorAll('#wsTiles .ws-tile')].map(t => { const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    const first = await page.$$('#wsTiles .ws-tile');
    const src = boxes[0], dst = boxes[boxes.length - 1];
    await page.mouse.move(src.x, src.y);
    await page.mouse.down();
    // move in steps so the pointermove threshold + target detection both fire
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(src.x + ((dst.x - src.x) * i) / 8, src.y + ((dst.y - src.y) * i) / 8);
      await sleep(40);
    }
    await page.mouse.up();
    await sleep(700);
    const after = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.id));
    // B5: the dragged tile must have moved to a later position (the exact
    // slot depends on which neighbour the pointer was closest to at release)
    const idxBefore = before.indexOf(before[0]);
    const idxAfter = after.indexOf(before[0]);
    check('dragged tile moved down the list', idxAfter > idxBefore, `tile went from slot ${idxBefore} to ${idxAfter}`);
    check('drag moved the tile order', before.join() !== after.join(), 'order unchanged');
  }

  // ============ B6: recency bars ============
  console.log('\n== B6. switch tracker bars ==');
  {
    // switch through three workspaces IN ORDER, then read each tile by its
    // workspace id so tile order (changed by B4/B5) cannot confuse the check
    const bars = await ev(async () => {
      const S = await import('/js/state.js');
      const Tabs = await import('/js/tabs.js');
      const ids = S.workspaces().map(w => w.id);
      const switched = [];
      for (const id of ids.slice(0, 3)) { Tabs.switchWorkspace(id); switched.push(id); await new Promise(r => setTimeout(r, 350)); }
      await new Promise(r => setTimeout(r, 600));
      const read = (id) => {
        const t = document.querySelector(`#wsTiles .ws-tile[data-ws="${id}"]`);
        if (!t) return null;
        return {
          active: t.classList.contains('active'),
          barOn: !!(t.querySelector('.ws-bar')?.classList.contains('on')),
          opacity: parseFloat(getComputedStyle(t.querySelector('.ws-bar')).opacity || '0'),
          netDot: !!t.querySelector('.net-dot')
        };
      };
      return { twoAgo: read(switched[0]), oneAgo: read(switched[1]), current: read(switched[2]) };
    });
    check('active tile bar is on (opacity 1)', bars.current.active && bars.current.barOn && bars.current.opacity >= 0.9, JSON.stringify(bars.current));
    check('one-switch-away faded (step 0)', Math.abs(bars.oneAgo.opacity - 0.62) < 0.15, 'opacity=' + bars.oneAgo.opacity);
    check('two-switches-away faded further', bars.twoAgo.opacity < bars.oneAgo.opacity && Math.abs(bars.twoAgo.opacity - 0.44) < 0.15, 'opacity=' + bars.twoAgo.opacity);
    check('no status dots left on tiles', !bars.current.netDot && !bars.oneAgo.netDot && !bars.twoAgo.netDot);
  }

  // ============ B7: fullscreen IPC ============
  console.log('\n== B7. fullscreen ==');
  {
    const fs1 = await ev(async () => await window.pigeonhole.app.fullscreen());
    const fs2 = await ev(async () => await window.pigeonhole.app.fullscreen());
    check('fullscreen toggles on then back off', fs1 === true && fs2 === false, JSON.stringify([fs1, fs2]));
  }

  // ============ B8: gconsent script logic (pure, in harness) ============
  console.log('\n== B8. Google consent script ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'inject', 'gconsent.js'), 'utf8');
    const run = (hostname, buttons) => {
      let clicked = null;
      const mk = (text) => ({ textContent: text, click() { clicked = text; } });
      const btns = buttons.map(mk);
      const document = {
        querySelectorAll: () => btns,
        getElementById: () => null,
        querySelector: () => null
      };
      const setTimeout = () => { };
      new Function('location', 'document', 'setTimeout', src)( { hostname }, document, setTimeout);
      return clicked;
    };
    check('google host: clicks Reject all', run('www.google.com', ['Reject all', 'Accept all']) === 'Reject all');
    check('youtube host: clicks Accept all when Reject missing', run('youtube.com', ['Accept all']) === 'Accept all');
    check('non-google host: does nothing', run('mail.example.com', ['Reject all']) === null);
    check('no buttons: no crash', run('www.google.com', []) === null);
  }

  // ============ regression: guided wizard still drives a mock signup ============
  console.log('\n== R1. guided wizard regression ==');
  {
    const ws = await newWs();
    const r = await ev(async ([wsId]) => {
      const { refresh } = await import('/js/state.js');
      const { driveMockFlow } = await import('/js/wizard.js');
      await refresh();
      return driveMockFlow(wsId, 'http://127.0.0.1:8123/provider-mock.html');
    }, [ws]);
    check('guided autofill still fills the form', r.fill?.ok && r.fill?.filled?.length >= 4, JSON.stringify(r.fill).slice(0, 200));
    check('identity saved from guided flow', /@mockmail\.com$/.test(r.email || ''), r.email);
  }

  console.log(`\n== beta5 suite: ${pass} passed, ${fail} failed ==`);
  try { await browser.close(); } catch { }
  elec.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('suite crashed:', e); process.exit(1); });
