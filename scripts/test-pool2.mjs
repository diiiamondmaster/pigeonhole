#!/usr/bin/env node
// Free-proxy-pool v2 E2E: the quality engine + supervisor. Boots the real app
// against engineered fakes and proves the behaviours that fix "far away,
// slow, inconsistent exits":
//   Q1  boot assignment prefers real-content-verified exits: a "ghost"
//       (answers the 204 ping, fails the real-content check) is never
//       assigned while a content-verified exit exists; it is reported weak
//   Q2  the user's location is detected (loc= oracle) and feeds scoring
//   Q3  real-page failures feed the exit's score, and the supervisor does
//       NOT churn when no better exit exists (no pointless swaps)
//   Q4  when a better exit appears, the supervisor upgrades seamlessly and
//       pages recover
//   Q5  proximity scoring: a same-country exit beats a far faster one
//   Q6  a dead assigned exit is replaced PROACTIVELY (before any page
//       breaks) and WITHOUT reloading the open page (hit counter frozen),
//       then new pages work through the replacement
//   Q7  supervision stats are visible (sweeps, rotations)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { startPoolFakes } from './pool-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8186;
const CDP_PORT = 9231;
const CFG = '/tmp/pool2-cfg';
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
  // engineered fakes:
  //   liar  (8306): answers 204 ping, real-content check AND throughput, but
  //                 breaks every real page (tunnels everything except the
  //                 site server) - isolates the page-feedback path
  //   ghost (8307): answers ONLY the 204 ping - the classic "fast but
  //                 useless" exit the tier-2 gate must demote
  //   nl (150ms) / de (100ms) / us (0ms): the proximity scenario - user is
  //                 in NL, so NL must outrank the faster US exit
  const fakes = await startPoolFakes({
    delays: { nl: 150, us: 0 },
    extraFakes: [
      { name: 'liar', kind: 'socks', port: 8306, delay: 0, tunnelFilter: (h, p) => p !== 8195 },
      { name: 'ghost', kind: 'socks', port: 8307, delay: 0, tunnelFilter: (h, p) => p === 8194 }
    ]
  });
  fakes.setSources({
    geoSocks: [
      { ip: '127.0.0.1', port: 8307, country: 'XX' },
      { ip: '127.0.0.1', port: 8306, country: 'US' }
    ],
    geoHttp: [],
    plain: ''
  });
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
    PH_POOL_SUPERVISE_MS: '600',      // fast supervision for the test
    PH_POOL_SWAP_COOLDOWN_MS: '1000',
    PH_POOL_UPGRADE_MARGIN: '10',
    XDG_CONFIG_HOME: CFG, DISPLAY: process.env.DISPLAY || ':96', ELECTRON_ENABLE_LOGGING: '1'
  };
  const errLog = fs.createWriteStream('/tmp/pool2-electron.log');
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
  const wsList = async () => (await call(() => window.pigeonhole.state())).workspaces;
  const ws0Proxy = async () => (((await wsList())[0]) || {}).proxy || null;
  const loadActive = (url) => page.evaluate(u => {
    const wv = document.querySelector('.ws-view.active webview');
    if (wv) wv.loadURL(u);
  }, url);

  // ---- Q1/Q2: ghost never assigned, user location feeds scoring ----
  console.log('\n== Q1/Q2. tier-2 gate + user location ==');
  let p0 = null;
  for (let i = 0; i < 80 && !p0; i++) {
    p0 = await ws0Proxy();
    if (!p0 || !(p0.mode === 'auto' && p0.enabled)) p0 = null;
    if (!p0) await sleep(500);
  }
  check('Q1: the workspace auto-enables a pool exit at boot', !!p0, JSON.stringify(p0));
  check('Q1: the ghost (204-only, port 8307) is never the assignment', p0 && p0.port !== 8307, JSON.stringify(p0));
  check('Q1: the content-verified liar (8306) is the assignment', p0 && p0.port === 8306, JSON.stringify(p0));
  const st1 = await call(() => window.pigeonhole.pool.status());
  check('Q1: the ghost is reported weak (tier-2 gate works)', (st1.weak || 0) >= 1, JSON.stringify({ weak: st1.weak, verified: st1.verified }));
  check('Q2: user location detected from the loc= oracle (NL)', st1.userCountry === 'NL', JSON.stringify(st1.userCountry));
  check('Q2: supervision reports its cadence', st1.supervision && st1.supervision.everyMs === 600, JSON.stringify(st1.supervision));

  // ---- Q3: page failures feed the score; no churn without a better exit ----
  console.log('\n== Q3. real-page feedback, no pointless churn ==');
  for (let i = 0; i < 5; i++) { loadActive(fakes.countUrl()); await sleep(450); }
  await sleep(2600);   // let several sweeps read the failures
  const p2 = await ws0Proxy();
  const st2 = await call(() => window.pigeonhole.pool.status());
  check('Q3: no swap happens when no better exit exists (no churn)', p2 && p2.port === 8306, JSON.stringify(p2));
  check('Q3: rotations counter still zero', (st2.supervision || {}).rotations === 0, JSON.stringify(st2.supervision));

  // ---- Q4: a better exit appears -> seamless upgrade, pages recover ----
  console.log('\n== Q4. supervisor upgrade when a better exit appears ==');
  fakes.setSources({
    geoSocks: [
      { ip: '127.0.0.1', port: 8307, country: 'XX' },
      { ip: '127.0.0.1', port: 8306, country: 'US' },
      { ip: '127.0.0.1', port: 8301, country: 'NL' }
    ],
    geoHttp: [],
    plain: ''
  });
  await call(() => window.pigeonhole.pool.refresh());
  let upgraded = false;
  for (let i = 0; i < 30 && !upgraded; i++) {
    loadActive(fakes.countUrl());          // keep feeding page failures
    await sleep(500);
    const p = await ws0Proxy();
    upgraded = !!(p && p.port === 8301);
  }
  check('Q4: the supervisor upgraded the workspace to the real exit (NL)', upgraded);
  const beforeCount = fakes.getCount();
  loadActive(fakes.countUrl());
  let recovered = false;
  for (let i = 0; i < 40 && !recovered; i++) { await sleep(300); recovered = await guestText(browser, 'hits-'); }
  check('Q4: pages load through the upgraded exit', recovered && fakes.getCount() > beforeCount, `count ${beforeCount} -> ${fakes.getCount()}`);
  const st3 = await call(() => window.pigeonhole.pool.status());
  check('Q4: the rotation is counted as an upgrade', (st3.supervision || {}).rotations >= 1, JSON.stringify(st3.supervision));

  // ---- Q5: proximity scoring - same country beats far + faster ----
  console.log('\n== Q5. proximity scoring ==');
  fakes.setSources({
    geoSocks: [
      { ip: '127.0.0.1', port: 8301, country: 'NL' },   // 150ms, same country
      { ip: '127.0.0.1', port: 8302, country: 'DE' }    // 100ms, same region
    ],
    geoHttp: [{ ip: '127.0.0.1', port: 8303, country: 'US' }],  // 0ms, far away
    plain: ''
  });
  const st4 = await call(() => window.pigeonhole.pool.refresh());
  const best = st4.best || {};
  check('Q5: best exit is the nearby one (NL), not the faster far one (US)', best.port === 8301, JSON.stringify(best));
  check('Q5: the best exit carries a real score', typeof best.score === 'number' && best.score >= 110, JSON.stringify(best.score));
  check('Q5: user country still detected (NL)', st4.userCountry === 'NL', JSON.stringify(st4.userCountry));

  // ---- Q6: proactive failover on a dead exit, without reloading pages ----
  console.log('\n== Q6. proactive failover is seamless ==');
  loadActive(fakes.countUrl());
  const preCount = fakes.getCount() + 1;          // the load in flight will land on this number
  let preHit = false;
  for (let i = 0; i < 40 && !preHit; i++) { await sleep(300); preHit = await guestText(browser, `hits-${preCount}`); }
  check('Q6: setup - a page is open through the NL exit', preHit, `expected hits-${preCount}, count=${fakes.getCount()}`);
  fakes.kill('nl');                      // the assigned exit dies silently
  let swapped = false, swappedPort = 0;
  for (let i = 0; i < 40 && !swapped; i++) {
    await sleep(400);
    const p = await ws0Proxy();
    swappedPort = p ? p.port : 0;
    swapped = swappedPort !== 8301 && !!p;
  }
  check('Q6: the dead exit was replaced proactively (no page error needed)', swapped, `exit stayed 8301 (now ${swappedPort})`);
  check('Q6: the replacement is a verified live exit', [8302, 8303].includes(swappedPort), `replacement=${swappedPort}`);
  // the page that was ALREADY open must not have been reloaded: the counter
  // is frozen at preCount (a reload would bump it)
  await sleep(1200);
  check('Q6: the open page was NOT reloaded during the swap', await guestText(browser, `hits-${preCount}`) && fakes.getCount() === preCount,
    `count=${fakes.getCount()} expected ${preCount}`);
  loadActive(fakes.countUrl());
  let nextWorked = false;
  for (let i = 0; i < 40 && !nextWorked; i++) { await sleep(300); nextWorked = await guestText(browser, `hits-${preCount + 1}`); }
  check('Q6: new pages work through the replacement exit', nextWorked && fakes.getCount() === preCount + 1, `count=${fakes.getCount()} expected ${preCount + 1}`);

  // ---- Q7: supervision stats ----
  const st5 = await call(() => window.pigeonhole.pool.status());
  const sup = st5.supervision || {};
  check('Q7: supervision has swept repeatedly', sup.sweeps > 3, JSON.stringify(sup));
  check('Q7: supervision rotated at least twice (upgrade + failover)', sup.rotations >= 2, JSON.stringify(sup));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  elec.kill(); try { await browser.close(); } catch { }
  fakes.close(); staticSrv.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[pool2-test] CRASHED', e); process.exit(1); });
