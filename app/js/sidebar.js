// Workspace sidebar: numbered, color-coded tiles that wrap into new columns
// and collapse to a slim rail.
import { el, qs, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { showMenu } from './ctxmenu.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { openWizard } from './wizard.js';
import { wsSettingsModal, confirmModal, openModal } from './modals.js';
import { toast } from './toasts.js';

export function renderSidebar() {
  const tilesRoot = qs('#wsTiles');
  tilesRoot.replaceChildren();

  for (const w of S.workspaces()) {
    const tile = el('button', {
      class: `ws-tile ${w.id === S.getActiveWsId() ? 'active' : ''} ${w.identity ? '' : 'no-identity'}`,
      role: 'option', 'aria-selected': w.id === S.getActiveWsId() ? 'true' : 'false',
      title: '',
      style: { '--h': w.hue },
      'data-ws': w.id,
      onclick: () => { if (S.getActiveWsId() !== w.id) Tabs.switchWorkspace(w.id); },
      oncontextmenu: (e) => { e.preventDefault(); tileMenu(e, w); }
    },
      el('span', { text: w.num }),
      // small status dot: this workspace exits through its own proxy
      w.proxy && w.proxy.enabled ? el('span', { class: 'net-dot', title: `Routed via ${String(w.proxy.scheme).toUpperCase()} ${w.proxy.host}:${w.proxy.port}` }) : null
    );
    tile.addEventListener('mouseenter', () => showTip(tile, w));
    tile.addEventListener('mouseleave', hideTip);
    tilesRoot.append(tile);
  }

  requestAnimationFrame(fitColumns);
  applyCollapsed(S.snap()?.ui?.sidebarCollapsed);
}

// size the sidebar to EXACTLY what the tiles need: rightmost tile edge +
// right padding + borders. No fudge and no scrollWidth (which never shrinks
// back and double-counts padding) - so the sidebar is never wider than
// the tiles it shows
function fitColumns() {
  const app = qs('#app');
  if (app.classList.contains('sb-collapsed')) return;
  const tiles = qs('#wsTiles');
  if (!tiles) return;
  let right = 0;
  for (const t of tiles.children) {
    const r = t.getBoundingClientRect();
    if (r.width && r.right > right) right = r.right;
  }
  const base = tiles.getBoundingClientRect().left;
  const needed = right ? Math.ceil(right - base + 13) : 0;   // + .ws-tiles right padding
  const w = Math.max(74, Math.min(needed + 2, Math.floor(window.innerWidth * 0.42)));
  qs('#sidebar').style.width = `${w}px`;
}

window.addEventListener('resize', () => { requestAnimationFrame(() => {
  const tiles = qs('#wsTiles'); if (tiles) fitColumns();
}); });

// ---- tooltip ----
let tipEl = null, tipTimer = null;
function showTip(tile, w) {
  hideTip();
  tipTimer = setTimeout(() => {
    const proxied = w.proxy && w.proxy.enabled;
    tipEl = el('div', {
      class: 'tip',
      style: {
        position: 'fixed', zIndex: 500, maxWidth: '300px',
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: '8px', padding: '6px 10px', fontSize: '11.5px', color: 'var(--text)',
        boxShadow: 'var(--shadow-pop)', pointerEvents: 'none', lineHeight: 1.45
      },
      html: `<b>${escapeHtml(w.name)}</b><br>` +
        `<span style="color:var(--text-faint)">${w.identity ? escapeHtml(w.identity.email) : 'No email yet — click + to set one up'}</span>` +
        (proxied
          ? `<br><span style="color:var(--accent)">exit: ${escapeHtml(String(w.proxy.scheme).toUpperCase())} ${escapeHtml(w.proxy.host)}:${w.proxy.port}</span>`
          : `<br><span style="color:var(--text-faint)">direct connection</span>`)
    });
    document.body.append(tipEl);
    const r = tile.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    tipEl.style.left = `${r.right + 10}px`;
    tipEl.style.top = `${Math.max(6, Math.min(r.top, window.innerHeight - tr.height - 6))}px`;
  }, 380);
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) { tipEl.remove(); tipEl = null; }
}

// ---- tile context menu ----
function tileMenu(e, w) {
  showMenu(e.clientX, e.clientY, [
    { label: 'Open workspace', icon: 'arrowR', kbd: `Alt+${w.num <= 9 ? w.num : ''}`, action: () => Tabs.switchWorkspace(w.id) },
    { label: 'Set up email…', icon: 'mail', action: () => { Tabs.switchWorkspace(w.id); openWizard(w.id); } },
    { sep: true },
    { label: 'Workspace settings…', icon: 'gear', action: () => wsSettingsModal(w.id) },
    { label: 'Rename…', icon: 'user', action: () => renameDialog(w) },
    { label: 'Duplicate workspace', icon: 'copy', action: () => duplicate(w) },
    { sep: true },
    { label: 'Delete workspace', icon: 'trash', danger: true, action: () => deleteFlow(w) }
  ]);
}

async function renameDialog(w) {
  const name = await promptModal('Rename workspace', w.name);
  if (name && name.trim()) {
    await PH().workspaces.rename(w.id, name.trim().slice(0, 80));
    await S.refresh();
    renderSidebar(); bus.emit('chrome-updated');
  }
}

async function duplicate(w) {
  const created = await PH().workspaces.duplicate(w.id);
  await S.refresh();
  renderSidebar();
  toast({ title: `Workspace ${created.num} created`, sub: 'Same quick links, fresh clean room', type: 'success', ic: 'copy' });
}

async function deleteFlow(w) {
  const ok = await confirmModal({
    title: `Delete workspace ${w.num}?`,
    body: `This permanently deletes its cookies, storage, saved logins and tabs. “${w.name}” cannot be recovered.`,
    actionLabel: 'Delete workspace'
  });
  if (!ok) return;
  Tabs.destroyWorkspace(w.id);
  await PH().workspaces.remove(w.id);
  await S.refresh();
  const next = S.workspaces()[0];
  if (next) Tabs.switchWorkspace(next.id, { fromBoot: true });
  else await createFirstWorkspace();
  renderSidebar(); bus.emit('chrome-updated');
}

// ---- creation ----
export async function createFirstWorkspace() {
  const created = await PH().workspaces.create({});
  await S.refresh();
  renderSidebar();
  Tabs.switchWorkspace(created.id, { fromBoot: true });
  openWizard(created.id);
}

export async function newWorkspace() {
  const created = await PH().workspaces.create({});
  await S.refresh();
  renderSidebar();
  Tabs.switchWorkspace(created.id);
  openWizard(created.id);
}

// ---- collapse ----
export function applyCollapsed(collapsed) {
  qs('#app').classList.toggle('sb-collapsed', !!collapsed);
  qs('#sbRail').classList.toggle('hidden', !collapsed);
  // drop the fitted inline width so the stylesheet rules actually apply:
  // an inline width beats any selector, so width:0 (collapsed) could never
  // win while one was set. Expanding re-fits from real content right after.
  qs('#sidebar').style.width = '';
  if (!collapsed) requestAnimationFrame(fitColumns);
}

export function toggleSidebar() {
  const collapsed = !qs('#app').classList.contains('sb-collapsed');
  applyCollapsed(collapsed);
  PH().ui.set({ sidebarCollapsed: collapsed });
  if (!collapsed) requestAnimationFrame(fitColumns);
}

// ---- simple prompt (used by rename) ----
function promptModal(title, value = '') {
  return new Promise((resolve) => {
    const input = el('input', { class: 'input', value, style: { width: '100%' } });
    const handle = openModal({
      title, size: 'sm',
      body: el('div', {}, input),
      onClose: (v) => resolve(v ?? null),
      footer: [
        { label: 'Cancel', onClick: () => null },
        { label: 'Save', primary: true, onClick: () => input.value }
      ]
    });
    input.addEventListener('keydown', (e) => {
      // Enter saves via the modal's own close path - replacing the whole
      // modal root would also destroy any dialog stacked underneath
      if (e.key === 'Enter') handle.close(input.value);
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function initSidebar() {
  qs('#logoBtn').innerHTML = icon('logo', 22);
  qs('#newWsBtn').innerHTML = icon('plus', 20);
  qs('#collapseBtn').innerHTML = icon('panel', 16);
  qs('#expandBtn').innerHTML = icon('panel', 16);
  qs('#newWsBtn').addEventListener('click', newWorkspace);
  qs('#collapseBtn').addEventListener('click', toggleSidebar);
  qs('#expandBtn').addEventListener('click', toggleSidebar);
  bus.on('ws-updated', () => renderSidebar());

  // fading switch trail (Opera GX style): the tile you leave keeps a short
  // glow in its own hue while the new workspace takes over
  let lastActive = null;
  bus.on('ws-activated', ({ wsId, fromBoot }) => {
    try {
      const anim = S.settings().wsAnim !== false;
      if (anim && !fromBoot && lastActive && lastActive !== wsId) {
        const prev = qs(`#wsTiles .ws-tile[data-ws="${lastActive}"]`);
        if (prev) {
          prev.classList.add('trail');
          setTimeout(() => prev.classList.remove('trail'), 1000);
        }
      }
    } catch { }
    lastActive = wsId;
  });
}
