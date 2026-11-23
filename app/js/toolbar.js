// Toolbar: navigation buttons, address bar with suggestions, find-in-page.
import { el, qs, escapeHtml, normalizeInput, isLikelyUrl, searchUrl, originOf } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';

let selectedIndex = -1;

export function initToolbar() {
  qs('#backBtn').innerHTML = icon('back', 17);
  qs('#fwdBtn').innerHTML = icon('forward', 17);
  qs('#reloadBtn').innerHTML = icon('reload', 17);
  qs('#homeBtn').innerHTML = icon('home', 17);
  qs('#findPrev').innerHTML = icon('chevL', 14);
  qs('#findNext').innerHTML = icon('chevR', 14);
  qs('#findClose').innerHTML = icon('close', 14);

  qs('#backBtn').addEventListener('click', () => Tabs.goBack(S.getActiveWsId()));
  qs('#fwdBtn').addEventListener('click', () => Tabs.goForward(S.getActiveWsId()));
  qs('#reloadBtn').addEventListener('click', () => Tabs.reload(S.getActiveWsId()));
  qs('#homeBtn').addEventListener('click', () => Tabs.navigate(S.getActiveWsId(), `pigeonhole://newtab?ws=${S.getActiveWsId()}`));

  const addr = qs('#addr');
  addr.addEventListener('focus', () => { addr.select(); addr.classList.add('open'); });
  addr.addEventListener('blur', () => setTimeout(() => { addr.classList.remove('open'); hideSuggest(); }, 160));
  addr.addEventListener('input', () => renderSuggest(addr.value));
  addr.addEventListener('keydown', onAddrKey);

  bus.on('active-tab-updated', () => syncAddr());
  bus.on('ws-activated', () => { syncAddr(); syncNav(); });
  bus.on('page-nav', () => syncNav());

  initFind();
}

export function syncAddr() {
  const wsId = S.getActiveWsId();
  const tab = Tabs.currentTab(wsId);
  const addr = qs('#addr');
  if (document.activeElement === addr) return;
  const url = tab?.url || '';
  addr.value = url.startsWith('pigeonhole://') ? '' : url;
  syncUrlIcon(url);
  qs('#addrProgress').classList.toggle('on', !!tab?.loading);
  qs('#toolbarProgress').style.width = tab?.loading ? '40%' : '0';
}

function syncUrlIcon(url) {
  const ic = qs('#urlIcon');
  if (url.startsWith('pigeonhole://')) ic.innerHTML = icon('grid', 13);
  else if (url.startsWith('https://')) ic.innerHTML = icon('lock', 13);
  else if (url.startsWith('http://')) ic.innerHTML = icon('warn', 13);
  else ic.innerHTML = icon('search', 14);
}

export function syncNav() {
  const wsId = S.getActiveWsId();
  qs('#backBtn').disabled = !Tabs.canGoBack(wsId);
  qs('#fwdBtn').disabled = !Tabs.canGoForward(wsId);
}

function onAddrKey(e) {
  const addr = qs('#addr');
  const items = currentSuggest();
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  else if (e.key === 'Escape') { addr.blur(); syncAddr(); hideSuggest(); }
  else if (e.key === 'Enter') {
    const pick = selectedIndex >= 0 && items[selectedIndex] ? items[selectedIndex].url : null;
    const target = pick || normalizeInput(addr.value, S.settings().searchEngine);
    hideSuggest(); addr.blur();
    if (target) Tabs.navigate(S.getActiveWsId(), target);
  }
}

let suggestItems = [];
function currentSuggest() { return suggestItems; }
function moveSel(d) {
  const box = qs('#suggest');
  if (box.classList.contains('hidden')) return;
  const n = suggestItems.length;
  if (!n) return;
  selectedIndex = (selectedIndex + d + n) % n;
  [...box.children].forEach((c, i) => c.classList.toggle('selected', i === selectedIndex));
}

function renderSuggest(raw) {
  const box = qs('#suggest');
  const q = raw.trim();
  selectedIndex = -1;
  if (!q) { hideSuggest(); return; }
  const engineName = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' }[S.settings().searchEngine || 'google'];
  const items = [];
  if (!isLikelyUrl(q) || /^https?:\/\//i.test(q)) {
    items.push({ type: 'search', title: q, sub: `Search ${engineName}`, url: searchUrl(q, S.settings().searchEngine), icon: 'search' });
  } else {
    items.push({ type: 'url', title: q, sub: 'Open address', url: normalizeInput(q, S.settings().searchEngine), icon: 'globe' });
  }
  const lower = q.toLowerCase();
  for (const h of S.historyFor(S.getActiveWsId())) {
    if (items.length >= 7) break;
    const url = h.url || '';
    const title = h.title || '';
    if (url.toLowerCase().includes(lower) || title.toLowerCase().includes(lower)) {
      items.push({ type: 'history', title: prettySuggest(url), sub: title, url, icon: 'clock' });
    }
  }
  suggestItems = items;
  box.replaceChildren(...items.map((it, i) => el('div', {
    class: 'suggest-item', role: 'option',
    onmousedown: (e) => { e.preventDefault(); hideSuggest(); qs('#addr').blur(); Tabs.navigate(S.getActiveWsId(), it.url); }
  },
    el('span', { class: 's-ico', html: icon(it.icon, 15) }),
    el('span', { class: 's-title', text: it.title.length > 46 ? it.title.slice(0, 46) + '…' : it.title }),
    el('span', { class: 'grow' }),
    el('span', { class: 's-sub', text: it.sub })
  )));
  box.classList.remove('hidden');
}
function prettySuggest(u) { return u.replace(/^https?:\/\//, '').replace(/^www\./, ''); }
function hideSuggest() { qs('#suggest').classList.add('hidden'); suggestItems = []; selectedIndex = -1; }

// ---------- find in page ----------
function initFind() {
  const bar = qs('#findBar'), input = qs('#findInput');
  qs('#findNext').addEventListener('click', () => runFind(1));
  qs('#findPrev').addEventListener('click', () => runFind(-1));
  qs('#findClose').addEventListener('click', closeFind);
  input.addEventListener('input', () => runFind(1, true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') closeFind();
  });
  bus.on('find-result', (e) => {
    qs('#findCount').textContent = e.matches ? `${(e.activeMatchOrdinal || 0)}/${e.matches}` : '';
  });
}
export function toggleFind() {
  const bar = qs('#findBar');
  if (bar.classList.contains('hidden')) {
    bar.classList.remove('hidden');
    qs('#findInput').focus();
    qs('#findInput').select();
  } else closeFind();
}
function runFind(dir, findNext = false) {
  const text = qs('#findInput').value;
  const wv = Tabs.webviewOf(S.getActiveWsId());
  if (!wv || !text) return;
  try { wv.findInPage(text, { forward: dir > 0, findNext: !findNext || undefined }); } catch { }
}
function closeFind() {
  qs('#findBar').classList.add('hidden');
  const wv = Tabs.webviewOf(S.getActiveWsId());
  try { wv?.stopFindInPage('clearSelection'); } catch { }
  qs('#findCount').textContent = '';
}
