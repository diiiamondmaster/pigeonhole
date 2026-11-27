// Pigeonhole - disposable instant mailboxes (mail.tm / mail.gw).
//
// One request to /domains, one to /accounts and the workspace owns a live
// email address - no CAPTCHA, no phone, no blocked signup. Verification
// mails are polled through the same API.
//
// Design notes:
// - API traffic goes out on the DEFAULT Node stack (no session), i.e. it is
//   NEVER routed through the workspace's (possibly flaky) proxy. The mailbox
//   keeps working exactly when browsing does not.
// - mail.tm and mail.gw expose the same REST API on different hosts, so the
//   client tries them in order and remembers which one created the account.
// - mail.tm asks for visible attribution (docs.mail.tm terms): the wizard's
//   instant-address step links back to them, and docs/email-providers.md
//   credits them. Keep that if you reuse this code.
// - Tokens expire; we re-authenticate per inbox fetch with the stored
//   address+password instead of caching tokens.
// - 8 requests/second/IP is the published limit: the wizard polls at most
//   every 8s, and domain lists are cached.

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// bases are env-overridable so E2E can point them at a local mock service;
// the packaged app always talks to the real mail.tm / mail.gw endpoints.
const APIS = [
  { id: 'mail.tm', base: process.env.PH_MAIL_API || 'https://api.mail.tm', host: 'mail.tm' },
  { id: 'mail.gw', base: process.env.PH_MAIL_API_2 || 'https://api.mail.gw', host: 'mail.gw' }
];

const domainCache = new Map();   // apiId -> { at, domains: [] }
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokens = new Map();        // `${apiId}:${accountId}` -> { token, at }

// ---- tiny JSON http(s) client (main-process Node stack, no session) ----
function jreq(url, { method = 'GET', headers = {}, body = null, timeoutMs = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : undefined), path: u.pathname + u.search, method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      timeout: timeoutMs
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { }
        resolve({ status: r.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
    if (body != null) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function tryApis(fn) {
  const errors = [];
  for (const api of APIS) {
    try {
      const out = await fn(api);
      if (out) return out;
    } catch (e) { errors.push(`${api.id}: ${e.message}`); }
  }
  throw new Error(errors.join(' · ') || 'no API reachable');
}

// ---- collection parsing ----
// mail.tm answers EITHER a plain JSON array (Accept: application/json) or
// the JSON-LD hydra shape ({'hydra:member': [...]}) depending on negotiation;
// both are handled everywhere collections come back.
function collection(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json['hydra:member'])) return json['hydra:member'];
  if (json && Array.isArray(json.member)) return json.member;
  return [];
}

// ---- domains ----
async function domains(api) {
  const c = domainCache.get(api.id);
  if (c && Date.now() - c.at < 30 * 60 * 1000 && c.domains.length) return c.domains;
  const r = await jreq(api.base + '/domains?isActive=true');
  if (r.status !== 200 || !r.json) throw new Error('domains HTTP ' + r.status);
  const list = collection(r.json).map(d => d.domain).filter(Boolean);
  if (!list.length) throw new Error('no active domains');
  domainCache.set(api.id, { at: Date.now(), domains: list });
  return list;
}

// ---- account creation ----
// local: local part; returns the created mailbox {address, password, accountId, api}
async function createAddress({ local, password, api: preferredApi }) {
  const pw = password || crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'a') + '9X!';
  const makeOn = async (api) => {
    const list = await domains(api);
    const domain = list[rnd(list.length)];
    const address = `${local}@${domain}`;
    const r = await jreq(api.base + '/accounts', { method: 'POST', body: { address, password: pw } });
    if (r.status === 201 && (r.json?.id || r.json?.account?.id)) {
      const accountId = r.json.id || r.json.account.id;
      return { address, password: pw, accountId, api: api.id, domain };
    }
    // 422 = address taken/unprocessable; 429 = rate limited. Both bubble as
    // per-api errors so the next API (or caller retry with a new local) can run.
    throw new Error(`HTTP ${r.status} ${(r.json?.['hydra:description'] || r.json?.message || '').slice(0, 80)}`);
  };
  if (preferredApi) {
    const api = APIS.find(a => a.id === preferredApi);
    if (api) { try { return await makeOn(api); } catch { } }
  }
  return tryApis(makeOn);
}

// ---- auth ----
async function token(api, address, password) {
  const r = await jreq(api.base + '/token', { method: 'POST', body: { address, password } });
  if (r.status !== 200 || !r.json?.token) throw new Error('login HTTP ' + r.status);
  return r.json.token;
}

async function authFor(store, wsId) {
  const ws = store.getWorkspace(wsId);
  if (!ws || !ws.disposable) throw new Error('no instant mailbox on this workspace');
  const apiId = String(ws.disposable.api || 'mail.tm');
  const api = APIS.find(a => a.id === apiId) || APIS[0];
  const password = store.decryptSecret(ws.disposable.password) || '';
  if (!password) throw new Error('mailbox password unavailable (vault not decrypted)');
  const key = `${api.id}:${ws.disposable.accountId || ws.disposable.address}`;
  const c = tokens.get(key);
  if (c && Date.now() - c.at < TOKEN_TTL_MS) return { api, token: c.token };
  const t = await token(api, ws.disposable.address, password);
  tokens.set(key, { token: t, at: Date.now() });
  return { api, token: t };
}

// ---- inbox ----
async function inbox(store, wsId) {
  const { api, token: t } = await authFor(store, wsId);
  const r = await jreq(api.base + '/messages?page=1', { headers: { authorization: 'Bearer ' + t } });
  if (r.status !== 200) throw new Error('inbox HTTP ' + r.status);
  const list = collection(r.json).map(m => ({
    id: m.id,
    from: m.from ? (m.from.address || '') : '',
    fromName: m.from ? (m.from.name || '') : '',
    subject: m.subject || '',
    intro: (m.intro || '').slice(0, 300),
    seen: !!m.seen,
    createdAt: m.createdAt || '',
    hasAttachments: !!(m.hasAttachments)
  }));
  return { api: api.id, address: store.getWorkspace(wsId).disposable.address, messages: list };
}

// ---- one message, with links extracted from the html body ----
async function message(store, wsId, msgId) {
  const { api, token: t } = await authFor(store, wsId);
  const r = await jreq(`${api.base}/messages/${encodeURIComponent(msgId)}`, { headers: { authorization: 'Bearer ' + t } });
  if (r.status !== 200) throw new Error('message HTTP ' + r.status);
  const m = r.json || {};
  const text = (m.text || '').slice(0, 4000);
  const html = m.html && Array.isArray(m.html) ? m.html.join('\n') : (m.html || '');
  // pull verification links out of the html: href first, then any bare http(s) url
  const links = [];
  const hrefs = (String(html).match(/href=["']([^"']+)["']/gi) || []);
  for (const h of hrefs) {
    const url = (h.match(/["']([^"']+)["']/) || [])[1];
    if (/^https?:\/\//i.test(url)) links.push(url);
  }
  for (const raw of (text.match(/https?:\/\/[^\s]+/g) || [])) {
    const clean = raw.replace(/[)\]>.]+$/, '');
    if (!links.includes(clean)) links.push(clean);
  }
  return {
    id: m.id,
    from: m.from ? (m.from.address || '') : '',
    subject: m.subject || '',
    text,
    links: links.slice(0, 12)
  };
}

function rnd(n) { return Math.floor(Math.random() * n); }

module.exports = { createAddress, inbox, message, domains, APIS };
