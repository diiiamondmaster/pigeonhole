// Pigeonhole sync (beta.7): the whole app, on every device, never backwards.
//
// The bundle: one sealed file - settings, workspaces (identities, vault
// secrets decrypted), tabs, history, mail backups and deletion tombstones.
// Sealed with a passphrase (scrypt -> AES-256-GCM), so the folder it lives
// in can be any transport the user already trusts: Syncthing, Dropbox, a
// USB stick. No server, no account, nothing new leaves the machines.
//
// "Never go backwards" is structural, not hopeful:
//   - every workspace carries a merge clock (updatedAt) stamped by each
//     mutation; merges are last-writer-wins PER WORKSPACE, so an older
//     snapshot can never overwrite a newer workspace record
//   - deleting a workspace writes a tombstone (deleted[id] = time). A peer
//     whose bundle still contains that workspace at an OLDER timestamp
//     cannot resurrect it
//   - settings merge the same way on settings.updatedAt
//   - a bundle whose every item is older changes nothing (merge is a no-op)
//
// What deliberately does NOT sync: the proxy pool cache (re-verified per
// machine), ui state (device-local), and Chromium partition data (cookies,
// site logins) - identities and passwords come over, logins are re-done on
// the new device with the synced credentials.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { app, dialog } = require('electron');

const MAGIC = Buffer.from('PHSYNC10', 'utf8');   // 8 bytes: salt@8, iv@20, tag@32, body@44
const BUNDLE_NAME = 'pigeonhole-sync.bundle';
const WRITE_DEBOUNCE_MS = 2000;
const READ_DEBOUNCE_MS = 900;
const POLL_MS = 30 * 1000;

let store = null;
let send = () => { };
let sessionForPartition = () => null;
let unhookFlush = null;
let watcher = null;
let pollTimer = null;
let writeTimer = null;
let readTimer = null;
let writing = false;
let lastSignature = null;      // hash of the bytes WE wrote - ignores our own file events

const syncDir = () => {
  const d = store.state.settings.sync && store.state.settings.sync.dir;
  return d && typeof d === 'string' ? d : null;
};
const enabled = () => !!(store.state.settings.sync && store.state.settings.sync.enabled && syncDir());
const bundlePath = () => path.join(syncDir(), BUNDLE_NAME);

// ---------- sealing ----------
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}
function seal(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, body]);
}
function unseal(buf, passphrase) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 16 + 12 + 16 || !buf.subarray(0, 8).equals(MAGIC)) {
    throw new Error('not a Pigeonhole sync bundle');
  }
  const salt = buf.subarray(8, 24);
  const iv = buf.subarray(24, 36);
  const tag = buf.subarray(36, 52);
  const body = buf.subarray(52);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = zlib.gunzipSync(Buffer.concat([decipher.update(body), decipher.final()]));
  const obj = JSON.parse(plain.toString('utf8'));
  if (obj.bundle !== 'pigeonhole-sync') throw new Error('wrong bundle kind');
  return obj;
}

// ---------- bundle build ----------
function wsSecrets(ws) {
  return {
    identityPassword: store.decryptSecret(ws.identity && ws.identity.password) || null,
    proxyPassword: store.decryptSecret(ws.proxy && ws.proxy.password) || null,
    accounts: (ws.accounts || []).map(a => ({ origin: a.origin, email: a.email, password: store.decryptSecret(a.password) || null }))
  };
}
function backupDirOf(wsId) {
  return path.join(app.getPath('userData'), 'backups', String(wsId).replace(/[^a-zA-Z0-9-]/g, ''));
}
function wsBundle(ws, { withBackups = true } = {}) {
  const out = {
    id: ws.id, num: ws.num, name: ws.name, hue: ws.hue,
    identity: ws.identity ? { ...ws.identity } : null,
    accounts: (ws.accounts || []).map(a => ({ ...a })),
    quickLinks: Array.isArray(ws.quickLinks) ? [...ws.quickLinks] : [],
    proxy: ws.proxy ? { ...ws.proxy } : null,
    group: ws.group || null,
    createdAt: ws.createdAt || 0,
    updatedAt: ws.updatedAt || ws.createdAt || 0,
    secrets: wsSecrets(ws),
    backups: []
  };
  // the identity/account password boxes are machine-bound; strip them, the
  // plaintext travels under the bundle's own seal instead
  if (out.identity) out.identity.password = null;
  for (const a of out.accounts) a.password = null;
  if (out.proxy) out.proxy.password = null;
  if (withBackups) {
    for (const b of ws.backups || []) {
      try {
        const p = path.join(backupDirOf(ws.id), String(b.name || '').replace(/[/\\]/g, '_'));
        if (fs.existsSync(p)) {
          const data = fs.readFileSync(p);
          if (data.length <= 8 * 1024 * 1024) {   // keep the bundle sane
            out.backups.push({ ...b, dataB64: data.toString('base64') });
          } else {
            out.backups.push({ ...b, dataB64: null });
          }
        }
      } catch { }
    }
  }
  return out;
}
function buildBundle({ onlyWsId = null, withBackups = true } = {}) {
  const st = store.state;
  return {
    bundle: 'pigeonhole-sync', v: 1,
    device: st.sync.deviceId,
    exportedAt: Date.now(),
    nextWsNum: st.nextWsNum,
    settings: { ...st.settings, sharedPassword: store.getSharedPassword(), updatedAt: st.settings.updatedAt || 0 },
    workspaces: st.workspaces.filter(w => !onlyWsId || w.id === onlyWsId).map(w => wsBundle(w, { withBackups })),
    tabs: onlyWsId ? { [onlyWsId]: st.tabs[onlyWsId] || [] } : { ...st.tabs },
    history: onlyWsId ? { [onlyWsId]: st.history[onlyWsId] || [] } : { ...st.history },
    deleted: onlyWsId ? {} : { ...st.deleted }
  };
}

// ---------- merge (the monotonic part) ----------
function adoptWorkspace(bws) {
  const st = store.state;
  const lws = st.workspaces.find(w => w.id === bws.id);
  const sec = bws.secrets || {};
  const ws = lws || {
    id: bws.id, num: 0, name: 'Workspace', hue: bws.hue || '#f2b155',
    identity: null, accounts: [], quickLinks: [], proxy: null, group: null,
    createdAt: bws.createdAt || Date.now(), backups: []
  };
  ws.name = String(bws.name || ws.name).slice(0, 80);
  ws.hue = bws.hue || ws.hue;
  ws.group = bws.group || null;
  ws.createdAt = bws.createdAt || ws.createdAt;
  ws.updatedAt = bws.updatedAt || Date.now();
  ws.quickLinks = Array.isArray(bws.quickLinks) ? bws.quickLinks.slice(0, 40) : [];
  ws.identity = bws.identity && bws.identity.email
    ? { ...bws.identity, password: sec.identityPassword != null ? store.encryptSecret(sec.identityPassword) : null }
    : (bws.identity === null ? null : ws.identity);
  ws.accounts = Array.isArray(bws.accounts)
    ? bws.accounts.map(a => {
      const pw = (sec.accounts || []).find(x => x.origin === a.origin && x.email === a.email);
      return { ...a, password: pw && pw.password != null ? store.encryptSecret(pw.password) : null };
    })
    : (ws.accounts || []);
  ws.proxy = bws.proxy
    ? { ...bws.proxy, password: sec.proxyPassword != null ? store.encryptSecret(sec.proxyPassword) : null }
    : null;
  // tabs + history ride with the workspace clock
  st.tabs[bws.id] = Array.isArray(bws.tabs) ? bws.tabs : (st.tabs[bws.id] || []);
  st.history[bws.id] = Array.isArray(bws.history) ? bws.history : (st.history[bws.id] || []);
  // mail backups: metadata always; file bytes restored when present
  const prevBackups = Array.isArray(ws.backups) ? ws.backups : [];
  ws.backups = Array.isArray(bws.backups) ? bws.backups.map(b => ({ ...b, dataB64: undefined })) : prevBackups;
  if (!lws) st.workspaces.push(ws);
  // restore backup files
  for (const b of (bws.backups || [])) {
    if (!b.dataB64) continue;
    try {
      const dir = backupDirOf(bws.id);
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(b.name || '').replace(/[/\\]/g, '_');
      const dst = path.join(dir, safe);
      if (!fs.existsSync(dst)) fs.writeFileSync(dst, Buffer.from(b.dataB64, 'base64'));
    } catch { }
  }
  return ws;
}

async function dropWorkspace(id, at) {
  const st = store.state;
  const i = st.workspaces.findIndex(w => w.id === id);
  if (i === -1) return false;
  const [gone] = st.workspaces.splice(i, 1);
  delete st.tabs[id];
  delete st.history[id];
  st.deleted[id] = Math.max(at || 0, st.deleted[id] || 0);
  try {
    const ses = sessionForPartition('persist:' + id);
    if (ses) {
      await ses.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'] });
      await ses.clearCache();
    }
  } catch { }
  if ((st.ui || {}).activeWsId === id) st.ui.activeWsId = st.workspaces[0]?.id || null;
  return !!gone;
}

// returns { changed, adopted, dropped, settingsUpdated, skipped }
function mergeBundle(bundle) {
  const st = store.state;
  const res = { changed: 0, adopted: 0, dropped: 0, settingsUpdated: false, skipped: 0 };
  // settings: last-writer-wins on settings.updatedAt
  const bSet = bundle.settings || {};
  if ((bSet.updatedAt || 0) > (st.settings.updatedAt || 0)) {
    const keep = { ...st.settings };
    for (const k of Object.keys(bSet)) {
      if (k === 'updatedAt' || k === 'sync') continue;
      keep[k] = bSet[k];
    }
    // the shared password arrives as plaintext: seal it locally
    if (bSet.sharedPassword != null) keep.sharedPassword = store.encryptSecret(String(bSet.sharedPassword));
    keep.updatedAt = bSet.updatedAt;
    st.settings = keep;
    res.settingsUpdated = true;
    res.changed++;
  }
  // workspaces: per-id LWW; tombstones win against older records
  for (const bws of bundle.workspaces || []) {
    if (!bws || typeof bws.id !== 'string') continue;
    const tabs = (bundle.tabs || {})[bws.id] || [];
    const history = (bundle.history || {})[bws.id] || [];
    const enriched = { ...bws, tabs, history };
    const tomb = st.deleted[bws.id] || 0;
    const bAt = bws.updatedAt || bws.createdAt || 0;
    if (tomb && tomb >= bAt) { res.skipped++; continue; }        // locally deleted at/after their write
    const lws = st.workspaces.find(w => w.id === bws.id);
    if (!lws) { adoptWorkspace(enriched); res.adopted++; res.changed++; }
    else if (bAt > (lws.updatedAt || 0)) { adoptWorkspace(enriched); res.adopted++; res.changed++; }
    else res.skipped++;
  }
  // incoming tombstones: delete local workspaces whose clock is older
  for (const [id, at] of Object.entries(bundle.deleted || {})) {
    const lws = st.workspaces.find(w => w.id === id);
    if (lws && (lws.updatedAt || 0) < at) {
      dropWorkspace(id, at);   // async partition wipe is fire-and-forget inside
      res.dropped++; res.changed++;
    } else if (!lws && !(st.deleted[id] >= at)) {
      st.deleted[id] = at;     // remember the deletion even without a local record
    }
  }
  st.nextWsNum = Math.max(st.nextWsNum || 1, bundle.nextWsNum || 1);
  if (res.changed) {
    store._renumber();
    store.flushNow();
  }
  return res;
}

// ---------- folder mode ----------
function writeBundleSoon() {
  if (!enabled()) return;
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (!enabled()) return;
    try {
      const pass = store.decryptSecret(store.state.settings.sync.pass);
      if (!pass) throw new Error('no sync passphrase stored');
      writing = true;
      const buf = seal(buildBundle({}), pass);
      lastSignature = crypto.createHash('sha256').update(buf).digest('hex');
      const tmp = bundlePath() + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, bundlePath());
      store.state.settings.sync.lastWriteAt = Date.now();
    } catch (e) {
      store.state.settings.sync.lastError = String(e.message || e);
      console.error('[sync] write failed:', e.message);
    } finally { writing = false; }
  }, WRITE_DEBOUNCE_MS);
}

async function readAndMergeNow({ manual = false } = {}) {
  if (!enabled() && !manual) return null;
  try {
    const p = manual ? manual : bundlePath();
    const buf = fs.readFileSync(p);
    const sig = crypto.createHash('sha256').update(buf).digest('hex');
    if (sig === lastSignature) return { changed: 0, skipped: 0, note: 'own-write' };
    const pass = manual ? manualPass : store.decryptSecret(store.state.settings.sync.pass);
    if (!pass) throw new Error('no sync passphrase stored');
    const bundle = unseal(buf, pass);
    // clock sanity: a bundle from the far future means skewed device clocks;
    // we still merge (LWW protects data) but surface the skew
    const skew = bundle.exportedAt - Date.now();
    const res = mergeBundle(bundle);
    store.state.settings.sync.lastError = skew > 30 * 60 * 1000 ? `peer clock is ${Math.round(skew / 60000)} min ahead - check device clocks` : null;
    store.state.settings.sync.lastMergeAt = Date.now();
    if (res.changed) {
      send('state-changed', { reason: 'sync-merge', ...res });
      send('sync-merged', res);
    }
    return res;
  } catch (e) {
    store.state.settings.sync.lastError = String(e.message || e);
    console.error('[sync] read/merge failed:', e.message);
    return null;
  }
}
let manualPass = null;

function startWatching() {
  stopWatching();
  if (!enabled()) return;
  try {
    watcher = fs.watch(syncDir(), { persistent: false }, (evt, name) => {
      if (name && name !== BUNDLE_NAME) return;
      if (writing) return;
      if (readTimer) clearTimeout(readTimer);
      readTimer = setTimeout(() => { readTimer = null; readAndMergeNow(); }, READ_DEBOUNCE_MS);
    });
  } catch (e) {
    console.error('[sync] watch failed:', e.message);
  }
  pollTimer = setInterval(() => { if (!writing) readAndMergeNow(); }, POLL_MS);
  readAndMergeNow();
}
function stopWatching() {
  try { watcher && watcher.close(); } catch { }
  watcher = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- lifecycle ----------
function init(storeRef, sendRef, sessionForPartitionRef) {
  store = storeRef;
  send = sendRef;
  sessionForPartition = sessionForPartitionRef;
  // normalise sync settings
  if (!store.state.settings.sync || typeof store.state.settings.sync !== 'object') store.state.settings.sync = {};
  if (unhookFlush) unhookFlush();
  unhookFlush = store.onFlush(writeBundleSoon);
  if (enabled()) startWatching();
}

function setup({ dir, passphrase }) {
  // first write to the folder immediately validates the passphrase round-trip
  store.state.settings.sync = { ...(store.state.settings.sync || {}), dir, pass: store.encryptSecret(String(passphrase)) };
  store.save();
  writing = true;
  try {
    const buf = seal(buildBundle({}), String(passphrase));
    lastSignature = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(bundlePath(), buf);
  } finally { writing = false; }
  store.state.settings.sync.enabled = true;
  store.state.settings.sync.lastWriteAt = Date.now();
  store.state.settings.sync.lastError = null;
  store.save();
  startWatching();
  return status();
}
function disable() {
  store.state.settings.sync.enabled = false;
  store.save();
  stopWatching();
  return status();
}
function status() {
  const s = store.state.settings.sync || {};
  return {
    enabled: enabled(), dir: syncDir(),
    deviceId: store.state.sync.deviceId,
    rev: store.state.sync.rev,
    lastWriteAt: s.lastWriteAt || 0, lastMergeAt: s.lastMergeAt || 0,
    lastError: s.lastError || null,
    workspaces: store.state.workspaces.length
  };
}
async function syncNow() {
  const r = await readAndMergeNow();
  writeBundleSoon();
  return { merged: r || { changed: 0 }, status: status() };
}

// ---------- file dialogs (one-shot import / export) ----------
async function exportToFile({ passphrase, wsId = null, defaultName }) {
  const win = require('electron').BrowserWindow.getFocusedWindow();
  const where = await dialog.showSaveDialog(win, {
    title: wsId ? 'Export workspace bundle' : 'Export Pigeonhole bundle',
    defaultPath: defaultName || (wsId ? `pigeonhole-workspace.bundle` : 'pigeonhole-full.bundle'),
    filters: [{ name: 'Pigeonhole bundle', extensions: ['bundle'] }]
  });
  if (where.canceled || !where.filePath) return { ok: false };
  const buf = seal(buildBundle({ onlyWsId: wsId, withBackups: true }), String(passphrase));
  fs.writeFileSync(where.filePath, buf);
  return { ok: true, path: where.filePath, bytes: buf.length };
}
async function importFromFile({ passphrase }) {
  const win = require('electron').BrowserWindow.getFocusedWindow();
  const picked = await dialog.showOpenDialog(win, {
    title: 'Import a Pigeonhole bundle',
    filters: [{ name: 'Pigeonhole bundle', extensions: ['bundle'] }],
    properties: ['openFile']
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
  try {
    const bundle = unseal(fs.readFileSync(picked.filePaths[0]), String(passphrase));
    const res = mergeBundle(bundle);
    if (res.changed) send('state-changed', { reason: 'sync-import', ...res });
    return { ok: true, path: picked.filePaths[0], ...res };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { init, status, setup, disable, syncNow, exportToFile, importFromFile, seal, unseal, buildBundle, mergeBundle, _internal: { readAndMergeNow, writeBundleSoon } };
