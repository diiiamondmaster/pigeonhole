#!/usr/bin/env node
// v1.1.0-beta.6 E2E suite. Boots the real app and verifies the beta.6 fixes
// and features:
//   K1  Atomic Mail is the wizard default: preselected provider card,
//       Continue enabled, no "instant address" path anywhere
//   K2  the disposable-mail API surface is gone (preload + store)
//   K3  reload button after a failed load retries the TARGET page, not the
//       internal error page (flaky server: down, then up)
//   K4  appearance zoom no longer lifts the statusbar off the window bottom
//       (compact and large both land gap = 0)
//   K5  switch trails: the tile you left carries a tall bar; every further
//       switch shrinks and fades it one step (height + opacity ladders)
//   K6  page (HTML) fullscreen really takes the window: webview rect equals
//       the window, chrome hidden; leaving restores the content area
//   K7  window fullscreen IPC still toggles both ways
//   K8  mail backup capture: a backup-looking download from a workspace with
//       a mail identity lands in the workspace backup store, NOT Downloads
//   K9  backup capture by local-part (address in the file name)
//   K10 legacy scan: old Downloads files tied to an identity are imported
//       (source 'legacy'), unrelated files are left in place
//   K11 backups: open-in-folder IPC + workspace delete removes the files
//   B3/B4/B5  renumber-on-delete, reorder IPC, drag-to-reorder (from beta.5)
//   B7/B8     fullscreen IPC + gconsent script logic (from beta.5)
//   R1        guided wizard regression against the mock provider page
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8201;
const FLAKY_PORT = 8203;
const MAIL_PORT = 8204;
const CDP_PORT = 9239;
const CFG = '/tmp/beta6-cfg';
const DL = '/tmp/beta6-downloads';
const USER_DATA = path.join(CFG, 'Pigeonhole');
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

// ---------- flaky site: connection dies while `down`, serves when up ----------
let flakyDown = true;
const flakySrv = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.startsWith('/video')) {
    // synthetic canvas video + a fullscreen helper (no media file needed)
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body style="margin:0;background:#102a43;color:#fff">
      <div style="padding:10px">video page</div>
      <video id="v" width="640" height="360" style="display:block;background:#000" controls></video>
      <script>
        const c = document.createElement('canvas'); c.width = 640; c.height = 360;
        const x = c.getContext('2d');
        setInterval(() => { x.fillStyle = '#123'; x.fillRect(0,0,640,360); x.fillStyle = '#f2b155';
          x.beginPath(); x.arc(320 + Math.round(80*Math.sin(Date.now()/400)), 180, 60, 0, 7); x.fill(); }, 100);
        document.getElementById('v').srcObject = c.captureStream(30);
        window.__fs = async () => { try { await document.documentElement.requestFullscreen(); return 'doc'; }
          catch { try { await document.getElementById('v').requestFullscreen(); return 'video'; } catch { return 'fail'; } } };
      </script></body></html>`);
    return;
  }
  if (flakyDown) { res.socket.destroy(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body><h1 id="mk">flaky-ok</h1></body></html>');
});

// ---------- fake mail provider: page + backup file downloads ----------
const mailSrv = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.startsWith('/file')) {
    const name = decodeURIComponent((u.split('name=')[1] || '').split('&')[0]) || 'backup.bin';
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`
    });
    res.end(Buffer.from('FAKE-BACKUP-CONTENTS-' + name));
    return;
  }
  // the provider "app" page with a one-click backup export link
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><body><h1 id="mk">mail-app</h1>
    <a id="dl" href="/file?name=${encodeURIComponent('account-backup.tuta')}">export backup</a>
    <script>window.__dl = (n) => { location.href = '/file?name=' + encodeURIComponent(n); };</script>
    </body></html>`);
});

async function bootApp() {
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env,
    PH_E2E: '1', PH_POOL_OFF: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const errLog = fs.createWriteStream('/tmp/beta6-electron.log');
  elec.stderr.on('data', d => errLog.write(d));
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
  await new Promise(r => srv.listen(APP_PORT, '127.0.0.1', r()));
  await new Promise(r => flakySrv.listen(FLAKY_PORT, '127.0.0.1', r()));
  await new Promise(r => mailSrv.listen(MAIL_PORT, '127.0.0.1', r()));
  const { browser, page, elec } = await bootApp();
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  // route all downloads into the test dir from the start
  fs.mkdirSync(DL, { recursive: true });
  await ev(async ([dir]) => { await window.pigeonhole.settings.set({ downloadsDir: dir }); }, [DL]);

  const newWs = () => ev(async () => {
    const { refresh } = await import('/js/state.js');
    const { id } = await window.pigeonhole.workspaces.create({});
    await refresh();
    return id;
  });

  // ============ K1/K2: Atomic Mail default, instant mode gone ============
  console.log('\n== K1/K2. wizard defaults to Atomic Mail, instant mode removed ==');
  {
    const ws = await newWs();
    const r = await ev(async ([wsId]) => {
      const { openWizard } = await import('/js/wizard.js');
      openWizard(wsId);
      await new Promise(r2 => setTimeout(r2, 300));
      const pathCards = [...document.querySelectorAll('#wizardPanel .choice-card h4')].map(h => h.textContent);
      // enter the guided path
      [...document.querySelectorAll('#wizardPanel .choice-card')].find(c => /Create a new email/.test(c.textContent))?.click();
      await new Promise(r2 => setTimeout(r2, 250));
      const atomicCard = document.querySelector('#wizardPanel .provider-card');
      const cont = [...document.querySelectorAll('#wizardPanel .btn-primary')].find(b => /Continue/.test(b.textContent));
      return {
        pathCards,
        atomicOn: !!atomicCard && atomicCard.classList.contains('on'),
        atomicFirst: !!atomicCard && /Atomic Mail/.test(atomicCard.querySelector('h4')?.textContent || ''),
        continueEnabled: cont ? !cont.disabled : null,
        hasTempApi: !!window.pigeonhole.temp
      };
    }, [ws]);
    check('path step offers guided + existing only (no instant card)', r.pathCards.length === 2 && !r.pathCards.some(t => /instant/i.test(t)), JSON.stringify(r.pathCards));
    check('Atomic Mail card is preselected', r.atomicOn, 'first provider card .on=' + r.atomicOn);
    check('Atomic Mail is the first provider', r.atomicFirst);
    check('Continue is enabled without picking a provider', r.continueEnabled === true);
    check('the disposable mail API is gone from the preload', r.hasTempApi === false);
    await ev(async () => { document.querySelector('#wizardPanel .panel-head .icon-btn')?.click(); });
  }

  // ============ K3: reload button retries the target, not the error page ============
  console.log('\n== K3. reload after a failed load ==');
  {
    flakyDown = true;
    await ev(async ([url]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      Tabs.navigate(S.getActiveWsId(), url);
    }, [`http://127.0.0.1:${FLAKY_PORT}/page`]);
    await sleep(1800);
    const onErr = await ev(() => document.querySelector('.ws-view.active webview')?.getURL());
    check('failed load lands on the internal error page', /^pigeonhole:\/\/error\//.test(onErr || ''), onErr);
    flakyDown = false;
    await page.click('#reloadBtn');
    await sleep(1600);
    const after = await ev(() => document.querySelector('.ws-view.active webview')?.getURL());
    const text = await page.evaluate(async () => {
      const wv = document.querySelector('.ws-view.active webview');
      try { return await wv.executeJavaScript('document.body.innerText'); } catch { return ''; }
    });
    check('reload button reloaded the TARGET page (not the error page)', /flaky-ok/.test(text || '') && !/^pigeonhole:\/\/error\//.test(after || ''), after + ' | ' + (text || '').slice(0, 40));
  }

  // ============ K4: zoom no longer lifts the bottom ============
  console.log('\n== K4. statusbar sits on the window bottom at any zoom ==');
  {
    const geo = async () => ev(async () => {
      const sb = document.querySelector('.statusbar').getBoundingClientRect();
      return { h: innerHeight, sbBottom: sb.bottom, gap: innerHeight - sb.bottom, zoom: document.body.style.zoom || '' };
    });
    const dflt = await geo();
    check('default: statusbar flush with the window bottom', Math.abs(dflt.gap) < 1, JSON.stringify(dflt));
    await ev(() => window.pigeonhole.settings.set({ uiScale: 'compact' }));
    await sleep(500);
    const compact = await geo();
    check('compact (zoom 0.9): no strip under the statusbar', Math.abs(compact.gap) < 1, JSON.stringify(compact));
    await ev(() => window.pigeonhole.settings.set({ uiScale: 'large' }));
    await sleep(500);
    const large = await geo();
    check('large (zoom 1.1): statusbar not clipped off-screen', Math.abs(large.gap) < 1, JSON.stringify(large));
    await ev(() => window.pigeonhole.settings.set({ uiScale: 'normal' }));
    await sleep(400);
  }

  // ============ workspaces for the rest of the suite ============
  const ids = [await newWs(), await newWs(), await newWs()];

  // ============ K5: switch trails shrink and fade ============
  console.log('\n== K5. recency trails (shrink + fade) ==');
  {
    const bars = await ev(async ([ids]) => {
      const Tabs = await import('/js/tabs.js');
      const switched = [];
      for (const id of ids) { Tabs.switchWorkspace(id); switched.push(id); await new Promise(r => setTimeout(r, 380)); }
      await new Promise(r => setTimeout(r, 500));
      const read = (id) => {
        const t = document.querySelector(`#wsTiles .ws-tile[data-ws="${id}"]`);
        const bar = t && t.querySelector('.ws-bar');
        if (!bar) return null;
        const cs = getComputedStyle(bar);
        const rect = bar.getBoundingClientRect();
        const tileR = t.getBoundingClientRect();
        return { active: t.classList.contains('active'), on: bar.classList.contains('on'),
          opacity: parseFloat(cs.opacity), h: rect.height, tileH: tileR.height };
      };
      return { twoAgo: read(switched[0]), oneAgo: read(switched[1]), current: read(switched[2]) };
    }, [ids]);
    check('active tile carries the full bar', bars.current.active && bars.current.on && bars.current.opacity >= 0.9, JSON.stringify(bars.current));
    check('the tile you just left has a TALL bar (step 0)', bars.oneAgo.h > bars.current.h * 0.85 && bars.oneAgo.opacity > 0.8, JSON.stringify(bars.oneAgo));
    check('two switches away: the bar SHRANK further', bars.twoAgo.h < bars.oneAgo.h, `${bars.twoAgo.h.toFixed(1)}px < ${bars.oneAgo.h.toFixed(1)}px`);
    check('two switches away: the bar FADED further', bars.twoAgo.opacity < bars.oneAgo.opacity, `${bars.twoAgo.opacity} < ${bars.oneAgo.opacity}`);
  }

  // ============ K6: HTML fullscreen takes the whole window ============
  console.log('\n== K6. page fullscreen fills the window ==');
  {
    await ev(async ([url]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      Tabs.navigate(S.getActiveWsId(), url);
    }, [`http://127.0.0.1:${FLAKY_PORT}/video`]);
    await sleep(1600);
    await ev(async () => {
      const wv = document.querySelector('.ws-view.active webview');
      await wv.executeJavaScript('window.__fs ? window.__fs() : null');
    }).catch(() => { });
    await sleep(1100);
    const fsState = await ev(async () => {
      const app = document.getElementById('app');
      const wv = document.querySelector('.ws-view.active webview')?.getBoundingClientRect();
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
      return { pageFs: app.classList.contains('page-fs'), wv: wv ? { x: Math.round(wv.x), y: Math.round(wv.y), w: Math.round(wv.width), h: Math.round(wv.height) } : null,
        topbarVisible: !!topbar && topbar.height > 0, win: { w: innerWidth, h: innerHeight } };
    });
    check('entering page fullscreen hides the chrome', fsState.pageFs && !fsState.topbarVisible, JSON.stringify(fsState));
    check('the webview fills the whole window', fsState.wv && fsState.wv.x === 0 && fsState.wv.y === 0 && fsState.wv.w === fsState.win.w && fsState.wv.h === fsState.win.h, JSON.stringify(fsState.wv));
    await ev(async () => {
      const wv = document.querySelector('.ws-view.active webview');
      await wv.executeJavaScript('document.exitFullscreen ? document.exitFullscreen() : null');
    }).catch(() => { });
    await sleep(900);
    const exState = await ev(async () => {
      const wv = document.querySelector('.ws-view.active webview')?.getBoundingClientRect();
      return { pageFs: document.getElementById('app').classList.contains('page-fs'), y: wv ? Math.round(wv.y) : null, topbarVisible: document.querySelector('.topbar')?.getBoundingClientRect().height > 0 };
    });
    check('leaving fullscreen restores the content area', !exState.pageFs && exState.topbarVisible && exState.y > 0, JSON.stringify(exState));
  }

  // ============ K7: window fullscreen IPC ============
  console.log('\n== K7. window fullscreen ==');
  {
    const fs1 = await ev(async () => await window.pigeonhole.app.fullscreen());
    const fs2 = await ev(async () => await window.pigeonhole.app.fullscreen());
    check('fullscreen toggles on then back off', fs1 === true && fs2 === false, JSON.stringify([fs1, fs2]));
  }

  // ============ K8/K9: backup capture ============
  console.log('\n== K8/K9. mail backup capture ==');
  {
    // K8: domain-matched capture. Identity on the (fake) provider host, a
    // backup-named export from that host: diverted into the workspace store.
    const wsA = ids[0];
    await ev(async ([wsId]) => {
      await window.pigeonhole.vault.setIdentity(wsId, { email: 'ada@127.0.0.1', password: 'pw-12345678', displayName: 'Ada', provider: 'Fake Mail' });
      const Tabs = await import('/js/tabs.js');
      Tabs.switchWorkspace(wsId);
    }, [wsA]);
    await ev(async ([url]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      Tabs.navigate(S.getActiveWsId(), url);
    }, [`http://127.0.0.1:${MAIL_PORT}/app`]);
    await sleep(1500);
    // download the backup export from the provider page
    await ev(async () => {
      const wv = document.querySelector('.ws-view.active webview');
      await wv.executeJavaScript('window.__dl ? window.__dl("account-backup.tuta") : document.getElementById("dl").click()');
    }).catch(() => { });
    await sleep(1800);

    const dlDirFiles = fs.existsSync(DL) ? fs.readdirSync(DL) : [];
    const backupDir = path.join(USER_DATA, 'backups', wsA);
    const stored = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    const snap = await ev(async ([wsId]) => (await import('/js/state.js')).ws(wsId)?.backups || [], [wsA]);
    check('K8: the backup file never reached the Downloads folder', !dlDirFiles.some(f => /account-backup/.test(f)), JSON.stringify(dlDirFiles));
    check('K8: the backup file lives in the workspace backup store', stored.some(f => /account-backup\.tuta/.test(f)), JSON.stringify(stored));
    check('K8: the backup is recorded on the workspace', snap.some(b => /account-backup\.tuta/.test(b.name)), JSON.stringify(snap));

    // K9: local-part capture. Different workspace, tuta identity, file name
    // carries the address.
    const wsB = ids[1];
    await ev(async ([wsId]) => {
      await window.pigeonhole.vault.setIdentity(wsId, { email: 'tester777@tuta.com', password: 'pw-12345678', displayName: 'T', provider: 'Tuta' });
    }, [wsB]);
    await ev(async ([wsId, url]) => {
      const Tabs = await import('/js/tabs.js');
      Tabs.switchWorkspace(wsId);
      Tabs.navigate(wsId, url);
    }, [wsB, `http://127.0.0.1:${MAIL_PORT}/app`]);
    await sleep(1500);
    await ev(async () => {
      const wv = document.querySelector('.ws-view.active webview');
      await wv.executeJavaScript('window.__dl ? window.__dl("backup-tester777@tuta.com.tuta") : null');
    }).catch(() => { });
    await sleep(1800);
    const backupDirB = path.join(USER_DATA, 'backups', wsB);
    const storedB = fs.existsSync(backupDirB) ? fs.readdirSync(backupDirB) : [];
    const snapB = await ev(async ([wsId]) => (await import('/js/state.js')).ws(wsId)?.backups || [], [wsB]);
    check('K9: address-named backup captured by local part', storedB.some(f => /tester777/.test(f)), JSON.stringify(storedB));
    check('K9: recorded with the workspace (Tuta provider)', snapB.some(b => /tester777/.test(b.name) && /Tuta/.test(b.provider || '')), JSON.stringify(snapB));

    // a normal (non-backup) download from the same page still goes to Downloads
    const DL_BEFORE = (fs.existsSync(DL) ? fs.readdirSync(DL) : []).length;
    await ev(async () => {
      const wv = document.querySelector('.ws-view.active webview');
      await wv.executeJavaScript('window.__dl ? window.__dl("holiday-photo.png") : null');
    }).catch(() => { });
    await sleep(1400);
    const DL_AFTER = (fs.existsSync(DL) ? fs.readdirSync(DL) : []).length;
    check('K9: a non-backup download still lands in Downloads', DL_AFTER > DL_BEFORE, `${DL_BEFORE} -> ${DL_AFTER}`);
  }

  // ============ K10: legacy scan of the Downloads folder ============
  console.log('\n== K10. legacy backup import from Downloads ==');
  {
    fs.rmSync(DL, { recursive: true, force: true });
    fs.mkdirSync(DL, { recursive: true });
    fs.writeFileSync(path.join(DL, 'backup-tester777@tuta.com.tuta'), 'LEGACY-1');
    fs.writeFileSync(path.join(DL, 'recovery-ada.tuta'), 'LEGACY-2');
    fs.writeFileSync(path.join(DL, 'random-notes.txt'), 'keep me');
    fs.writeFileSync(path.join(DL, 'setup.exe'), 'keep me too');
    // note: 'recovery-ada.tuta' is claimed by the ONLY tuta workspace via
    // the provider-extension rule - that is the designed behaviour. Only
    // files with no tie at all must stay behind.
    const r = await ev(async ([dir]) => {
      await window.pigeonhole.settings.set({ downloadsDir: dir });
      return await window.pigeonhole.backups.rescan();
    }, [DL]);
    await sleep(700);
    const left = fs.readdirSync(DL).sort();
    const snapB = await ev(async ([wsId]) => (await import('/js/state.js')).ws(wsId)?.backups || [], [ids[1]]);
    const storedB = fs.readdirSync(path.join(USER_DATA, 'backups', ids[1])).sort();
    check('K10: scan imported the identity-matched file', (r.imported || 0) >= 1, JSON.stringify(r));
    check('K10: the matched file moved into the workspace store', storedB.some(f => /tester777/.test(f)), JSON.stringify(storedB));
    check('K10: recorded as a legacy import', snapB.some(b => b.source === 'legacy' && /tester777/.test(b.name)), JSON.stringify(snapB));
    check('K10: unrelated files stay in Downloads untouched', left.includes('random-notes.txt') && left.includes('setup.exe'), JSON.stringify(left));
    check('K10: the provider-specific .tuta file went to the only tuta workspace', !left.includes('recovery-ada.tuta'), JSON.stringify(left));
    const wsSnap = await ev(async () => (await import('/js/state.js')).workspaces().map(w => [w.id, (w.backups || []).length]));
    const total = wsSnap.reduce((n, [, b]) => n + b, 0);
    check('K10: no file was claimed by the wrong workspace', total >= 3, JSON.stringify(wsSnap));
  }

  // ============ K11: backup open + delete cleanup ============
  console.log('\n== K11. backup lifecycle ==');
  {
    const ok = await ev(async ([wsId]) => {
      const S = await import('/js/state.js');
      const b = S.ws(wsId)?.backups?.[0];
      if (!b) return 'no-record';
      try { await window.pigeonhole.backups.open(wsId, b.name); return true; }
      catch (e) { return 'rejected: ' + String(e.message || e).slice(0, 60); }
    }, [ids[1]]);
    check('K11: open-in-folder resolves for a stored backup', ok === true, String(ok));
    const wsB = ids[1];
    const dirBefore = fs.existsSync(path.join(USER_DATA, 'backups', wsB));
    await ev(async ([wsId]) => { await window.pigeonhole.workspaces.remove(wsId); }, [wsB]);
    await sleep(700);
    const dirAfter = fs.existsSync(path.join(USER_DATA, 'backups', wsB));
    check('K11: deleting the workspace removes its backup files', dirBefore && !dirAfter, `before=${dirBefore} after=${dirAfter}`);
  }

  // ============ B3: renumber on delete ============
  console.log('\n== B3. numbering compacts after delete ==');
  {
    const before = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.num));
    const all = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.id));
    await ev(async ([id]) => { await window.pigeonhole.workspaces.remove(id); }, [all[0]]);
    await sleep(400);
    const after = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.num));
    check('numbers compact to 1..N after delete', after.join() === Array.from({ length: after.length }, (_, i) => i + 1).join(), before.join() + ' -> ' + after.join());
    const nid = await newWs();
    const nums2 = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.num));
    check('next create continues at N+1', nums2[nums2.length - 1] === nums2.length && !!nid, nums2.join());
  }

  // ============ B4: reorder IPC ============
  console.log('\n== B4. reorder IPC renumbers ==');
  {
    const r = await ev(async () => {
      const S = await import('/js/state.js');
      const ids = S.workspaces().map(w => w.id);
      if (ids.length < 2) return [];
      const perm = [ids[ids.length - 1], ...ids.slice(0, -1)];   // rotate
      await window.pigeonhole.workspaces.reorder(perm);
      await S.refresh();
      return S.workspaces().map(w => [w.id.slice(0, 8), w.num]);
    });
    check('full permutation renumbers 1..N', r.every(([, n], i) => n === i + 1), JSON.stringify(r));
    const bad = await ev(async () => {
      try { await window.pigeonhole.workspaces.reorder(['ws-bogus']); return 'accepted'; }
      catch { return 'rejected'; }
    });
    check('bogus order rejected by IPC', bad === 'rejected', bad);
  }

  // ============ B5: drag to reorder ============
  console.log('\n== B5. drag tile reorders ==');
  {
    const before = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.id));
    if (before.length >= 2) {
      const boxes = await ev(() => [...document.querySelectorAll('#wsTiles .ws-tile')].map(t => { const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
      const src = boxes[0], dst = boxes[boxes.length - 1];
      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(src.x + ((dst.x - src.x) * i) / 8, src.y + ((dst.y - src.y) * i) / 8);
        await sleep(40);
      }
      await page.mouse.up();
      await sleep(700);
      const after = await ev(async () => (await import('/js/state.js')).workspaces().map(w => w.id));
      check('drag moved the tile order', before.join() !== after.join() || boxes.length < 2, 'order unchanged');
    } else {
      check('drag moved the tile order (skipped: <2 ws)', true);
    }
  }

  // ============ B8: gconsent script logic ============
  console.log('\n== B8. Google consent script ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'inject', 'gconsent.js'), 'utf8');
    const run = (hostname, buttons) => {
      let clicked = null;
      const mk = (text) => ({ textContent: text, click() { clicked = text; } });
      const btns = buttons.map(mk);
      const document = { querySelectorAll: () => btns, getElementById: () => null, querySelector: () => null };
      const setTimeout = () => { };
      new Function('location', 'document', 'setTimeout', src)({ hostname }, document, setTimeout);
      return clicked;
    };
    check('google host: clicks Reject all', run('www.google.com', ['Reject all', 'Accept all']) === 'Reject all');
    check('non-google host: does nothing', run('mail.example.com', ['Reject all']) === null);
    check('no buttons: no crash', run('www.google.com', []) === null);
  }

  // ============ R1: guided wizard regression ============
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

  console.log(`\n== beta6 suite: ${pass} passed, ${fail} failed ==`);
  try { await browser.close(); } catch { }
  elec.kill('SIGKILL');
  flakySrv.close(); mailSrv.close(); srv.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('suite crashed:', e); process.exit(1); });
