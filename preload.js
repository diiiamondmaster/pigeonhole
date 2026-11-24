// Pigeonhole - preload. The only bridge between the chrome renderer and the
// main process. contextIsolation stays on; no Node lands in the renderer.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('pigeonhole', {
  state: () => invoke('ph:state'),
  workspaces: {
    create: (opts) => invoke('ph:ws-create', opts),
    duplicate: (wsId) => invoke('ph:ws-duplicate', wsId),
    remove: (wsId) => invoke('ph:ws-remove', wsId),
    rename: (wsId, name) => invoke('ph:ws-rename', wsId, name),
    setHue: (wsId, hue) => invoke('ph:ws-set-hue', wsId, hue),
    clearData: (wsId) => invoke('ph:ws-clear-data', wsId)
  },
  tabs: { save: (wsId, tabs) => invoke('ph:tabs-save', wsId, tabs) },
  history: { add: (wsId, entry) => invoke('ph:history-add', wsId, entry) },
  settings: {
    set: (patch) => invoke('ph:settings-set', patch),
    setSharedPassword: (pw) => invoke('ph:settings-set-shared-password', pw)
  },
  vault: {
    setIdentity: (wsId, identity) => invoke('ph:vault-set-identity', wsId, identity),
    updateIdentity: (wsId, patch) => invoke('ph:vault-update-identity', wsId, patch),
    accounts: (wsId) => invoke('ph:vault-accounts', wsId),
    addAccount: (wsId, acct) => invoke('ph:vault-add-account', wsId, acct),
    removeAccount: (wsId, origin, email) => invoke('ph:vault-remove-account', wsId, origin, email),
    secret: (wsId, which, ref) => invoke('ph:vault-secret', wsId, which, ref),
    exportVault: (wsId) => invoke('ph:vault-export', wsId)
  },
  ui: { set: (patch) => invoke('ph:ui-set', patch) },
  updates: {
    check: () => invoke('ph:update-check'),
    download: () => invoke('ph:update-download'),
    install: (mode) => invoke('ph:update-install', mode)
  },
  app: {
    open: (kind) => invoke('ph:app-open', kind),
    info: () => invoke('ph:app-info'),
    setTitle: (t) => invoke('ph:set-title', t),
    cancelDownload: (id) => invoke('ph:dl-cancel', id),
    showItem: (p) => invoke('ph:show-item', p),
    openDevTools: () => invoke('ph:open-devtools'),
    pickDownloadsDir: () => invoke('ph:pick-downloads-dir')
  },
  onEvent: (cb) => {
    ipcRenderer.on('ph-event', (_e, data) => { try { cb(data); } catch { } });
  },
  dev: { ready: () => invoke('ph:dev-ready') }
});
