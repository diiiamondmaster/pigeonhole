// Pigeonhole - IPC surface. Every renderer->main call lands here.
// Inputs are validated (workspace ids must match a strict pattern, URLs must be
// http(s), strings are length-capped) and secrets never travel to the renderer
// except through the explicit vault-secret channels.
const { ipcMain, dialog, shell, app, session, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cancelDownload } = require('./downloads');
const extensions = require('./extensions');
const { applyWorkspaceProxy } = require('./proxy');
const pool = require('./proxypool');
const disposable = require('./disposable');

const WS_ID = /^[a-zA-Z0-9-]{1,40}$/;

function bad(reason) { const e = new Error(reason); e.invalidInput = true; return e; }
const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');
const isHttpUrl = (u) => /^https?:\/\//i.test(u || '');

function registerIpc(getWindow, sessionForPartition, store, updater) {

  const send = (type, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('ph-event', { type, payload });
  };

  // the pool writes workspace proxies + fires the same events as the manual
  // path, so assignment is indistinguishable downstream
  pool.bind(send, store, sessionForPartition);

  // page-load probe on a workspace session: the only path that can answer
  // proxy 407 challenges (the app 'login' handler supplies the credentials)
  async function exitIpViaHiddenWindow(target, ses) {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({
      show: false, width: 240, height: 160,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
    });
    try {
      await win.loadURL(target, { userAgent: 'pigeonhole-exit-ip-test' });
      return await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
    } finally { try { win.destroy(); } catch { } }
  }

  // ---------- state ----------
  ipcMain.handle('ph:state', () => store.snapshot());

  // ---------- workspaces ----------
  // pool assignments are serialized so concurrent workspace creations pick
  // distinct exits (the pick reads what the previous assign already wrote)
  let autoAssignQueue = Promise.resolve();
  const queueAutoAssign = (wsId) => {
    autoAssignQueue = autoAssignQueue.then(() => pool.assign(wsId).catch(() => { }));
  };
  ipcMain.handle('ph:ws-create', (_e, opts = {}) => {
    const ws = store.createWorkspace({ name: str(opts?.name, 80), hue: Number.isFinite(opts?.hue) ? opts.hue : null });
    sessionForPartition('persist:' + ws.id);
    // free pool: new workspaces get an automatic exit unless opted out
    if (store.state.settings.poolAutoNewWorkspaces) {
      queueAutoAssign(ws.id);
    }
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

  // reorder: a full permutation of workspace ids; numbers recompute to 1..N
  ipcMain.handle('ph:ws-reorder', (_e, ids) => {
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every(i => WS_ID.test(String(i || '')))) throw bad('bad id list');
    const ok = store.reorderWorkspaces(ids.map(String));
    if (!ok) throw bad('bad order');   // not a permutation of the current set
    send('state-changed', { reason: 'ws-reorder' });
    return true;
  });

  // ---------- disposable instant mailboxes (mail.tm / mail.gw) ----------
  // local: desired local part (falls back to a random one), password: optional
  ipcMain.handle('ph:temp-create', async (_e, wsId, local, password) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!store.getWorkspace(wsId)) throw bad('no such workspace');
    const clean = String(local || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    const mine = await disposable.createAddress({
      local: clean || ('ph' + crypto.randomBytes(5).toString('hex')),
      password: typeof password === 'string' && password.length >= 8 ? password.slice(0, 128) : null
    }).catch((e) => { throw new Error(String(e.message || e).slice(0, 200)); });
    const rec = store.setDisposable(wsId, {
      address: mine.address, password: mine.password, accountId: mine.accountId, api: mine.api, createdAt: Date.now()
    });
    send('state-changed', { reason: 'ws-disposable', wsId });
    return rec;
  });

  ipcMain.handle('ph:temp-inbox', async (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    try { return { ok: true, ...(await disposable.inbox(store, wsId)) }; }
    catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
  });

  ipcMain.handle('ph:temp-message', async (_e, wsId, msgId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!/^[a-zA-Z0-9]{1,64}$/.test(String(msgId || ''))) throw bad('bad message id');
    try { return { ok: true, ...(await disposable.message(store, wsId, String(msgId))) }; }
    catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
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

  // ---------- per-workspace proxy ----------
  ipcMain.handle('ph:ws-set-proxy', async (_e, wsId, cfg) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!store.getWorkspace(wsId)) throw bad('no such workspace');
    if (cfg && typeof cfg !== 'object') throw bad('bad proxy config');
    if (cfg && cfg.enabled) {
      if (typeof cfg.host !== 'string' || !cfg.host.trim()) throw bad('proxy host required');
      if (!Number.isFinite(Number(cfg.port)) || Number(cfg.port) < 1 || Number(cfg.port) > 65535) throw bad('proxy port out of range');
    }
    const saved = store.setProxy(wsId, cfg);
    // route the live session right away (workspaces without a session yet
    // pick the setting up when their webview first attaches)
    try { await applyWorkspaceProxy(wsId, session.fromPartition('persist:' + wsId)); } catch { }
    send('state-changed', { reason: 'ws-proxy', wsId });
    send('proxy-applied', { wsId, proxy: saved });
    return saved;
  });

  // Exit-IP test: fetches an IP echo service THROUGH the workspace's own
  // session, so the answer proves which exit the traffic really takes.
  // Default service is api.ipify.org; the sandbox tests pass a local URL.
  ipcMain.handle('ph:ws-test-proxy', async (_e, wsId, url) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    const ws = store.getWorkspace(wsId);
    if (!ws) throw bad('no such workspace');
    const target = isHttpUrl(url) ? String(url).slice(0, 500) : 'https://api.ipify.org/?format=json';
    const ses = session.fromPartition('persist:' + wsId);
    const via = (ws.proxy && ws.proxy.enabled)
      ? `${ws.proxy.scheme}://${ws.proxy.host}:${ws.proxy.port}`
      : 'direct';
    const t0 = Date.now();
    try {
      const res = await new Promise((resolve, reject) => {
        let settled = false;
        const req = net.request({ url: target, session: ses });
        req.setHeader('User-Agent', 'pigeonhole-exit-ip-test');
        const to = setTimeout(() => {
          if (settled) return; settled = true;
          try { req.destroy(); } catch { }
          reject(new Error('timed out after 12s'));
        }, 12000);
        const chunks = [];
        req.on('response', (r) => {
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            if (settled) return; settled = true; clearTimeout(to);
            resolve({ status: r.statusCode, body: Buffer.concat(chunks) });
          });
          r.on('aborted', () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('connection interrupted')); } });
        });
        req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
        req.end();
      });
      if (res.status !== 200) {
        // 407: a credentialed HTTP exit challenges net.request, which cannot
        // answer proxy auth (no login event). Retry the probe as a real page
        // load in a hidden window on the workspace session - there the app
        // 'login' handler answers from the encrypted store.
        if (res.status === 407) {
          try {
            const text = await exitIpViaHiddenWindow(target, ses);
            let ip = null;
            try { ip = JSON.parse(text).ip || null; } catch { }
            if (!ip) { const m = /\b((?:\d{1,3}\.){3}\d{1,3})\b/.exec(text || ''); if (m) ip = m[1]; }
            if (ip) return { ok: true, ip, ms: Date.now() - t0, via: via + ' (authenticated)' };
          } catch { /* fall through to the error */ }
        }
        throw new Error('the service answered HTTP ' + res.status);
      }
      const text = res.body.toString('utf8');
      let ip = null;
      try { ip = JSON.parse(text).ip || null; } catch { }
      if (!ip) { const m = /\b((?:\d{1,3}\.){3}\d{1,3})\b/.exec(text); if (m) ip = m[1]; }
      if (!ip) throw new Error('no IP found in the answer');
      return { ok: true, ip, ms: Date.now() - t0, via };
    } catch (e) {
      return { ok: false, error: String(e.message || e), via };
    }
  });

  // ---------- free proxy pool ----------
  ipcMain.handle('ph:pool-status', () => pool.status());
  ipcMain.handle('ph:pool-refresh', () => pool.refresh({ force: true }));
  ipcMain.handle('ph:pool-regions', () => pool.regions());
  ipcMain.handle('ph:pool-rotate', (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!store.getWorkspace(wsId)) throw bad('no such workspace');
    return pool.rotate(wsId);
  });
  ipcMain.handle('ph:pool-heal', (_e, wsId) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    return pool.heal(wsId);
  });
  // real-page feedback: the renderer reports load outcomes per workspace so
  // the supervisor scores exits on actual browsing, not just probes
  ipcMain.handle('ph:pool-note-page', (_e, wsId, ok) => {
    if (!WS_ID.test(wsId || '')) return false;
    return pool.notePage(wsId, !!ok);
  });
  ipcMain.handle('ph:pool-bulk', () => pool.bulk());

  // proxy mode switch: 'direct' | 'auto' | 'custom' (custom is applied by the
  // normal ph:ws-set-proxy flow once the user fills the fields)
  ipcMain.handle('ph:ws-proxy-mode', async (_e, wsId, mode, region) => {
    if (!WS_ID.test(wsId || '')) throw bad('bad id');
    if (!store.getWorkspace(wsId)) throw bad('no such workspace');
    if (!['direct', 'auto'].includes(mode)) {
      // custom: just clear any pool marker so the manual fields own the route
      const ws = store.getWorkspace(wsId);
      if (ws && ws.proxy && ws.proxy.enabled) {
        const saved = store.setProxy(wsId, {
          enabled: true, scheme: ws.proxy.scheme, host: ws.proxy.host, port: ws.proxy.port,
          username: ws.proxy.username, keepPassword: true, bypass: ws.proxy.bypass,
          mode: 'custom'
        });
        send('state-changed', { reason: 'ws-proxy', wsId });
        return saved;
      }
      return null;
    }
    if (mode === 'direct') {
      const saved = store.setProxy(wsId, { enabled: false });
      try { await applyWorkspaceProxy(wsId, session.fromPartition('persist:' + wsId)); } catch { }
      send('state-changed', { reason: 'ws-proxy', wsId });
      send('proxy-applied', { wsId, proxy: saved });
      return saved;
    }
    return pool.assign(wsId, { region: typeof region === 'string' ? region.slice(0, 8) : 'any' });
  });

  // ---------- built-in extensions ----------
  ipcMain.handle('ph:ext-list', () => extensions.list());

  ipcMain.handle('ph:ext-set-enabled', (_e, id, on) => {
    const ok = extensions.setEnabled(String(id || '').slice(0, 40), !!on);
    if (!ok) throw bad('unknown extension');
    return extensions.list();
  });

  // Ad Shield config: level presets + per-site overrides
  ipcMain.handle('ph:ext-set-config', (_e, cfg) => {
    if (!cfg || typeof cfg !== 'object') throw bad('bad config');
    const ok = extensions.setConfig(cfg);
    if (!ok) throw bad('bad adshield config');
    return extensions.getConfig();
  });

  ipcMain.handle('ph:ext-get-config', () => extensions.getConfig());

  ipcMain.handle('ph:ads-count', () => extensions.adsCounts());

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
    if (typeof patch.uiScale === 'string') out.uiScale = ['compact', 'normal', 'large'].includes(patch.uiScale) ? patch.uiScale : 'normal';
    if (typeof patch.tileSize === 'string') out.tileSize = ['small', 'normal', 'large'].includes(patch.tileSize) ? patch.tileSize : 'normal';
    if (patch.wsAnim != null) out.wsAnim = !!patch.wsAnim;
    if (typeof patch.adshieldLevel === 'string') out.adshieldLevel = ['basic', 'standard', 'strict'].includes(patch.adshieldLevel) ? patch.adshieldLevel : 'standard';
    if (patch.poolAutoNewWorkspaces != null) out.poolAutoNewWorkspaces = !!patch.poolAutoNewWorkspaces;
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
  ipcMain.handle('ph:app-fullscreen', () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      w.setFullScreen(!w.isFullScreen());
      return w.isFullScreen();
    }
    return false;
  });

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
