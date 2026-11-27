// Tab switcher (beta.7): Ctrl+K opens a palette over everything; type a few
// letters, it fuzzy-matches open tabs ACROSS ALL WORKSPACES (title + URL +
// workspace name), Enter jumps there - switching the workspace and
// activating the tab. A "new tab" row at the bottom covers the
// nothing-matches case. Self-contained overlay: appended to body on open,
// removed on close.
import { el, qs } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import * as Tabs from './tabs.js';

let root = null;
let activeIdx = 0;

const isUrlish = (q) => /^[a-z]+:\/\//i.test(q) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(q);

export function openSwitcher() {
  if (root) { closeSwitcher(); return; }
  activeIdx = 0;
  root = el('div', { class: 'switcher-ovr', role: 'dialog', 'aria-label': 'Search tabs' });
  const input = el('input', {
    class: 'switcher-input', type: 'text', placeholder: 'Search open tabs across all workspaces…',
    spellcheck: 'false', autocomplete: 'off'
  });
  const list = el('div', { class: 'switcher-list', role: 'listbox' });
  root.append(el('div', { class: 'switcher-box' },
    el('div', { class: 'switcher-head' },
      el('span', { class: 'switcher-ic', html: icon('search', 15) }),
      input,
      el('span', { class: 'switcher-kbd', text: 'Esc' })),
    list,
    el('div', { class: 'switcher-foot', text: '↑↓ move · Enter jump · across every workspace' })));
  document.body.append(root);
  input.focus();

  input.addEventListener('input', () => renderList(list, input.value.trim()));
  input.addEventListener('keydown', (e) => {
    const rows = [...list.querySelectorAll('.switcher-row')];
    if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) setActive((activeIdx + 1) % rows.length, rows); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) setActive((activeIdx - 1 + rows.length) % rows.length, rows); }
    else if (e.key === 'Home') { e.preventDefault(); if (rows.length) setActive(0, rows); }
    else if (e.key === 'End') { e.preventDefault(); if (rows.length) setActive(rows.length - 1, rows); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIdx];
      if (row) row.click();
      else if (input.value.trim()) newTabRow(input.value.trim()).click();
    }
  });
  renderList(list, '');
}

export function closeSwitcher() {
  root?.remove();
  root = null;
}

function setActive(i, rows) {
  activeIdx = i;
  rows.forEach((r, idx) => r.classList.toggle('active', idx === i));
  rows[i]?.scrollIntoView({ block: 'nearest' });
}

// subsequence fuzzy score: earlier + denser + prefix matches rank higher
function score(hay, needle) {
  hay = (hay || '').toLowerCase();
  needle = (needle || '').toLowerCase();
  if (!needle) return 1;
  if (hay.includes(needle)) return 100 - hay.indexOf(needle);
  let hi = 0, hits = 0, first = -1;
  for (const ch of needle) {
    const found = hay.indexOf(ch, hi);
    if (found === -1) return 0;
    if (first === -1) first = found;
    hits += found === hi ? 2 : 1;
    hi = found + 1;
  }
  return 40 + hits - first;
}

function allTabs() {
  const out = [];
  for (const w of S.workspaces()) {
    for (const t of Tabs.list(w.id)) {
      out.push({ w, t });
    }
  }
  return out;
}

function newTabRow(q) {
  const url = isUrlish(q) ? (/^[a-z]+:\/\//i.test(q) ? q : 'https://' + q) : `pigeonhole://newtab?ws=${S.getActiveWsId()}&q=${encodeURIComponent(q)}`;
  return el('div', {
    class: 'switcher-row switcher-new', role: 'option',
    onclick: () => {
      const wsId = S.getActiveWsId();
      closeSwitcher();
      Tabs.createTab(wsId, { url, active: true });
    }
  },
    el('span', { class: 'fav', html: icon('plus', 13) }),
    el('span', { class: 'title', text: `Open in a new tab: ${q.slice(0, 60)}` }));
}

function renderList(list, q) {
  activeIdx = 0;
  const rows = [];
  if (q) {
    const scored = [];
    for (const { w, t } of allTabs()) {
      const sc = Math.max(score(t.title, q), score(t.url, q) * 0.8, score(w.name, q) * 0.6);
      if (sc > 0) scored.push({ sc, w, t });
    }
    scored.sort((a, b) => b.sc - a.sc);
    for (const { w, t } of scored.slice(0, 12)) rows.push(tabRow(w, t));
    rows.push(newTabRow(q));
  } else {
    // no query: every workspace's ACTIVE tab, most recently used first
    for (const w of S.workspaces()) {
      const t = Tabs.list(w.id).find(x => x.active) || Tabs.list(w.id)[0];
      if (t) rows.push(tabRow(w, t));
    }
  }
  list.replaceChildren(...(rows.length ? rows : [el('div', { class: 'switcher-empty', text: q ? 'No open tab matches — Enter opens a new one.' : 'No open tabs.' })]));
  setActive(0, [...list.querySelectorAll('.switcher-row')]);
}

function tabRow(w, t) {
  const row = el('div', {
    class: 'switcher-row', role: 'option',
    onclick: () => {
      closeSwitcher();
      if (S.getActiveWsId() !== w.id) Tabs.switchWorkspace(w.id);
      Tabs.activateTab(w.id, t.id);
    }
  },
    el('span', { class: 'fav' },
      t.favicon ? el('img', { src: t.favicon, alt: '' }) : el('span', { html: icon('globe', 13) })),
    el('span', { class: 'title', text: t.title || (t.url.startsWith('pigeonhole://newtab') ? 'New Tab' : t.url) }),
    el('span', { class: 'ws-tag', style: { '--h': w.hue } },
      el('b', { text: String(w.num) }),
      el('span', { text: w.name.slice(0, 18) })),
    el('span', { class: 'kbd', text: 'Enter' }));
  return row;
}
