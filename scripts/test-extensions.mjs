#!/usr/bin/env node
// Extensions + per-workspace proxy E2E. Boots the real app (app/ over HTTP +
// Electron + CDP) and drives the IPC surface directly:
//   E1  extensions list -> four built-ins with the right defaults
//   E2  toggling persists to the store and reflects in the list
//   E3  Ad Shield config: level presets, per-site rules, reset
//   E4  workspace proxy: sanitized IPC answers never leak the password;
//       the store keeps it encrypted; bad input is rejected
//   E5  proxy password keep / replace / clear semantics
//   E6  unknown extension ids and bad configs are rejected
//   E7  exit-IP test channel answers through the workspace session
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8179;
const CDP_PORT = 9224;
const CFG = '/tmp/ext-cfg';
const STORE = CFG + '/Pigeonhole/pigeonhole-store.json';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- static server for app/ ----
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
  await new Promise(r => staticSrv.listen(APP_PORT, '127.0.0.1', () => r()));
  const { browser, page, elec } = await bootApp();
  const call = (fn, ...args) => page.evaluate(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);

  console.log('\n== E1. built-in extension list ==');
  const wsId = await call(() => window.pigeonhole.state().then(s => s.workspaces[0].id));
  check('a workspace exists for the test', !!wsId, String(wsId));
  const list0 = await call(() => window.pigeonhole.extensions.list());
  const byId = Object.fromEntries(list0.map(x => [x.id, x]));
  check('four built-ins ship', list0.length === 4, JSON.stringify(list0.map(x => x.id)));
  check('spell check on by default', byId.spellcheck?.enabled === true);
  check('tracker shield on by default', byId.trackershield?.enabled === true);
  check('video speed on by default', byId.videospeed?.enabled === true);
  check('ad shield on by default', byId.adshield?.enabled === true);
  check('history guard is gone', !byId.historyguard);
  check('adshield card carries its level config', byId.adshield?.config?.level === 'standard', JSON.stringify(byId.adshield?.config));
  check('cards carry names/descriptions/versions', !!(byId.spellcheck?.name && byId.spellcheck?.description && byId.spellcheck?.version));

  console.log('\n== E2. toggling persists and reflects ==');
  const list1 = await call(() => window.pigeonhole.extensions.setEnabled('spellcheck', false));
  check('list reflects the toggle', list1.find(x => x.id === 'spellcheck')?.enabled === false);
  await sleep(800);   // store write is debounced
  const onDisk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('store keeps extensions map on disk', onDisk.settings?.extensions?.spellcheck === false, JSON.stringify(onDisk.settings?.extensions));
  await call(() => window.pigeonhole.extensions.setEnabled('spellcheck', true));
  check('toggle back on', (await call(() => window.pigeonhole.extensions.list())).find(x => x.id === 'spellcheck')?.enabled === true);

  console.log('\n== E3. Ad Shield config (level + per-site) ==');
  const cfg0 = await call(() => window.pigeonhole.extensions.getConfig());
  check('default config: standard, no sites', cfg0?.level === 'standard' && Object.keys(cfg0?.sites || {}).length === 0, JSON.stringify(cfg0));
  await call(() => window.pigeonhole.extensions.setConfig({ level: 'strict' }));
  let st = await call(() => window.pigeonhole.state());
  check('level change reflects in state', st.settings?.adshield?.level === 'strict', JSON.stringify(st.settings?.adshield));
  await call(c => window.pigeonhole.extensions.setConfig({ site: { origin: c, level: 'off' } }), 'http://blocked.test');
  st = await call(() => window.pigeonhole.state());
  check('per-site off rule saved', st.settings?.adshield?.sites?.['http://blocked.test'] === 'off', JSON.stringify(st.settings?.adshield?.sites));
  await call(c => window.pigeonhole.extensions.setConfig({ site: { origin: c, level: null } }), 'http://blocked.test');
  st = await call(() => window.pigeonhole.state());
  check('null level clears the site rule', !('http://blocked.test' in (st.settings?.adshield?.sites || {})), JSON.stringify(st.settings?.adshield?.sites));
  const badCfg = await call(() => window.pigeonhole.extensions.setConfig({ level: 'ultra' }).catch(e => String(e.message || e)));
  check('invalid level rejected', /bad/i.test(String(badCfg)), String(badCfg));
  const badSite = await call(() => window.pigeonhole.extensions.setConfig({ site: { origin: 'not-a-url', level: 'off' } }).catch(e => String(e.message || e)));
  check('bad origin rejected', /bad/i.test(String(badSite)), String(badSite));
  await call(() => window.pigeonhole.extensions.setConfig({ level: 'standard' }));
  check('level back to standard', (await call(() => window.pigeonhole.extensions.getConfig())).level === 'standard');

  console.log('\n== E4. per-workspace proxy via IPC ==');
  const saved = await call(id => window.pigeonhole.workspaces.setProxy(id, {
    enabled: true, scheme: 'socks5', host: '127.0.0.1', port: 1080,
    username: 'proxyuser', password: 'topsecret', keepPassword: false, bypass: ''
  }), wsId);
  check('saved answer is sanitized (no password field)', saved && !('password' in saved) && saved.host === '127.0.0.1' && saved.port === 1080, JSON.stringify(saved));
  check('saved answer marks the stored secret', saved?.hasPassword === true, JSON.stringify(saved));
  st = await call(() => window.pigeonhole.state());
  const wp = (st.workspaces || []).find(w => w.id === wsId)?.proxy;
  check('state() carries the sanitized proxy', wp?.enabled === true && wp?.scheme === 'socks5' && !('password' in wp), JSON.stringify(wp));
  await sleep(800);
  const disk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const dp = disk.workspaces.find(w => w.id === wsId)?.proxy;
  if (disk.settings?.vaultEncrypted) {
    check('on-disk password encrypted when the OS store exists', dp?.password?.e === 1 && !JSON.stringify(disk).includes('topsecret'), JSON.stringify(dp?.password));
  } else {
    // sandbox has no keychain: the store's documented fallback is a flagged
    // plaintext box, and settings.vaultEncrypted=false makes the UI warn
    check('no keychain: plaintext box + vaultEncrypted=false warning flag',
      dp?.password && typeof dp.password === 'object' && 'e' in dp.password === false && disk.settings?.vaultEncrypted === false,
      JSON.stringify({ pw: dp?.password, enc: disk.settings?.vaultEncrypted }));
  }
  const bad = await call(id => window.pigeonhole.workspaces.setProxy(id, { enabled: true, scheme: 'socks5', host: '', port: 0 }).catch(e => String(e.message || e)), wsId);
  check('empty host rejected', /host/i.test(String(bad)), String(bad));
  const bad2 = await call(id => window.pigeonhole.workspaces.setProxy(id, { enabled: true, scheme: 'http', host: 'x', port: 99999 }).catch(e => String(e.message || e)), wsId);
  check('out-of-range port rejected', /port/i.test(String(bad2)), String(bad2));

  console.log('\n== E5. password keep / replace / clear semantics ==');
  const kept = await call(id => window.pigeonhole.workspaces.setProxy(id, {
    enabled: true, scheme: 'socks5', host: '127.0.0.1', port: 1080,
    username: 'proxyuser', password: '', keepPassword: true, bypass: ''
  }), wsId);
  check('empty password + keepPassword retains the secret', kept?.hasPassword === true, JSON.stringify(kept));
  const cleared = await call(id => window.pigeonhole.workspaces.setProxy(id, {
    enabled: true, scheme: 'http', host: '127.0.0.1', port: 8080,
    username: 'u', password: '', keepPassword: false, bypass: ''
  }), wsId);
  check('empty password without keep clears the secret', cleared?.hasPassword === false, JSON.stringify(cleared));
  const off = await call(id => window.pigeonhole.workspaces.setProxy(id, { enabled: false }), wsId);
  check('disabling clears the proxy', off === null, JSON.stringify(off));
  st = await call(() => window.pigeonhole.state());
  check('state() shows no proxy after disable', (st.workspaces || []).find(w => w.id === wsId)?.proxy === null);

  console.log('\n== E6. unknown extension id rejected ==');
  const err = await call(() => window.pigeonhole.extensions.setEnabled('nope', true).catch(e => String(e.message || e)));
  check('unknown id rejected', /unknown extension/i.test(String(err)), String(err));

  console.log('\n== E7. exit-IP test channel ==');
  // not proxied: the request goes out through the session (direct)
  const ipRes = await call(id => window.pigeonhole.workspaces.testProxy(id, 'http://127.0.0.1:8179/index.html')
    .then(r => JSON.stringify(r)).catch(e => 'ERR ' + String(e.message || e)), wsId);
  let ipOk = false;
  try { ipOk = JSON.parse(ipRes).ok === false && /no IP found|HTTP \d+/.test(JSON.parse(ipRes).error || ''); } catch { }
  check('testProxy answers through the session (no IP in the test page answer)', ipOk, ipRes);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  elec.kill(); try { await browser.close(); } catch { }
  staticSrv.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[ext-test] CRASHED', e); process.exit(1); });
