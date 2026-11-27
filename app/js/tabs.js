// Tab engine + webview lifecycle.
// Every workspace gets a container div; every tab a <webview partition="persist:ws-…">
// so cookies, cache and storage never leak between workspaces. Tabs of inactive
// workspaces survive (elements stay alive, hidden), but after an app restart
// webviews are re-attached lazily - only when their workspace is first opened.
import { el, qs, debounce, originOf } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import { showMenu } from './ctxmenu.js';
import { toast } from './toasts.js';

const NTP = (wsId) => `pigeonhole://newtab?ws=${wsId}`;

// keep the address-bar suggestions fresh without hammering IPC on every title change
const refreshSoon = debounce(() => { S.refresh().then(() => bus.emit('history-refreshed')); }, 900);

const containers = new Map();   // wsId -> {root, views: Map(tabId -> webview)}
const tabs = new Map();         // wsId -> [{id,url,title,favicon,active,loading,suspended,domReady,zoom}]

let tabSeq = 0;
const newTabId = () => 't' + Date.now().toString(36) + (tabSeq++).toString(36);

// per-workspace debounce: a single shared timer would let a change in
// workspace B CANCEL workspace A's still-pending save (rapid multi-workspace
// switching left stale tab lists in the store - and duplicate-workspace
// copied them). One timer per workspace id instead.
const persistTimers = new Map();
const persist = (wsId) => {
  clearTimeout(persistTimers.get(wsId));
  persistTimers.set(wsId, setTimeout(() => {
    persistTimers.delete(wsId);
    const list = (tabs.get(wsId) || []).map(t => ({ id: t.id, url: t.url, title: t.title, favicon: t.favicon, active: t.active, pinned: !!t.pinned }));
    PH().tabs.save(wsId, list);
  }, 500));
};

// closed-tab stack (beta.7): Ctrl+Shift+T and the tab menu's "recently
// closed" list draw from here. Internal pages are not worth reopening.
const closedStacks = new Map();   // wsId -> [{url,title,favicon,pinned}]
const CLOSED_CAP = 10;
function rememberClosed(wsId, t) {
  if (!t || !/^https?:/i.test(t.url || '')) return;
  const st = closedStacks.get(wsId) || closedStacks.set(wsId, []).get(wsId);
  st.unshift({ url: t.url, title: t.title || '', favicon: t.favicon || null, pinned: !!t.pinned });
  if (st.length > CLOSED_CAP) st.length = CLOSED_CAP;
}
export function closedList(wsId) { return (closedStacks.get(wsId) || []).slice(0, CLOSED_CAP); }
export function undoClose(wsId) {
  const st = closedStacks.get(wsId) || [];
  const item = st.shift();
  if (!item) return null;
  const t = createTab(wsId, { url: item.url, active: true });
  t.title = item.title || '';
  t.favicon = item.favicon || null;
  render(wsId);
  return t;
}

// ---------- containers ----------
export function containerFor(wsId) { return containers.get(wsId); }

export function mountWorkspace(wsId) {
  if (containers.has(wsId)) return containers.get(wsId);
  const views = new Map();
  const root = el('div', {
    class: `ws-view ${S.getActiveWsId() === wsId ? 'active' : ''}`,
    'data-ws': wsId
  });
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
    id: t.id || newTabId(),
    // NTP tabs are always re-pointed at this workspace so the page gets the right data
    url: !t.url || /^pigeonhole:\/\/newtab/.test(t.url) ? NTP(wsId) : t.url,
    title: t.title || '',
    favicon: t.favicon || null, active: !!t.active, pinned: !!t.pinned, loading: false,
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
    allowpopups: '',
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
      refreshSoon();
    }
    // Google's "unusual traffic" wall is IP-based: once per tab, a pool-routed
    // workspace rotates its exit and retries; if it persists we say so instead
    // of looping. Non-pool routes get the honest explanation only.
    if (/^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//i.test(url) && !tab.gwallNoted) {
      tab.gwallNoted = true;
      const ws = S.ws(wsId);
      if (ws && ws.proxy && ws.proxy.mode === 'auto') {
        if (!tab.gwallRetried) {
          tab.gwallRetried = true;
          PH().pool.rotate(wsId).then(() => {
            // proxy-applied reloads this workspace's active page; if the wall
            // was on a background tab, drive it from here
            try { if (!isActiveTab(wsId, tab)) wv.loadURL(url); } catch { }
          }).catch(() => { });
          toast({ title: 'Google put up an \u201cunusual traffic\u201d wall', sub: 'Shared exits trip it. Pigeonhole rotated to another exit and is retrying - if it persists, try DuckDuckGo for a few minutes.', type: 'info', ic: 'warn', timeout: 7000 });
        }
      } else {
        toast({ title: 'Google put up an \u201cunusual traffic\u201d wall', sub: 'It is tied to this exit\u2019s IP. Rotate the proxy (top bar \u2192 network menu) or use DuckDuckGo for a few minutes.', type: 'info', ic: 'warn', timeout: 7000 });
      }
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
    // the title arrives after did-navigate - patch the history entry it belongs to
    if (/^https?:/i.test(tab.url)) PH().history.add(wsId, { url: tab.url, title: tab.title });
    render(wsId);
    if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab });
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    const f = (e.favicons || []).find(u => /^(data|https?):/.test(u || ''));
    if (f && f !== tab.favicon) { tab.favicon = f; render(wsId); }
  });
  wv.addEventListener('did-start-loading', () => { tab.loading = true; render(wsId); if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab }); });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; render(wsId); if (isActiveTab(wsId, tab)) bus.emit('active-tab-updated', { wsId, tab }); });
  wv.addEventListener('did-finish-load', () => {
    // real-traffic feedback: successful page loads keep the workspace exit's
    // quality score healthy (the pool supervisor blends this with its probes)
    try {
      const u = wv.getURL() || '';
      if (/^pigeonhole:/i.test(u)) return;   // error/newtab pages are not signal
      PH().pool.notePage(wsId, true).catch(() => { });
    } catch { }
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return;
    if (e.errorCode === -3) return; // aborted
    // real-traffic feedback: a failed load decays the exit's score; the
    // supervisor picks this up within a sweep and pre-empts the next failure
    PH().pool.notePage(wsId, false).catch(() => { });
    const showErrorPage = () => {
      const target = e.validatedURL || tab.url || safeUrl(wv);
      tab.lastError = { code: e.errorCode, desc: e.errorDescription };
      const q = `pigeonhole://error?code=${encodeURIComponent(e.errorCode)}&desc=${encodeURIComponent(e.errorDescription || '')}&url=${encodeURIComponent(target)}`;
      try { wv.loadURL(q); } catch { wv.setAttribute('src', q); }
    };
    // free-pool auto-heal: a proxy-flavoured failure on an auto-routed
    // workspace rotates the exit and retries before showing an error page
    const proxyish = /proxy|socks|tunnel/i.test(String(e.errorDescription || '')) || [-130, -131, -133, -137].includes(e.errorCode);
    if (proxyish) {
      const ws = S.ws(wsId);
      if (ws && ws.proxy && ws.proxy.mode === 'auto') {
        PH().pool.heal(wsId).then((r) => {
          if (r && r.rotated) {
            // proxy-applied reloads the active tab of this workspace; if it
            // is not active, force it from here
            const url = e.validatedURL || tab.url || safeUrl(wv);
            try { if (!isActiveTab(wsId, tab)) wv.loadURL(url); } catch { }
            toast({ title: 'Exit rotated automatically', sub: 'The free-pool exit for this workspace died - Pigeonhole swapped it and retried.', type: 'info', ic: 'globe', timeout: 6000 });
          } else {
            showErrorPage();
          }
        }).catch(() => showErrorPage());
        return;   // hold off the error page until the rotation resolves
      }
    }
    showErrorPage();
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
  const l = tabs.get(wsId) || [];
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
  rememberClosed(wsId, closed);
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
  bus.emit('tab-activated', { wsId, tab: t });
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
  loadWebview(wv, t);
  render(wsId);
  persist(wsId);
  return t;
}

// Apply a navigation to a webview that may still be attaching. loadURL only
// exists once the guest is interactive; the plain src fallback is unreliable
// while the initial navigation is in flight (it can be dropped), so the
// intended URL is re-applied on the guest's first dom-ready. The target is
// captured up front: did-navigate from a completing initial load rewrites
// tab.url before the retry runs, and must not defeat the comparison.
function loadWebview(wv, tab) {
  if (!wv) return;
  const target = tab.url;
  const go = () => { try { wv.loadURL(target); return true; } catch { return false; } };
  if (go()) return;
  wv.addEventListener('dom-ready', () => {
    try { if (wv.getURL() === target) return; } catch { }
    go();
  }, { once: true });
}

export function goBack(wsId) { try { webviewOf(wsId)?.goBack(); } catch { } }
export function goForward(wsId) { try { webviewOf(wsId)?.goForward(); } catch { } }

// Reload the ACTIVE tab. When a failed load parked the tab on the internal
// error page, a plain reload() would reload the error page itself - exactly
// the "reload button does nothing" complaint. Parse the failed URL back out
// and navigate to THAT instead.
export function reload(wsId) {
  const t = currentTab(wsId);
  const wv = webviewOf(wsId, t);
  if (!wv || !t) return;
  let cur = '';
  try { cur = wv.getURL() || ''; } catch { }
  if (/^pigeonhole:\/\/error\//i.test(cur)) {
    let target = '';
    const m = /[?&]url=([^&]*)/.exec(cur);
    if (m) { try { target = decodeURIComponent(m[1]); } catch { } }
    if (target && /^https?:\/\//i.test(target)) {
      t.lastError = null;
      t.url = target;
      loadWebview(wv, t);
      render(wsId);
      return;
    }
  }
  try { wv.reload(); } catch {
    // the webview is not interactive yet (still attaching): re-apply src
    try { wv.setAttribute('src', t.url || NTP(wsId)); } catch { }
  }
}
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
  if (w && !containers.has(wsId)) {
    restoreWorkspace(wsId, S.tabsFor(wsId), { lazy: false });
    // restoreWorkspace may have mounted the container - mark it active now
    containers.get(wsId)?.root.classList.add('active');
  } else {
    ensureWebviews(wsId);
  }
  render(wsId);
  bus.emit('ws-activated', { wsId, fromBoot });
  bus.emit('tab-activated', { wsId, tab: currentTab(wsId) });
  bus.emit('active-tab-updated', { wsId, tab: currentTab(wsId) });
  PH().ui.set({ activeWsId: wsId });
}

// ---------- tab strip rendering ----------
export function render(wsId) {
  // a drag in progress owns the strip; rebuilding it mid-drag would detach
  // the dragged element from the DOM under the pointer
  if (drag && drag.wsId === wsId && drag.moved) return;
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
      class: `tab ${t.active ? 'active' : ''} ${t.loading ? 'loading' : ''} ${t.suspended ? 'suspended' : ''} ${t.pinned ? 'pinned' : ''}`,
      role: 'tab', 'aria-selected': t.active ? 'true' : 'false',
      title: t.title || t.url,
      'data-tab': t.id,
      onclick: () => activateTab(wsId, t.id),
      onauxclick: (e) => { if (e.button === 1) closeTab(wsId, t.id); },
      oncontextmenu: (e) => { e.preventDefault(); tabMenu(e, wsId, t.id); }
    },
      fav,
      el('span', { class: 'title', text: t.title || (t.url.startsWith('pigeonhole://newtab') ? 'New Tab' : t.url) }),
      el('span', {
        class: 'close', html: icon(t.pinned ? 'pin' : 'close', 12),
        title: t.pinned ? 'Unpin tab' : 'Close tab',
        onclick: (e) => { e.stopPropagation(); t.pinned ? togglePin(wsId, t.id) : closeTab(wsId, t.id); }
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

// ---------- tab reordering (drag) ----------
// Pointer-based so it survives the constant strip re-renders: the drag owns
// the strip while it lasts (render() stands down), the tab DOM node is moved
// live between its siblings, and the array order is synced on drop.
let drag = null;

function initTabDrag() {
  const strip = qs('#tabstrip');
  strip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.close') || e.target.closest('.newtab-btn')) return;
    const tabEl = e.target.closest('.tab');
    if (!tabEl) return;
    drag = { wsId: S.getActiveWsId(), tabId: tabEl.getAttribute('data-tab'), el: tabEl,
      startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    tabEl.setPointerCapture?.(e.pointerId);
  });
  strip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // the strip re-renders constantly (favicons, titles); the node captured
    // at pointerdown can be replaced before the drag even engages - look the
    // tab up by id in that case instead of dying
    if (!drag.el.isConnected) {
      const el2 = strip.querySelector('.tab[data-tab="' + drag.tabId + '"]');
      if (!el2) { drag = null; return; }
      drag.el = el2;
      if (drag.moved) drag.el.classList.add('dragging');
    }
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < 7 && Math.abs(e.clientY - drag.startY) < 7) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      document.body.style.userSelect = 'none';
    }
    e.preventDefault();
    // live reorder: compare the POINTER position to sibling midpoints (the
    // dragged node itself has not moved yet, so its own rect is useless here)
    const px = e.clientX;
    const sibs = [...strip.querySelectorAll('.tab')].filter(n => n !== drag.el);
    for (const s of sibs) {
      const r = s.getBoundingClientRect();
      if (r.width < 4) continue;
      if (px < r.left + r.width / 2 && s.previousElementSibling !== drag.el) {
        s.parentNode.insertBefore(drag.el, s); break;
      }
      if (px > r.left + r.width / 2 && s.nextElementSibling !== drag.el && s === s.parentNode.lastElementChild) {
        s.parentNode.insertBefore(drag.el, s.nextSibling); break;
      }
    }
  });
  const finish = (e) => {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const { wsId, moved } = drag;
    const el = drag.el.isConnected ? drag.el : strip.querySelector('.tab[data-tab="' + drag.tabId + '"]');
    drag = null;
    document.body.style.userSelect = '';
    el?.classList.remove('dragging');
    el?.releasePointerCapture?.(e?.pointerId);
    if (!moved || !el) return;
    if (el.isConnected) {
      // sync the model to the DOM order the user just chose
      const order = [...qs('#tabstrip').querySelectorAll('.tab')].map(n => n.getAttribute('data-tab'));
      const l = tabs.get(wsId) || [];
      l.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      persist(wsId);
      render(wsId);
      // the click that follows a drag would re-activate the dragged tab - swallow it once
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); strip.removeEventListener('click', swallow, true); };
      strip.addEventListener('click', swallow, true);
      setTimeout(() => strip.removeEventListener('click', swallow, true), 120);
      bus.emit('tabs-reordered', { wsId });
    }
  };
  strip.addEventListener('pointerup', finish);
  strip.addEventListener('pointercancel', finish);
}

// pinned tabs (beta.7): compact favicon-first tabs at the strip's left;
// exempt from "close others". Pinning moves the tab to the front of the
// pinned block, unpinning parks it after the last pinned tab.
export function togglePin(wsId, tabId) {
  const l = tabs.get(wsId) || [];
  const i = l.findIndex(t => t.id === tabId);
  if (i === -1) return;
  const [t] = l.splice(i, 1);
  t.pinned = !t.pinned;
  if (t.pinned) l.unshift(t);
  else {
    const lastPin = l.reduce((acc, x, idx) => x.pinned ? idx : acc, -1);
    l.splice(lastPin + 1, 0, t);
  }
  render(wsId);
  persist(wsId);
}

export function moveTab(wsId, tabId, dir) {
  const l = tabs.get(wsId) || [];
  const i = l.findIndex(t => t.id === tabId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= l.length) return;
  const [t] = l.splice(i, 1);
  l.splice(j, 0, t);
  render(wsId);
  persist(wsId);
}

function tabMenu(e, wsId, tabId) {
  const l = tabs.get(wsId) || [];
  const t = l.find(x => x.id === tabId);
  const closed = closedList(wsId);
  const items = [];
  if (t && !t.pinned) {
    items.push({ label: 'Move left', icon: 'chevL', action: () => moveTab(wsId, tabId, -1) });
    items.push({ label: 'Move right', icon: 'chevR', action: () => moveTab(wsId, tabId, 1) });
  }
  items.push({ label: t && t.pinned ? 'Unpin tab' : 'Pin tab', icon: 'pin', action: () => togglePin(wsId, tabId) });
  items.push({ sep: true });
  items.push({ label: 'Reload tab', icon: 'reload', action: () => { activateTab(wsId, tabId); reload(wsId); } });
  items.push({ label: 'Close other tabs', icon: 'close', action: () => { for (const x of [...l]) if (x.id !== tabId && !x.pinned) closeTab(wsId, x.id); } });
  if (closed.length) {
    items.push({ sep: true });
    items.push({
      label: `Reopen closed tab — ${(closed[0].title || closed[0].url).slice(0, 30)}`,
      icon: 'clock', kbd: 'Ctrl+Shift+T', action: () => undoClose(wsId)
    });
    for (const c of closed.slice(1, 4)) {
      items.push({ label: `Reopen: ${(c.title || c.url).slice(0, 40)}`, icon: 'history', action: () => createTab(wsId, { url: c.url, active: true }) });
    }
  }
  items.push({ sep: true });
  items.push({ label: 'Close tab', icon: 'close', kbd: 'Ctrl+W', danger: true, action: () => closeTab(wsId, tabId) });
  showMenu(e.clientX, e.clientY, items);
}
initTabDrag();
