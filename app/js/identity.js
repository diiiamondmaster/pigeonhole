// Identity integration: watches the active page for login / signup forms,
// offers one-click fills with the workspace identity, and captures submitted
// credentials so they can be saved into the workspace vault.
import { el, qs, originOf, escapeHtml } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { detectIn, siteFillIn } from './autofill.js';
import { toast } from './toasts.js';

let pollTimer = null;
let ntpTimer = null;
const dismissed = new Set();     // "origin|kind" for this session
let pendingCreds = null;         // {wsId, origin, email, password}
let currentOffer = null;

export function initIdentity() {
  pollTimer = setInterval(pollPage, 1600);
  ntpTimer = setInterval(pollNtp, 420);

  bus.on('page-nav', ({ wsId, url, prev }) => {
    // a navigation away from a page where credentials were typed -> offer save
    if (pendingCreds && pendingCreds.wsId === wsId && prev && pendingCreds.origin && pendingCreds.origin === originOf(prev)) {
      showSaveOffer(pendingCreds);
      pendingCreds = null;
    } else {
      hideOffer();
    }
  });
  bus.on('ws-activated', hideOffer);
  bus.on('tab-activated', hideOffer);

  qs('#fillBtn').innerHTML = icon('wand', 15) + '<span>Fill identity</span>';
  qs('#fillBtn').addEventListener('click', () => fillActivePage());
  bus.on('active-tab-updated', syncFillBtn);
  bus.on('ws-activated', syncFillBtn);
}

export function syncFillBtn() {
  const w = S.activeWs();
  qs('#fillBtn').classList.toggle('hidden', !w?.identity);
}

async function activeWebview() {
  const wsId = S.getActiveWsId();
  const tab = Tabs.currentTab(wsId);
  if (!tab || !tab.url || tab.url.startsWith('pigeonhole://')) return null;
  return Tabs.webviewOf(wsId, tab);
}

let busy = false;
async function pollPage() {
  if (busy) return;
  const wv = await activeWebview();
  if (!wv) return;
  const wsId = S.getActiveWsId();
  // the wizard owns filling while it is open on this workspace
  try {
    const { isWizardActiveFor } = await import('./wizard.js');
    if (isWizardActiveFor(wsId)) return;
  } catch { }
  busy = true;
  try {
    const d = await detectIn(wv);
    if (!d || d.kind === 'none' || d.error) return;
    const wsId = S.getActiveWsId();
    const url = Tabs.currentTab(wsId)?.url || '';
    const origin = originOf(url);
    if (!origin) return;

    // remember typed credentials for the save prompt
    if (d.email && d.password) {
      pendingCreds = { wsId, origin, email: d.email, password: d.password };
    }

    if (currentOffer && currentOffer.origin === origin && currentOffer.kind === d.kind) return; // already shown
    if (dismissed.has(origin + '|' + d.kind)) return;
    if (currentOffer && currentOffer.origin !== origin) hideOffer();

    const w = S.ws(wsId);
    if (d.kind === 'login') {
      showOffer(origin, 'login', w?.identity ? `Sign-in form detected — fill <b>${escapeHtml(w.identity.email)}</b>?` : 'Sign-in form detected', w?.identity ? 'Fill identity' : null, w?.identity);
    } else if (d.kind === 'signup') {
      showOffer(origin, 'signup', w?.identity ? `Sign-up form detected — use <b>${escapeHtml(w.identity.email)}</b> here?` : 'Sign-up form detected', w?.identity ? 'Fill identity' : null, w?.identity);
    }
  } finally { busy = false; }
}

function showOffer(origin, kind, html, actionLabel, identity) {
  const bar = qs('#offerBar');
  bar.classList.remove('hidden');
  currentOffer = { origin, kind };
  // replaceChildren stringifies null args into literal "null" text nodes -
  // filter them out
  bar.replaceChildren(...[
    el('span', { class: 'ob-ico', html: icon(kind === 'login' ? 'key' : 'wand', 16) }),
    el('span', { class: 'ob-text', html }),
    identity && kind === 'login' ? el('button', { class: 'btn btn-sm', text: 'Save login after signing in', title: 'After you sign in, Pigeonhole will offer to store these site credentials in the workspace vault', onclick: () => hideOffer() }) : null,
    actionLabel ? el('button', { class: 'btn btn-sm btn-primary', text: actionLabel, onclick: () => fillActivePage() }) : null,
    el('button', { class: 'btn btn-sm btn-ghost', text: 'Ignore', onclick: () => { dismissed.add(origin + '|' + kind); hideOffer(); } })
  ].filter(Boolean));
}

function showSaveOffer(creds) {
  if (!creds?.email || !creds?.password) return;
  const bar = qs('#offerBar');
  bar.classList.remove('hidden');
  currentOffer = { origin: creds.origin, kind: 'save' };
  const w = S.ws(creds.wsId);
  if (w?.accounts?.some(a => a.origin === creds.origin && a.email === creds.email)) return hideOffer();
  bar.replaceChildren(
    el('span', { class: 'ob-ico', html: icon('shield', 16) }),
    el('span', { class: 'ob-text', html: `Save login for <b>${escapeHtml(creds.origin.replace(/^https?:\/\//, ''))}</b> (${escapeHtml(creds.email)}) in this workspace?` }),
    el('button', {
      class: 'btn btn-sm btn-primary', text: 'Save', onclick: async () => {
        await PH().vault.addAccount(creds.wsId, { origin: creds.origin, email: creds.email, password: creds.password, title: '' });
        S.refresh();
        toast({ title: 'Login saved to workspace vault', sub: creds.origin.replace(/^https?:\/\//, ''), type: 'success', ic: 'check' });
        hideOffer();
      }
    }),
    el('button', { class: 'btn btn-sm btn-ghost', text: 'Not now', onclick: () => hideOffer() })
  );
}

export function hideOffer() {
  qs('#offerBar').classList.add('hidden');
  currentOffer = null;
}

// fill the current page with the workspace identity (email + password)
export async function fillActivePage() {
  const wsId = S.getActiveWsId();
  const w = S.ws(wsId);
  if (!w?.identity) { toast({ title: 'No identity in this workspace yet', sub: 'Use the + button to set one up', ic: 'warn' }); return; }
  const wv = await activeWebview();
  if (!wv) { toast({ title: 'Nothing to fill', sub: 'Open a web page first', ic: 'info' }); return; }
  const password = await PH().vault.secret(wsId, 'identity');
  const result = await siteFillIn(wv, {
    email: w.identity.email,
    password: password || '',
    first: (w.identity.displayName || '').split(' ')[0] || '',
    last: (w.identity.displayName || '').split(' ').slice(1).join(' ')
  });
  if (result?.ok) {
    const msg = result.filled.length
      ? `Filled ${result.filled.join(', ')}`
      : 'No matching form fields found on this page';
    toast({ title: msg, sub: result.captcha ? 'The CAPTCHA stays yours to solve' : (result.missed.length ? 'Not found: ' + result.missed.join(', ') : ''), type: 'info', ic: 'wand', timeout: 3000 });
  } else {
    toast({ title: 'Could not read this page', sub: 'Some sites block autofill scripts', ic: 'warn' });
  }
}

// ---- internal page action polling (new tab page + error page) ----
async function pollNtp() {
  const wsId = S.getActiveWsId();
  const tab = Tabs.currentTab(wsId);
  if (!tab?.url || !tab.url.startsWith('pigeonhole://')) return;
  const wv = Tabs.webviewOf(wsId, tab);
  if (!wv) return;
  try {
    const action = await wv.executeJavaScript('(window.__phAction || null)', false);
    if (action && action.type) {
      await wv.executeJavaScript('window.__phAction = null', false);
      handleNtpAction(action, wsId);
    }
  } catch { /* page navigating */ }
}

function handleNtpAction(action, wsId) {
  if (action.type === 'navigate' && typeof action.url === 'string' && /^(https?|pigeonhole):/i.test(action.url)) {
    Tabs.navigate(wsId, action.url);
  } else if (action.type === 'newtab') {
    Tabs.navigate(wsId, `pigeonhole://newtab?ws=${wsId}`);
  } else if (action.type === 'wizard') {
    import('./wizard.js').then(m => m.openWizard(wsId));
  } else if (action.type === 'vault') {
    import('./vault.js').then(m => m.openVault(wsId));
  } else if (action.type === 'settings') {
    import('./modals.js').then(m => m.settingsModal());
  }
}
