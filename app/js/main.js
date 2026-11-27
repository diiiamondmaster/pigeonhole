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
import { settingsModal, wsSettingsModal } from './modals.js';
import { toast, downloadToast } from './toasts.js';
import { closeWizard } from './wizard.js';
import { handleUpdateEvent, checkUpdates } from './updates.js';
import { initExtPanel, toggleExtPanel, updateAdsBadge, openShieldMenu } from './extpanel.js';
import { showMenu } from './ctxmenu.js';

let APP_INFO = { version: '1.0.0' };
let ADS_BLOCKED = 0;

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
  initExtPanel();
  applyUiPrefs();
  renderSidebar();
  renderTopbar();
  renderStatusbar();

  PH().app.info().then(info => { APP_INFO = info; renderStatusbar(); });
  PH().extensions.adsCount().then(c => { ADS_BLOCKED = c.total || 0; updateAdsBadge(ADS_BLOCKED); renderStatusbar(); }).catch(() => { });
  PH().app.setTitle('Pigeonhole');

  PH().onEvent(handleEvent);
  window.addEventListener('keydown', onChromeKey, { capture: true });

  bus.on('ws-activated', () => { renderTopbar(); renderStatusbar(); syncAddr(); syncNav(); syncFillBtn(); });
  bus.on('chrome-updated', () => { renderTopbar(); renderSidebar(); renderStatusbar(); syncFillBtn(); applyUiPrefs(); });
  bus.on('active-tab-updated', ({ wsId, tab }) => {
    if (wsId !== S.getActiveWsId()) return;
    renderStatusbar();
    PH().app.setTitle(tab?.title ? `${tab.title} — Pigeonhole` : 'Pigeonhole');
  });

  applyCollapsed(S.snap()?.ui?.sidebarCollapsed);
  console.log('[pigeonhole] chrome ready');
}

// ---------- appearance prefs (Settings > Appearance) ----------
function applyUiPrefs() {
  const st = S.settings();
  // whole-chrome zoom: compact 90% / large 110%
  const factor = ({ compact: 0.9, large: 1.1 })[st.uiScale] || 1;
  document.body.style.zoom = factor !== 1 ? String(factor) : '';
  // 100vh does NOT shrink with body zoom: an #app at 100vh under zoom 0.9
  // left an empty strip under the statusbar (and 1.1 clipped it off-screen).
  // Compensate the height so the statusbar always lands on the window edge.
  qs('#app').style.height = factor !== 1 ? (100 / factor) + 'vh' : '';
  // sidebar workspace tiles
  const tile = ({ small: '40px', large: '54px' })[st.tileSize] || '46px';
  document.documentElement.style.setProperty('--tile', tile);
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
  const isPool = !!(proxied && w.proxy.mode === 'auto');
  const exitLabel = isPool
    ? `Auto exit${w.proxy.country ? ' · ' + w.proxy.country : ''} · ${String(w.proxy.scheme || '').toUpperCase()} ${w.proxy.host}:${w.proxy.port} · ${w.proxy.latencyMs || '?'} ms`
    : (proxied ? `SOCKS5/HTTP proxy ${w.proxy.host}:${w.proxy.port}` : '');
  const net = el('span', {
    class: 'net-chip ' + (proxied ? 'proxy' : 'direct'),
    title: isPool
      ? `Pigeonhole manages this exit: ${exitLabel}. Dead exits rotate automatically. Click for network actions.`
      : proxied
        ? `This workspace exits through its own ${String(w.proxy.scheme || '').toUpperCase()} proxy (${w.proxy.host}:${w.proxy.port}). Click for network actions.`
        : 'This workspace connects directly. Click for network actions.',
    onclick: (e) => { e.stopPropagation(); openNetMenu(e.currentTarget, w); }
  },
    el('span', { class: 'dot' }),
    el('span', { text: isPool ? 'Auto' : (proxied ? 'Proxy' : 'Direct') }),
    ...(isPool && w.proxy.country ? [el('span', { class: 'cc', style: { fontWeight: 650 }, text: ' ' + w.proxy.country })] : []));
  chip.replaceChildren(
    el('span', { class: 'ws-avatar', style: { '--h': w.hue }, text: w.num }),
    meta,
    net);
  // clickable chip = quick path to this workspace's settings (straight to
  // Network/proxy - the #1 beta question was "where do I even turn it on")
  chip.onclick = () => wsSettingsModal(w.id, { focusNetwork: true });
  // hue line under the top bar in the active workspace colour
  const bar = qs('.topbar');
  if (bar) { bar.style.setProperty('--h', w.hue); bar.classList.add('has-hue'); }
}

// network actions from the top bar chip / status bar
export function openNetMenu(anchor, w) {
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 120, bottom: 80 };
  const proxied = !!(w.proxy && w.proxy.enabled);
  const isPool = !!(proxied && w.proxy.mode === 'auto');
  showMenu(Math.max(8, r.left - 40), (r.bottom || 80) + 6, [
    {
      label: 'Test exit IP…', icon: 'globe', kbd: '', action: async () => {
        toast({ title: 'Testing the exit IP…', sub: 'Pigeonhole asks an IP service through this workspace\u2019s own connection.', type: 'info', ic: 'globe', timeout: 2500 });
        const res = await PH().workspaces.testProxy(w.id);
        if (res?.ok) {
          toast({ title: `Exit IP: ${res.ip}`, sub: `via ${res.via} \u00b7 ${res.ms || 0} ms`, type: 'success', ic: 'check', timeout: 7000 });
        } else {
          toast({ title: 'Exit IP test failed', sub: `${res?.error || 'no answer'} \u00b7 via ${res?.via || 'direct'}`, type: 'error', ic: 'warn', timeout: 7000 });
        }
      }
    },
    ...(isPool ? [{
      label: 'Find another exit…', icon: 'globe', action: async () => {
        toast({ title: 'Rotating the exit…', sub: 'Picking another verified proxy from the free pool.', type: 'info', ic: 'globe', timeout: 2500 });
        try {
          const saved = await PH().pool.rotate(w.id);
          await S.refresh(); renderTopbar(); renderStatusbar();
          toast({ title: `Workspace ${w.num} rotated`, sub: `Now exiting via ${saved.scheme.toUpperCase()} ${saved.host}:${saved.port}`, type: 'success', ic: 'check', timeout: 5000 });
        } catch (e) { toast({ title: 'No alternative exit right now', sub: String(e.message || e).slice(0, 90), type: 'error', ic: 'warn' }); }
      }
    }] : []),
    { label: proxied ? 'Proxy settings…' : 'Route through a proxy…', icon: 'panel', action: () => wsSettingsModal(w.id, { focusNetwork: true }) },
    ...(proxied ? [{ label: `Turn proxy off (${String(w.proxy.scheme).toUpperCase()} ${w.proxy.host}:${w.proxy.port})`, icon: 'close', action: async () => { await PH().workspaces.setProxy(w.id, { enabled: false }); await S.refresh(); renderTopbar(); renderStatusbar(); toast({ title: `Workspace ${w.num} is back on a direct connection`, type: 'success', ic: 'check' }); } }] : [])
  ]);
}

function renderStatusbar() {
  const w = S.activeWs();
  const proxied = !!(w && w.proxy && w.proxy.enabled);
  const isPool = !!(proxied && w.proxy.mode === 'auto');
  const routeText = isPool
    ? `Auto exit · ${String(w.proxy.scheme).toUpperCase()} ${w.proxy.host}:${w.proxy.port}${w.proxy.country ? ' · ' + w.proxy.country : ''}`
    : (proxied ? `Routed via ${String(w.proxy.scheme).toUpperCase()} proxy` : 'Direct connection');
  const netItem = el('span', {
    class: 'status-item',
    style: { cursor: 'pointer' },
    title: proxied ? `Workspace traffic goes through ${String(w.proxy.scheme).toUpperCase()} ${w.proxy.host}:${w.proxy.port}. Click for network actions.` : 'Each workspace can be routed through its own proxy - click for network actions',
    ...(w ? { onclick: () => openNetMenu(netItem, w) } : {})
  },
    el('span', { class: 'dot' }),
    el('span', { html: routeText }));
  qs('#statusLeft').replaceChildren(...[
    netItem,
    ADS_BLOCKED > 0 ? el('span', {
      class: 'status-item ads', title: 'Blocked by Ad Shield this session (click for the menu)'
    },
      el('span', { html: icon('shieldCheck', 13) }),
      el('span', { text: `${ADS_BLOCKED} ads blocked` })) : null,
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
    // the workspace's route just changed live. Visible rotations (user
    // action, heal-and-retry) reload the workspace's pages so they pick the
    // new path up; supervisor swaps set reload:false - the new route covers
    // new requests while already-rendered pages keep working, so nothing
    // reloads under the user's cursor.
    if (payload.wsId && payload.wsId === S.getActiveWsId() && payload.reload !== false) Tabs.reload(payload.wsId);
    S.refresh().then(() => { renderTopbar(); renderStatusbar(); });
  } else if (type === 'pool-rotation') {
    // the supervisor swapped this workspace's exit on its own
    S.refresh().then(() => { renderTopbar(); renderStatusbar(); });
    if (payload.wsId && payload.wsId === S.getActiveWsId()) {
      const old = payload.old || {};
      const neu = payload.proxy || {};
      if (payload.reason === 'dead') {
        toast({
          title: 'Exit replaced automatically',
          sub: `${old.host || 'the old exit'}:${old.port || ''} stopped responding - traffic now leaves via ${neu.host}:${neu.port}${neu.country ? ' (' + neu.country + ')' : ''}. Pages kept working.`,
          type: 'info', ic: 'globe', timeout: 6000
        });
      } else if (payload.reason === 'upgrade') {
        toast({
          title: 'Exit upgraded',
          sub: `Swapped ${old.host || 'the old exit'}:${old.port || ''} for a better verified exit (${neu.host}:${neu.port}${neu.country ? ', ' + neu.country : ''}${neu.latencyMs ? ', ' + neu.latencyMs + ' ms' : ''}). Pages kept working.`,
          type: 'success', ic: 'globe', timeout: 6000
        });
      }
    }
  } else if (type === 'backup-captured') {
    // a mail backup download was diverted into the workspace's backup store
    S.refresh().then(() => { renderSidebar(); renderStatusbar(); });
    const kb = payload.bytes >= 1048576 ? (payload.bytes / 1048576).toFixed(1) + ' MB' : Math.round((payload.bytes || 0) / 1024) + ' KB';
    toast({
      title: 'Mail backup saved to the workspace',
      sub: `${payload.name} (${kb})${payload.provider ? ' - ' + payload.provider : ''} - kept out of the Downloads folder, in Workspace settings \u2192 Mail backup files.`,
      type: 'success', ic: 'check', timeout: 6500
    });
  } else if (type === 'backup-legacy') {
    S.refresh().then(() => { renderSidebar(); renderStatusbar(); });
  } else if (type === 'backups-scanned') {
    S.refresh().then(() => { renderSidebar(); renderStatusbar(); });
    toast({
      title: `Imported ${payload.imported || 0} backup file${(payload.imported || 0) === 1 ? '' : 's'} from Downloads`,
      sub: 'Matched to their workspaces by mailbox address; unrelated files were left untouched. See each workspace\u2019s settings \u2192 Mail backup files.',
      type: payload.imported ? 'success' : 'info', ic: 'check', timeout: 6500
    });
  } else if (type === 'state-changed') {
    S.refresh().then(() => { applyUiPrefs(); renderSidebar(); renderTopbar(); });
  } else if (type === 'pool-migrated') {
    // one-time upgrade notice: existing workspaces just got pool exits
    S.refresh().then(() => { renderSidebar(); renderTopbar(); renderStatusbar(); });
    toast({
      title: `Free proxy pool: ${payload.count || 0} workspace${(payload.count || 0) === 1 ? '' : 's'} routed automatically`,
      sub: 'Each one now exits through its own verified community proxy - check any workspace\u2019s Network settings, or Settings \u2192 Network to control it.',
      type: 'success', ic: 'globe', timeout: 9000
    });
  } else if (type === 'ads-blocked') {
    ADS_BLOCKED = payload.total || 0;
    updateAdsBadge(ADS_BLOCKED);
    renderStatusbar();
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
    case 'fullscreen': PH().app.fullscreen().catch(() => { }); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
    case 'new-workspace': newWorkspace(); break;
    case 'toggle-sidebar': import('./sidebar.js').then(m => m.toggleSidebar()); break;
    case 'settings': settingsModal(); break;
    case 'about': settingsModal('about'); break;
    case 'ext-panel': toggleExtPanel(); break;
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
  else if (c && s && k === 'e') { e.preventDefault(); runAction('ext-panel'); }
  else if (c && s && k === 'i') { e.preventDefault(); runAction('devtools'); }
  else if (c && !a && k === 'tab') { e.preventDefault(); runAction(s ? 'prev-tab' : 'next-tab'); }
  else if (a && !c && k === 'arrowleft') { e.preventDefault(); runAction('back'); }
  else if (a && !c && k === 'arrowright') { e.preventDefault(); runAction('forward'); }
  else if (a && !c && k === 'home') { e.preventDefault(); runAction('home'); }
  else if (a && !c && /^[0-9]$/.test(k)) { e.preventDefault(); runAction('ws-switch', { n: k === '0' ? 10 : Number(k) }); }
  else if (!c && !a && k === 'f5' && !inField) { e.preventDefault(); runAction('reload'); }
  else if (!c && !a && k === 'f11') { e.preventDefault(); runAction('fullscreen'); }
}

// top bar buttons
qs('#vaultBtn').innerHTML = icon('key', 17);
qs('#settingsBtn').innerHTML = icon('gear', 17);
qs('#shieldBtn').innerHTML = icon('shield', 17) + '<span class="count-badge hidden"></span>';
qs('#extBtn').innerHTML = icon('puzzle', 17);
qs('#fsBtn').innerHTML = icon('expand', 16);
qs('#vaultBtn').addEventListener('click', () => runAction('vault'));
qs('#settingsBtn').addEventListener('click', () => settingsModal());
qs('#fsBtn').addEventListener('click', () => runAction('fullscreen'));
qs('#logoBtn')?.addEventListener('click', () => settingsModal('about'));
// the ads status item opens the shield menu
qs('#statusLeft').addEventListener('click', (e) => {
  const item = e.target.closest('.status-item.ads');
  if (item) { e.stopPropagation(); openShieldMenu(item); }
});

// ---------- dev scene runner (screenshot harness) ----------
async function runScene(payload) {
  const name = payload?.name;
  const wsId = S.getActiveWsId();
  if (name === 'wizard') import('./wizard.js').then(m => m.openWizard(wsId));
  else if (name === 'vault') openVault(wsId);
  else if (name === 'settings') settingsModal();
  else if (name === 'ext-panel') toggleExtPanel();
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
