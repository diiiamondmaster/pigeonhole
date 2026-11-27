// Pigeonhole - the free proxy pool, v2: quality engine + seamless supervision.
// Workspaces can exit through community proxies without the user owning one.
// v1 verified a candidate once with a single 204 probe and ranked by raw
// latency - which is why far-away, "fast to answer one byte but useless for
// real pages" exits kept getting assigned and dying mid-session. v2 keeps the
// good bones (multi-source fetch, live verification, per-workspace routing)
// and adds the machinery that makes exits actually usable:
//
//   1. FETCH    open-proxy lists from several public sources (plain ip:port,
//               scheme://ip:port and Geonode JSON). All key-less, fetched
//               directly (Node http(s), never through a workspace proxy).
//   2. VERIFY   two tiers. Tier 1: the classic 204 probe - can the tunnel
//               carry a request at all? Tier 2: a REAL content fetch through
//               the candidate (Cloudflare trace by default) - status 200,
//               actual body bytes, TLS end-to-end. A proxy that only answers
//               204s is marked weak and demoted to last resort.
//   3. SCORE    every exit carries a living quality record: EWMA latency,
//               probe success history, real-page results (did-fail-load /
//               did-finish-load feed back into the exit's score), measured
//               throughput on assigned exits, and geographic proximity to
//               the user (same country / same region beat far exits).
//   4. WATCH    a supervisor sweeps every ~45s: re-probes every ASSIGNED
//               exit plus the top standbys. A dead exit is replaced
//               proactively - before your tabs break. A degraded one is
//               upgraded when a clearly better standby exists. Proactive
//               swaps never reload pages: the new route applies to new
//               requests while rendered pages keep working. That is the
//               "seamless" part.
//   5. HEAL     the renderer watchdog stays as the last line of defence: if
//               a page still hits a proxy error, it rotates and retries.
const { app, session, net } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHECK_PARTITIONS = 12;             // parallel scratch sessions for tier-1 checks
const CHECK_TIMEOUT_MS = 6500;
const TIER2_TIMEOUT_MS = 9000;
const TIER2_PARTITIONS = 4;              // parallel sessions for the tier-2 content check
const TIER2_TOP = 14;                    // content-check this many best tier-1 survivors
const FETCH_TIMEOUT_MS = 15000;
const TARGET_VERIFIED = 36;              // stop tier-1 once we have this many good exits
const MAX_CANDIDATES = 300;              // ...over at most this many candidates
const CHECK_BUDGET_MS = 90000;           // ...within this wall-clock budget
const TIER2_BUDGET_MS = 35000;           // separate budget for tier-2
const REFRESH_EVERY_MS = 12 * 60 * 1000; // background top-up while the app runs
const STALE_AFTER_MS = 10 * 60 * 1000;   // cache age that forces a refresh
const EXIT_FRESH_MS = 15 * 60 * 1000;   // an assignment this fresh is not churned
const PROXY_USABLE_MS = 8 * 60 * 1000;  // an exit is assignable only if proven alive this recently
const GEO_BATCH = 100;                   // ip-api batch size (free tier friendly)
const GEO_TTL_MS = 24 * 60 * 60 * 1000;  // user-country detection cache
const SUPERVISE_EVERY_MS = 45000;        // default supervisor sweep cadence
const STANDBY_SIZE = 6;                  // hot standbys kept fresh by the supervisor
const DEAD_AFTER_STREAK = 2;             // consecutive failed probes -> exit is dead
const DEGRADED_MS = 1600;                // EWMA latency above this = degraded exit
const UPGRADE_MARGIN = 18;               // standby must beat the exit by this score margin
const SWAP_COOLDOWN_MS = 90000;          // per-workspace anti-flap for quality swaps
const BULK_EVERY_SWEEPS = 2;             // throughput probe cadence on assigned exits
const BULK_TIMEOUT_MS = 10000;
const BULK_MIN_KBPS = 30;                // below this the exit is bandwidth-starved
const REVALIDATE_PER_SWEEP = 6;          // stale entries re-probed per sweep without a refresh

// sources: name -> {url, protocol, plain|geonode|scheme}. Overridable for
// tests via PH_POOL_SOURCES (JSON array of {url, protocol}) and PH_POOL_CHECK_URL.
const DEFAULT_SOURCES = [
  { name: 'monosans-socks5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', protocol: 'socks5' },
  { name: 'monosans-http', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', protocol: 'http' },
  { name: 'geonode-socks5', url: 'https://proxylist.geonode.com/api/proxy-list?limit=250&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5', protocol: 'socks5', geonode: true },
  { name: 'geonode-http', url: 'https://proxylist.geonode.com/api/proxy-list?limit=250&page=1&sort_by=lastChecked&sort_type=desc&protocols=http', protocol: 'http', geonode: true },
  { name: 'speedx-socks5', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', protocol: 'socks5' },
  { name: 'proxyscrape-socks5', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all', protocol: 'socks5' },
  { name: 'proxyscrape-http', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all', protocol: 'http' },
  // v2: wider candidate nets - more sources means better odds of a nearby,
  // genuinely fast exit instead of whatever a single list happens to carry.
  { name: 'proxifly-all', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt', protocol: 'auto', format: 'scheme' },
  { name: 'mmpx12-socks5', url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt', protocol: 'socks5' },
  { name: 'roosterkid-socks5', url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt', protocol: 'socks5' }
];

// Country -> region cluster. Used for proximity scoring: same country beats
// same region beats the other side of the planet. Country codes appear once.
const CLUSTER_EU = 'AL AD AT BA BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LI LT LU LV MC ME MK MT NL NO PL PT RO RS SE SI SK SM UA VA';
const CLUSTER_NA = 'US CA MX';
const CLUSTER_LA = 'AG AI AW BB BL BM BQ BS CR CU CW DM DO GD GP GT HN HT JM KN KY LC MF MQ MS NI PA PR SV SX TC TT VC VG VI AR BO BR CL CO EC GY PE PY SR UY VE';
const CLUSTER_AF = 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MG ML MR MU MW MZ NA NE NG RE RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW';
const CLUSTER_ME = 'AE BH IL IQ IR JO KW LB OM PS QA SA SY TR YE';
const CLUSTER_AS = 'AF AM AZ BD BT BN CN GE HK ID IN JP KG KH KP KR KZ LA LK MM MN MO MY NP PH PK SG TJ TH TM TW UZ VN';
const CLUSTER_OC = 'AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TO TV VU WF WS';
const CLUSTERS = new Map();
for (const [name, list] of [['EU', CLUSTER_EU], ['NA', CLUSTER_NA], ['LA', CLUSTER_LA], ['AF', CLUSTER_AF], ['ME', CLUSTER_ME], ['AS', CLUSTER_AS], ['OC', CLUSTER_OC]]) {
  for (const c of list.split(' ')) if (c) CLUSTERS.set(c, name);
}
const clusterOf = (country) => (country && CLUSTERS.get(String(country).toUpperCase())) || '';

const st = {
  phase: 'idle',            // idle | fetching | checking | supervising
  fetchedAt: 0,
  candidates: [],           // everything parsed (pre-check)
  verified: [],             // [{ip,port,protocol,country,ms,ewmaMs,okCount,failCount,tier2,tier2Ms,lastOkAt,lastFailAt,failStreak,kbps,verifiedAt,pageOks,pageFails,username?,password?}]
  sources: [],              // [{name, ok, count, error?}]
  inflight: null,           // single-flight refresh promise
  userCountry: '',          // detected once per day (direct, never proxied)
  userCluster: '',
  geoAt: 0,
  tier2Known: true,         // direct control says the tier-2 target answers?
  bulkKnown: true,          // direct control says the bulk target answers?
  supervision: { everyMs: 0, lastSweepAt: 0, sweeps: 0, rotations: 0, offlineSweeps: 0, sweeping: false },
  lastSwapAt: {},           // wsId -> t (quality-swap cooldown; dead swaps bypass)
  sweepN: 0
};

// ---- small utils ----
const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cacheFile = () => path.join(app.getPath('userData'), 'pool-cache.json');
const keyOf = (c) => `${c.ip}:${c.port}`;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const envMs = (name, dflt) => Math.max(250, num(process.env[name], dflt));
const envNum = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) ? n : dflt; };

// "does this URL answer at all, directly?" - ANY http status counts as up
// (gstatic answers 204); only timeouts / DNS / connection errors are down.
function fetchOk(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    try {
      const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pigeonhole)' } }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); resolve(false); });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

// ---- direct fetch (Node stack, never through a workspace proxy) ----
function fetchUrl(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pigeonhole)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, timeoutMs)); // 1 hop is enough
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ---- parsing ----
// plain line: "1.2.3.4:1080" or "user:pass@1.2.3.4:1080"
function parsePlain(text, protocol) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#|^=|updated at|website=/i.test(line)) continue;
    const m = /^(?:([A-Za-z0-9_.-]{2,60}):([^@\s]{2,60})@)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/.exec(line);
    if (!m) continue;
    const [, username, password, ip, port] = m;
    // Chromium's SOCKS5 client never offers the username/password auth
    // method, so credentialed SOCKS entries can never verify - skip them.
    // Credentialed HTTP proxies work: the credentials ride inline in the
    // proxy rules (Chromium answers the 407 challenge by itself).
    if (protocol === 'socks5' && username) continue;
    out.push({ ip, port: Number(port), protocol, username: username || '', password: password || '', country: '' });
    if (out.length >= 400) break;
  }
  return out;
}
// scheme line: "socks5://1.2.3.4:1080" or "http://user:pass@1.2.3.4:8080"
function parseSchemeUrl(text, dfltProtocol) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#|^=/i.test(line)) continue;
    const m = /^(https?|socks[45]):\/\/(?:([^:@\s]{2,60}):([^@\s]{2,60})@)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/.exec(line);
    if (!m) continue;
    const [, proto, username, password, ip, port] = m;
    const protocol = proto === 'socks4' ? 'socks5' : (proto === 'http' || proto === 'https' ? 'http' : 'socks5');
    if (protocol === 'socks5' && username) continue;      // same Chromium limitation
    out.push({ ip, port: Number(port), protocol, username: username || '', password: password || '', country: '' });
    if (out.length >= 500) break;
  }
  return out;
}
function parseGeonode(text, protocol) {
  try {
    const data = JSON.parse(text).data || [];
    return data.map(d => ({
      ip: String(d.ip || '').trim(), port: Number(d.port), protocol,
      username: '', password: '', country: String(d.country || '').toUpperCase().slice(0, 2)
    })).filter(c => /^\d{1,3}(\.\d{1,3}){3}$/.test(c.ip) && c.port > 0);
  } catch { return []; }
}

// ---- country enrichment (one free batch call, best effort) ----
async function enrichCountries(cands) {
  const missing = cands.filter(c => !c.country).map(c => c.ip);
  if (!missing.length) return;
  const uniq = [...new Set(missing)].slice(0, GEO_BATCH * 2);
  for (let i = 0; i < uniq.length; i += GEO_BATCH) {
    const slice = uniq.slice(i, i + GEO_BATCH);
    try {
      const body = JSON.stringify(slice);
      const res = await new Promise((resolve, reject) => {
        // fields MUST name 'query' - the response carries it only when asked
        const req = http.request('http://ip-api.com/batch?fields=status,countryCode,query', {
          method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8')))); });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
      });
      const byIp = new Map();
      (Array.isArray(res) ? res : []).forEach(r => { if (r && r.status === 'success') byIp.set(String(r.query || ''), String(r.countryCode || '').toUpperCase()); });
      cands.forEach(c => { if (!c.country && byIp.has(c.ip)) c.country = byIp.get(c.ip); });
    } catch { /* geo is a nice-to-have */ }
  }
}

// ---- user location (direct, cached 24h; feeds proximity scoring) ----
async function detectUserCountry() {
  if (st.userCountry && now() - st.geoAt < GEO_TTL_MS) return st.userCountry;
  if (process.env.PH_POOL_LOC) { setUserCountry(process.env.PH_POOL_LOC); return st.userCountry; }
  const candidates = [getGeoUrl(), 'http://ip-api.com/json?fields=countryCode'];
  for (const url of candidates) {
    try {
      const text = await fetchUrl(url, 6000);
      let cc = '';
      const mLoc = /(?:^|\n)loc=([A-Za-z]{2})(?:\n|$)/.exec(text || '');
      const mJson = /"countryCode"\s*:\s*"([A-Za-z]{2})"/.exec(text || '');
      if (mLoc) cc = mLoc[1];
      else if (mJson) cc = mJson[1];
      if (cc) { setUserCountry(cc); return st.userCountry; }
    } catch { /* try the next oracle */ }
  }
  return '';
}
function setUserCountry(cc) {
  st.userCountry = String(cc || '').toUpperCase().slice(0, 2);
  st.userCluster = clusterOf(st.userCountry);
  st.geoAt = now();
}

// ---- scoring ----
// 0..100+ composite; only fresh entries are assignable, score decides order.
//   latency   EWMA probe RTT (100ms -> 100pts, ~1200ms -> 0pts)
//   reliability  probe + real-page success history (failures weigh double)
//   stability survived checks without failing (anti one-hit-wonder)
//   tier-2    real-content verified exits get +12; 204-only exits cap at 35
//   proximity same country +18, same region +8
//   bandwidth measured kbps below the floor costs 10
function scoreOf(v) {
  const lat = 100 - Math.max(0, (num(v.ewmaMs, num(v.ms, 2000)) - 100) / 11);
  const ok = (v.okCount || 0) + (v.pageOks || 0);
  const bad = (v.failCount || 0) * 2 + (v.pageFails || 0) * 2;
  const rel = (ok + bad) > 0 ? (100 * ok) / (ok + bad) : 60;   // no history yet -> neutral
  let s = lat * 0.55 + rel * 0.45 + Math.min(10, ok);
  if (v.tier2) s += 12;
  else s = Math.min(s, 35);                                     // 204-only exit = last resort
  if (st.userCountry && v.country) {
    if (v.country === st.userCountry) s += 18;
    else if (clusterOf(v.country) && clusterOf(v.country) === st.userCluster) s += 8;
  }
  if (v.kbps && v.kbps < BULK_MIN_KBPS) s -= 10;
  return Math.round(s * 10) / 10;
}
const freshOk = (v) => v && (now() - num(v.lastOkAt, 0) < PROXY_USABLE_MS);
const byScore = (a, b) => scoreOf(b) - scoreOf(a) || num(a.ewmaMs, 9999) - num(b.ewmaMs, 9999);

// ---- probes through scratch sessions ----
// Chromium routes the probe THROUGH the candidate. Rules never carry
// credentials (Chromium refuses credentialed fixed-server proxies with
// ERR_NO_SUPPORTED_PROXIES), so a credentialed HTTP candidate answers the
// probe with 407 - which still proves the route is alive; the credentials
// then authenticate page traffic through the app 'login' handler.

// tier-1: does the tunnel answer at all? (204/200 = clean, 407 = alive HTTP
// proxy demanding auth). Returns latency ms or null.
function probe(partName, cand, checkUrl, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise(async (resolve) => {
    let ses;
    try {
      ses = session.fromPartition(partName);           // non-persist: in-memory only
      const hostPort = `${cand.ip}:${cand.port}`;
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: cand.protocol === 'socks5'
          ? `socks5://${hostPort}`
          : `http=${hostPort};https=${hostPort}`,
        proxyBypassRules: '<-loopback>'
      });
    } catch { return resolve(null); }
    const t0 = now();
    let done = false;
    const finish = (ms) => { if (!done) { done = true; resolve(ms); } };
    try {
      const req = net.request({ url: checkUrl, session: ses });
      req.setHeader('User-Agent', 'Mozilla/5.0 (compatible; Pigeonhole)');
      const to = setTimeout(() => { try { req.abort(); } catch { } finish(null); }, timeoutMs);
      req.on('response', (res) => {
        const code = res.statusCode;
        res.resume();
        res.on('end', () => {
          clearTimeout(to);
          finish(code === 204 || code === 200 || code === 407 ? now() - t0 : null);
        });
      });
      req.on('error', () => { clearTimeout(to); finish(null); });
      req.on('abort', () => { clearTimeout(to); finish(null); });
      req.end();
    } catch { finish(null); }
  });
}

// tier-2 / bulk: fetch REAL content through the candidate. Returns
// { ms, code, bytes, text } or null (transport-level failure). An early
// abort after wantBytes counts as 200 (that IS the success case for the
// throughput probe). 407 answers "alive but wants auth" - callers treat
// that as alive-weak.
function probeContent(partName, cand, url, { timeoutMs = TIER2_TIMEOUT_MS, wantBytes = 0 } = {}) {
  return new Promise(async (resolve) => {
    let ses;
    try {
      ses = session.fromPartition(partName);
      const hostPort = `${cand.ip}:${cand.port}`;
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: cand.protocol === 'socks5'
          ? `socks5://${hostPort}`
          : `http=${hostPort};https=${hostPort}`,
        proxyBypassRules: '<-loopback>'
      });
    } catch { return resolve(null); }
    const t0 = now();
    let done = false;
    let gotBytes = 0;
    let gotEnough = false;                 // early abort after wantBytes = success
    const chunks = [];
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    const to = setTimeout(() => { try { req && req.abort(); } catch { } finish(null); }, timeoutMs);
    try {
      req = net.request({ url, session: ses });
      req.setHeader('User-Agent', 'Mozilla/5.0 (compatible; Pigeonhole)');
      req.on('response', (res) => {
        const code = res.statusCode;
        res.on('data', d => {
          chunks.push(d);
          gotBytes += d.length;
          if (wantBytes && gotBytes >= wantBytes) { gotEnough = true; try { req.abort(); } catch { } }
        });
        res.on('end', () => {
          clearTimeout(to);
          finish({ ms: now() - t0, code, bytes: gotBytes, text: Buffer.concat(chunks).slice(0, 512).toString('utf8') });
        });
        res.on('aborted', () => {
          clearTimeout(to);
          finish({ ms: now() - t0, code: gotEnough ? 200 : code, bytes: gotBytes, text: '' });
        });
      });
      req.on('error', () => { clearTimeout(to); finish(null); });
      req.on('abort', () => { clearTimeout(to); finish({ ms: now() - t0, code: gotEnough ? 200 : 0, bytes: gotBytes, text: '' }); });
      req.end();
    } catch { clearTimeout(to); finish(null); }
  });
}

// update a verified entry after a probe result (EWMA + history)
function noteProbe(v, ms) {
  if (ms == null) {
    v.failCount = (v.failCount || 0) + 1;
    v.failStreak = (v.failStreak || 0) + 1;
    v.lastFailAt = now();
  } else {
    v.ms = ms;
    v.ewmaMs = v.ewmaMs ? Math.round(v.ewmaMs * 0.6 + ms * 0.4) : ms;
    v.okCount = (v.okCount || 0) + 1;
    v.failStreak = 0;
    v.lastOkAt = now();
  }
  return v;
}

async function checkAll(cands, checkUrl, prevByKey, tier2Enabled = true) {
  const parts = [];
  for (let i = 0; i < CHECK_PARTITIONS; i++) parts.push(`pool-check-${i}`);
  const verified = [];
  const queue = [...cands];
  const t0 = now();
  let idx = 0;
  const stop = () => verified.length >= TARGET_VERIFIED || !queue.length || (now() - t0) > CHECK_BUDGET_MS;
  await Promise.all(parts.map(async (part) => {
    while (true) {
      if (stop()) return;
      const my = idx++;
      if (my >= queue.length) return;
      const cand = queue[my];
      const ms = await probe(part, cand, checkUrl);
      if (ms != null) {
        const prev = prevByKey.get(keyOf(cand));
        const v = { ...cand, ms, verifiedAt: now() };
        if (prev) {
          v.ewmaMs = prev.ewmaMs ? Math.round(prev.ewmaMs * 0.6 + ms * 0.4) : ms;
          v.okCount = (prev.okCount || 0) + 1; v.failCount = prev.failCount || 0;
          v.tier2 = prev.tier2; v.tier2Ms = prev.tier2Ms; v.kbps = prev.kbps;
          v.pageFails = prev.pageFails || 0; v.pageOks = prev.pageOks || 0;
          v.lastPageFailAt = prev.lastPageFailAt; v.lastPageOkAt = prev.lastPageOkAt;
        } else { v.ewmaMs = ms; v.okCount = 1; v.failCount = 0; }
        v.failStreak = 0; v.lastOkAt = now();
        verified.push(v);
        st.verified = verified;   // live progress for status()
      } else {
        const prev = prevByKey.get(keyOf(cand));
        if (prev) { prev.failCount = (prev.failCount || 0) + 1; prev.failStreak = (prev.failStreak || 0) + 1; prev.lastFailAt = now(); }
      }
    }
  }));

  // tier-2: real-content gate on the most promising survivors. A 407 counts
  // as pass for credentialed candidates (alive + auth machinery reachable);
  // a genuine content answer upgrades country data from the trace's loc=.
  // Skipped when the direct control says the target itself is down (then we
  // fail open: no exit is punished for a target it cannot reach either way).
  const tier2Url = getTier2Url();
  if (tier2Enabled && tier2Url && verified.length) {
    const ranked = [...verified].sort(byScore).slice(0, TIER2_TOP);
    const parts2 = [];
    for (let i = 0; i < TIER2_PARTITIONS; i++) parts2.push(`pool-t2-${i}`);
    let i2 = 0;
    const t20 = now();
    await Promise.all(parts2.map(async (part) => {
      while (i2 < ranked.length && (now() - t20) < TIER2_BUDGET_MS) {
        const my = i2++;
        const v = ranked[my];
        if (v.username) { v.tier2 = true; v.tier2Ms = v.ms; continue; }   // 407-capable: alive-verified by tier-1
        const r = await probeContent(part, v, tier2Url, { timeoutMs: TIER2_TIMEOUT_MS });
        if (r && (r.code === 200 && r.bytes >= 20)) {
          v.tier2 = true; v.tier2Ms = r.ms;
          const mLoc = /(?:^|\n)loc=([A-Za-z]{2})(?:\n|$)/.exec(r.text || '');
          if (mLoc) v.country = mLoc[1].toUpperCase();
        } else if (r && r.code === 407) {
          v.tier2 = true; v.tier2Ms = r.ms;                              // auth-capable exit
        } else {
          v.tier2 = false;                                               // 204-only liar
        }
        st.verified = verified;   // live progress
      }
    }));
  } else {
    // tier-2 target unreachable directly: fail open, keep prior knowledge
    verified.forEach(v => { v.tier2 = v.tier2 !== false; });
  }
  verified.sort(byScore);
  return verified;
}

const OFF = () => !!process.env.PH_POOL_OFF;   // test isolation: no network, no writes

// direct controls: is the tier-2/bulk target reachable WITHOUT a proxy?
// If the target itself is down we never blame the exits for it.
async function controlTarget(url, { wantBytes = 0 } = {}) {
  try {
    const text = await fetchUrl(url, 8000);
    return text.length >= (wantBytes ? Math.min(wantBytes, 1024) : 20);
  } catch { return false; }
}

// ---- refresh ----
async function refresh({ force = false } = {}) {
  if (OFF()) return status();
  if (st.inflight) return st.inflight;
  const freshCount = st.verified.filter(freshOk).length;
  if (!force && now() - st.fetchedAt < STALE_AFTER_MS && freshCount >= 8) {
    return status();
  }
  st.inflight = (async () => {
    st.phase = 'fetching';
    st.sources = [];
    try { await detectUserCountry(); } catch { }
    const sources = getSources();
    const lists = await Promise.allSettled(sources.map(async (s) => {
      const text = await fetchUrl(s.url);
      const cands = s.geonode ? parseGeonode(text, s.protocol) : (s.format === 'scheme' ? parseSchemeUrl(text, s.protocol) : parsePlain(text, s.protocol));
      return { ...s, cands };
    }));
    // dedupe by ip:port (credential-carrying entry wins), keep source order
    const byKey = new Map();
    for (const r of lists) {
      if (r.status !== 'fulfilled') { st.sources.push({ name: r.reason ? String(r.reason.message || r.reason).slice(0, 120) : 'failed', ok: false, count: 0 }); continue; }
      const s = r.value;
      st.sources.push({ name: s.name, ok: true, count: s.cands.length });
      for (const c of s.cands) {
        const prev = byKey.get(keyOf(c));
        if (!prev || (!prev.username && c.username)) {
          if (prev && !c.country) c.country = prev.country;   // carry geo over
          byKey.set(keyOf(c), c);
        }
      }
    }
    let cands = [...byKey.values()];
    // warm start: previously verified first, then the rest in fetch order
    const prevVerified = (st.verified || []).slice();
    const prevKeys = new Set(prevVerified.map(keyOf));
    cands.sort((a, b) => (prevKeys.has(keyOf(b)) ? 1 : 0) - (prevKeys.has(keyOf(a)) ? 1 : 0));
    cands = cands.slice(0, MAX_CANDIDATES);
    st.candidates = cands;
    st.fetchedAt = now();
    await enrichCountries(cands).catch(() => { });
    if (!cands.length) {
      // all sources failed and nothing new: keep the old verified set if any
      st.phase = 'idle'; st.inflight = null;
      saveCache();
      return status();
    }
    st.phase = 'checking';
    // tier-2 direct control (fail-open: no gate when the target is down)
    st.tier2Known = await controlTarget(getTier2Url()).catch(() => false);
    const prevByKey = new Map(prevVerified.map(v => [keyOf(v), v]));
    const fresh = await checkAll(cands, getCheckUrl(), prevByKey, st.tier2Known);
    const keep = prevVerified.filter(v => freshOk(v) && now() - (v.verifiedAt || 0) < EXIT_FRESH_MS);
    st.verified = mergeVerified(keep, fresh);
    st.phase = 'idle';
    st.inflight = null;
    saveCache();
    return status();
  })();
  return st.inflight;
}

function mergeVerified(keep, fresh) {
  const byKey = new Map();
  for (const v of [...fresh, ...keep]) {
    if (byKey.has(keyOf(v))) continue;
    byKey.set(keyOf(v), v);
  }
  return [...byKey.values()].sort(byScore).slice(0, TARGET_VERIFIED + 12);
}

// ---- persistence ----
function saveCache() {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: st.fetchedAt, candidates: st.candidates.slice(0, 300), verified: st.verified, savedAt: now(),
      userCountry: st.userCountry, geoAt: st.geoAt
    }));
  } catch { }
}
function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (Array.isArray(raw.verified)) st.verified = raw.verified;
    st.fetchedAt = Number(raw.fetchedAt) || 0;
    if (raw.userCountry && now() - (num(raw.geoAt, 0)) < GEO_TTL_MS) setUserCountry(raw.userCountry);
  } catch { }
}

// ---- assignment ----
let hook = { send: () => { }, store: null, sessionForPartition: () => null };
function bind(send, store, sessionForPartition) { hook = { send, store, sessionForPartition }; }

function usedExits() {
  const out = new Set();
  for (const w of hook.store.state.workspaces) {
    if (w.proxy && w.proxy.enabled) out.add(`${w.proxy.host}:${w.proxy.port}`);
  }
  return out;
}

// the assignable pool for a region preference:
//   'any'  -> everything, score-ranked (proximity is already in the score)
//   'near' -> same-region exits when at least 2 exist, else everything
//   'XX'   -> exact country when any exist, else everything
// Only exits proven alive recently (fresh) are assignable; stale ones are
// last-resort so a dead pool-cache from yesterday never silently wins.
function regionPool(region) {
  const fresh = st.verified.filter(freshOk);
  const all = fresh.length ? fresh : st.verified;
  if (!region || region === 'any') return all;
  if (region === 'near') {
    const near = all.filter(v => clusterOf(v.country) && clusterOf(v.country) === st.userCluster);
    return near.length >= 2 ? near : all;
  }
  const exact = all.filter(v => v.country === region);
  return exact.length ? exact : all;
}

function pick(region, { exclude } = {}) {
  const used = usedExits();
  const pool = regionPool(region)
    .filter(v => !exclude || keyOf(v) !== exclude)
    .sort(byScore);
  // free AND real-content-verified: a 204-only exit is a last resort, never
  // a preferred assignment even when it is the only unused one
  const free = pool.filter(v => !used.has(keyOf(v)) && v.tier2 !== false);
  return free[0] || pool[0] || null;    // prefer unused; share last-resort
}

async function applyExit(wsId, cand, region, { force = false, reload = true, why = 'manual' } = {}) {
  const store = hook.store;
  const ws = store.getWorkspace(wsId);
  if (!ws) throw new Error('no such workspace');
  // race guard: background auto-assigns only ever write over an empty
  // config or another pool exit. If the user configured a custom proxy
  // meanwhile, that wins - unless the caller is an explicit user action
  // (bulk route-all, rotate, re-enable auto, supervisor failover).
  if (!force && ws.proxy && ws.proxy.enabled && ws.proxy.mode !== 'auto') return store.sanitizeProxy(ws.proxy);
  const saved = store.setProxy(wsId, {
    enabled: true,
    scheme: cand.protocol === 'socks5' ? 'socks5' : 'http',
    host: cand.ip, port: cand.port,
    username: cand.username || '', password: cand.password || '',
    bypass: getBypass(),
    mode: 'auto', source: 'pool',
    country: cand.country || '', latencyMs: Math.round(num(cand.ewmaMs, cand.ms || 0)), assignedAt: now(),
    prefRegion: region || 'any'
  });
  try {
    const { applyWorkspaceProxy } = require('./proxy');
    await applyWorkspaceProxy(wsId, hook.sessionForPartition('persist:' + wsId));
  } catch { }
  // reload:false = seamless swap: the new route covers new requests while
  // already-rendered pages keep working; nothing reloads under the user.
  hook.send('state-changed', { reason: 'ws-proxy', wsId });
  hook.send('proxy-applied', { wsId, proxy: saved, reload, why });
  return saved;
}

// ensure enough verified exits exist, warming the pool only when needed
async function ensurePool() {
  const freshCount = st.verified.filter(freshOk).length;
  if (freshCount < 4) {
    await refresh().catch(() => { });          // bounded by the check budget
  } else if (now() - st.fetchedAt > STALE_AFTER_MS) {
    refresh().catch(() => { });                // background top-up, no await
  }
}

async function assign(wsId, { region = 'any', force = false } = {}) {
  if (OFF()) throw new Error('pool disabled');
  const ws = hook.store.getWorkspace(wsId);
  if (!ws) throw new Error('no such workspace');
  await ensurePool();
  // idempotent: keep a still-fresh exit unless forced or the region changed
  const cur = ws.proxy;
  if (!force && cur && cur.mode === 'auto' && cur.enabled
    && now() - (cur.assignedAt || 0) < EXIT_FRESH_MS
    && (cur.prefRegion || 'any') === (region || 'any')
    && st.verified.some(v => keyOf(v) === `${cur.host}:${cur.port}` && freshOk(v))) {
    return cur;
  }
  const cand = pick(region);
  if (!cand) throw new Error('No verified proxy in the pool right now - try Refresh');
  return applyExit(wsId, cand, region, { force: !!force });
}

async function rotate(wsId) {
  if (OFF()) throw new Error('pool disabled');
  const ws = hook.store.getWorkspace(wsId);
  if (!ws) throw new Error('no such workspace');
  await ensurePool();
  const cur = ws.proxy && ws.proxy.enabled ? `${ws.proxy.host}:${ws.proxy.port}` : null;
  const region = (ws.proxy && ws.proxy.prefRegion) || 'any';
  const cand = pick(region, { exclude: cur });
  if (!cand) throw new Error('No alternative exit in the pool right now');
  return applyExit(wsId, cand, region, { force: true });   // rotate is an explicit user action
}

// ---- real-page feedback (renderer reports load outcomes) ----
// Failures accumulate with timestamps (a failure every second counts just as
// much as three in one instant) and decay once the traffic stops failing.
function notePage(wsId, ok) {
  if (OFF() || !hook.store) return false;
  const ws = hook.store.getWorkspace(wsId);
  if (!ws || !ws.proxy || !ws.proxy.enabled) return false;
  const key = `${ws.proxy.host}:${ws.proxy.port}`;
  const v = st.verified.find(x => keyOf(x) === key);
  if (!v) return false;
  if (ok) { v.pageOks = (v.pageOks || 0) + 1; v.lastPageOkAt = now(); }
  else { v.pageFails = (v.pageFails || 0) + 1; v.lastPageFailAt = now(); v.lastFailAt = now(); }
  return true;
}

// ---- supervisor: continuous monitoring + seamless transitions ----
// Every sweep:
//   0. direct control (is the network up at all? skip silently if not)
//   1. re-probe every ASSIGNED exit (tier-1 always, real-content + throughput
//      periodically) - the exit's score and streak update live
//   2. re-probe the top standbys so a failover target is always pre-warmed
//   3. re-validate a few stale pool entries without a full refresh
//   4. swap exits that are dead (2 failed sweeps) or clearly degraded, with
//      reload:false - pages never notice
async function sweep() {
  if (OFF() || !hook.store) return;
  if (st.supervision.sweeping) return;
  st.supervision.sweeping = true;
  st.phase = 'supervising';
  try {
    st.sweepN++;
    const sup = st.supervision;
    sup.lastSweepAt = now();

    // 0. network control: probe our own check targets directly
    let netUp = await controlOk();
    if (!netUp) { sup.offlineSweeps++; return; }

    const work = hook.store.state.workspaces.filter(w => w.proxy && w.proxy.enabled && w.proxy.mode === 'auto');
    const assigned = [];
    for (const w of work) {
      const key = `${w.proxy.host}:${w.proxy.port}`;
      let v = st.verified.find(x => keyOf(x) === key);
      if (!v) {
        // exit not in the pool (restored cache, manual edit): track it live
        v = {
          ip: w.proxy.host, port: w.proxy.port, protocol: w.proxy.scheme === 'socks5' ? 'socks5' : 'http',
          username: w.proxy.username || '', password: '', country: w.proxy.country || '',
          ms: 0, ewmaMs: 0, okCount: 0, failCount: 0, failStreak: 0, tier2: !!w.proxy.username,
          lastOkAt: num(w.proxy.assignedAt, 0), verifiedAt: num(w.proxy.assignedAt, 0), pageOks: 0, pageFails: 0
        };
        st.verified.push(v);
      }
      assigned.push({ wsId: w.id, ws: w, v });
    }

    // 2. hot standbys: best fresh, unused, real-content-verified exits
    const used = usedExits();
    const standbys = st.verified
      .filter(v => freshOk(v) && v.tier2 !== false && !used.has(keyOf(v)) && !assigned.some(a => a.v === v))
      .sort(byScore).slice(0, STANDBY_SIZE);

    // 1. probe assigned exits + standbys (and read real-page feedback)
    const probeList = [
      ...assigned.map(a => ({ v: a.v, tier2: true })),
      ...standbys.map(v => ({ v, tier2: false }))
    ];
    let pi = 0;
    const parts = [];
    for (let i = 0; i < TIER2_PARTITIONS; i++) parts.push(`pool-sup-${i}`);
    await Promise.all(parts.map(async (part) => {
      while (pi < probeList.length) {
        const my = pi++;
        const { v, tier2 } = probeList[my];
        const ms = await probe(part, v, getCheckUrl());
        noteProbe(v, ms);
        if (ms == null) continue;
        // standbys get their one-time content check the first time we warm
        // them, so a failover target is always real-world-verified
        if (!tier2 && v.tier2 == null && st.tier2Known && !v.username) {
          const r = await probeContent(part, v, getTier2Url(), { timeoutMs: TIER2_TIMEOUT_MS });
          if (r && (r.code === 200 && r.bytes >= 20)) { v.tier2 = true; v.tier2Ms = r.ms; }
          else if (r && r.code === 407) { v.tier2 = true; v.tier2Ms = r.ms; }
          else if (r) v.tier2 = false;
        }
        // deeper checks on ASSIGNED exits only, not every sweep
        if (tier2 && !v.username) {
          if (st.sweepN % BULK_EVERY_SWEEPS === 0 && st.bulkKnown) {
            const r = await probeContent(part, v, getBulkUrl(), { timeoutMs: BULK_TIMEOUT_MS, wantBytes: 12 * 1024 });
            if (r && r.code === 200 && r.bytes >= 2048) { v.kbps = Math.round((r.bytes / 1024) / Math.max(0.25, r.ms / 1000)); v.kbpsBad = 0; }
            else if (r && r.code !== 407) { v.kbpsBad = (v.kbpsBad || 0) + 1; if (v.kbpsBad >= 2) v.kbps = 0; }   // two strikes
          } else if (st.tier2Known) {
            const r = await probeContent(part, v, getTier2Url(), { timeoutMs: TIER2_TIMEOUT_MS });
            if (r && r.code === 200 && r.bytes >= 20) { v.tier2 = true; v.tier2Ms = r.ms; }
            else if (r && r.code === 407) { v.tier2 = true; v.tier2Ms = r.ms; }
            else if (r) v.tier2 = false;
          }
        }
      }
    }));

    // 3. re-validate a few stale entries (keeps the pool warm between refreshes)
    const stale = st.verified.filter(v => !freshOk(v) && now() - num(v.lastFailAt, 0) > 60000).slice(0, REVALIDATE_PER_SWEEP);
    for (const v of stale) {
      const ms = await probe('pool-sup-0', v, getCheckUrl());
      noteProbe(v, ms);
    }
    // drop long-dead weight
    st.verified = st.verified.filter(v => freshOk(v) || now() - num(v.lastFailAt, 0) < 30 * 60 * 1000);

    // 4. decisions
    for (const { wsId, ws, v } of assigned) {
      // page feedback decays one tick per sweep once it stops arriving
      if (now() - num(v.lastPageFailAt, 0) > 45000) v.pageFails = Math.max(0, (v.pageFails || 0) - 1);
      if (now() - num(v.lastPageOkAt, 0) > 45000) v.pageOks = Math.max(0, (v.pageOks || 0) - 1);
      const recentFails = (v.pageFails || 0) >= 3 && (now() - num(v.lastPageFailAt, 0) < 45000);
      const dead = (v.failStreak || 0) >= DEAD_AFTER_STREAK;
      const degraded = !!((num(v.ewmaMs, 9999) > DEGRADED_MS) || v.tier2 === false || (v.kbps != null && v.kbps < BULK_MIN_KBPS) || recentFails);
      if (!dead && !degraded) continue;

      const region = (ws.proxy && ws.proxy.prefRegion) || 'any';
      const curScore = scoreOf(v);
      const best = pick(region, { exclude: keyOf(v) });
      if (!best) continue;
      const bestScore = scoreOf(best);
      const shared = usedExits().has(keyOf(best));
      const t = now();
      const cooled = !st.lastSwapAt[wsId] || (t - st.lastSwapAt[wsId]) > envMs('PH_POOL_SWAP_COOLDOWN_MS', SWAP_COOLDOWN_MS);
      // dead exits swap immediately (sharing an exit beats no exit at all);
      // degraded exits need a free standby, a clear margin and the cooldown
      if (dead) {
        await swapExit(wsId, ws, v, best, 'dead');
      } else if (degraded && cooled && !shared && bestScore >= curScore + envNum('PH_POOL_UPGRADE_MARGIN', UPGRADE_MARGIN)) {
        await swapExit(wsId, ws, v, best, 'upgrade');
      }
    }
    sup.sweeps++;
    saveCache();
  } catch { /* a sweep never breaks the app */ }
  finally {
    st.supervision.sweeping = false;
    st.phase = 'idle';
  }
}

async function controlOk() {
  // direct (unproxied) reachability: check target, then tier-2, then geo.
  // Only when every oracle is down do we call the machine offline and skip.
  for (const url of [getCheckUrl(), getTier2Url(), getGeoUrl()]) {
    if (await fetchOk(url, 5000)) return true;
  }
  return false;
}

async function swapExit(wsId, ws, oldEntry, cand, reason) {
  try {
    const region = (ws.proxy && ws.proxy.prefRegion) || 'any';
    const saved = await applyExit(wsId, cand, region, { force: true, reload: false, why: reason });
    st.lastSwapAt[wsId] = now();
    st.supervision.rotations++;
    // the old exit is retired from the assignable pool until it proves itself
    oldEntry.failStreak = Math.max(oldEntry.failStreak || 0, DEAD_AFTER_STREAK);
    hook.send('pool-rotation', {
      wsId, reason,
      old: { host: oldEntry.ip, port: oldEntry.port, country: oldEntry.country || '', latencyMs: Math.round(num(oldEntry.ewmaMs, oldEntry.ms || 0)) },
      proxy: saved
    });
    return true;
  } catch { return false; }
}

// watchdog entry: called when a page fails with proxy-flavoured errors.
// The supervisor usually catches dead exits first; this is the visible-error
// backstop and rotates with a page retry.
const healLog = new Map();   // wsId -> {t, n}
async function heal(wsId) {
  if (OFF()) return { rotated: false };
  const ws = hook.store.getWorkspace(wsId);
  if (!ws || !ws.proxy || !ws.proxy.enabled || ws.proxy.mode !== 'auto') return { rotated: false };
  const l = healLog.get(wsId) || { t: 0, n: 0 };
  const t = now();
  if (t - l.t > 10 * 60 * 1000) l.n = 0;         // window reset
  if (t - l.t < 12000 || l.n >= 8) return { rotated: false, limited: true };
  l.t = t; l.n += 1; healLog.set(wsId, l);
  // blame the exit right away: the supervisor will retire it from standbys
  try {
    const key = `${ws.proxy.host}:${ws.proxy.port}`;
    const v = st.verified.find(x => keyOf(x) === key);
    if (v) noteProbe(v, null);
  } catch { }
  try {
    const proxy = await rotate(wsId);
    return { rotated: true, proxy };
  } catch { return { rotated: false, reason: 'no exit available' }; }
}

async function bulk() {
  if (OFF()) return [];
  const ids = hook.store.state.workspaces.map(w => w.id);
  const out = [];
  for (const id of ids) { try { out.push(await assign(id, { force: true })); } catch { } }
  return out;
}

function regions() {
  const counts = new Map();
  for (const v of st.verified) {
    if (!freshOk(v)) continue;
    const c = v.country || '??';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count);
}

function status() {
  const fresh = st.verified.filter(freshOk);
  const best = [...fresh].sort(byScore)[0] || st.verified[0];
  return {
    phase: st.phase, fetchedAt: st.fetchedAt, ageSec: st.fetchedAt ? Math.round((now() - st.fetchedAt) / 1000) : null,
    candidates: st.candidates.length, verified: st.verified.length, usable: fresh.length,
    weak: fresh.filter(v => v.tier2 === false).length,
    best: best ? { ...best, password: undefined, score: scoreOf(best) } : null,
    sources: st.sources, regions: regions(),
    userCountry: st.userCountry || null,
    supervision: {
      everyMs: envMs('PH_POOL_SUPERVISE_MS', SUPERVISE_EVERY_MS),
      lastSweepAt: st.supervision.lastSweepAt || null,
      sweeps: st.supervision.sweeps, rotations: st.supervision.rotations,
      offlineSweeps: st.supervision.offlineSweeps, sweeping: st.supervision.sweeping
    }
  };
}

// ---- env (tests override sources/check URLs/timings) ----
function getSources() {
  const env = process.env.PH_POOL_SOURCES;
  if (env) {
    try {
      const arr = JSON.parse(env);
      if (Array.isArray(arr) && arr.length) return arr.map((s, i) => ({
        name: `src-${i}`, url: String(s.url), protocol: s.protocol === 'http' ? 'http' : 'socks5',
        geonode: !!s.geonode, format: s.format === 'scheme' ? 'scheme' : 'plain'
      }));
    } catch { }
  }
  return DEFAULT_SOURCES;
}
function getCheckUrl() { return process.env.PH_POOL_CHECK_URL || 'https://www.gstatic.com/generate_204'; }
function getTier2Url() { return process.env.PH_POOL_TIER2_URL || 'https://www.cloudflare.com/cdn-cgi/trace'; }
function getBulkUrl() { return process.env.PH_POOL_BULK_URL || 'https://speed.cloudflare.com/__down?bytes=25000'; }
function getGeoUrl() { return process.env.PH_POOL_GEO_URL || 'https://www.cloudflare.com/cdn-cgi/trace'; }
function getBypass() { return process.env.PH_POOL_BYPASS || '<local>'; }

let timer = null;
let superviseTimer = null;
function init() {
  if (process.env.PH_POOL_OFF) return;      // tests that must not touch the network
  loadCache();
  detectUserCountry().catch(() => { });     // refresh if stale, best effort
  const anyAuto = hook.store && hook.store.state.workspaces.some(w => w.proxy && w.proxy.mode === 'auto');
  const wantAuto = anyAuto || (hook.store && hook.store.state.settings && hook.store.state.settings.poolAutoNewWorkspaces);
  if (wantAuto && (st.verified.filter(freshOk).length < 4 || now() - st.fetchedAt > STALE_AFTER_MS)) refresh().catch(() => { });
  if (!timer) { timer = setInterval(() => { refresh().catch(() => { }); }, REFRESH_EVERY_MS); timer.unref?.(); }
  // the supervisor: continuous exit monitoring + seamless failover
  if (!superviseTimer) {
    const every = envMs('PH_POOL_SUPERVISE_MS', SUPERVISE_EVERY_MS);
    setTimeout(() => sweep().catch(() => { }), Math.min(3000, every)).unref?.();
    superviseTimer = setInterval(() => { sweep().catch(() => { }); }, every);
    superviseTimer.unref?.();
    st.supervision.everyMs = every;
  }
  // bulk-target control, refreshed lazily (fail-open: unknown = try it)
  if (!st.bulkKnownAt || now() - st.bulkKnownAt > 10 * 60 * 1000) {
    st.bulkKnownAt = now();
    controlTarget(getBulkUrl(), { wantBytes: 4096 }).then(ok => { st.bulkKnown = ok; }).catch(() => { });
  }
}

// one-time upgrade: workspaces that never had a proxy at all get a pool exit
// automatically - the "I expected them to auto enable" behaviour.
async function migrate() {
  if (process.env.PH_POOL_OFF) return 0;
  const store = hook.store;
  if (!store) return 0;
  const settings = store.state.settings || {};
  if (settings.poolMigrated) return 0;
  if (settings.poolAutoNewWorkspaces === false) { store.state.settings.poolMigrated = true; store.save(); return 0; }
  const plain = store.state.workspaces.filter(w => !w.proxy);
  if (!plain.length) { store.state.settings.poolMigrated = true; store.save(); return 0; }
  let n = 0;
  for (const w of plain) {
    try { await assign(w.id); n++; } catch { }
  }
  store.state.settings.poolMigrated = true;
  store.save();
  if (n && hook.send) {
    hook.send('pool-migrated', { count: n });
    for (const w of plain) hook.send('state-changed', { reason: 'ws-proxy', wsId: w.id });
  }
  return n;
}

module.exports = { init, bind, refresh, status, assign, rotate, heal, bulk, regions, migrate, notePage, sweep, _st: st };
