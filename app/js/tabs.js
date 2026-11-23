// Tab engine + webview lifecycle.
// Every workspace gets a container div; every tab a <webview partition="persist:ws-…">
// so cookies, cache and storage never leak between workspaces. Tabs of inactive
// workspaces survive (elements stay alive, hidden), but after an app restart
// webviews are re-attached lazily - only when their workspace is first opened.
import { el, qs, debounce, originOf } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';

const NTP = (wsId) => `pigeonhole://newtab?ws=${wsId}`;

const containers = new Map();   // wsId -> {root, views: Map(tabId -> webview)}
const tabs = new Map();         // wsId -> [{id,url,title,favicon,active,loading,suspended,domReady,zoom}]

let tabSeq = 0;
const newTabId = () => 't' + Date.now().toString(36) + (tabSeq++).toString(36);

const persist = debounce((wsId) => {
  const list = (tabs.get(wsId) || []).map(t => ({ id: t.id, url: t.url, title: t.title, favicon: t.favicon, active: t.active }));
  PH().tabs.save(wsId, list);
}, 500);

// ---------- containers ----------
export function containerFor(wsId) { return containers.get(wsId); }

export function mountWorkspace(wsId) {
  if (containers.has(wsId)) return containers.get(wsId);
  const views = new Map();
  const root = el('div', { class: 'ws-view', 'data-ws': wsId });
  qs('#wsViews').append(root);
  const c = { root, views };
  containers.set(wsId, c);
  return c;
}

export function destroyWorkspace(wsId) {
  const c = containers.get(wsId);
  if (c) { c.root.remove(); containers.delete(wsId); }
  tabs.delete(wsId);
}

// ---------- restore / boot ----------
export function restoreWorkspace(wsId, storedTabs, { lazy = false } = {}) {
  mountWorkspace(wsId);
  const list = (storedTabs || []).map(t => ({
    id: t.id || newTabId(), url: t.url || NTP(wsId), title: t.title || '',
    favicon: t.favicon || null, active: !!t.active, loading: false,
    suspended: true, domReady: false, zoom: 1
  }));
  if (!list.length) list.push(makeTab(wsId, { url: NTP(wsId), active: true }));
  tabs.set(wsId, list);
  if (!list.some(t => t.active)) list[0].active = true;
  if (!lazy) ensureWebviews(wsId);
  return list;
}

function makeTab(wsId, { url, active }) {
  return { id: newTabId(), url, title: '', favicon: null, active: !!active, loading: false, suspended: false, domReady: false, zoom: 1 };
}

// ---------- webviews ----------
export function ensureWebviews(wsId) {
  const c = containers.get(wsId);
  if (!c) return;
  for (const t of tabs.get(wsId) || []) {
    if (!c.views.has(t.id)) {
      t.suspended = false;
      c.views.set(t.id, buildWebview(wsId, t));
      if (t.active) syncViewVisibility(wsId);
    }
  }
  syncViewVisibility(wsId);
}

function buildWebview(wsId, tab) {
  const wv = el('webview', {
    partition: 'persist:' + wsId,
    'data-tab': tab.id
  });
  wv.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no');
  // src after partition - order matters for partition to apply
  wv.setAttribute('src', tab.url || NTP(wsId));

  wv.addEventListener('dom-ready', () => {
    tab.domReady = true;
    bus.emit('page-dom-ready', { wsId, tabId: tab.id, tab, wv });
  });
  wv.addEventListener('did-navigate', () => {
    const prev = tab.url;
    const url = safeUrl(wv);
    tab.url = url;
    tab.lastError = null;
    if (/^pigeonhole:\/\//i.test(url)) {
      // internal pages: not history
    } else {
      PH().history.add(wsId, { url, title: tab.title });
      S.refreshLocal?.();
    }
    bus.emit('page-nav', { wsId, tabId: tab.id, tab, wv, url, prev });
    render(wsId);
    if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab });
  });
  wv.addEventListener('did-navigate-in-page', () => {
    const url = safeUrl(wv);
    if (url !== tab.url) {
      tab.url = url;
      bus.emit('page-nav', { wsId, tabId: tab.id, tab, wv, url, prev: null, inPage: true });
      if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab });
      render(wsId);
    }
  });
  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || tab.title;
    render(wsId);
    if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab });
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    const f = (e.favicons || []).find(u => /^(data|https?):/.test(u || ''));
    if (f && f !== tab.favicon) { tab.favicon = f; render(wsId); }
  });
  wv.addEventListener('did-start-loading', () => { tab.loading = true; render(wsId); if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab }); });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; render(wsId); if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab }); });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return;
    if (e.errorCode === -3) return; // aborted
    const target = tab.url || safeUrl(wv);
    tab.lastError = { code: e.errorCode, desc: e.errorDescription };
    const q = `pigeonhole://error?code=${encodeURIComponent(e.errorCode)}&desc=${encodeURIComponent(e.errorDescription || '')}&url=${encodeURIComponent(target)}`;
    try { wv.loadURL(q); } catch { wv.setAttribute('src', q); }
  });
  wv.addEventListener('found-in-page', (e) => bus.emit('find-result', e));
  wv.addEventListener('enter-html-full-screen', () => document.getElementById('app').classList.add('page-fs'));
  wv.addEventListener('leave-html-full-screen', () => document.getElementById('app').classList.remove('page-fs'));

  const c = containers.get(wsId);
  c.root.append(wv);
  return wv;
}

function safeUrl(wv) {
  try { return wv.getURL() || ''; } catch { return ''; }
}

function syncViewVisibility(wsId) {
  const c = containers.get(wsId);
  if (!c) return;
  for (const t of tabs.get(wsId) || []) {
    const wv = c.views.get(t.id);
    if (wv) wv.style.display = (t.active && !t.suspended) ? '' : 'none';
  }
}

// ---------- tab CRUD ----------
export function list(wsId) { return tabs.get(wsId) || []; }
export function currentTab(wsId) {
  const l = tabs.get(S.getActiveWsId() === wsId ? wsId : wsId) || [];
  return l.find(t => t.active) || l[0] || null;
}
const isActiveTab = (wsId, tab) => S.getActiveWsId() === wsId && tab.active;

export function createTab(wsId, { url = NTP(wsId), active = true, render: doRender = true } = {}) {
  mountWorkspace(wsId);
  const t = makeTab(wsId, { url, active });
  const l = tabs.get(wsId) || tabs.set(wsId, []).get(wsId);
  if (active) l.forEach(x => x.active = false);
  l.push(t);
  ensureWebviews(wsId);
  if (active) {
    activateTab(wsId, t.id, { render: false });
  } else syncViewVisibility(wsId);
  if (doRender) render(wsId);
  persist(wsId);
  return t;
}

export function closeTab(wsId, tabId) {
  const l = tabs.get(wsId) || [];
  const i = l.findIndex(t => t.id === tabId);
  if (i === -1) return;
  const [closed] = l.splice(i, 1);
  const c = containers.get(wsId);
  const wv = c?.views.get(tabId);
  if (wv) { try { wv.remove(); } catch { } c.views.delete(tabId); }
  if (!l.length) {
    createTab(wsId, { url: NTP(wsId), active: true, render: false });
  } else if (closed.active) {
    const next = l[Math.min(i, l.length - 1)];
    activateTab(wsId, next.id, { render: false });
  } else {
    syncViewVisibility(wsId);
  }
  render(wsId);
  persist(wsId);
}

export function activateTab(wsId, tabId, { render: doRender = true } = {}) {
  const l = tabs.get(wsId) || [];
  const t = l.find(x => x.id === tabId);
  if (!t) return;
  l.forEach(x => x.active = x.id === tabId);
  if (t.suspended) {
    const c = containers.get(wsId);
    if (!c.views.has(t.id)) { c.views.set(t.id, buildWebview(wsId, t)); }
    t.suspended = false;
  }
  syncViewVisibility(wsId);
  if (doRender) render(wsId);
  bus.emit('tab-activated', { wsId, tab });
  bus.emit('active-tab-updated', { wsId, tab: t });
  persist(wsId);
}

export function navigate(wsId, url) {
  const t = currentTab(wsId);
  if (!t) return createTab(wsId, { url, active: true });
  const c = containers.get(wsId);
  let wv = c?.views.get(t.id);
  if (!wv) { ensureWebviews(wsId); wv = c?.views.get(t.id); }
  t.url = url; t.lastError = null;
  try { wv.loadURL(url); } catch { wv?.setAttribute('src', url); }
  render(wsId);
  persist(wsId);
  return t;
}

export function goBack(wsId) { try { webviewOf(wsId)?.goBack(); } catch { } }
export function goForward(wsId) { try { webviewOf(wsId)?.goForward(); } catch { } }
export function reload(wsId) { try { webviewOf(wsId)?.reload(); } catch { } }
export function canGoBack(wsId) { try { return !!webviewOf(wsId)?.canGoBack(); } catch { return false; } }
export function canGoForward(wsId) { try { return !!webviewOf(wsId)?.canGoForward(); } catch { return false; } }

export function webviewOf(wsId, tab = currentTab(wsId)) {
  const c = containers.get(wsId);
  return (tab && c?.views.get(tab.id)) || null;
}

export function setZoom(wsId, z) {
  const t = currentTab(wsId); const wv = webviewOf(wsId, t);
  if (!t || !wv) return;
  t.zoom = Math.max(0.5, Math.min(2.4, z));
  try { wv.setZoomFactor(t.zoom); } catch { }
  bus.emit('zoom-changed', { wsId, zoom: t.zoom });
}

export function getZoom(wsId) { return currentTab(wsId)?.zoom || 1; }

// ---------- workspace switching ----------
export function switchWorkspace(wsId, { fromBoot = false } = {}) {
  if (!S.ws(wsId)) return;
  S.setActiveWsId(wsId);
  for (const [id, c] of containers) c.root.classList.toggle('active', id === wsId);
  // containers of workspaces never opened yet
  const w = S.ws(wsId);
  if (w && !containers.has(wsId)) restoreWorkspace(wsId, S.tabsFor(wsId), { lazy: false });
  else ensureWebviews(wsId);
  render(wsId);
  bus.emit('ws-activated', { wsId, fromBoot });
  bus.emit('tab-activated', { wsId, tab: currentTab(wsId) });
  bus.emit('active-tab-updated', { wsId, tab: currentTab(wsId) });
  PH().ui.set({ activeWsId: wsId });
}

// ---------- tab strip rendering ----------
export function render(wsId) {
  const strip = qs('#tabstrip');
  const l = tabs.get(wsId) || [];
  strip.replaceChildren();
  for (const t of l) {
    const fav = t.loading
      ? el('span', { class: 'spinner' })
      : (t.favicon
        ? el('span', { class: 'fav' }, el('img', { src: t.favicon, alt: '' }))
        : el('span', { class: 'fav', html: icon(t.url.startsWith('pigeonhole://') ? 'grid' : 'globe', 13) }));
    const tab = el('div', {
      class: `tab ${t.active ? 'active' : ''} ${t.loading ? 'loading' : ''} ${t.suspended ? 'suspended' : ''}`,
      role: 'tab', 'aria-selected': t.active ? 'true' : 'false',
      title: t.title || t.url,
      onclick: () => activateTab(wsId, t.id),
      onauxclick: (e) => { if (e.button === 1) closeTab(wsId, t.id); }
    },
      fav,
      el('span', { class: 'title', text: t.title || (t.url.startsWith('pigeonhole://newtab') ? 'New Tab' : t.url) }),
      el('span', {
        class: 'close', html: icon('close', 12), title: 'Close tab',
        onclick: (e) => { e.stopPropagation(); closeTab(wsId, t.id); }
      })
    );
    strip.append(tab);
  }
  strip.append(el('button', {
    class: 'newtab-btn', html: icon('plus', 16), title: 'New tab (Ctrl+T)',
    'aria-label': 'New tab', onclick: () => createTab(wsId, { url: NTP(wsId), active: true })
  }));
}

export function openInWorkspace(wsId, url, { focus = true } = {}) {
  if (!S.ws(wsId)) wsId = S.getActiveWsId();
  if (focus && wsId !== S.getActiveWsId()) switchWorkspace(wsId);
  createTab(wsId, { url, active: true });
}
