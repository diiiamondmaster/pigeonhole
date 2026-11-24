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
      onclick: () => { if (S.getActiveWsId() !== w.id) Tabs.switchWorkspace(w.id); },
      oncontextmenu: (e) => { e.preventDefault(); tileMenu(e, w); }
    },
      el('span', { text: w.num })
    );
    tile.addEventListener('mouseenter', () => showTip(tile, w));
    tile.addEventListener('mouseleave', hideTip);
    tilesRoot.append(tile);
  }

  requestAnimationFrame(fitColumns);
  applyCollapsed(S.snap()?.ui?.sidebarCollapsed);
}

// grow the sidebar when tiles wrap into extra columns
function fitColumns() {
  const app = qs('#app');
  if (app.classList.contains('sb-collapsed')) return;
  const tiles = qs('#wsTiles');
  const needed = tiles ? Math.max(tiles.scrollWidth, 0) : 0;
  const sidebar = qs('#sidebar');
  const w = Math.max(74, Math.min(needed + 27, Math.floor(window.innerWidth * 0.42)));
  sidebar.style.width = `${w}px`;
}

window.addEventListener('resize', () => { requestAnimationFrame(() => {
  const tiles = qs('#wsTiles'); if (tiles) fitColumns();
}); });

// ---- tooltip ----
let tipEl = null, tipTimer = null;
function showTip(tile, w) {
  hideTip();
  tipTimer = setTimeout(() => {
    tipEl = el('div', {
      class: 'tip',
      style: {
        position: 'fixed', zIndex: 500, maxWidth: '300px',
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: '8px', padding: '6px 10px', fontSize: '11.5px', color: 'var(--text)',
        boxShadow: 'var(--shadow-pop)', pointerEvents: 'none', lineHeight: 1.45
      },
      html: `<b>${escapeHtml(w.name)}</b><br><span style="color:var(--text-faint)">${w.identity ? escapeHtml(w.identity.email) : 'No email yet — click + to set one up'}</span>`
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
    openModal({
      title, size: 'sm',
      body: el('div', {}, input),
      onClose: (v) => resolve(v ?? null),
      footer: [
        { label: 'Cancel', onClick: () => null },
        { label: 'Save', primary: true, onClick: () => input.value }
      ]
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = input.value; input.value = v; qs('#modalRoot').replaceChildren(); resolve(v); }
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
}
