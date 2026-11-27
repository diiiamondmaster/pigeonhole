// Pigeonhole - persistent state store.
// Single JSON document at userData/pigeonhole-store.json, atomic + debounced writes.
// Secrets (email passwords, shared password) are encrypted at rest with
// Electron safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
// When OS-level encryption is unavailable the values fall back to plaintext and
// settings.vaultEncrypted is set to false so the UI can surface a warning.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_VERSION = 1;
const FILE = () => path.join(app.getPath('userData'), 'pigeonhole-store.json');

const HUES = [36, 12, 350, 320, 262, 220, 190, 160, 90, 45]; // amber, coral, red, magenta, violet, blue, cyan, green, lime, gold

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  identityMode: 'numbered',     // numbered | human | words | custom
  identityBase: '',
  identityPadding: 3,
  identityStart: 1,
  pwLength: 16,
  pwSymbols: true,
  sharedPassword: null,         // secret
  autoFillOnLoad: true,
  autoDetectSuccess: true,
  betaUpdates: false,            // update channel: false = stable only, true = include prereleases
  extensions: {                 // built-in extension toggles (Settings > Extensions)
    spellcheck: true,
    trackershield: true,
    videospeed: true,
    adshield: true,
    gconsent: true
  },
  adshield: {                   // Ad Shield: blocking level + per-site overrides
    level: 'standard',           // basic | standard | strict
    sites: {}                    // 'https://host' -> 'off' | 'basic' | 'standard' | 'strict'
  },
  uiScale: 'normal',             // compact | normal | large  (whole chrome zoom)
  tileSize: 'normal',            // small | normal | large     (sidebar workspace tiles)
  wsAnim: true,                  // fading switch trail on workspace tiles
  poolAutoNewWorkspaces: true,  // free pool: route new workspaces automatically
  vaultEncrypted: false,
  downloadsDir: ''
};

function defaultState() {
  return {
    version: STATE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    ui: { sidebarCollapsed: false, activeWsId: null },
    nextWsNum: 1,
    workspaces: [],             // {id,num,name,hue,identity,accounts,quickLinks,proxy,backups,createdAt,updatedAt,group}
    tabs: {},                   // wsId -> [{id,url,title,active,favicon,pinned}]
    history: {},                // wsId -> [{url,title,at}]
    // cross-device sync metadata (beta.7): every mutation stamps updatedAt,
    // deletions leave tombstones, and each store carries a device id
    sync: { deviceId: null, rev: 0 },
    deleted: {}                 // wsId -> removedAt (tombstone: never resurrect)
  };
}

class Store {
  constructor() {
    this.state = defaultState();
    this._saveTimer = null;
    this.encryptionAvailable = false;
  }

  load() {
    try {
      if (fs.existsSync(FILE())) {
        const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
        if (raw && typeof raw === 'object' && Array.isArray(raw.workspaces)) {
          this.state = { ...defaultState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
          // extension toggles merge per-key so older stores keep new defaults
          this.state.settings.extensions = { ...DEFAULT_SETTINGS.extensions, ...(raw.settings?.extensions || {}) };
          // 1.1.0-beta.2: History Guard was removed from the extension set
          delete this.state.settings.extensions.historyguard;
          // adshield config shape + appearance prefs normalize per-key
          const ds = DEFAULT_SETTINGS.adshield;
          this.state.settings.adshield = {
            level: ['basic', 'standard', 'strict'].includes(raw.settings?.adshield?.level) ? raw.settings.adshield.level : ds.level,
            sites: (raw.settings?.adshield?.sites && typeof raw.settings.adshield.sites === 'object') ? raw.settings.adshield.sites : {}
          };
          this.state.settings.uiScale = ['compact', 'normal', 'large'].includes(raw.settings?.uiScale) ? raw.settings.uiScale : 'normal';
          this.state.settings.tileSize = ['small', 'normal', 'large'].includes(raw.settings?.tileSize) ? raw.settings.tileSize : 'normal';
          this.state.settings.wsAnim = raw.settings?.wsAnim === undefined ? true : !!raw.settings.wsAnim;
          if (!this.state.ui) this.state.ui = defaultState().ui;
          if (!this.state.tabs) this.state.tabs = {};
          if (!this.state.history) this.state.history = {};
          // normalize entries so one malformed record cannot brick boot
          this.state.workspaces = this.state.workspaces.filter(w => w && typeof w === 'object' && typeof w.id === 'string')
            .map(w => ({ ...w, accounts: Array.isArray(w.accounts) ? w.accounts : [], quickLinks: Array.isArray(w.quickLinks) ? w.quickLinks : [], proxy: w.proxy && typeof w.proxy === 'object' ? w.proxy : null, backups: Array.isArray(w.backups) ? w.backups : [], disposable: undefined }));
          for (const w of this.state.workspaces) {
            if (!Array.isArray(this.state.tabs[w.id])) this.state.tabs[w.id] = [];
            if (!Array.isArray(this.state.history[w.id])) this.state.history[w.id] = [];
          }
        }
      }
    } catch (e) {
      console.error('[store] failed to load state, starting fresh:', e.message);
      this.state = defaultState();
    }
    try {
      this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    } catch { this.encryptionAvailable = false; }
    this.state.settings.vaultEncrypted = this.encryptionAvailable;
    // sync metadata backfill (existing stores upgrade in place)
    if (!this.state.sync || typeof this.state.sync !== 'object') this.state.sync = { deviceId: null, rev: 0 };
    if (!this.state.sync.deviceId) { this.state.sync.deviceId = 'dev-' + crypto.randomBytes(8).toString('hex'); this.save(); }
    this.state.sync.rev = Number(this.state.sync.rev) || 0;
    if (!this.state.deleted || typeof this.state.deleted !== 'object') this.state.deleted = {};
    for (const w of this.state.workspaces) {
      if (typeof w.updatedAt !== 'number') w.updatedAt = w.createdAt || Date.now();
    }
    this._migrate();
  }

  _migrate() {
    // future migrations keyed on this.state.version
    this.state.version = STATE_VERSION;
  }

  // ---------- secrets ----------
  encryptSecret(plain) {
    if (plain == null || plain === '') return null;
    if (!this.encryptionAvailable) return { v: String(plain) };
    try {
      return { v: safeStorage.encryptString(String(plain)).toString('base64'), e: 1 };
    } catch {
      return { v: String(plain) };
    }
  }
  decryptSecret(box) {
    if (!box || typeof box !== 'object') return null;
    try {
      if (box.e && typeof box.v === 'string') {
        if (!this.encryptionAvailable) return null;
        return safeStorage.decryptString(Buffer.from(box.v, 'base64'));
      }
      return typeof box.v === 'string' ? box.v : null;
    } catch { return null; }
  }

  // ---------- persistence ----------
  // sync: bump a workspace's merge clock. Called by every mutation path
  // (rename, proxy, vault, tabs, history, group, quick links...).
  touchWs(id) {
    const w = this.getWorkspace(id);
    if (w) w.updatedAt = Date.now();
  }
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.state.sync.rev = (Number(this.state.sync.rev) || 0) + 1;
      this._flush();
    }, 350);
  }
  _flush() {
    try {
      const file = FILE();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
    for (const fn of this._flushHooks) { try { fn(); } catch (e) { console.error('[store] flush hook:', e.message); } }
  }
  // observers of completed flushes (the sync writer listens here)
  onFlush(fn) {
    (this._flushHooks = this._flushHooks || []).push(fn);
    return () => { const i = this._flushHooks.indexOf(fn); if (i >= 0) this._flushHooks.splice(i, 1); };
  }
  flushNow() { if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; } this._flush(); }

  // ---------- workspaces ----------
  createWorkspace({ name = '', hue = null } = {}) {
    const id = 'ws-' + crypto.randomBytes(6).toString('hex');
    const num = this.state.nextWsNum++;
    const ws = {
      id, num,
      name: name || `Workspace ${num}`,
      hue: hue != null ? hue : HUES[(num - 1) % HUES.length],
      identity: null,   // {email,password(secret),displayName,provider,createdAt}
      accounts: [],      // [{origin,email,password(secret),title,createdAt,updatedAt}]
      quickLinks: [],
      proxy: null,       // {enabled,scheme,host,port,username,password(secret),bypass}
      group: null,       // sidebar group label (beta.7)
      createdAt: Date.now(),
      updatedAt: Date.now()   // sync clock: mutations bump this (LWW per workspace)
    };
    this.state.workspaces.push(ws);
    this.state.tabs[id] = [];
    this.state.history[id] = this.state.history[id] || [];
    this.save();
    return ws;
  }

  getWorkspace(id) { return this.state.workspaces.find(w => w.id === id) || null; }

  // ---------- per-workspace proxy ----------
  // cfg: {enabled, scheme:'http'|'socks5', host, port, username, password?, keepPassword?, bypass,
  //       mode?:'custom'|'auto', source?:'pool', country?, latencyMs?, assignedAt?, prefRegion?}
  // Pool-assigned exits carry source/mode/country/latency; manual saves come
  // through as plain 'custom' configs. A new non-empty password replaces the
  // stored one; keepPassword=true with an empty field retains it.
  setProxy(wsId, cfg) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    if (!cfg || !cfg.enabled) {
      ws.proxy = null;
    } else {
      const port = Number(cfg.port);
      const pool = (cfg.source === 'pool') || (cfg.mode === 'auto');
      ws.proxy = {
        enabled: true,
        scheme: cfg.scheme === 'socks5' ? 'socks5' : 'http',
        host: String(cfg.host || '').trim().slice(0, 200),
        port: Number.isFinite(port) ? Math.max(1, Math.min(65535, Math.round(port))) : 0,
        username: String(cfg.username ?? '').slice(0, 200),
        password: (typeof cfg.password === 'string' && cfg.password)
          ? this.encryptSecret(cfg.password)
          : (cfg.keepPassword ? (ws.proxy ? ws.proxy.password : null) : null),
        bypass: String(cfg.bypass ?? '').slice(0, 400),
        mode: pool ? 'auto' : 'custom',
        source: pool ? 'pool' : null,
        country: String(cfg.country || '').toUpperCase().slice(0, 2),
        latencyMs: Number.isFinite(Number(cfg.latencyMs)) ? Math.round(Number(cfg.latencyMs)) : 0,
        assignedAt: Number.isFinite(Number(cfg.assignedAt)) ? Number(cfg.assignedAt) : 0,
        prefRegion: String(cfg.prefRegion || 'any').slice(0, 8)
      };
    }
    this.save();
    return this.sanitizeProxy(ws.proxy);
  }
  sanitizeProxy(p) {
    if (!p) return null;
    return {
      enabled: !!p.enabled, scheme: p.scheme === 'socks5' ? 'socks5' : 'http',
      host: p.host || '', port: p.port || 0, username: p.username || '',
      hasPassword: !!p.password,
      bypass: p.bypass || '',
      mode: p.mode === 'auto' ? 'auto' : 'custom',
      source: p.source === 'pool' ? 'pool' : null,
      country: p.country || '', latencyMs: p.latencyMs || 0,
      prefRegion: p.prefRegion || 'any'
    };
  }

  deleteWorkspace(id) {
    const i = this.state.workspaces.findIndex(w => w.id === id);
    if (i === -1) return false;
    this.state.workspaces.splice(i, 1);
    delete this.state.tabs[id];
    delete this.state.history[id];
    // tombstone: a sync peer holding an older snapshot of this workspace
    // must not resurrect it ("never go backwards")
    this.state.deleted[id] = Date.now();
    if (this.state.ui.activeWsId === id) {
      this.state.ui.activeWsId = this.state.workspaces[0]?.id || null;
    }
    this._renumber();   // no gaps: remaining workspaces compact to 1..N
    this.save();
    return true;
  }

  // Reassign workspace numbers to the current array order (1..N) and park
  // the creation counter right after. Used after delete AND reorder so the
  // sidebar never shows stale numbering.
  _renumber() {
    this.state.workspaces.forEach((w, i) => { w.num = i + 1; });
    this.state.nextWsNum = this.state.workspaces.length + 1;
  }

  // Reorder by explicit id list. The list must be a permutation of exactly
  // the current workspace ids; anything else is rejected untouched.
  reorderWorkspaces(ids) {
    if (!Array.isArray(ids) || ids.length !== this.state.workspaces.length) return false;
    const byId = new Map(this.state.workspaces.map(w => [w.id, w]));
    if (ids.some(id => !byId.has(String(id)))) return false;
    this.state.workspaces = ids.map(id => byId.get(String(id)));
    this._renumber();
    this.save();
    return true;
  }

  // ---------- vault ----------
  setIdentity(wsId, { email, password, displayName = '', provider = '' }) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    ws.identity = {
      email: String(email || '').trim(),
      password: this.encryptSecret(password),
      displayName: String(displayName || '').trim(),
      provider: String(provider || ''),
      createdAt: ws.identity?.createdAt || Date.now()
    };
    if (!ws.name || /^Workspace \d+$/.test(ws.name)) {
      ws.name = String(email || `Workspace ${ws.num}`).split('@')[0];
    }
    this.touchWs(wsId);
    this.save();
    return this.sanitizeIdentity(ws.identity);
  }

  updateIdentity(wsId, patch) {
    const ws = this.getWorkspace(wsId);
    if (!ws || !ws.identity) return null;
    if (typeof patch.email === 'string' && patch.email.trim()) {
      ws.identity.email = patch.email.trim();
      if (/^Workspace \d+$/.test(ws.name)) ws.name = patch.email.split('@')[0];
    }
    if (typeof patch.displayName === 'string') ws.identity.displayName = patch.displayName.trim();
    if (typeof patch.provider === 'string') ws.identity.provider = patch.provider;
    if (typeof patch.password === 'string' && patch.password) ws.identity.password = this.encryptSecret(patch.password);
    this.touchWs(wsId);
    this.save();
    return this.sanitizeIdentity(ws.identity);
  }

  sanitizeIdentity(identity) {
    if (!identity) return null;
    return {
      email: identity.email,
      displayName: identity.displayName,
      provider: identity.provider,
      createdAt: identity.createdAt,
      hasPassword: !!identity.password
    };
  }

  upsertAccount(wsId, { origin, email, password, title = '' }) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return null;
    const o = String(origin || '').replace(/\/+$/, '');
    const existing = ws.accounts.find(a => a.origin === o && a.email === email);
    if (existing) {
      existing.password = this.encryptSecret(password);
      existing.title = title || existing.title;
      existing.updatedAt = Date.now();
    } else {
      ws.accounts.push({
        origin: o, email: String(email || ''), password: this.encryptSecret(password),
        title: String(title || ''), createdAt: Date.now(), updatedAt: Date.now()
      });
    }
    this.touchWs(wsId);
    this.save();
    return true;
  }

  removeAccount(wsId, origin, email) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return false;
    const o = String(origin || '').replace(/\/+$/, '');
    const i = ws.accounts.findIndex(a => a.origin === o && a.email === email);
    if (i === -1) return false;
    ws.accounts.splice(i, 1);
    this.touchWs(wsId);
    this.save();
    return true;
  }

  listAccounts(wsId) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return [];
    return ws.accounts.map(a => ({
      origin: a.origin, email: a.email, title: a.title, createdAt: a.createdAt, updatedAt: a.updatedAt
    }));
  }

  // ---------- tabs & history ----------
  saveTabs(wsId, tabs) {
    if (!this.getWorkspace(wsId)) return;
    const clean = (Array.isArray(tabs) ? tabs : []).filter(t => t && typeof t.url === 'string').map(t => ({
      id: String(t.id), url: t.url, title: String(t.title || ''), active: !!t.active, pinned: !!t.pinned,
      favicon: typeof t.favicon === 'string' ? t.favicon.slice(0, 200000) : null
    }));
    this.state.tabs[wsId] = clean;
    this.touchWs(wsId);
    this.save();
  }
  getTabs(wsId) { return this.state.tabs[wsId] || []; }
  addHistory(wsId, { url, title }) {
    if (!this.getWorkspace(wsId)) return;
    if (!/^https?:/i.test(url || '')) return;
    const h = this.state.history[wsId] = this.state.history[wsId] || [];
    const last = h[h.length - 1];
    if (last && last.url === url) { last.title = title || last.title; return; }
    h.push({ url, title: String(title || ''), at: Date.now() });
    if (h.length > 400) h.splice(0, h.length - 400);
    this.touchWs(wsId);
    this.save();
  }
  getHistory(wsId) { return (this.state.history[wsId] || []).slice(-40).reverse(); }

  // ---------- settings ----------
  setSettings(patch) {
    const allowed = ['searchEngine', 'identityMode', 'identityBase', 'identityPadding', 'identityStart',
      'pwLength', 'pwSymbols', 'autoFillOnLoad', 'autoDetectSuccess', 'betaUpdates', 'downloadsDir',
      'uiScale', 'tileSize', 'wsAnim'];
    for (const k of allowed) {
      if (k in patch) this.state.settings[k] = patch[k];
    }
    if (typeof patch.adshieldLevel === 'string' && ['basic', 'standard', 'strict'].includes(patch.adshieldLevel)) {
      this.state.settings.adshield.level = patch.adshieldLevel;
    }
    this.state.settings.updatedAt = Date.now();   // sync clock for settings (LWW)
    this.save();
    return this.getSettings();
  }
  getSettings() {
    const s = this.state.settings;
    return {
      searchEngine: s.searchEngine, identityMode: s.identityMode, identityBase: s.identityBase,
      identityPadding: s.identityPadding, identityStart: s.identityStart, pwLength: s.pwLength,
      pwSymbols: s.pwSymbols, autoFillOnLoad: s.autoFillOnLoad, autoDetectSuccess: s.autoDetectSuccess,
      betaUpdates: !!s.betaUpdates, vaultEncrypted: s.vaultEncrypted, downloadsDir: s.downloadsDir, hasSharedPassword: !!s.sharedPassword,
      uiScale: s.uiScale, tileSize: s.tileSize, wsAnim: !!s.wsAnim,
      adshield: { level: s.adshield.level, sites: { ...s.adshield.sites } }
    };
  }
  setSharedPassword(pw) {
    this.state.settings.sharedPassword = pw ? this.encryptSecret(pw) : null;
    this.save();
  }
  getSharedPassword() { return this.decryptSecret(this.state.settings.sharedPassword); }

  // ---------- ui ----------
  setUi(patch) {
    Object.assign(this.state.ui, patch || {});
    this.save();
  }

  // sidebar group label (beta.7): null = ungrouped
  setGroup(wsId, group) {
    const ws = this.getWorkspace(wsId);
    if (!ws) return false;
    const g = (group == null || !String(group).trim()) ? null : String(group).trim().slice(0, 40);
    if (ws.group === g) return false;
    ws.group = g;
    this.touchWs(wsId);
    this.save();
    return true;
  }

  // snapshot for renderer (no secrets)
  snapshot() {
    return {
      settings: this.getSettings(),
      ui: { ...this.state.ui },
      workspaces: this.state.workspaces.map(w => ({
        id: w.id, num: w.num, name: w.name, hue: w.hue,
        identity: this.sanitizeIdentity(w.identity),
        backups: (w.backups || []).map(b => ({
          name: String(b.name || '').slice(0, 200), bytes: Number(b.bytes) || 0,
          capturedAt: Number(b.capturedAt) || 0, source: b.source === 'legacy' ? 'legacy' : 'download',
          provider: String(b.provider || '').slice(0, 60)
        })),
        accountCount: w.accounts.length,
        quickLinks: w.quickLinks || [],
        proxy: this.sanitizeProxy(w.proxy),
        group: w.group || null,
        updatedAt: w.updatedAt || w.createdAt || 0,
        createdAt: w.createdAt
      })),
      tabs: Object.fromEntries(Object.entries(this.state.tabs).map(([k, v]) => [k, v])),
      history: Object.fromEntries(Object.entries(this.state.history).map(([k, v]) => [k, v.slice(-40).reverse()]))
    };
  }
}

module.exports = { store: new Store(), HUES };
