// Pigeonhole - native menus: the application menu (accelerators forward actions
// to the chrome renderer) and the right-click menu inside web pages.
const { Menu, MenuItem, clipboard, app } = require('electron');
const { store } = require('./store');
const { extEnabled, effectiveLevelFor, setSiteLevel } = require('./extensions');

const SEARCH_URLS = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q='
};

function send(getWindow, payload) {
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send('ph-event', { type: 'shortcut', payload });
}

function buildAppMenu(getWindow) {
  const S = (label, action, accelerator, enabled = true) => ({
    label, accelerator, enabled,
    click: () => send(getWindow, { action })
  });

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'Pigeonhole',
      submenu: [
        { label: 'About Pigeonhole', click: () => send(getWindow, { action: 'about' }) },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send(getWindow, { action: 'settings' }) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: '&File',
      submenu: [
        S('&New Tab', 'new-tab', 'CmdOrCtrl+T'),
        S('New &Workspace', 'new-workspace', 'CmdOrCtrl+Shift+N'),
        S('&Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        { type: 'separator' },
        S('&Settings', 'settings', 'CmdOrCtrl+,'),
        ...(process.platform !== 'darwin' ? [{ role: 'quit' }] : [])
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        S('&Find…', 'find', 'CmdOrCtrl+F')
      ]
    },
    {
      label: '&View',
      submenu: [
        S('&Back', 'back', 'Alt+Left'),
        S('&Forward', 'forward', 'Alt+Right'),
        S('&Reload', 'reload', 'CmdOrCtrl+R'),
        { type: 'separator' },
        S('Zoom &In', 'zoom-in', 'CmdOrCtrl+Plus'),
        S('Zoom &Out', 'zoom-out', 'CmdOrCtrl+-'),
        S('Zoom &Reset', 'zoom-reset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        S('Toggle &Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        S('&Extensions panel', 'ext-panel', 'CmdOrCtrl+Shift+E'),
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Check for updates…', click: () => send(getWindow, { action: 'check-updates' }) },
        { type: 'separator' },
        { label: 'Documentation', click: () => send(getWindow, { action: 'docs' }) },
        { label: 'Email provider notes', click: () => send(getWindow, { action: 'docs-providers' }) },
        { label: 'Report an issue', click: () => send(getWindow, { action: 'issues' }) },
        { type: 'separator' },
        { label: 'About Pigeonhole', click: () => send(getWindow, { action: 'about' }) }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildGuestMenu(win, wc, params) {
  const go = (action, extra = {}) => {
    win.webContents.send('ph-event', { type: 'shortcut', payload: { action, ...extra } });
  };
  const openTab = (url) => {
    const partition = wc.session ? (wc.session.partition || '') : '';
    const wsId = partition.startsWith('persist:ws-') ? partition.slice('persist:'.length) : null;
    win.webContents.send('ph-event', { type: 'open-tab', payload: { wsId, url } });
  };

  const menu = new Menu();

  const nav = (label, fn, enabled) => menu.append(new MenuItem({ label, enabled, click: fn }));
  let canBack = false, canFwd = false;
  try {
    if (wc.navigationHistory) { canBack = wc.navigationHistory.canGoBack?.() ?? wc.canGoBack(); canFwd = wc.navigationHistory.canGoForward?.() ?? wc.canGoForward(); }
    else { canBack = wc.canGoBack?.(); canFwd = wc.canGoForward?.(); }
  } catch { }
  nav('Back', () => wc.navigationHistory?.goBack?.() ?? wc.goBack?.(), !!canBack);
  nav('Forward', () => wc.navigationHistory?.goForward?.() ?? wc.goForward?.(), !!canFwd);
  nav('Reload', () => wc.reload(), true);
  menu.append(new MenuItem({ type: 'separator' }));

  // Spell Check extension: corrections for the misspelled word under the cursor.
  // (The chrome's own inputs get the same treatment through this menu.)
  if (params.misspelledWord && extEnabled('spellcheck')) {
    const word = String(params.misspelledWord);
    const sugg = (params.dictionarySuggestions || []).slice(0, 5);
    for (const s of sugg) {
      menu.append(new MenuItem({ label: s, click: () => { try { wc.replaceMisspelling(s); } catch { } } }));
    }
    if (!sugg.length) menu.append(new MenuItem({ label: `No suggestions for “${word.slice(0, 24)}”`, enabled: false }));
    menu.append(new MenuItem({
      label: `Add “${word.slice(0, 24)}” to dictionary`,
      click: () => { try { wc.session.addWordToSpellCheckerDictionary(word); } catch { } }
    }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    menu.append(new MenuItem({ label: 'Open link in new tab', click: () => openTab(params.linkURL) }));
    menu.append(new MenuItem({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.mediaType === 'image' && params.srcURL) {
    menu.append(new MenuItem({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) }));
    menu.append(new MenuItem({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) }));
    menu.append(new MenuItem({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.isEditable && params.editFlags) {
    const ef = params.editFlags;
    if (ef.canCut) menu.append(new MenuItem({ label: 'Cut', role: 'cut' }));
    if (ef.canCopy) menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    if (ef.canPaste) menu.append(new MenuItem({ label: 'Paste', role: 'paste' }));
    if (ef.canSelectAll) menu.append(new MenuItem({ label: 'Select all', role: 'selectAll' }));
  } else if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim();
    menu.append(new MenuItem({ label: 'Copy', click: () => clipboard.writeText(text) }));
    const engine = SEARCH_URLS[store.state.settings.searchEngine] || SEARCH_URLS.google;
    const q = text.slice(0, 80);
    menu.append(new MenuItem({ label: `Search ${store.state.settings.searchEngine === 'duckduckgo' ? 'DuckDuckGo' : store.state.settings.searchEngine === 'bing' ? 'Bing' : 'Google'} for “${q.length > 24 ? q.slice(0, 24) + '…' : q}”`, click: () => openTab(engine + encodeURIComponent(text)) }));
  }

  if (params.isEditable || (params.selectionText && params.selectionText.trim())) {
    menu.append(new MenuItem({ type: 'separator' }));
  }

  // Ad Shield per-site control: right on the page being looked at.
  let pageOrigin = null;
  try { const u = new URL(wc.getURL()); if (/^https?:$/.test(u.protocol)) pageOrigin = u.origin; } catch { }
  if (pageOrigin && extEnabled('adshield')) {
    const lvl = effectiveLevelFor(pageOrigin);
    const on = lvl !== 'off';
    menu.append(new MenuItem({
      type: 'checkbox',
      label: 'Block ads on this site',
      checked: on,
      click: () => setSiteLevel(pageOrigin, on ? 'off' : null)
    }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  menu.append(new MenuItem({
    label: 'Inspect element',
    click: () => { try { wc.inspectElement(params.x, params.y); } catch { } }
  }));

  menu.popup({ window: win });
}

module.exports = { buildAppMenu, buildGuestMenu };
