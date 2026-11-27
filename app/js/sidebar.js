// Workspace sidebar: numbered, color-coded tiles that wrap into new columns
// and collapse to a slim rail. Drag tiles to reorder - numbers follow the
// order automatically. Each tile carries a small bar on its right edge: full
// for the active workspace, and for the others a trail that shrinks and
// fades one step for every workspace switched through after leaving it.
import { el, qs, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { showMenu } from './ctxmenu.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { openWizard } from './wizard.js';
import { wsSettingsModal, confirmModal, openModal } from './modals.js';
import { toast } from './toasts.js';

// recency trail: most recently used first. The active workspace sits at the
// head; the bar of the one you left shrinks and fades one step per later
// switch.
const recency = [];

export function renderSidebar() {
  const tilesRoot = qs('#wsTiles');
  tilesRoot.replaceChildren();

  const makeTile = (w) => {
    const tile = el('button', {
      class: `ws-tile ${w.id === S.getActiveWsId() ? 'active' : ''} ${w.identity ? '' : 'no-identity'}`,
      role: 'option', 'aria-selected': w.id === S.getActiveWsId() ? 'true' : 'false',
      title: '',
      style: { '--h': w.hue },
      'data-ws': w.id,
      onclick: () => {
        if (clickSuppressed) return;   // that pointer was a drag, not a click
        if (S.getActiveWsId() !== w.id) Tabs.switchWorkspace(w.id);
      },
      oncontextmenu: (e) => { e.preventDefault(); tileMenu(e, w); }
    },
      el('span', { text: w.num }),
      // recency bar (proxy state stays in the tooltip + top bar chip)
      el('span', { class: 'ws-bar' }));
    tile.addEventListener('pointerdown', onTilePointerDown);
    tile.addEventListener('mouseenter', () => showTip(tile, w));
    tile.addEventListener('mouseleave', hideTip);
    return tile;
  };

  // beta.7 groups: ungrouped tiles first (identical to the pre-group look),
  // then one collapsible labelled section per group, in name order. With no
  // groups in use the sidebar renders exactly as it always did.
  const groups = new Map();
  const loose = [];
  for (const w of S.workspaces()) {
    const tile = makeTile(w);
    if (w.group) {
      if (!groups.has(w.group)) groups.set(w.group, []);
      groups.get(w.group).push(tile);
    } else loose.push(tile);
  }
  for (const tile of loose) tilesRoot.append(tile);
  const collapsed = S.snap()?.ui?.wsGroupCollapsed || {};
  for (const g of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const tiles = groups.get(g);
    const head = el('button', {
      class: 'ws-group-head', 'data-group': g,
      'aria-expanded': collapsed[g] ? 'false' : 'true',
      onclick: async () => {
        const cur = S.snap()?.ui?.wsGroupCollapsed || {};
        await PH().ui.set({ wsGroupCollapsed: { ...cur, [g]: !cur[g] } });
        await S.refresh();
        renderSidebar();
      }
    },
      el('span', { class: 'chev', html: icon('chevD', 11) }),
      el('span', { class: 'ws-group-name', text: g.slice(0, 18) }),
      el('span', { class: 'ws-group-count', text: String(tiles.length) }));
    tilesRoot.append(head);
    if (!collapsed[g]) for (const tile of tiles) tilesRoot.append(tile);
  }

  applyBars();
  requestAnimationFrame(fitColumns);
  applyCollapsed(S.snap()?.ui?.sidebarCollapsed);
}

// ---- recency bars ----
// Opera-GX-style trail: the workspace you used last carries a tall bar on
// its tile; every workspace you switch through after leaving it makes that
// bar one step SHORTER and more transparent, until it disappears.
// The ladder's LENGTH follows the workspace count: with few workspaces you
// cannot be many switches away anyway, so the trail compresses (2 steps
// minimum) and the older bars fade out sooner; from 8 workspaces up it
// spans the full 7 steps.
const TRAIL_HEAD = { h: 88, o: 0.92 };   // step 0: the tile you just left
const TRAIL_TAIL = { h: 18, o: 0.12 };   // the last visible step
const TRAIL_MAX_STEPS = 7;
function trailLevel(step, steps) {
  const f = step / steps;
  return {
    h: Math.round(TRAIL_HEAD.h + (TRAIL_TAIL.h - TRAIL_HEAD.h) * f),
    o: TRAIL_HEAD.o + (TRAIL_TAIL.o - TRAIL_HEAD.o) * f
  };
}
function trailSteps() {
  return Math.max(2, Math.min(TRAIL_MAX_STEPS, S.workspaces().length - 1));
}
function applyBars() {
  const root = qs('#wsTiles');
  if (!root) return;
  const showBars = S.settings().wsAnim !== false;
  const activeId = S.getActiveWsId();
  for (const t of root.children) {
    const bar = t.querySelector('.ws-bar');
    if (!bar) continue;
    if (!showBars) { bar.style.opacity = '0'; bar.classList.remove('on'); continue; }
    const id = t.dataset.ws;
    if (id === activeId) {
      bar.classList.add('on');
      bar.style.opacity = '1'; bar.style.height = '72%'; bar.style.top = '14%';
      bar.title = 'Current workspace';
      continue;
    }
    bar.classList.remove('on');
    const rank = recency.indexOf(id);           // 0 = active itself
    const step = rank <= 0 ? -1 : rank - 1;      // first switched-away tile = step 0
    const steps = trailSteps();
    const lv = step >= 0 && step <= steps ? trailLevel(step, steps) : null;
    if (lv) {
      bar.style.opacity = String(lv.o);
      bar.style.height = lv.h + '%';
      bar.style.top = ((100 - lv.h) / 2).toFixed(1) + '%';
      bar.title = `Used ${step + 1} switch${step === 0 ? '' : 'es'} ago`;
    } else {
      bar.style.opacity = '0';
      bar.title = '';
    }
  }
}

// MRU order for the Ctrl+Tab cycler: recency first (active at the head),
// then never-visited workspaces in list order so cycling always covers all.
export function mruIds() {
  const exist = new Set(S.workspaces().map(w => w.id));
  const out = [];
  const act = S.getActiveWsId();
  if (act && exist.has(act)) out.push(act);
  for (const id of recency) if (exist.has(id) && !out.includes(id)) out.push(id);
  for (const w of S.workspaces()) if (!out.includes(w.id)) out.push(w.id);
  return out;
}

export function noteRecency(wsId) {
  const i = recency.indexOf(wsId);
  if (i !== -1) recency.splice(i, 1);
  recency.unshift(wsId);
  if (recency.length > 12) recency.length = 12;
  applyBars();
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
          ? `<br><span style="color:var(--accent)">exit: ${w.proxy.mode === 'auto' ? 'auto · ' : ''}${escapeHtml(String(w.proxy.scheme).toUpperCase())} ${escapeHtml(w.proxy.host)}:${w.proxy.port}${w.proxy.mode === 'auto' && w.proxy.country ? ' · ' + escapeHtml(w.proxy.country) : ''}</span>`
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

// ---- drag to reorder ----
// Pointer-based so it works on the wrapping grid: a 6px threshold separates
// click (switch) from drag (reorder); the dragged tile becomes a floating
// ghost and the nearest tile to the pointer shows the drop target.
let clickSuppressed = false;
const drag = { tile: null, wsId: null, moved: false, sx: 0, sy: 0, ghost: null, hover: null, targetIdx: -1 };

function onTilePointerDown(e) {
  if (e.button !== 0) return;
  const tile = e.currentTarget;
  drag.tile = tile; drag.wsId = tile.dataset.ws;
  drag.moved = false; drag.sx = e.clientX; drag.sy = e.clientY;
  drag.ghost = null; drag.hover = null; drag.targetIdx = -1;
  try { tile.setPointerCapture(e.pointerId); } catch { }
  tile.addEventListener('pointermove', onTilePointerMove);
  tile.addEventListener('pointerup', onTilePointerUp);
  tile.addEventListener('pointercancel', onTilePointerUp);
}

function onTilePointerMove(e) {
  if (!drag.tile) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    hideTip();
    drag.tile.classList.add('dragging');
    const r = drag.tile.getBoundingClientRect();
    drag.ghost = drag.tile.cloneNode(true);
    drag.ghost.className = 'ws-tile ws-drag-ghost';
    drag.ghost.style.width = r.width + 'px';
    drag.ghost.style.height = r.height + 'px';
    document.body.append(drag.ghost);
  }
  if (drag.ghost) {
    drag.ghost.style.left = (e.clientX - 23) + 'px';
    drag.ghost.style.top = (e.clientY - 23) + 'px';
  }
  // a group header under the pointer means "file into that group", not a
  // reorder: highlight the header and park the drop index
  drag.groupTarget = null;
  for (const head of qs('#wsTiles').querySelectorAll('.ws-group-head')) {
    head.classList.remove('drop-hint');
    const r = head.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8) {
      head.classList.add('drop-hint');
      drag.groupTarget = head.dataset.group;
    }
  }

  // nearest tile to the pointer = drop target; before/after by quadrant
  const tiles = [...qs('#wsTiles').children].filter(t => t !== drag.tile && !t.classList?.contains('ws-group-head') && t !== drag.groupHead);
  let best = null, bestD = Infinity, after = false;
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = Math.hypot(e.clientX - cx, e.clientY - cy);
    if (d < bestD) { bestD = d; best = t; after = e.clientY > cy || (Math.abs(e.clientY - cy) < r.height / 2 && e.clientX > cx); }
  }
  if (drag.groupTarget) { drag.hover = null; drag.targetIdx = -1; return; }
  if (drag.hover && drag.hover !== best) drag.hover.classList.remove('drop-hint');
  drag.hover = best;
  if (best) best.classList.add('drop-hint');
  if (best) {
    const all = [...qs('#wsTiles').children];
    let idx = all.indexOf(best);
    const from = all.indexOf(drag.tile);
    if (after) idx += 1;
    if (from < idx) idx -= 1;               // removal shifts the insertion point
    drag.targetIdx = Math.max(0, Math.min(all.length - 1, idx));
  }
}

async function onTilePointerUp(e) {
  const tile = drag.tile;
  if (!tile) return;
  tile.removeEventListener('pointermove', onTilePointerMove);
  tile.removeEventListener('pointerup', onTilePointerUp);
  tile.removeEventListener('pointercancel', onTilePointerUp);
  const wasMoved = drag.moved;
  const targetIdx = drag.targetIdx;
  const groupTarget = drag.groupTarget;
  drag.ghost?.remove();
  drag.ghost = null;
  drag.hover?.classList.remove('drop-hint');
  drag.hover = null;
  for (const head of qs('#wsTiles').querySelectorAll('.ws-group-head')) head.classList.remove('drop-hint');
  drag.groupTarget = null;
  tile.classList.remove('dragging');
  drag.tile = null;
  if (wasMoved) {
    clickSuppressed = true;                  // this pointer was a drag
    setTimeout(() => { clickSuppressed = false; }, 120);
    if (groupTarget) await moveToGroup(drag.wsId, groupTarget);
    else await reorderFromDrag(drag.wsId, targetIdx);
  }
}

async function moveToGroup(wsId, group) {
  if (!wsId || !group) return;
  try {
    await PH().workspaces.setGroup(wsId, group);
    await S.refresh();
    renderSidebar();
    bus.emit('chrome-updated');
    toast({ title: `Moved to “${group.slice(0, 20)}”`, sub: 'Drag onto another group header to refile, or right-click a tile to change it.', type: 'success', ic: 'check', timeout: 2600 });
  } catch { toast({ title: 'Could not move to the group', type: 'error', ic: 'warn' }); }
}

async function reorderFromDrag(wsId, targetIdx) {
  if (!wsId || targetIdx < 0) return;
  const ids = S.workspaces().map(w => w.id);
  const from = ids.indexOf(wsId);
  if (from === -1 || from === targetIdx) return;
  ids.splice(from, 1);
  ids.splice(targetIdx, 0, wsId);
  await persistOrder(ids);
}

async function persistOrder(ids) {
  try {
    await PH().workspaces.reorder(ids);
    await S.refresh();
  } catch { toast({ title: 'Could not reorder', sub: 'The order was not saved - try again', type: 'error', ic: 'warn' }); }
  renderSidebar();
  bus.emit('chrome-updated');
}

async function moveWs(wsId, dir) {
  const ids = S.workspaces().map(w => w.id);
  const i = ids.indexOf(wsId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await persistOrder(ids);
}
function tileMenu(e, w) {
  const n = S.workspaces().length;
  const i = S.workspaces().findIndex(x => x.id === w.id);
  showMenu(e.clientX, e.clientY, [
    { label: 'Open workspace', icon: 'arrowR', kbd: `Alt+${w.num <= 9 ? w.num : ''}`, action: () => Tabs.switchWorkspace(w.id) },
    { label: 'Set up email…', icon: 'mail', action: () => { Tabs.switchWorkspace(w.id); openWizard(w.id); } },
    { sep: true },
    { label: i > 0 ? 'Move up in the list' : 'Move up in the list', icon: 'chevL', disabled: i <= 0, action: () => moveWs(w.id, -1) },
    { label: 'Move down in the list', icon: 'chevR', disabled: i >= n - 1, action: () => moveWs(w.id, 1) },
    { sep: true },
    { label: 'Workspace settings…', icon: 'gear', action: () => wsSettingsModal(w.id) },
    { label: (w.proxy && w.proxy.enabled) ? 'Proxy settings…' : 'Route through a proxy…', icon: 'globe', action: () => wsSettingsModal(w.id, { focusNetwork: true }) },
    { label: 'Rename…', icon: 'user', action: () => renameDialog(w) },
    ...groupMenuItems(w),
    { label: 'Duplicate workspace', icon: 'copy', action: () => duplicate(w) },
    { sep: true },
    { label: 'Delete workspace', icon: 'trash', danger: true, action: () => deleteFlow(w) }
  ]);
}

function groupMenuItems(w) {
  const items = [];
  const names = [...new Set(S.workspaces().map(x => x.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const g of names.slice(0, 6)) {
    if (g === w.group) continue;
    items.push({ label: `Move to “${g.slice(0, 22)}”`, icon: 'chevD', action: () => moveToGroup(w.id, g) });
  }
  items.push({
    label: w.group ? 'Move to another group…' : 'Move to group…', icon: 'panel',
    action: async () => {
      const name = await promptModal('Group (empty = no group)', w.group || '');
      if (name === null) return;
      await moveToGroup(w.id, name.trim() || null);
    }
  });
  if (w.group) items.push({ label: 'Remove from group', icon: 'close', action: () => moveToGroup(w.id, null) });
  return items;
}

async function renameDialog(w) {
  const name = await promptModal('Rename workspace', w.name);
  if (name && name.trim()) {
    await PH().workspaces.rename(w.id, name.trim().slice(0, 80));
    await S.refresh();
    renderSidebar(); bus.emit('chrome-updated');
  }
}

export async function duplicate(w) {
  const created = await PH().workspaces.duplicate(w.id);
  await S.refresh();
  renderSidebar();
  Tabs.switchWorkspace(created.id);
  // pre-arm the wizard on the SAME provider: tabs, route and group carried
  // over; one click on "Open signup page" gives the clone its own person
  const prov = w.identity?.provider || 'atomic';
  const { openWizardAt } = await import('./wizard.js');
  openWizardAt(created.id, 'identity', 'guided', prov);
  toast({ title: `Workspace ${created.num} is ready`, sub: `Tabs${w.proxy && w.proxy.mode === 'custom' ? ', proxy route' : ''}${w.group ? ', group' : ''} copied over — the wizard is pre-armed to create a fresh identity on the same provider.`, type: 'success', ic: 'copy', timeout: 7000 });
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

  // recency: every activation becomes the head of the trail; the bars of
  // tiles you switch away from fade one step per later switch. The active
  // highlight moves with it (tiles are toggled in place - no re-render that
  // could disturb an in-flight drag or focus)
  // seed the trail with the workspace the boot restored as active, so the
  // first manual switch already paints a correct "last used" bar
  const bootActive = S.getActiveWsId();
  if (bootActive) noteRecency(bootActive);
  bus.on('ws-activated', ({ wsId }) => {
    try {
      noteRecency(wsId);
      const root = qs('#wsTiles');
      if (root) for (const t of root.children) {
        const on = t.dataset.ws === wsId;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    } catch { }
  });
}
