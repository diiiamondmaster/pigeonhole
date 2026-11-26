// Chrome bootstrap: loads state, wires the top bar / status bar / shortcuts
// and routes events from the main process (menu actions, new tabs, downloads).
import { el, qs, escapeHtml } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { initSidebar, renderSidebar, applyCollapsed, newWorkspace } from './sidebar.js';
import { initToolbar, syncAddr, syncNav, toggleFind } from './toolbar.js';
import { initIdentity, syncFillBtn } from './identity.js';
import { initVault, openVault, closeVault } from './vault.js';
import { settingsModal } from './modals.js';
import { toast, downloadToast } from './toasts.js';
import { closeWizard } from './wizard.js';
import { handleUpdateEvent, checkUpdates } from './updates.js';

let APP_INFO = { version: '1.0.0' };

async function boot() {
  await S.refresh();

  // first run: create the first workspace and open the wizard for it
  if (!S.workspaces().length) {
    const created = await PH().workspaces.create({});
    await S.refresh();
    renderSidebar();
    Tabs.switchWorkspace(created.id, { fromBoot: true });
    const { openWizard } = await import('./wizard.js');
    openWizard(created.id);
  } else {
    const active = S.getActiveWsId();
    for (const w of S.workspaces()) {
      // active workspace gets live webviews; the others restore lazily
      Tabs.restoreWorkspace(w.id, S.tabsFor(w.id), { lazy: w.id !== active });
    }
    if (active && S.ws(active)) Tabs.switchWorkspace(active, { fromBoot: true });
    else if (S.workspaces()[0]) Tabs.switchWorkspace(S.workspaces()[0].id, { fromBoot: true });
  }

  initSidebar();
  initToolbar();
  initIdentity();
  initVault();
  renderSidebar();
  renderTopbar();
  renderStatusbar();

  PH().app.info().then(info => { APP_INFO = info; renderStatusbar(); });
  PH().app.setTitle('Pigeonhole');

  PH().onEvent(handleEvent);
  window.addEventListener('keydown', onChromeKey, { capture: true });

  bus.on('ws-activated', () => { renderTopbar(); renderStatusbar(); syncAddr(); syncNav(); syncFillBtn(); });
  bus.on('chrome-updated', () => { renderTopbar(); renderSidebar(); renderStatusbar(); syncFillBtn(); });
  bus.on('active-tab-updated', ({ wsId, tab }) => {
    if (wsId !== S.getActiveWsId()) return;
    renderStatusbar();
    PH().app.setTitle(tab?.title ? `${tab.title} — Pigeonhole` : 'Pigeonhole');
  });

  applyCollapsed(S.snap()?.ui?.sidebarCollapsed);
  console.log('[pigeonhole] chrome ready');
}

// ---------- top bar ----------
function renderTopbar() {
  const w = S.activeWs();
  const chip = qs('#wsChip');
  if (!w) { chip.replaceChildren(); return; }
  const meta = el('div', { class: 'ws-chip-meta' },
    el('div', { class: 'ws-chip-name', text: w.name }),
    el('div', { class: 'ws-chip-email', text: w.identity ? w.identity.email : 'no email yet' }));
  const proxied = !!(w.proxy && w.proxy.enabled);
  const net = el('span', {
    class: 'net-chip ' + (proxied ? 'proxy' : 'direct'),
    title: proxied
      ? `This workspace exits through its own ${String(w.proxy.scheme || '').toUpperCase()} proxy (${w.proxy.host}:${w.proxy.port}).`
      : 'This workspace connects directly. Route it through its own proxy from workspace settings → Network.'
  },
    el('span', { class: 'dot' }),
    el('span', { text: proxied ? 'Proxy' : 'Direct' }));
  chip.replaceChildren(
    el('span', { class: 'ws-avatar', style: { '--h': w.hue }, text: w.num }),
    meta,
    net);
}

function renderStatusbar() {
  const w = S.activeWs();
  const proxied = !!(w && w.proxy && w.proxy.enabled);
  qs('#statusLeft').replaceChildren(...[
    el('span', {
      class: 'status-item',
      title: proxied ? `Workspace traffic goes through ${String(w.proxy.scheme).toUpperCase()} ${w.proxy.host}:${w.proxy.port}` : 'Each workspace can be routed through its own proxy - workspace settings → Network'
    },
      el('span', { class: 'dot' }),
      el('span', { html: proxied ? `Routed via ${String(w.proxy.scheme).toUpperCase()} proxy` : 'Direct connection' })),
    w ? el('span', { class: 'status-item' }, el('b', { text: `Workspace ${w.num}` }), el('span', { text: w.identity ? w.identity.email : 'no identity yet' })) : null
  ].filter(Boolean));
  qs('#statusRight').replaceChildren(
    el('span', { class: 'status-item', text: `Pigeonhole v${APP_INFO.version}` }),
    el('span', { class: 'status-item', text: 'Local-first · no telemetry' }));
}

// ---------- events from main ----------
function handleEvent({ type, payload }) {
  if (type === 'open-tab') {
    const wsId = payload.wsId && S.ws(payload.wsId) ? payload.wsId : S.getActiveWsId();
    Tabs.openInWorkspace(wsId, payload.url, { focus: true });
  } else if (type === 'shortcut') {
    runAction(payload.action, payload);
  } else if (type === 'download') {
    downloadToast(payload);
  } else if (type === 'proxy-applied') {
    // the workspace's route just changed live: reload its pages so they
    // pick the new path up, and refresh the network chips
    if (payload.wsId && payload.wsId === S.getActiveWsId()) Tabs.reload(payload.wsId);
    S.refresh().then(() => { renderTopbar(); renderStatusbar(); });
  } else if (type === 'state-changed') {
    S.refresh().then(() => { renderSidebar(); renderTopbar(); });
  } else if (type === 'scene') {
    runScene(payload);
  } else if (type && type.startsWith('update-')) {
    handleUpdateEvent(type, payload);
  }
}

// ---------- actions (menu accelerators + keyboard) ----------
export function runAction(action, extra = {}) {
  const wsId = S.getActiveWsId();
  switch (action) {
    case 'new-tab': Tabs.createTab(wsId, { url: `pigeonhole://newtab?ws=${wsId}`, active: true }); break;
    case 'close-tab': { const t = Tabs.currentTab(wsId); if (t) Tabs.closeTab(wsId, t.id); break; }
    case 'focus-address': { const a = qs('#addr'); a.focus(); a.select(); break; }
    case 'reload': Tabs.reload(wsId); break;
    case 'back': Tabs.goBack(wsId); break;
    case 'forward': Tabs.goForward(wsId); break;
    case 'home': Tabs.navigate(wsId, `pigeonhole://newtab?ws=${wsId}`); break;
    case 'find': toggleFind(); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
    case 'new-workspace': newWorkspace(); break;
    case 'toggle-sidebar': import('./sidebar.js').then(m => m.toggleSidebar()); break;
    case 'settings': settingsModal(); break;
    case 'about': settingsModal('about'); break;
    case 'vault': { const p = qs('#vaultPanel'); if (p.classList.contains('hidden')) openVault(wsId); else closeVault(); break; }
    case 'ws-switch': { const w = S.wsByNum(extra.n || 1); if (w) Tabs.switchWorkspace(w.id); break; }
    case 'zoom-in': Tabs.setZoom(wsId, Tabs.getZoom(wsId) * 1.2); break;
    case 'zoom-out': Tabs.setZoom(wsId, Tabs.getZoom(wsId) / 1.2); break;
    case 'zoom-reset': Tabs.setZoom(wsId, 1); break;
    case 'devtools-guest': { const wv = Tabs.webviewOf(wsId); try { wv?.openDevTools(); } catch { } break; }
    case 'devtools': PH().app.openDevTools(); break;
    case 'docs': PH().app.open('docs'); break;
    case 'docs-providers': PH().app.open('docs-providers'); break;
    case 'issues': PH().app.open('issues'); break;
    case 'check-updates': checkUpdates({ manual: true }); break;
  }
}

function cycleTab(dir) {
  const wsId = S.getActiveWsId();
  const l = Tabs.list(wsId);
  if (l.length < 2) return;
  const i = l.findIndex(t => t.active);
  const next = l[(i + dir + l.length) % l.length];
  Tabs.activateTab(wsId, next.id);
}

// keyboard shortcuts while the chrome (not the page) has focus
function onChromeKey(e) {
  const c = e.ctrlKey || e.metaKey, a = e.altKey, s = e.shiftKey;
  const k = (e.key || '').toLowerCase();
  const inField = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '');

  if (c && !a && k === 't') { e.preventDefault(); runAction('new-tab'); }
  else if (c && !a && k === 'w') { e.preventDefault(); runAction('close-tab'); }
  else if (c && !a && k === 'l') { e.preventDefault(); runAction('focus-address'); }
  else if (c && !a && k === 'r' && !inField) { e.preventDefault(); runAction('reload'); }
  else if (c && !a && k === 'f') { e.preventDefault(); runAction('find'); }
  else if (c && s && k === 'n') { e.preventDefault(); runAction('new-workspace'); }
  else if (c && !a && k === 'b') { e.preventDefault(); runAction('toggle-sidebar'); }
  else if (c && s && k === 'i') { e.preventDefault(); runAction('devtools'); }
  else if (c && !a && k === 'tab') { e.preventDefault(); runAction(s ? 'prev-tab' : 'next-tab'); }
  else if (a && !c && k === 'arrowleft') { e.preventDefault(); runAction('back'); }
  else if (a && !c && k === 'arrowright') { e.preventDefault(); runAction('forward'); }
  else if (a && !c && k === 'home') { e.preventDefault(); runAction('home'); }
  else if (a && !c && /^[0-9]$/.test(k)) { e.preventDefault(); runAction('ws-switch', { n: k === '0' ? 10 : Number(k) }); }
  else if (!c && !a && k === 'f5' && !inField) { e.preventDefault(); runAction('reload'); }
}

// top bar buttons
qs('#vaultBtn').innerHTML = icon('key', 17);
qs('#settingsBtn').innerHTML = icon('gear', 17);
qs('#vaultBtn').addEventListener('click', () => runAction('vault'));
qs('#settingsBtn').addEventListener('click', () => settingsModal());
qs('#logoBtn')?.addEventListener('click', () => settingsModal('about'));

// ---------- dev scene runner (screenshot harness) ----------
async function runScene(payload) {
  const name = payload?.name;
  const wsId = S.getActiveWsId();
  if (name === 'wizard') import('./wizard.js').then(m => m.openWizard(wsId));
  else if (name === 'vault') openVault(wsId);
  else if (name === 'settings') settingsModal();
  else if (name === 'ws-settings') import('./modals.js').then(m => m.wsSettingsModal(wsId));
  else if (name === 'about') settingsModal('about');
  else if (name === 'ntp') Tabs.navigate(wsId, `pigeonhole://newtab?ws=${wsId}`);
  else if (name === 'error') Tabs.navigate(wsId, 'http://127.0.0.1:9/unreachable');
  else if (name === 'collapsed') import('./sidebar.js').then(m => m.toggleSidebar());
  else if (name === 'offer') {
    // point the active tab at the local site playground to trigger the offer bar
    Tabs.navigate(wsId, 'http://127.0.0.1:8123/form-playground.html');
  } else if (name === 'many') {
    for (let i = 0; i < 15; i++) await PH().workspaces.create({});
    await S.refresh();
    import('./sidebar.js').then(m => m.renderSidebar());
  } else if (name === 'wizard-mock' || name === 'wizard-create') {
    const created = await PH().workspaces.create({});
    await S.refresh();
    import('./sidebar.js').then(m => m.renderSidebar());
    Tabs.switchWorkspace(created.id);
    import('./wizard.js').then(m => m.driveMockFlow(created.id, 'http://127.0.0.1:8123/provider-mock.html', { hold: name === 'wizard-create' }));
  } else if (name === 'wizard-provider') {
    import('./wizard.js').then(m => m.openWizardAt(wsId, 'provider'));
  } else if (name === 'wizard-identity') {
    import('./wizard.js').then(m => m.openWizardAt(wsId, 'identity'));
  } else if (name === 'wizard-confirm') {
    import('./wizard.js').then(m => m.openWizardAt(wsId, 'confirm'));
  } else if (name === 'settings-identity') {
    settingsModal('identity');
  }
}

boot().then(() => { try { window.pigeonhole.dev?.ready(); } catch { } })
  .catch(e => { console.error('[boot]', e); document.body.textContent = 'Failed to start: ' + e; });
