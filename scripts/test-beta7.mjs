#!/usr/bin/env node
// v1.2.0-beta.1 E2E suite. Boots the real app and verifies the beta.7
// features (the user's picker selections):
//   S1  undo close tab (Ctrl+Shift+T path) reopens the last closed tab
//   S2  pinned tabs: compact, first in the strip, exempt from close-others,
//       persisted
//   S3  Ctrl+K tab switcher: fuzzy across workspaces, jump switches both
//   S4  Ctrl+Tab workspace cycler: MRU order, commits after the pause
//   S5  sidebar groups: header + collapse + tiles inside
//   S6  duplicate workspace: tabs + group carry over, identity fresh,
//       wizard pre-armed on the identity step
//   S7  app lock: PIN set -> lock overlay -> wrong pin stays -> right pin
//   S8  cross-device sync (the custom request): folder mode writes a sealed
//       bundle; a peer bundle with NEWER data merges in; an OLDER bundle
//       changes nothing - never goes backwards
//   S9  traffic meter counts bytes for the workspace
//   S10 reader view toggles on/off inside the page
//   S11 PiP path degrades gracefully with no video
//   S12 Settings renders the Sync tab and the App lock card
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8301;
const SITE_PORT = 8302;
const CDP_PORT = 9339;
const CFG = '/tmp/beta7-cfg';
const SYNC_DIR = '/tmp/beta7-sync';
const USER_DATA = path.join(CFG, 'Pigeonhole');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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

// ---------- test site: an article page (with content-length, for the
// traffic meter) and a video-less plain page ----------
const site = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/article')) {
    const paras = Array.from({ length: 12 }, (_, i) => `<p>${'Article body text with plenty of words to make a meaty paragraph for the reader heuristic. '.repeat(3)}(${i})</p>`).join('');
    const body = `<!doctype html><html><head><title>long article</title></head><body><h1>A Long Article</h1><div>${paras}</div></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  const body = '<!doctype html><html><body><h1 id="mk">plain-ok</h1></body></html>';
  res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});

async function bootApp() {
  fs.rmSync(CFG, { recursive: true, force: true });
  const env = {
    ...process.env,
    PH_E2E: '1', PH_POOL_OFF: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const errLog = fs.createWriteStream('/tmp/beta7-electron.log');
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
  await new Promise(r => srv.listen(APP_PORT, '127.0.0.1', r));
  await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));
  fs.rmSync(SYNC_DIR, { recursive: true, force: true });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const { browser, page, elec } = await bootApp();
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  const newWs = () => ev(async () => {
    const { refresh } = await import('/js/state.js');
    const { id } = await window.pigeonhole.workspaces.create({});
    await refresh();
    return id;
  });

  const wsA = await newWs();
  const wsB = await newWs();

  // ============ S1: undo close tab ============
  console.log('\n== S1. undo close tab ==');
  {
    const url = `http://127.0.0.1:${SITE_PORT}/article`;
    const r = await ev(async ([wsId, url]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      Tabs.switchWorkspace(wsId);
      const t = Tabs.createTab(wsId, { url, active: true });
      await new Promise(r2 => setTimeout(r2, 500));
      const before = Tabs.list(wsId).map(x => x.url);
      Tabs.closeTab(wsId, t.id);
      const afterClose = Tabs.list(wsId).map(x => x.url);
      const reopened = Tabs.undoClose(wsId);
      const afterUndo = Tabs.list(wsId).map(x => x.url);
      return { before, afterClose, reopened: reopened && reopened.url, afterUndo };
    }, [wsA, url]);
    check('tab closed then reopened with the same URL', r.afterUndo.includes(url) && !r.afterClose.includes(url), JSON.stringify(r));
  }

  // ============ S2: pinned tabs ============
  console.log('\n== S2. pinned tabs ==');
  {
    const r = await ev(async ([wsId]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      const { refresh } = S;
      const victim = Tabs.list(wsId).find(t => t.url.startsWith('http'));
      Tabs.togglePin(wsId, victim.id);
      await new Promise(r2 => setTimeout(r2, 250));
      const first = Tabs.list(wsId)[0];
      // snapshot as PRIMITIVES now: `first` is the same live object as
      // `victim`, and the unpin at the end would rewrite it before return
      const pinnedAtRead = !!(first && first.pinned);
      const firstIsVictim = !!(first && first.id === victim.id);
      const domPinned = document.querySelector('#tabstrip .tab')?.classList.contains('pinned');
      await new Promise(r2 => setTimeout(r2, 800));   // persist debounce
      await refresh();
      const stored = S.tabsFor(wsId).map(t => ({ url: t.url, pinned: !!t.pinned }));
      // the real "Close other tabs" menu path: open the tab menu on the
      // pinned tab and click that item
      Tabs.createTab(wsId, { url: 'http://127.0.0.1:8302/extra1', active: true });
      Tabs.createTab(wsId, { url: 'http://127.0.0.1:8302/extra2', active: false });
      await new Promise(r2 => setTimeout(r2, 300));
      const pinnedEl = document.querySelector('#tabstrip .tab.pinned');
      pinnedEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
      await new Promise(r2 => setTimeout(r2, 250));
      const item = [...document.querySelectorAll('.ctx-menu button')].find(x => /close other tabs/i.test(x.textContent || ''));
      item && item.click();
      await new Promise(r2 => setTimeout(r2, 350));
      const urlsLeft = Tabs.list(wsId).map(t => t.url);
      Tabs.togglePin(wsId, victim.id);   // unpin for later tests
      return { pinnedFirst: pinnedAtRead && firstIsVictim, domPinned, stored, itemFound: !!item, urlsLeft, victimId: victim.id, firstId: first && first.id };
    }, [wsA]);
    check('pinning moves the tab to the front of the strip', r.pinnedFirst, JSON.stringify(r));
    check('pinned tab renders compact (DOM .pinned class)', r.domPinned);
    check('pinned state persists to the store', r.stored.some(t => t.pinned), JSON.stringify(r.stored));
    check('the tab menu offers "Close other tabs"', r.itemFound);
    check('close-others leaves the pinned tab alive', r.urlsLeft.some(u => u && u.includes('article')), JSON.stringify(r.urlsLeft));
  }

  // ============ S3: Ctrl+K switcher ============
  console.log('\n== S3. tab switcher (Ctrl+K) ==');
  {
    const r = await ev(async ([wsA, wsB]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      const sw = await import('/js/switcher.js');
      Tabs.switchWorkspace(wsB);   // sit in wsB; the match lives in wsA
      Tabs.switchWorkspace(wsA);
      Tabs.createTab(wsA, { url: 'http://127.0.0.1:8302/target-page', active: true });
      Tabs.switchWorkspace(wsB);
      await new Promise(r2 => setTimeout(r2, 400));
      sw.openSwitcher();
      const input = document.querySelector('.switcher-input');
      input.value = 'target-page';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 200));
      const rows = [...document.querySelectorAll('.switcher-row')].map(x => x.textContent.slice(0, 60));
      const match = [...document.querySelectorAll('.switcher-row')].find(x => /target-page/.test(x.textContent));
      match && match.click();
      await new Promise(r2 => setTimeout(r2, 250));
      const activeWs = S.getActiveWsId();
      const cur = Tabs.currentTab(wsA);
      return { rows, jumpedToA: activeWs === wsA, curUrl: cur && cur.url };
    }, [wsA, wsB]);
    check('switcher finds a tab in ANOTHER workspace', r.rows.some(x => /target-page/.test(x)), JSON.stringify(r.rows));
    check('picking the row switches workspace AND tab', r.jumpedToA && /target-page/.test(r.curUrl || ''), JSON.stringify(r));
  }

  // ============ S4: workspace cycler (Ctrl+Tab) ============
  console.log('\n== S4. workspace cycler (Ctrl+Tab) ==');
  {
    const r = await ev(async ([wsA, wsB]) => {
      const Tabs = await import('/js/tabs.js');
      const S = await import('/js/state.js');
      const cyc = await import('/js/cycler.js');
      Tabs.switchWorkspace(wsA);   // MRU now: A (active), B
      const before = S.getActiveWsId();
      cyc.cycleWorkspace(1);       // -> B selected, commits after the pause
      await new Promise(r2 => setTimeout(r2, 900));
      const afterOne = S.getActiveWsId();
      const overlayGone = !document.querySelector('.cycler-ovr');
      cyc.cycleWorkspace(1);       // -> next MRU after B
      await new Promise(r2 => setTimeout(r2, 900));
      const afterTwo = S.getActiveWsId();
      return { before, afterOne, overlayGone, afterTwo };
    }, [wsA, wsB]);
    check('one Ctrl+Tab cycle commits to the next MRU workspace', r.afterOne === wsB, JSON.stringify(r));
    check('cycler overlay clears after commit', r.overlayGone);
    check('cycling wraps through the MRU list', r.afterTwo === wsA, JSON.stringify(r));
  }

  // ============ S5: sidebar groups ============
  console.log('\n== S5. workspace groups ==');
  {
    const r = await ev(async ([wsA, wsB]) => {
      const S = await import('/js/state.js');
      const { renderSidebar } = await import('/js/sidebar.js');
      await window.pigeonhole.workspaces.setGroup(wsA, 'Alpha');
      await window.pigeonhole.workspaces.setGroup(wsB, 'Alpha');
      await S.refresh();
      renderSidebar();
      const head = document.querySelector('.ws-group-head');
      const headName = head && head.textContent;
      const tilesInDom = [...document.querySelectorAll('#wsTiles .ws-tile')].map(t => t.dataset.ws);
      head.click();   // collapse
      await new Promise(r2 => setTimeout(r2, 300));
      await S.refresh();
      const collapsedTiles = [...document.querySelectorAll('#wsTiles .ws-tile')].map(t => t.dataset.ws);
      const groupedHidden = !collapsedTiles.includes(wsA) && !collapsedTiles.includes(wsB);
      head.click();   // expand again
      await new Promise(r2 => setTimeout(r2, 300));
      return { headName, tilesInDom, collapsedTiles, groupedHidden, expandedBack: document.querySelectorAll('#wsTiles .ws-tile').length };
    }, [wsA, wsB]);
    check('group header renders with the name', /alpha/i.test(r.headName || ''), JSON.stringify(r.headName));
    check('both grouped tiles render under it', r.tilesInDom.includes(wsA) && r.tilesInDom.includes(wsB), JSON.stringify(r.tilesInDom));
    check('collapsing hides the group tiles (ungrouped stay)', r.groupedHidden, JSON.stringify(r.collapsedTiles));
    check('expanding brings them back', r.expandedBack >= 2);
  }

  // ============ S6: duplicate workspace ============
  console.log('\n== S6. duplicate workspace ==');
  {
    const r = await ev(async ([wsA]) => {
      const S = await import('/js/state.js');
      const Tabs = await import('/js/tabs.js');
      const sb = await import('/js/sidebar.js');
      const src = S.ws(wsA);
      const srcUrls = Tabs.list(wsA).map(t => t.url);
      await sb.duplicate({ ...src });
      await new Promise(r2 => setTimeout(r2, 700));
      await S.refresh();
      const dup = S.workspaces().find(w => w.id !== wsA && (w.group === 'Alpha' || w.group === null) && w.id !== null && S.workspaces().indexOf(w) === S.workspaces().length - 1);
      const dupUrls = Tabs.list(dup.id).map(t => t.url);
      const wizardOpen = !!document.querySelector('#wizardPanel');
      const wizardAtIdentity = wizardOpen && /address|identity|signup/i.test(document.querySelector('#wizardPanel')?.textContent || '');
      return { dupId: dup.id, name: dup.name, group: dup.group, identity: dup.identity, dupUrls, srcUrls, wizardOpen, wizardAtIdentity, activeIsDup: S.getActiveWsId() === dup.id };
    }, [wsA]);
    check('duplicate copies every tab URL', r.dupUrls.length === r.srcUrls.length && r.dupUrls.every((u, i) => u === r.srcUrls[i]), JSON.stringify({ src: r.srcUrls, dup: r.dupUrls }));
    check('duplicate stays in the same group', r.group === 'Alpha', JSON.stringify(r.group));
    check('duplicate carries a FRESH identity (none yet)', r.identity === null);
    check('the clone becomes the active workspace', r.activeIsDup);
    check('the wizard is pre-armed (open at the identity step)', r.wizardOpen && r.wizardAtIdentity, 'wizardOpen=' + r.wizardOpen);
  }

  // ============ S7: app lock ============
  console.log('\n== S7. app lock (PIN) ==');
  {
    const r = await ev(async () => {
      const L = window.pigeonhole.lock;
      await L.setPin('4242');
      await L.lock();
      await new Promise(r2 => setTimeout(r2, 300));
      const overlayShown = !!document.querySelector('.lock-ovr');
      const wrong = await L.unlock('9999');
      await new Promise(r2 => setTimeout(r2, 250));
      const stillLocked = !!document.querySelector('.lock-ovr');
      const right = await L.unlock('4242');
      await new Promise(r2 => setTimeout(r2, 300));
      const unlocked = !document.querySelector('.lock-ovr');
      await L.setPolicy({ idleMinutes: 0 });
      return { overlayShown, wrong: wrong.ok, stillLocked, right: right.ok, unlocked };
    });
    check('locking covers the app with the PIN overlay', r.overlayShown);
    check('a wrong PIN does not unlock', r.wrong === false && r.stillLocked);
    check('the right PIN unlocks in place', r.right === true && r.unlocked);
  }

  // ============ S8: cross-device sync ============
  console.log('\n== S8. cross-device sync (sealed bundle, never backwards) ==');
  {
    const PASS = 'seal-me-7';
    const st1 = await ev(async ([dir, pass]) => window.pigeonhole.sync.setup(dir, pass), [SYNC_DIR, PASS]);
    check('sync setup enables folder mode', st1 && st1.enabled === true, JSON.stringify(st1));
    const bundleFile = path.join(SYNC_DIR, 'pigeonhole-sync.bundle');
    await sleep(2600);   // write debounce
    check('the sealed bundle file exists in the folder', fs.existsSync(bundleFile) && fs.statSync(bundleFile).size > 400, 'size=' + (fs.existsSync(bundleFile) ? fs.statSync(bundleFile).size : 0));

    // ---- peer with NEWER data: rename wsA, bump its clock, drop the bundle ----
    // main/sync.js is CommonJS: reach its seal/unseal through createRequire
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const syncCore = req(path.join(ROOT, 'main', 'sync.js'));
    const cur = syncCore.unseal(fs.readFileSync(bundleFile), PASS);
    const newer = JSON.parse(JSON.stringify(cur));
    const peerWs = newer.workspaces.find(w => w.id === wsA);
    peerWs.name = 'peer-newer-name';
    peerWs.updatedAt = Date.now() + 1000;
    fs.writeFileSync(bundleFile, syncCore.seal(newer, PASS));
    await ev(async () => window.pigeonhole.sync.syncNow());
    await ev(async () => { const { refresh } = await import('/js/state.js'); await refresh(); });
    const nameAfterNewer = await ev(async ([wsId]) => (await import('/js/state.js')).ws(wsId).name, [wsA]);
    check('a NEWER peer bundle merges in (rename applied)', nameAfterNewer === 'peer-newer-name', nameAfterNewer);

    // ---- peer with OLDER data: must change nothing ----
    const stale = JSON.parse(JSON.stringify(newer));
    const staleWs = stale.workspaces.find(w => w.id === wsA);
    staleWs.name = 'stale-old-name';
    staleWs.updatedAt = Date.now() - 500000;
    fs.writeFileSync(bundleFile, syncCore.seal(stale, PASS));
    const r2 = await ev(async () => window.pigeonhole.sync.syncNow());
    await ev(async () => { const { refresh } = await import('/js/state.js'); await refresh(); });
    const nameAfterStale = await ev(async ([wsId]) => (await import('/js/state.js')).ws(wsId).name, [wsA]);
    check('an OLDER bundle changes nothing (never backwards)', nameAfterStale === 'peer-newer-name', JSON.stringify({ nameAfterStale, merged: r2 && r2.merged }));
    // wrong passphrase on the FILE itself (read via node)
    let wrongRejected = false;
    try { syncCore.unseal(fs.readFileSync(bundleFile), 'wrong-pass'); } catch { wrongRejected = true; }
    check('a wrong passphrase cannot open the bundle', wrongRejected);
    const dis = await ev(async () => window.pigeonhole.sync.disable());
    check('sync can be stopped again', dis && dis.enabled === false, JSON.stringify(dis));
  }

  // ============ S9: traffic meter ============
  console.log('\n== S9. traffic meter ==');
  {
    await ev(async ([wsId, url]) => {
      const Tabs = await import('/js/tabs.js');
      Tabs.switchWorkspace(wsId);
      Tabs.navigate(wsId, url);
    }, [wsA, `http://127.0.0.1:${SITE_PORT}/article`]);
    await sleep(1800);
    const r = await ev(async ([wsId]) => {
      const t = await window.pigeonhole.traffic.get();
      return t[wsId] || null;
    }, [wsA]);
    check('bytes are counted for the workspace', r && (r.down > 0 || r.up > 0), JSON.stringify(r));
  }

  // ============ S10: reader view ============
  console.log('\n== S10. reader view ==');
  {
    // toggle reader view through the chrome action, then inspect the page
    await ev(async () => {
      const fx = await import('/js/pagefx.js');
      await fx.readerToggle();
    });
    const wvUrl = await ev(async ([wsId]) => {
      const Tabs = await import('/js/tabs.js');
      const wv = Tabs.webviewOf(wsId);
      return wv ? wv.getURL() : null;
    }, [wsA]);
    const on = await ev(async ([wsId]) => {
      const Tabs = await import('/js/tabs.js');
      const wv = Tabs.webviewOf(wsId);
      return await wv.executeJavaScript('!!document.getElementById("__phReader")', true);
    }, [wsA]);
    check('reader view builds the article overlay inside the page', on === true, 'wv=' + wvUrl);
    const off = await ev(async ([wsId]) => {
      const fx = await import('/js/pagefx.js');
      await fx.readerToggle();
      const Tabs = await import('/js/tabs.js');
      const wv = Tabs.webviewOf(wsId);
      return await wv.executeJavaScript('!document.getElementById("__phReader")', true);
    }, [wsA]);
    check('toggling again leaves the normal page', off === true);
  }

  // ============ S11: PiP with no video ============
  console.log('\n== S11. picture-in-picture (no video path) ==');
  {
    const r = await ev(async () => {
      const fx = await import('/js/pagefx.js');
      await fx.pipToggle();
      await new Promise(r2 => setTimeout(r2, 400));
      const t = [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' ');
      return { toast: t };
    });
    check('PiP with no video degrades to a clear toast', /no video/i.test(r.toast), JSON.stringify(r.toast));
  }

  // ============ S12: settings surfaces ============
  console.log('\n== S12. settings renders Sync + App lock ==');
  {
    const r = await ev(async () => {
      const { settingsModal } = await import('/js/modals.js');
      settingsModal('sync');
      await new Promise(r2 => setTimeout(r2, 500));
      const syncTab = !!document.querySelector('#modalRoot .seg, #modalRoot .row') && /Sync/.test([...document.querySelectorAll('#modalRoot .btn')].map(b => b.textContent).join(' '));
      const syncText = document.querySelector('#modalRoot')?.textContent || '';
      const hasSyncBody = /every device|sealed file/i.test(syncText);
      settingsModal('privacy');
      await new Promise(r2 => setTimeout(r2, 500));
      const privText = document.querySelector('#modalRoot')?.textContent || '';
      const hasLockCard = /App lock/i.test(privText) && /PIN/i.test(privText);
      document.querySelector('#modalRoot .overlay, #modalRoot')?.querySelector('.icon-btn')?.click();
      return { hasSyncBody, hasLockCard };
    });
    check('Settings has a Sync tab with the folder-sync flow', r.hasSyncBody);
    check('Privacy tab shows the App lock card', r.hasLockCard);
  }

  console.log(`\n==== beta7 suite: ${pass} passed, ${fail} failed ====`);
  elec.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('suite crashed:', e); process.exit(1); });
