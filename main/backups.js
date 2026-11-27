// Pigeonhole - mail backup capture.
//
// No-phone mail providers (Tuta, Atomic Mail, Mailfence, ...) hand you a
// backup / recovery file when you sign up or export: a .tuta container, an
// encrypted zip, a key export. In a normal browser those pile up in the
// Downloads folder, unlabelled, until you need them and cannot tell which
// account they belong to. Pigeonhole knows which workspace is downloading
// what, so:
//
//   CAPTURE  when a download that looks like a mail backup starts in a
//            workspace with an email identity, it never lands in Downloads:
//            it is stored under the app's data folder in a per-workspace
//            backups directory and recorded on that workspace.
//   LEGACY   at boot (and on demand), the Downloads folder is scanned for
//            old backup-looking files; each one whose name ties it to a
//            current workspace identity (email address / local part, or a
//            provider-specific extension) is imported the same way. Files
//            that match no workspace - or several - are left alone.
//
// Matching is deliberately conservative: a random "backup.zip" that belongs
// to no known address is NOT mail data, and guessing wrong would move a
// user's file. The email identity is the key.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_BACKUP_BYTES = 128 * 1024 * 1024;   // bigger than this: not a backup
const LEGACY_SCAN_LIMIT = 400;                // files looked at per scan
const BOOT_SCAN_DELAY_MS = 9000;

// mail providers and their identity domains (main-side mirror of the
// wizard registry - keep in sync with app/js/providers.js)
const MAIL_DOMAINS = [
  'tuta.com', 'tutanota.com', 'tuta.io', 'tutamail.com', 'tutanota.de', 'keemail.me',
  'atomicmail.io',
  'proton.me', 'protonmail.com',
  'mailfence.com'
];
const TUTA_DOMAINS = new Set(['tuta.com', 'tutanota.com', 'tuta.io', 'tutamail.com', 'tutanota.de', 'keemail.me']);
// filenames that smell like a provider backup/export
const NAME_RE = /backup|recovery|restore|export|seed|account[-_. ]?key|\.tuta($|\.)/i;

let hook = { send: () => { }, store: null };
let bootScanTimer = null;

function bind(send, store) { hook = { send, store }; }

// ---- helpers ----
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const regDomain = (h) => String(h || '').split('.').slice(-2).join('.');
const backupDir = (wsId) => path.join(app.getPath('userData'), 'backups', String(wsId).replace(/[^a-zA-Z0-9-]/g, ''));

function identityOf(ws) {
  const email = ws && ws.identity && ws.identity.email;
  if (!email || !String(email).includes('@')) return null;
  return { email: String(email).toLowerCase(), local: String(email).split('@')[0], domain: String(email).split('@')[1] };
}

function uniquePath(dir, name) {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 150) || 'backup';
  let p = path.join(dir, safe);
  let i = 1;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i})${ext}`); i += 1; }
  return p;
}

// does this host belong to the workspace's mail provider?
function hostMatchesIdentity(host, ident) {
  if (!host || !ident) return false;
  return regDomain(host) === regDomain(ident.domain) || MAIL_DOMAINS.includes(host);
}

// ---- record keeping ----
function record(wsId, { name, bytes, capturedAt, source, provider }) {
  const store = hook.store;
  const ws = store && store.getWorkspace(wsId);
  if (!ws) return null;
  if (!Array.isArray(ws.backups)) ws.backups = [];
  ws.backups.push({ name: String(name).slice(0, 200), bytes: Number(bytes) || 0, capturedAt: Number(capturedAt) || Date.now(), source, provider: String(provider || '').slice(0, 60) });
  if (ws.backups.length > 24) ws.backups = ws.backups.slice(-24);
  store.save();
  return ws.backups[ws.backups.length - 1];
}

// ---- live capture (called from downloads.js before a save path is set) ----
// item: Electron DownloadItem; wc: the webContents that started it.
// Returns true when the download is handled as a workspace backup.
function capture(item, wc) {
  try {
    if (!hook.store) return false;
    const { wsIdOfWebContents } = require('./proxy');
    const wsId = wc ? wsIdOfWebContents(wc) : null;
    if (!wsId) return false;
    const ws = hook.store.getWorkspace(wsId);
    const ident = identityOf(ws);
    if (!ident) return false;                       // no identity: cannot tie it

    const name = String(item.getFilename() || '');
    const bytes = item.getTotalBytes ? item.getTotalBytes() : 0;
    if (bytes && bytes > MAX_BACKUP_BYTES) return false;

    const srcHost = hostOf(item.getURL ? item.getURL() : '');
    const pageHost = (() => { try { return wc.getURL() ? hostOf(wc.getURL()) : ''; } catch { return ''; } })();
    const normName = norm(name);
    const normEmail = norm(ident.email);
    const localOk = ident.local.length >= 5 && normName.includes(norm(ident.local));
    const fromProvider = hostMatchesIdentity(srcHost, ident) || hostMatchesIdentity(pageHost, ident);
    const tutaFile = /\.tuta$/i.test(name) && TUTA_DOMAINS.has(regDomain(ident.domain));

    // capture only when the evidence ties the file to THIS workspace:
    //   from the provider's own site AND a backup-looking name, or
    //   the file name carries this workspace's address/local part, or
    //   a Tuta container for a Tuta identity
    if (!((fromProvider && NAME_RE.test(name)) || localOk || tutaFile)) return false;

    const dir = backupDir(wsId);
    fs.mkdirSync(dir, { recursive: true });
    const dest = uniquePath(dir, name);
    item.setSavePath(dest);

    const provider = providerLabelFor(ident.domain);
    item.once('done', (_e, state) => {
      if (state !== 'completed') { try { fs.unlinkSync(dest); } catch { } return; }
      const rec = record(wsId, { name: path.basename(dest), bytes: item.getTotalBytes ? item.getTotalBytes() : 0, capturedAt: Date.now(), source: 'download', provider });
      hook.send('backup-captured', { wsId, name: path.basename(dest), bytes: rec ? rec.bytes : 0, provider });
      hook.send('state-changed', { reason: 'ws-backup', wsId });
    });
    return true;
  } catch { return false; }
}

function providerLabelFor(domain) {
  const reg = regDomain(domain);
  if (TUTA_DOMAINS.has(reg)) return 'Tuta';
  if (reg === 'atomicmail.io') return 'Atomic Mail';
  if (reg === 'proton.me' || reg === 'protonmail.com') return 'Proton Mail';
  if (reg === 'mailfence.com') return 'Mailfence';
  return reg;
}

// ---- legacy scan of the Downloads folder ----
// A file is imported when its name ties it to EXACTLY ONE current workspace
// identity (the full address, the local part, or a provider-specific
// extension with a unique owning provider). Anything else is ignored.
async function scanLegacy({ quiet = false } = {}) {
  if (!hook.store) return { imported: 0, ignored: 0 };
  const store = hook.store;
  let dir = store.state.settings.downloadsDir || app.getPath('downloads');
  try { dir = fs.realpathSync(dir); } catch { }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { imported: 0, ignored: 0 }; }

  // candidate workspaces: identity + unique local part
  const byEmail = new Map();
  const byLocal = new Map();
  for (const w of store.state.workspaces) {
    const ident = identityOf(w);
    if (!ident) continue;
    if (!byEmail.has(ident.email)) byEmail.set(ident.email, []);
    byEmail.get(ident.email).push(w);
    if (ident.local.length >= 5) {
      if (!byLocal.has(ident.local)) byLocal.set(ident.local, []);
      byLocal.get(ident.local).push(w);
    }
  }

  let imported = 0, ignored = 0;
  for (const ent of entries.slice(0, LEGACY_SCAN_LIMIT)) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (name.startsWith('.') || /icon/i.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.size > MAX_BACKUP_BYTES) continue;

    const normName = norm(name);
    let ws = null, provider = '';
    // 1. full email address embedded in the file name
    for (const [email, list] of byEmail) {
      if (normName.includes(norm(email))) {
        if (list.length === 1) { ws = list[0]; provider = providerLabelFor(email.split('@')[1]); }
        else ws = 'ambiguous';
        break;
      }
    }
    // 2. unique local part (owner's handle) in the file name
    if (!ws) {
      for (const [local, list] of byLocal) {
        if (normName.includes(norm(local))) {
          if (list.length === 1) { ws = list[0]; provider = providerLabelFor(list[0].identity.email.split('@')[1]); }
          else ws = 'ambiguous';
          break;
        }
      }
    }
    // 3. provider-specific container whose owning provider is unique here
    if (!ws && /\.tuta$/i.test(name)) {
      const tutaWs = store.state.workspaces.filter(w => TUTA_DOMAINS.has(regDomain(identityOf(w)?.domain || '')));
      if (tutaWs.length === 1) { ws = tutaWs[0]; provider = 'Tuta'; }
      else ws = 'ambiguous';
    }
    if (!ws || ws === 'ambiguous') { if (NAME_RE.test(name)) ignored++; continue; }
    // only backup-looking files: a random "notes.txt" containing the handle
    // is not mail data either
    if (!NAME_RE.test(name)) { ignored++; continue; }

    const ident = identityOf(ws);
    const dir2 = backupDir(ws.id);
    fs.mkdirSync(dir2, { recursive: true });
    const dest = uniquePath(dir2, name);
    try {
      try { fs.renameSync(full, dest); }
      catch { // cross-device: copy + delete
        fs.copyFileSync(full, dest);
        fs.unlinkSync(full);
      }
    } catch { continue; }
    const rec = record(ws.id, { name: path.basename(dest), bytes: st.size, capturedAt: st.mtimeMs || Date.now(), source: 'legacy', provider: provider || providerLabelFor(ident.domain) });
    imported++;
    hook.send('backup-legacy', { wsId: ws.id, name: rec.name, bytes: rec.bytes, provider: rec.provider });
    hook.send('state-changed', { reason: 'ws-backup', wsId: ws.id });
  }
  if (imported && !quiet) {
    hook.send('backups-scanned', { imported, ignored });
  }
  return { imported, ignored };
}

// ---- workspace lifecycle ----
function removeFor(wsId) {
  try { fs.rmSync(backupDir(wsId), { recursive: true, force: true }); } catch { }
}

function openInFolder(wsId, name) {
  const safe = String(name || '').replace(/[/\\]/g, '');
  const p = path.join(backupDir(wsId), safe);
  if (!fs.existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
}

function init(send, store) {
  bind(send, store);
  if (!bootScanTimer) {
    bootScanTimer = setTimeout(() => {
      bootScanTimer = null;
      scanLegacy({ quiet: false }).catch(() => { });
    }, BOOT_SCAN_DELAY_MS);
    bootScanTimer.unref?.();
  }
}

module.exports = { init, bind, capture, scanLegacy, removeFor, openInFolder, backupDir };
