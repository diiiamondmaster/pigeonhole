// Extensions quick panel + Ad Shield menu, anchored to the toolbar buttons:
//   - puzzle button (or Ctrl+Shift+E): live toggles for every extension,
//     Ad Shield level presets, per-site override for the page being viewed,
//     and the session blocked-ad count
//   - shield button: a compact Ad Shield menu (levels + per-site + count)
// Also owns the blocked-ad badge on the shield button.
import { el, qs, originOf, hostOf } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { showMenu } from './ctxmenu.js';
import { settingsModal } from './modals.js';
import { toast } from './toasts.js';

const EXT_ICONS = { spellcheck: 'wand', trackershield: 'shield', videospeed: 'speed', adshield: 'shieldCheck' };
const SHORT = {
  spellcheck: 'Underlines misspellings; right-click for fixes',
  trackershield: 'Blocks analytics beacons',
  videospeed: 'S / D / R / V keys on any video',
  adshield: 'Ad blocking with levels'
};

let panel = null;

function closePanel() {
  if (panel) { panel.remove(); panel = null; window.removeEventListener('mousedown', outside, true); }
}
function outside(e) {
  if (panel && !panel.contains(e.target) && e.target.id !== 'extBtn' && !e.target.closest?.('#extBtn')) closePanel();
}

export function toggleExtPanel() {
  if (panel) { closePanel(); return; }
  buildPanel();
}

async function buildPanel() {
  const st = S.settings();
  const exts = await PH().extensions.list();
  const ads = st.adshield || {};
  const level = ads.level || 'standard';
  const counts = await PH().extensions.adsCount();
  const btn = qs('#extBtn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const setLevel = async (l) => {
    await PH().extensions.setConfig({ level: l });
    await S.refresh();
    closePanel(); buildPanel();
  };
  const siteToggle = async () => {
    const org = curOrigin();
    if (!org) return;
    const off = (S.settings().adshield?.sites || {})[org] === 'off';
    await PH().extensions.setConfig({ site: { origin: org, level: off ? null : 'off' } });
    await S.refresh();
    closePanel(); buildPanel();
  };

  const levelSeg = el('div', { class: 'seg ep-seg' }, [['basic', 'Basic'], ['standard', 'Standard'], ['strict', 'Strict']].map(([k, l]) =>
    el('button', { class: k === level ? 'on accent' : '', text: l, onclick: () => setLevel(k) })));

  panel = el('div', { class: 'ext-pop', role: 'dialog', 'aria-label': 'Extensions panel' },
    el('div', { class: 'ep-head' },
      el('b', { text: 'Extensions' }),
      el('button', { class: 'ep-x', html: icon('close', 13), title: 'Close', onclick: closePanel })),
    ...exts.map(x => el('div', { class: 'ep-row' },
      el('span', { class: 'ep-ic', html: icon(EXT_ICONS[x.id] || 'puzzle', 16) }),
      el('span', { class: 'grow' },
        el('b', { text: x.name }),
        el('div', { class: 'ep-sub', text: SHORT[x.id] || x.description.slice(0, 60) })),
      switchEl(x.enabled, async (v) => {
        try {
          await PH().extensions.setEnabled(x.id, v);
          toast({ title: `${x.name} ${v ? 'on' : 'off'}`, sub: v ? 'Applies to every workspace right away.' : 'Off everywhere until switched back on.', type: 'info', ic: 'check', timeout: 3200 });
          closePanel(); buildPanel();
        } catch (e) {
          toast({ title: 'Could not switch the extension', sub: String(e?.message || e), type: 'error', ic: 'warn' });
        }
      }))),
    el('div', { class: 'ep-ads' },
      el('div', { class: 'ep-ads-head' },
        el('span', { html: icon('shieldCheck', 14) + ' Ad Shield level' }),
        el('span', { class: 'ep-count', text: `${counts.total} blocked this session` })),
      levelSeg,
      siteRow()),
    el('div', { class: 'ep-foot' },
      el('button', { class: 'btn btn-sm', text: 'All settings…', onclick: () => { closePanel(); settingsModal('extensions'); } }))
  );

  function siteRow() {
    const org = curOrigin();
    if (!org) {
      return el('div', { class: 'ep-sub', style: { marginTop: '6px' }, text: 'Open a website to pause blocking per site.' });
    }
    const off = (S.settings().adshield?.sites || {})[org] === 'off';
    return el('div', { class: 'ep-site' },
      el('span', { class: 'grow', text: `Block ads on ${hostOf(org)}` }),
      switchEl(!off, () => siteToggle()));
  }

  panel.style.top = (rect.bottom + 8) + 'px';
  panel.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  document.body.append(panel);
  setTimeout(() => window.addEventListener('mousedown', outside, true), 0);
}

function curOrigin() {
  try {
    const t = Tabs.currentTab(S.getActiveWsId());
    return originOf(t?.url || '');
  } catch { return null; }
}

// bare switch (same component as everywhere else)
function switchEl(value, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  return el('span', { class: 'switch' }, input, el('i', {}));
}

// ---------- shield button: compact Ad Shield menu ----------
export function openShieldMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const ads = S.settings().adshield || {};
  const level = ads.level || 'standard';
  const org = curOrigin();
  const siteOff = org && (ads.sites || {})[org] === 'off';
  const setLevel = async (l) => {
    await PH().extensions.setConfig({ level: l });
    await S.refresh();
    toast({ title: `Ad Shield: ${l}`, sub: l === 'basic' ? 'Beacons and trackers only.' : l === 'standard' ? 'Common ad networks + YouTube slots (best effort).' : 'Aggressive patterns + cosmetic hiding.', type: 'info', ic: 'shieldCheck', timeout: 3600 });
  };
  PH().extensions.adsCount().then(c => {
    showMenu(Math.max(8, rect.left - 150), rect.bottom + 6, [
      { label: 'Basic - beacons only', icon: level === 'basic' ? 'check' : '', action: () => setLevel('basic') },
      { label: 'Standard - ad networks + YouTube', icon: level === 'standard' ? 'check' : '', action: () => setLevel('standard') },
      { label: 'Strict - everything, aggressively', icon: level === 'strict' ? 'check' : '', action: () => setLevel('strict') },
      { sep: true },
      ...(org ? [{
        label: siteOff ? `Resume blocking on ${hostOf(org)}` : `Pause blocking on ${hostOf(org)}`,
        icon: siteOff ? 'eye' : 'eyeOff',
        action: async () => {
          await PH().extensions.setConfig({ site: { origin: org, level: siteOff ? null : 'off' } });
          await S.refresh();
        }
      }] : []),
      { sep: true },
      { label: `${c.total} ads blocked this session`, icon: 'shieldCheck', action: () => { } },
      { label: 'All extension settings…', icon: 'puzzle', action: () => settingsModal('extensions') }
    ]);
  }).catch(() => { });
}

// ---------- toolbar badge ----------
export function updateAdsBadge(total) {
  const badge = qs('#shieldBtn .count-badge');
  if (!badge) return;
  badge.textContent = total > 999 ? '999+' : String(total);
  badge.classList.toggle('hidden', !total);
}

export function initExtPanel() {
  const ext = qs('#extBtn');
  const shield = qs('#shieldBtn');
  if (ext) ext.addEventListener('click', (e) => { e.stopPropagation(); toggleExtPanel(); });
  if (shield) shield.addEventListener('click', (e) => { e.stopPropagation(); openShieldMenu(e.currentTarget); });
}
