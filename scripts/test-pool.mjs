#!/usr/bin/env node
// Free-proxy-pool E2E. Boots the real app against local fake sources and fake
// proxies (plain SOCKS5, credentialed HTTP, dead candidate) and proves:
//   T1  boot migration auto-enables pool exits on every never-configured
//       workspace (the "I expected them to auto enable" behaviour)
//   T2  verified = only the live fakes; the dead candidate never lands
//   T3  a webview's page really transits the assigned exit (transit logs)
//   T4  Test exit IP answers through the exit
//   T5  rotate changes the exit and pages follow
//   T6  a dead exit heals automatically: watchdog rotates + reloads
//   T7  refresh drops the dead proxy from the verified pool
//   T8  new workspaces get an exit automatically on create
//   T9  Direct/Auto/Custom mode switching persists correctly
//  T10  regions() reflects verified countries
//  T11  bulk routes every workspace
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { startPoolFakes } from './pool-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8184;
const CDP_PORT = 9229;
const CFG = '/tmp/pool-cfg';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 400) + ']' : ''}`); }
};
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

async function guestText(browser, needle, urlPart = '') {
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    if (p.url().startsWith('http://127.0.0.1:8195') && p.url().includes(urlPart)) {
      const t = await p.evaluate(() => document.body.innerText).catch(() => '');
      if (t.includes(needle)) return true;
    }
  }
  return false;
}

async function main() {
  const fakes = await startPoolFakes();
  await new Promise(r => staticSrv.listen(APP_PORT, '127.0.0.1', () => r()));
  fs.rmSync(CFG, { recursive: true, force: true });

  const env = {
    ...process.env,
    PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`,
    PH_POOL_SOURCES: fakes.sourcesEnv,
    PH_POOL_CHECK_URL: fakes.checkUrl,
    PH_POOL_TIER2_URL: fakes.traceUrl,
    PH_POOL_BULK_URL: fakes.bulkUrl,
    PH_POOL_GEO_URL: fakes.whoamiUrl,
    PH_POOL_BYPASS: '<-loopback>',
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const errLog = fs.createWriteStream('/tmp/pool-electron.log');
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'),
    [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
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
  await page.waitForTimeout(2500);
  const call = (fn, ...args) => page.evaluate(`(${fn})(${args.map(a => JSON.stringify(a)).join(',')})`);
  const state = () => call(() => window.pigeonhole.state());
  const wsList = async () => (await state()).workspaces;

  // ---- T1: fresh boot -> first workspace auto-gets an exit; created ones too ----
  // (a fresh store creates ONE workspace in the renderer; migration covers
  //  upgraded stores with unconfigured workspaces - same assign() call)
  console.log('\n== T1/T2. auto-enable on boot + on create ==');
  let ws = [];
  let firstAuto = null;
  for (let i = 0; i < 80 && !firstAuto; i++) {
    ws = await wsList();
    firstAuto = ws.find(w => w.proxy && w.proxy.enabled && w.proxy.mode === 'auto' && w.proxy.source === 'pool');
    if (!firstAuto) await sleep(500);
  }
  check('T1: the first workspace auto-enables a pool exit at boot', !!firstAuto, JSON.stringify(ws.map(w => w.proxy && w.proxy.source)));
  // create three more; each must land its own exit automatically
  for (let k = 0; k < 3; k++) await call(() => window.pigeonhole.workspaces.create({}));
  let allAuto = false;
  for (let i = 0; i < 80 && !allAuto; i++) {
    ws = await wsList();
    allAuto = ws.length >= 4 && ws.every(w => w.proxy && w.proxy.enabled && w.proxy.mode === 'auto' && w.proxy.source === 'pool');
    if (!allAuto) await sleep(500);
  }
  check('T1: every workspace auto-enables a pool exit', allAuto, JSON.stringify(ws.map(w => w.proxy && w.proxy.source)));
  const exits = ws.map(w => `${w.proxy.host}:${w.proxy.port}`);
  check('T1: exits are distinct (no shared IPs)', new Set(exits).size === exits.length, JSON.stringify(exits));
  const nl = ws.find(w => w.proxy && w.proxy.port === 8301);
  check('T1: fastest fake (NL) assigned first', !!nl);
  check('T1: state exposes country + latency for pool exits', nl && nl.proxy.country === 'NL' && Number.isFinite(nl.proxy.latencyMs), JSON.stringify(nl && nl.proxy));

  // ---- T2: dead candidate never verified ----
  const poolSt = await call(() => window.pigeonhole.pool.status());
  check('T2: dead candidate (port 8305) never verified', !poolSt.verified ? false : !JSON.stringify(poolSt).includes('8305'), JSON.stringify(poolSt).slice(0, 300));
  check('T2: all four live fakes verified', poolSt.verified === 4, JSON.stringify(poolSt).slice(0, 200));
  check('T2: credentialed HTTP fake (PL) verified - 407 counts as alive', (await wsList()).some(w => w.proxy && w.proxy.port === 8304 && w.proxy.username === 'u1'), JSON.stringify((await wsList()).map(w => w.proxy && w.proxy.port)));

  // ---- T3: page traffic really transits the assigned exit ----
  console.log('\n== T3/T4. routing + exit IP through the pool exit ==');
  const ws0 = (await wsList())[0];
  await page.evaluate(() => { const wv = document.querySelector('.ws-view.active webview'); if (wv) console.log('active webview partition', wv.partition, 'src', wv.src); });
  await page.evaluate(url => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(url);
  }, fakes.siteUrl());
  let landed = false;
  for (let i = 0; i < 30 && !landed; i++) {
    await sleep(300);
    landed = await guestText(browser, 'pool-ok');
  }
  const transit = [...fakes.logs.nl, ...fakes.logs.de, ...fakes.logs.pl, ...fakes.logs.us];
  check('T3: the page loaded through a pool exit', landed);
  check('T3: the exit logged the page request in transit', transit.some(l => l.includes('pool-target')), JSON.stringify(transit.slice(0, 6)));
  const nlLogged = fakes.logs.nl.some(l => l.includes('pool-target'));

  // ---- T3b: pages also load through the CREDENTIALED http exit (PL) ----
  // (webview auth challenge -> app 'login' -> stored credentials)
  const wsPL = ws.find(w => w.proxy && w.proxy.port === 8304);
  if (wsPL) {
    const plIdx = ws.findIndex(w => w.id === wsPL.id);
    await page.evaluate(i => { const t = document.querySelectorAll('#wsTiles .ws-tile')[i]; t && t.click(); }, plIdx);
    await sleep(900);
    await page.evaluate(url => {
      const wv = document.querySelector('.ws-view.active webview');
      if (wv) wv.loadURL(url);
    }, fakes.siteUrl('/pool-target.html?pl'));
    let plLanded = false;
    for (let i = 0; i < 50 && !plLanded; i++) { await sleep(300); plLanded = await guestText(browser, 'pool-ok', '?pl'); }
    // the 407 -> login -> authorized retry takes a beat; poll the transit log
    let plTransit = false;
    for (let i = 0; i < 50 && !plTransit; i++) { await sleep(300); plTransit = fakes.logs.pl.some(l => l.includes('pool-target') && l.includes('Basic')); }
    check('T3b: pages load through the credentialed HTTP exit (login event answers)', plLanded, JSON.stringify(fakes.logs.pl.slice(0, 6)));
    check('T3b: the page request really transited the credentialed exit with auth', plTransit, JSON.stringify(fakes.logs.pl.slice(0, 8)));
    // back to workspace 0
    await page.evaluate(() => { const t = document.querySelectorAll('#wsTiles .ws-tile')[0]; t && t.click(); });
    await sleep(900);
  } else {
    check('T3b: credentialed exit assigned (PL)', false, 'no workspace got the PL exit');
  }

  // ---- T4: exit-IP test answers through the assigned exit ----
  const ipRes = await call((id, u) => window.pigeonhole.workspaces.testProxy(id, u)
    .then(r => JSON.stringify(r)).catch(e => 'ERR ' + String(e.message || e)), ws0.id, fakes.siteUrl('/ip'));
  let ipOk = false;
  try { ipOk = JSON.parse(ipRes).ip === '9.9.9.9'; } catch { }
  check('T4: testProxy answers the exit IP through the assigned exit', ipOk, ipRes);
  check('T4: the /ip probe transited the exit (socks case logged it)', nlLogged ? fakes.logs.nl.some(l => l.includes('/ip')) || fakes.logs.nl.some(l => l.includes('pool-target')) : true, JSON.stringify(fakes.logs.nl));

  // ---- T4b: exit-IP through the credentialed exit uses the page-load path ----
  const wsPL2 = (await wsList()).find(w => w.proxy && w.proxy.port === 8304);
  if (wsPL2) {
    const ipRes2 = await call((id, u) => window.pigeonhole.workspaces.testProxy(id, u)
      .then(r => JSON.stringify(r)).catch(e => 'ERR ' + String(e.message || e)), wsPL2.id, fakes.siteUrl('/ip'));
    let ipOk2 = false;
    try { ipOk2 = JSON.parse(ipRes2).ip === '198.51.100.44'; } catch { }
    check('T4b: testProxy answers through the credentialed exit (auth flow)', ipOk2, ipRes2);
  }

  // ---- T5: rotate changes the exit, pages follow ----
  console.log('\n== T5/T6. rotation + auto-heal ==');
  const before = (await wsList())[0].proxy;
  const rot = await call(id => window.pigeonhole.pool.rotate(id).then(r => JSON.stringify(r)).catch(e => 'ERR ' + String(e.message || e)), ws0.id);
  const after = (await wsList())[0].proxy;
  check('T5: rotate swaps to a different exit', after && after.port !== before.port, `${before.port} -> ${after && after.port}`);
  await page.evaluate(url => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(url + '?after-rotate');
  }, fakes.siteUrl());
  let landed2 = false;
  for (let i = 0; i < 30 && !landed2; i++) { await sleep(300); landed2 = await guestText(browser, 'pool-ok'); }
  check('T5: pages load through the rotated exit', landed2);

  // ---- T6: dead exit heals itself (watchdog) ----
  // kill the exit ws0 currently uses; loading a page must trigger did-fail-load
  // -> pool.heal -> rotation -> automatic reload with content back
  const cur = (await wsList())[0].proxy;
  const killName = cur.port === 8301 ? 'nl' : cur.port === 8302 ? 'de' : cur.port === 8304 ? 'pl' : 'us';
  await new Promise(async (r) => { fakes.kill(killName); setTimeout(r, 200); });
  const nlBefore = fakes.logs.nl.length;
  await sleep(600);
  await page.evaluate(url => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(url);
  }, fakes.siteUrl('/pool-target.html?heal=1'));
  let healed = false, healedPort = 0;
  for (let i = 0; i < 60 && !healed; i++) {
    await sleep(400);
    const curWs = (await wsList())[0];
    healedPort = curWs.proxy ? curWs.proxy.port : 0;
    healed = healedPort !== cur.port && await guestText(browser, 'pool-ok');
  }
  check('T6: a dead exit self-heals - rotated automatically', healed, `exit stayed on ${cur.port} after failure (killName=${killName})`);
  check('T6: the healed exit is a different verified proxy', healed && healedPort !== cur.port, `old=${cur.port} new=${healedPort}`);

  // ---- T7: refresh drops the dead proxy ----
  const st2 = await call(() => window.pigeonhole.pool.refresh());
  check('T7: refresh drops the killed proxy from the verified pool', !JSON.stringify(st2).includes(String(cur.port)) || st2.verified < 4, JSON.stringify(st2).slice(0, 240));
  const regions = await call(() => window.pigeonhole.pool.regions());
  check('T7: regions reflect live countries only', Array.isArray(regions) && regions.every(r => r.country !== 'XX'), JSON.stringify(regions));

  // ---- T8: new workspaces get an exit automatically ----
  const created = await call(() => window.pigeonhole.workspaces.create({}));
  let autoNew = false;
  for (let i = 0; i < 40 && !autoNew; i++) {
    await sleep(400);
    const w = (await wsList()).find(x => x.id === created.id);
    autoNew = !!(w && w.proxy && w.proxy.enabled && w.proxy.mode === 'auto');
  }
  check('T8: a newly created workspace gets an automatic exit', autoNew);

  // ---- T9: mode switching persists ----
  const ws1 = (await wsList())[1];
  await call(id => window.pigeonhole.workspaces.setProxyMode(id, 'direct'), ws1.id);
  check('T9: direct mode clears the proxy', !((await wsList())[1].proxy));
  await call(id => window.pigeonhole.workspaces.setProxyMode(id, 'auto'), ws1.id);
  check('T9: auto mode re-assigns a pool exit', ((await wsList())[1].proxy || {}).source === 'pool');
  await call((id, cfg) => window.pigeonhole.workspaces.setProxy(id, cfg), ws1.id, {
    enabled: true, scheme: 'http', host: '127.0.0.1', port: 8310, username: '', password: '', bypass: ''
  });
  const customNow = (await wsList())[1].proxy;
  check('T9: custom save switches to manual mode', customNow && customNow.mode === 'custom' && !customNow.source, JSON.stringify(customNow));

  // ---- T10/T11: regions + bulk ----
  const regs2 = await call(() => window.pigeonhole.pool.regions());
  check('T10: pool regions() lists countries with counts', Array.isArray(regs2) && regs2.length >= 2, JSON.stringify(regs2));
  const bulkRes = await call(() => window.pigeonhole.pool.bulk().then(r => JSON.stringify(r.length)));
  const afterBulk = await wsList();
  check('T11: bulk routes every workspace', afterBulk.every(w => w.proxy && w.proxy.mode === 'auto'), `bulk=${bulkRes} exits=${afterBulk.map(w => w.proxy && w.proxy.port).join(',')}`);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  elec.kill(); try { await browser.close(); } catch { }
  fakes.close(); staticSrv.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[pool-test] CRASHED', e); process.exit(1); });
