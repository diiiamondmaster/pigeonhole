// Pigeonhole - main process.
// One window. Every workspace is an isolated Chromium session (its own partition:
// cookies, cache, storage). This process owns the store, IPC, menus, downloads,
// the internal pigeonhole:// protocol and the screenshot harness used in dev.
const { app, BrowserWindow, protocol, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// The internal protocol must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pigeonhole', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }
]);

const { store } = require('./store');
const { registerIpc } = require('./ipc');
const { buildAppMenu, buildGuestMenu } = require('./menus');
const { attachDownloadHandlers, initDownloads } = require('./downloads');
const { registerProtocol } = require('./protocol');

const IS_DEV = !!process.env.PH_DEV || !!process.argv.includes('--dev');
let mainWindow = null;

// ---- single instance ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// ---- webview / window-open policy ----
const VALID_WS = /^[a-zA-Z0-9-]{1,40}$/;

function isGuestOf(wc) {
  try { return wc.getType() === 'webview'; } catch { return false; }
}

function sessionForPartition(partition) {
  const ses = session.fromPartition(partition);
  attachDownloadHandlers(ses);
  return ses;
}

app.on('web-contents-created', (_ev, wc) => {
  if (!isGuestOf(wc)) return;

  // window.open / target=_blank  ->  a new tab in the same workspace
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url || '') && mainWindow && !mainWindow.isDestroyed()) {
      const partition = wc.session ? (wc.session.partition || '') : '';
      const wsId = partition.startsWith('persist:ws-') ? partition.slice('persist:'.length) : null;
      mainWindow.webContents.send('ph-event', { type: 'open-tab', payload: { wsId, url } });
    }
    return { action: 'deny' };
  });

  // keyboard shortcuts while focus is inside a page
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const act = mapShortcut(input);
    if (act && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ph-event', { type: 'shortcut', payload: act });
      e.preventDefault();
    }
  });

  // right-click menu
  wc.on('context-menu', (e, params) => {
    if (mainWindow && !mainWindow.isDestroyed()) buildGuestMenu(mainWindow, wc, params);
  });
});

function mapShortcut(input) {
  const c = input.control || input.meta, a = input.alt, s = input.shift;
  const k = (input.key || '').toLowerCase();
  if (c && !a && k === 't') return { action: 'new-tab' };
  if (c && !a && k === 'w') return { action: 'close-tab' };
  if (c && !a && k === 'l') return { action: 'focus-address' };
  if (c && !a && k === 'r') return { action: 'reload' };
  if (!c && !a && k === 'f5') return { action: 'reload' };
  if (c && !a && k === 'f') return { action: 'find' };
  if (c && a && k === 'i') return { action: 'devtools-guest' };
  if (c && s && k === 'i') return { action: 'devtools' };
  if (c && !a && k === 'tab') return { action: s ? 'prev-tab' : 'next-tab' };
  if (c && !a && k === '0') return { action: 'zoom-reset' };
  if (c && !a && (k === '+' || k === '=')) return { action: 'zoom-in' };
  if (c && !a && k === '-') return { action: 'zoom-out' };
  if (a && !c && (k === 'arrowleft')) return { action: 'back' };
  if (a && !c && (k === 'arrowright')) return { action: 'forward' };
  if (a && !c && k === 'home') return { action: 'home' };
  if (a && !c && /^[0-9]$/.test(k)) return { action: 'ws-switch', n: Number(k) === 0 ? 10 : Number(k) };
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#14171c',
    title: 'Pigeonhole',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true
    }
  });

  // The chrome itself never opens child windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('context-menu', (e, params) => {
    // native edit menu for our own chrome inputs
    if (params.isEditable) buildGuestMenu(mainWindow, mainWindow.webContents, { ...params, linkURL: '', srcURL: '', mediaType: 'none' });
  });

  // Defense in depth: sanitize every webview before it attaches.
  mainWindow.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    if (!/^persist:ws-[a-zA-Z0-9-]{1,40}$/.test(params.partition || '')) {
      params.partition = 'persist:ws-_unknown';
    }
  });

  if (!IS_DEV) mainWindow.removeMenu();

  mainWindow.loadFile(path.join(__dirname, '..', 'app', 'index.html'));

  mainWindow.on('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // ---- dev screenshot harness: electron . --shot=out.png --wait=3000 [--scene=wizard] ----
  const shotArg = process.argv.find(a => a.startsWith('--shot='));
  if (shotArg) {
    const out = shotArg.slice(7);
    const wait = Number((process.argv.find(a => a.startsWith('--wait=')) || '--wait=3000').slice(7)) || 3000;
    const scene = (process.argv.find(a => a.startsWith('--scene=')) || '').slice(8) || null;
    const capture = async () => {
      try {
        await new Promise(r => setTimeout(r, wait));
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
        console.log('[shot] saved ' + out);
      } catch (e) { console.error('[shot] failed', e); }
      store.flushNow();
      app.exit(0);
    };
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (global.__phReady) {
        clearInterval(iv);
        if (scene && mainWindow) mainWindow.webContents.send('ph-event', { type: 'scene', payload: { name: scene } });
        setTimeout(capture, 700);
      } else if (Date.now() - t0 > 25000) { clearInterval(iv); capture(); }
    }, 200);
  }
}

// ---- app lifecycle ----
app.whenReady().then(() => {
  app.commandLine.appendSwitch('disable-features', 'PlzDedicatedThreadForImageDecoding'); // keep default otherwise
  store.load();

  if (process.argv.includes('--demo')) seedDemo();

  registerProtocol(store);
  registerIpc(() => mainWindow, sessionForPartition, store);
  initDownloads(() => mainWindow);
  if (!IS_DEV || process.env.PH_MENU !== '0') buildAppMenu(() => mainWindow);

  // make sure every existing workspace session gets download handling
  for (const w of store.state.workspaces) sessionForPartition('persist:' + w.id);

  createWindow();
});

app.on('window-all-closed', () => {
  store.flushNow();
  app.quit();
});

app.on('before-quit', () => store.flushNow());

// External links never open inside the browser chrome.
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// ---- dev-only demo seeding ----
function seedDemo() {
  const s = store.state;
  s.workspaces = []; s.tabs = {}; s.history = {}; s.nextWsNum = 1; s.ui.activeWsId = null;
  const mk = (email, name, links) => {
    const ws = store.createWorkspace({});
    store.setIdentity(ws.id, { email, password: 'demo-password-123', displayName: name, provider: 'Proton Mail' });
    store.saveTabs(ws.id, links.map((l, i) => ({
      id: 't' + ws.num + i, url: l.url, title: l.title, active: i === 0, favicon: null
    })));
    return ws;
  };
  const w1 = mk('marcus.hayden001@proton.me', 'Marcus Hayden', [
    { url: 'https://example.com/', title: 'Example Domain' },
    { url: 'pigeonhole://newtab', title: 'New Tab' }
  ]);
  mk('marcus.hayden002@proton.me', 'Marcus Hayden', [
    { url: 'https://example.com/', title: 'Example Domain' }
  ]);
  mk('ottersprout4410@tuta.com', 'Otter Sprout', [
    { url: 'pigeonhole://newtab', title: 'New Tab' }
  ]);
  mk('quietfawn2207@mailfence.com', 'Quiet Fawn', []);
  s.ui.activeWsId = w1.id;
  store.flushNow();
  console.log('[demo] seeded 4 demo workspaces');
}
