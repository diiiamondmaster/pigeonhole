// Workspace cycler (beta.7): Ctrl+Tab / Ctrl+Shift+Tab walks the
// workspaces in most-recently-used order, Alt+Tab style. Each press moves
// the selection inside a small overlay; the switch commits a moment after
// the last press (so rapid tapping cycles without switching mid-way), and
// Escape cancels outright. The tile trail ladder encodes the same MRU
// order - this is that list, hands on the keyboard.
import { el } from './util.js';
import * as S from './state.js';
import * as Tabs from './tabs.js';
import { mruIds } from './sidebar.js';

let pending = null;   // { order: [wsId...], idx, timer }
let root = null;
const COMMIT_MS = 550;

export function cycleWorkspace(dir = 1) {
  const order = mruIds();
  if (order.length < 2) return;
  if (!pending) {
    pending = { order, idx: 0 };
  } else {
    pending.order = order;   // MRU shifts as you cycle; keep it fresh
  }
  pending.idx = (pending.idx + (dir > 0 ? 1 : -1) + order.length) % order.length;
  show();
  clearTimeout(pending.timer);
  pending.timer = setTimeout(commit, COMMIT_MS);
}

function commit() {
  if (!pending) return;
  const id = pending.order[pending.idx];
  dismiss();
  if (id && id !== S.getActiveWsId()) Tabs.switchWorkspace(id);
}
function dismiss() {
  if (pending) { clearTimeout(pending.timer); }
  pending = null;
  root?.remove();
  root = null;
  window.removeEventListener('keydown', onKey, true);
}
function onKey(e) {
  if (!pending) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
  else if (e.key === 'ArrowRight' || (e.ctrlKey && e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); cycleWorkspace(1); }
  else if (e.key === 'ArrowLeft' || (e.ctrlKey && e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); cycleWorkspace(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); commit(); }
}

function show() {
  if (!root) {
    root = el('div', { class: 'cycler-ovr', role: 'dialog', 'aria-label': 'Switch workspace' });
    document.body.append(root);
    window.addEventListener('keydown', onKey, true);
  }
  const rows = pending.order.map((id, i) => {
    const w = S.ws(id);
    if (!w) return null;
    return el('div', {
      class: 'cycler-row' + (i === pending.idx ? ' sel' : '') + (id === S.getActiveWsId() ? ' cur' : ''),
      onclick: () => { pending.idx = i; commit(); }
    },
      el('span', { class: 'cycler-num', style: { '--h': w.hue }, text: String(w.num) }),
      el('span', { class: 'cycler-name', text: w.name.slice(0, 30) }),
      el('span', { class: 'cycler-tag', text: id === S.getActiveWsId() ? 'current' : (i === pending.idx ? '→' : '') }));
  }).filter(Boolean);
  root.replaceChildren(el('div', { class: 'cycler-box' }, ...rows,
    el('div', { class: 'cycler-foot', text: 'Tab/←→ cycle · Enter switch · Esc stay' })));
  root.querySelectorAll('.cycler-row')[pending.idx]?.scrollIntoView({ block: 'nearest' });
}
