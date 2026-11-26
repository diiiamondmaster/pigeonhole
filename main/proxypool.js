// Pigeonhole - the free proxy pool.
// Workspaces can exit through community proxies without the user owning one:
//   1. FETCH  open-proxy lists from several public sources (plain ip:port or
//              user:pass@ip:port lines, plus the Geonode API). All sources are
//              free, key-less and fetched directly (Node http(s), never routed
//              through a workspace proxy).
//   2. CHECK   every candidate is health-checked the only way that counts -
//              by actually routing a request through it (scratch Electron
//              sessions, generate_204 probe, 7s timeout). Source metadata is
//              routinely stale; live checks are the gate.
//   3. ASSIGN  the best verified proxy nobody else uses becomes a workspace's
//              exit, written through the normal per-workspace proxy machinery
//              (credentials included, encrypted at rest like everything else).
//   4. HEAL    when a route dies mid-session (proxy errors on a page), the
//              watchdog rotates that workspace to the next best exit and
//              reloads - reliability comes from rotation, not from any single
//              open proxy being trustworthy.
//
// The pool refreshes itself in the background while the app runs, keeps its
// cache on disk, and never blocks the UI: assignment returns immediately when
// a verified exit is available, and warms the pool first only when empty.
const { app, session, net } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHECK_PARTITIONS = 8;             // parallel scratch sessions for health checks
const CHECK_TIMEOUT_MS = 7000;
const FETCH_TIMEOUT_MS = 15000;
const TARGET_VERIFIED = 36;              // stop checking once we have this many good exits
const MAX_CANDIDATES = 260;             // ...over at most this many candidates
const CHECK_BUDGET_MS = 90000;           // ...within this wall-clock budget
const REFRESH_EVERY_MS = 12 * 60 * 1000; // background top-up while the app runs
const STALE_AFTER_MS = 10 * 60 * 1000;   // cache age that forces a refresh
const EXIT_FRESH_MS = 15 * 60 * 1000;   // an assignment this fresh is not churned
const GEO_BATCH = 100;                   // ip-api batch size (free tier friendly)

// sources: name -> {url, protocol, plain|geonode}. Overridable for tests via
// PH_POOL_SOURCES (JSON array of {url, protocol}) and PH_POOL_CHECK_URL.
const DEFAULT_SOURCES = [
  { name: 'monosans-socks5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', protocol: 'socks5' },
  { name: 'monosans-http', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', protocol: 'http' },
  { name: 'geonode-socks5', url: 'https://proxylist.geonode.com/api/proxy-list?limit=250&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5', protocol: 'socks5', geonode: true },
  { name: 'geonode-http', url: 'https://proxylist.geonode.com/api/proxy-list?limit=250&page=1&sort_by=lastChecked&sort_type=desc&protocols=http', protocol: 'http', geonode: true },
  { name: 'speedx-socks5', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', protocol: 'socks5' },
  { name: 'proxyscrape-socks5', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all', protocol: 'socks5' },
  { name: 'proxyscrape-http', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all', protocol: 'http' }
];

const st = {
  phase: 'idle',            // idle | fetching | checking
  fetchedAt: 0,
  candidates: [],           // everything parsed (pre-check)
  verified: [],              // [{ip,port,protocol,country,ms,verifiedAt,username?,password?}]
  sources: [],               // [{name, ok, count, error?}]
  inflight: null             // single-flight refresh promise
};

// ---- small utils ----
const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cacheFile = () => path.join(app.getPath('userData'), 'pool-cache.json');
const keyOf = (c) => `${c.ip}:${c.port}`;

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

// ---- health check through scratch sessions ----
// Chromium routes the probe THROUGH the candidate. Rules never carry
// credentials (Chromium refuses credentialed fixed-server proxies with
// ERR_NO_SUPPORTED_PROXIES), so a credentialed HTTP candidate answers the
// probe with 407 - which still proves the route is alive; the credentials
// then authenticate page traffic through the app 'login' handler.
function probe(partName, cand, checkUrl) {
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
      const to = setTimeout(() => { try { req.abort(); } catch { } finish(null); }, CHECK_TIMEOUT_MS);
      req.on('response', (res) => {
        const code = res.statusCode;
        res.resume();
        // 204/200 = clean answer; 407 = alive HTTP proxy demanding auth
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

async function checkAll(cands, checkUrl) {
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
        verified.push({ ...cand, ms, verifiedAt: now() });
        st.verified = verified;   // live progress for status()
      }
    }
  }));
  verified.sort((a, b) => a.ms - b.ms);
  return verified;
}

const OFF = () => !!process.env.PH_POOL_OFF;   // test isolation: no network, no writes

// ---- refresh ----
async function refresh({ force = false } = {}) {
  if (OFF()) return status();
  if (st.inflight) return st.inflight;
  if (!force && now() - st.fetchedAt < STALE_AFTER_MS && st.verified.length >= 8) {
    return status();
  }
  st.inflight = (async () => {
    st.phase = 'fetching';
    st.sources = [];
    const sources = getSources();
    const lists = await Promise.allSettled(sources.map(async (s) => {
      const text = await fetchUrl(s.url);
      const cands = s.geonode ? parseGeonode(text, s.protocol) : parsePlain(text, s.protocol);
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
    const keep = prevVerified.filter(v => now() - (v.verifiedAt || 0) < EXIT_FRESH_MS);
    const fresh = await checkAll(cands, getCheckUrl());
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
  for (const v of [...fresh, ...keep]) if (!byKey.has(keyOf(v))) byKey.set(keyOf(v), v);
  return [...byKey.values()].sort((a, b) => a.ms - b.ms).slice(0, TARGET_VERIFIED + 12);
}

// ---- persistence ----
function saveCache() {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: st.fetchedAt, candidates: st.candidates.slice(0, 300), verified: st.verified, savedAt: now()
    }));
  } catch { }
}
function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (Array.isArray(raw.verified)) st.verified = raw.verified;
    st.fetchedAt = Number(raw.fetchedAt) || 0;
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

function pick(region) {
  const used = usedExits();
  const pool = st.verified.filter(v => !region || region === 'any' || !v.country || v.country === region);
  const free = pool.filter(v => !used.has(keyOf(v)));
  return free[0] || pool[0] || null;    // prefer unused; share last-resort
}

async function applyExit(wsId, cand, region, { force = false } = {}) {
  const store = hook.store;
  const ws = store.getWorkspace(wsId);
  if (!ws) throw new Error('no such workspace');
  // race guard: background auto-assigns only ever write over an empty
  // config or another pool exit. If the user configured a custom proxy
  // meanwhile, that wins - unless the caller is an explicit user action
  // (bulk route-all, rotate, re-enable auto).
  if (!force && ws.proxy && ws.proxy.enabled && ws.proxy.mode !== 'auto') return store.sanitizeProxy(ws.proxy);
  const saved = store.setProxy(wsId, {
    enabled: true,
    scheme: cand.protocol === 'socks5' ? 'socks5' : 'http',
    host: cand.ip, port: cand.port,
    username: cand.username || '', password: cand.password || '',
    bypass: getBypass(),
    mode: 'auto', source: 'pool',
    country: cand.country || '', latencyMs: cand.ms || 0, assignedAt: now(),
    prefRegion: region || 'any'
  });
  try {
    const { applyWorkspaceProxy } = require('./proxy');
    await applyWorkspaceProxy(wsId, hook.sessionForPartition('persist:' + wsId));
  } catch { }
  hook.send('state-changed', { reason: 'ws-proxy', wsId });
  hook.send('proxy-applied', { wsId, proxy: saved });
  return saved;
}

// ensure enough verified exits exist, warming the pool only when needed
async function ensurePool() {
  if (st.verified.length < 4) {
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
    && st.verified.some(v => keyOf(v) === `${cur.host}:${cur.port}` && now() - v.verifiedAt < EXIT_FRESH_MS)) {
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
  const used = usedExits();
  const cur = ws.proxy && ws.proxy.enabled ? `${ws.proxy.host}:${ws.proxy.port}` : null;
  const region = (ws.proxy && ws.proxy.prefRegion) || 'any';
  let cands = st.verified.filter(v => (!region || region === 'any' || !v.country || v.country === region) && keyOf(v) !== cur);
  cands.sort((a, b) => used.has(keyOf(b)) - used.has(keyOf(a)) || a.ms - b.ms);   // unused + fast first
  const cand = cands[0] || st.verified.find(v => keyOf(v) !== cur) || st.verified[0];
  if (!cand) throw new Error('No alternative exit in the pool right now');
  return applyExit(wsId, cand, region, { force: true });   // rotate is an explicit user action
}

// watchdog entry: called when a page fails with proxy-flavoured errors
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
    const c = v.country || '??';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count);
}

function status() {
  return {
    phase: st.phase, fetchedAt: st.fetchedAt, ageSec: st.fetchedAt ? Math.round((now() - st.fetchedAt) / 1000) : null,
    candidates: st.candidates.length, verified: st.verified.length,
    best: st.verified[0] ? { ...st.verified[0], password: undefined } : null,
    sources: st.sources, regions: regions()
  };
}

// ---- env (tests override sources/check URL/bypass) ----
function getSources() {
  const env = process.env.PH_POOL_SOURCES;
  if (env) {
    try {
      const arr = JSON.parse(env);
      if (Array.isArray(arr) && arr.length) return arr.map((s, i) => ({ name: `src-${i}`, url: String(s.url), protocol: s.protocol === 'http' ? 'http' : 'socks5', geonode: !!s.geonode }));
    } catch { }
  }
  return DEFAULT_SOURCES;
}
function getCheckUrl() { return process.env.PH_POOL_CHECK_URL || 'https://www.gstatic.com/generate_204'; }
function getBypass() { return process.env.PH_POOL_BYPASS || '<local>'; }

let timer = null;
function init() {
  if (process.env.PH_POOL_OFF) return;      // tests that must not touch the network
  loadCache();
  const anyAuto = hook.store && hook.store.state.workspaces.some(w => w.proxy && w.proxy.mode === 'auto');
  const wantAuto = anyAuto || (hook.store && hook.store.state.settings && hook.store.state.settings.poolAutoNewWorkspaces);
  if (wantAuto && (st.verified.length < 4 || now() - st.fetchedAt > STALE_AFTER_MS)) refresh().catch(() => { });
  if (!timer) { timer = setInterval(() => { refresh().catch(() => { }); }, REFRESH_EVERY_MS); timer.unref?.(); }
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

module.exports = { init, bind, refresh, status, assign, rotate, heal, bulk, regions, migrate, _st: st };
