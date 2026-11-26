// Pigeonhole - IPC surface. Every renderer->main call lands here.
// Inputs are validated (workspace ids must match a strict pattern, URLs must be
// http(s), strings are length-capped) and secrets never travel to the renderer
// except through the explicit vault-secret channels.
const { ipcMain, dialog, shell, app, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { cancelDownload } = require('./downloads');

const WS_ID = /^[a-zA-Z0-9-]{1,40}$/;

function bad(reason) { const e = new Error(reason); e.invalidInput = true; return e; }
const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');
const isHttpUrl = (u) => /^https?:\/\//i.test(u || '');

function registerIpc(getWindow, sessionForPartition, store, updater) {

  const send = (type, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('ph-event', { type, payload });
  };

  // ---------- state ----------
  ipcMain.handle('ph:state', () => store.snapshot());

  // ---------- workspaces ----------
  ipcMain.handle('ph:ws-create', (_e, opts = {}) => {
    const ws = store.createWorkspace({ name: str(opts?.name, 80), hue: Number.isFinite(opts?.hue) ? opts.hue : null });
    sessionForPartition('persist:' + ws.id);
    return { id: ws.id, num: ws.num, name: ws.name, hue: ws.hue };
  });

  ipcMain.handle('ph:ws-duplicate', (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    const src = store.getWorkspace(wsId);
    if (!src) throw bad('no such workspace');
    const ws = store.createWorkspace({ hue: src.hue });
    // quick links carry over; the identity and browsing data stay fresh
    ws.quickLinks = Array.isArray(src.quickLinks) ? [...src.quickLinks] : [];
    store.save();
    sessionForPartition('persist:' + ws.id);
    return { id: ws.id, num: ws.num, name: ws.name, hue: ws.hue };
  });

  ipcMain.handle('ph:ws-remove', async (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    const ws = store.getWorkspace(wsId);
    if (!ws) return false;
    store.deleteWorkspace(wsId);
    send('state-changed', { reason: 'ws-removed', wsId });
    // wipe the partition data on disk (best effort)
    try {
      const ses = session.fromPartition('persist:' + wsId);
      await ses.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'] });
      await ses.clearCache();
      await ses.closeAllConnections?.();
    } catch { /* ignore */ }
    try {
      const dir = path.join(app.getPath('userData'), 'Partitions', wsId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch { /* locked files on Windows - cache clear above is the fallback */ }
    return true;
  });

  ipcMain.handle('ph:ws-rename', (_e, wsId, name) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    const ws = store.getWorkspace(wsId);
    if (!ws) throw bad('no such workspace');
    ws.name = str(name, 80) || ws.name;
    store.save();
    return ws.name;
  });

  ipcMain.handle('ph:ws-set-hue', (_e, wsId, hue) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    const ws = store.getWorkspace(wsId);
    if (!ws) throw bad('no such workspace');
    if (Number.isFinite(hue)) { ws.hue = Math.max(0, Math.min(359, Math.round(hue))); store.save(); }
    return ws.hue;
  });

  ipcMain.handle('ph:ws-clear-data', async (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    try {
      const ses = session.fromPartition('persist:' + wsId);
      await ses.clearStorageData({});
      await ses.clearCache();
      return true;
    } catch { return false; }
  });

  // ---------- tabs & history ----------
  ipcMain.handle('ph:tabs-save', (_e, wsId, tabs) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (Array.isArray(tabs)) store.saveTabs(wsId, tabs);
    return true;
  });

  ipcMain.handle('ph:history-add', (_e, wsId, entry) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (entry && isHttpUrl(entry.url)) {
      // titles come from web pages - keep them from smuggling markup into the NTP
      store.addHistory(wsId, { url: entry.url, title: str(entry.title, 200).replace(/[<>]/g, '') });
    }
    return true;
  });

  // ---------- settings ----------
  ipcMain.handle('ph:settings-set', (_e, patch) => {
    if (!patch || typeof patch !== 'object') throw bad('bad patch');
    // Only copy keys the caller actually sent. Building a full object from a
    // partial patch would overwrite every untouched setting (wiping the
    // identity base and silently disabling the wizard's autofill toggles).
    const out = {};
    if (typeof patch.searchEngine === 'string') out.searchEngine = str(patch.searchEngine, 20);
    if (typeof patch.identityMode === 'string') out.identityMode = str(patch.identityMode, 12);
    if (typeof patch.identityBase === 'string') out.identityBase = str(patch.identityBase, 40).replace(/[^a-zA-Z0-9._-]/g, '');
    if (patch.identityPadding != null) out.identityPadding = Math.max(1, Math.min(6, Number(patch.identityPadding) || 3));
    if (patch.identityStart != null) out.identityStart = Math.max(1, Math.min(9999, Number(patch.identityStart) || 1));
    if (patch.pwLength != null) out.pwLength = Math.max(10, Math.min(64, Number(patch.pwLength) || 16));
    if (patch.pwSymbols != null) out.pwSymbols = !!patch.pwSymbols;
    if (patch.autoFillOnLoad != null) out.autoFillOnLoad = !!patch.autoFillOnLoad;
    if (patch.autoDetectSuccess != null) out.autoDetectSuccess = !!patch.autoDetectSuccess;
    if (patch.betaUpdates != null) out.betaUpdates = !!patch.betaUpdates;
    if (typeof patch.downloadsDir === 'string') out.downloadsDir = str(patch.downloadsDir, 500);
    return store.setSettings(out);
  });

  ipcMain.handle('ph:settings-set-shared-password', (_e, pw) => {
    store.setSharedPassword(typeof pw === 'string' && pw ? pw.slice(0, 256) : null);
    return store.getSettings().hasSharedPassword;
  });

  // ---------- vault ----------
  ipcMain.handle('ph:vault-set-identity', (_e, wsId, id) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!id || typeof id.email !== 'string' || !id.email.includes('@')) throw bad('email required');
    return store.setIdentity(wsId, {
      email: str(id.email, 200), password: typeof id.password === 'string' ? id.password.slice(0, 256) : '',
      displayName: str(id.displayName, 80), provider: str(id.provider, 60)
    });
  });

  ipcMain.handle('ph:vault-update-identity', (_e, wsId, patch) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    return store.updateIdentity(wsId, {
      email: str(patch?.email, 200), displayName: str(patch?.displayName, 80),
      provider: str(patch?.provider, 60), password: typeof patch?.password === 'string' ? patch.password.slice(0, 256) : undefined
    });
  });

  ipcMain.handle('ph:vault-accounts', (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    return store.listAccounts(wsId);
  });

  ipcMain.handle('ph:vault-add-account', (_e, wsId, acct) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!acct || !isHttpUrl(acct.origin) || typeof acct.email !== 'string') throw bad('bad account');
    return store.upsertAccount(wsId, {
      origin: str(acct.origin, 300), email: str(acct.email, 200),
      password: typeof acct.password === 'string' ? acct.password.slice(0, 256) : '',
      title: str(acct.title, 120)
    });
  });

  ipcMain.handle('ph:vault-remove-account', (_e, wsId, origin, email) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    return store.removeAccount(wsId, str(origin, 300), str(email, 200));
  });

  // the only channels that hand secrets to the renderer
  ipcMain.handle('ph:vault-secret', (_e, wsId, which, ref) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    const ws = store.getWorkspace(wsId);
    if (!ws) throw bad('no such workspace');
    if (which === 'identity') return store.decryptSecret(ws.identity?.password);
    if (which === 'shared') return store.getSharedPassword();
    if (which === 'account' && ref && isHttpUrl(ref.origin)) {
      const a = ws.accounts.find(a => a.origin === String(ref.origin).replace(/\/+$/, '') && a.email === ref.email);
      return a ? store.decryptSecret(a.password) : null;
    }
    throw bad('unknown secret');
  });

  ipcMain.handle('ph:vault-export', async (_e, wsId) => {
    const w = getWindow();
    if (!w) return { ok: false };
    if (wsId && !WS_ID.test(wsId)) throw bad('bad id');
    const targets = wsId ? store.state.workspaces.filter(w => w.id === wsId) : store.state.workspaces;
    const data = {
      exportedAt: new Date().toISOString(),
      warning: 'This file contains your passwords in plain text. Store it safely and delete it when you are done.',
      workspaces: targets.map(w => ({
        name: w.name, identity: w.identity ? {
          email: w.identity.email, password: store.decryptSecret(w.identity.password) || '',
          displayName: w.identity.displayName, provider: w.identity.provider
        } : null,
        accounts: w.accounts.map(a => ({ origin: a.origin, email: a.email, password: store.decryptSecret(a.password) || '', title: a.title }))
      }))
    };
    const { canceled, filePath } = await dialog.showSaveDialog(w, {
      title: 'Export vault (plain text)',
      defaultPath: `pigeonhole-vault-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, filePath };
  });

  // ---------- self-update ----------
  ipcMain.handle('ph:update-check', () => updater.check({ silent: true }));
  ipcMain.handle('ph:update-download', () => updater.download());
  ipcMain.handle('ph:update-install', (_e, mode) => updater.install(mode === 'restart' ? 'restart' : 'quit'));

  // ---------- ui / misc ----------
  ipcMain.handle('ph:ui-set', (_e, patch) => {
    if (patch && typeof patch === 'object') store.setUi({ sidebarCollapsed: !!patch.sidebarCollapsed, activeWsId: WS_ID.test(patch.activeWsId || '') ? patch.activeWsId : store.state.ui.activeWsId });
    return true;
  });

  ipcMain.handle('ph:app-open', (_e, kind) => {
    const base = 'https://github.com/diiiamondmaster/pigeonhole';
    if (kind === 'downloads') shell.openPath(store.state.settings.downloadsDir || app.getPath('downloads'));
    if (kind === 'userData') shell.openPath(app.getPath('userData'));
    if (kind === 'releases') shell.openExternal(base + '/releases');
    if (kind === 'repo') shell.openExternal(base);
    if (kind === 'docs') shell.openExternal(base + '#readme');
    if (kind === 'docs-providers') shell.openExternal(base + '/blob/main/docs/email-providers.md');
    if (kind === 'issues') shell.openExternal(base + '/issues');
    return true;
  });

  ipcMain.handle('ph:show-item', (_e, p) => {
    if (typeof p === 'string' && p.length < 600) shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle('ph:app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }));

  ipcMain.handle('ph:set-title', (_e, title) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.setTitle(str(title, 200) || 'Pigeonhole');
    return true;
  });

  ipcMain.handle('ph:open-devtools', () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.openDevTools({ mode: 'detach' });
    return true;
  });

  // ---------- screenshot harness (dev only) ----------
  ipcMain.handle('ph:dev-ready', () => { global.__phReady = true; return true; });

  ipcMain.handle('ph:dl-cancel', (_e, id) => cancelDownload(String(id).slice(0, 20)));

  // downloads dir pick
  ipcMain.handle('ph:pick-downloads-dir', async () => {
    const w = getWindow();
    if (!w) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(w, { properties: ['openDirectory'] });
    return canceled ? null : (filePaths[0] || null);
  });
}

module.exports = { registerIpc };
