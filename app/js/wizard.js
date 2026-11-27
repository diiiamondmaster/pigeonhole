// Email onboarding wizard - docked panel that walks through:
//   choose path -> pick a provider -> generate an identity -> create the
//   mailbox (with live autofill on the provider's signup form) -> save.
//
// The signup page opens inside the workspace itself, so the account is born in
// the very session (cookies, storage) it will live in.
import { el, qs, escapeHtml, strength, fmtDate, copyText } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { PROVIDERS, PHONE_LABEL, providerById } from './providers.js';
import { detectIn, providerFillIn } from './autofill.js';
import { toast } from './toasts.js';

const sessions = new Map();   // wsId -> session
let pollTimer = null;
let currentWsId = null;

const FIRST = ['marcus', 'elena', 'julian', 'aria', 'theo', 'nadia', 'leo', 'clara', 'adam', 'maya', 'felix', 'iris', 'nolan', 'ruth', 'oscar', 'june', 'hugo', 'ivy', 'dean', 'wren', 'silas', 'jade', 'aaron', 'lila', 'reid', 'nova', 'easton', 'sage', 'jonah', 'pearl', 'milo', 'estelle', 'arlen', 'josephine', 'barnaby', 'colette', 'emerick', 'harriet', 'lars', 'margot'];
const LAST = ['hayden', 'brooks', 'carver', 'dalton', 'ellis', 'farrow', 'grant', 'hollis', 'irving', 'jansen', 'keller', 'lowe', 'mercer', 'nash', 'oakley', 'preston', 'quill', 'rhodes', 'sawyer', 'tanner', 'ulrich', 'vance', 'whitmore', 'yeats', 'ashford', 'bennett', 'caldwell', 'draper', 'embry', 'fairbanks', 'gibbs', 'hartley', 'ingram', 'jarvis', 'kingsley', 'lockwood', 'monroe', 'norwood', 'osgood', 'thorne'];
const WORDS = ['otter', 'sprout', 'quiet', 'fawn', 'ember', 'harbor', 'cipher', 'meadow', 'lunar', 'cobalt', 'juniper', 'walnut', 'pixel', 'tundra', 'saffron', 'gadget', 'nimbus', 'orchid', 'pebble', 'raven', 'sonnet', 'thistle', 'umbra', 'velvet', 'willow', 'zephyr', 'acorn', 'bramble', 'cinder', 'dapple'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];

export function genPassword(len = 16, symbols = true) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnpqrstuvwxyz', digits = '23456789';
  const sym = '!@#$%&*?+=-_';
  let pool = upper + lower + digits + (symbols ? sym : '');
  let out = [upper[rnd(upper.length)], lower[rnd(lower.length)], digits[rnd(digits.length)]];
  if (symbols) out.push(sym[rnd(sym.length)]);
  while (out.length < len) out.push(pool[rnd(pool.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

export function genExtras() {
  return {
    first: pick(FIRST), last: pick(LAST),
    dob: { y: 1985 + rnd(18), m: 1 + rnd(12), d: 1 + rnd(28) },
    gender: Math.random() < 0.5 ? 'male' : 'female',
    answer: pick(WORDS) + (100 + rnd(900))
  };
}

export function zeroPad(n, w) { return String(n).padStart(w, '0'); }

export function nextNumberFor(base) {
  if (!base) return null;
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
  let max = 0, found = false;
  for (const w of S.workspaces()) {
    const local = (w.identity?.email || '').split('@')[0];
    const m = local && local.match(re);
    if (m) { found = true; max = Math.max(max, parseInt(m[1], 10)); }
  }
  return found ? max + 1 : (S.settings().identityStart || 1);
}

// ------------------------------------------------------------------
export function openWizard(wsId) {
  currentWsId = wsId;
  if (!sessions.has(wsId)) {
    const st = S.settings();
    const extras = genExtras();
    const base = st.identityBase || '';
    sessions.set(wsId, {
      wsId, step: 'path', mode: 'guided', providerId: null, customUrl: '',
      draft: {
        mode: st.identityMode || 'numbered',
        base, num: nextNumberFor(base), padding: st.identityPadding || 3,
        first: extras.first, last: extras.last, word: pick(WORDS), wordSuffix: 100 + rnd(900), customLocal: '',
        nameSuffix: 100 + rnd(900),
        domain: '', pwMode: st.hasSharedPassword ? 'shared' : 'generate',
        pwCustom: '', pwGen: genPassword(st.pwLength || 16, st.pwSymbols !== false),
        extras
      },
      // instant-address mode (mail.tm): one API call, no CAPTCHA, live inbox
      instant: { address: '', msgs: [], lastPoll: 0, known: [], openMsg: null, msgDetail: null, busy: false, error: '' },
      // multi-step signup pages need several attempts: the budget only counts
      // fills that actually filled something, so dead screens burn nothing
      fillsLeft: 8, fillReport: null, wizardTabId: null, created: false, providerName: ''
    });
  }
  renderPanel();
  if (!S.ws(wsId)) {
    // stale snapshot (workspace just created) - heal instead of silently no-op
    S.refresh().then(() => { if (sessions.has(wsId)) renderPanel(); }).catch(() => { });
  }
  if (!pollTimer) pollTimer = setInterval(wizardPoll, 1500);
}

export function closeWizard() {
  qs('#wizardPanel').classList.add('hidden');
}

// is the wizard panel open for this workspace? (the offer bar stays out of the way)
export function isWizardActiveFor(wsId) {
  if (qs('#wizardPanel').classList.contains('hidden')) return false;
  return currentWsId === wsId;
}

function session() {
  return currentWsId ? sessions.get(currentWsId) || null : null;
}

function emailPreview(s) {
  const d = s.draft;
  const prov = providerById(s.providerId);
  const domain = d.domain || prov?.domains?.[0] || 'example.com';
  let local = '';
  if (s.mode === 'existing') return d.existingEmail || '';
  if (d.mode === 'numbered') local = d.base ? d.base + zeroPad(d.num || 1, d.padding) : '';
  else if (d.mode === 'human') local = `${d.first}.${d.last}${d.nameSuffix || 100}`.replace(/[^a-z0-9._-]/g, '');
  else if (d.mode === 'words') local = d.word + (d.wordSuffix || 100);
  else local = d.customLocal;
  return local ? `${local}@${domain}` : '';
}

// ------------------------------------------------------------------
function renderPanel() {
  const panel = qs('#wizardPanel');
  panel.classList.remove('hidden');
  const s = session();
  if (!s) { closeWizard(); return; }
  const w = S.ws(s.wsId);

  panel.replaceChildren(
    el('div', { class: 'panel-head' },
      el('div', { class: 'grow' },
        el('h2', { text: 'Email setup' }),
        el('div', { class: 'sub', text: w ? `Workspace ${w.num} · ${w.name}` : 'New workspace' })),
      el('button', { class: 'icon-btn sm', html: icon('close', 15), title: 'Close (you can resume later)', onclick: closeWizard })
    ),
    stepsBar(s),
    el('div', { class: 'panel-body' }, stepBody(s))
  );
}

function stepsBar(s) {
  const steps = s.mode === 'existing' ? ['path', 'identity', 'confirm']
    : s.mode === 'instant' ? ['path', 'instant', 'inbox']
      : ['path', 'provider', 'identity', 'create', 'confirm'];
  const idx = steps.indexOf(s.step);
  return el('div', { class: 'wz-steps' },
    steps.map((_, i) => el('div', { class: `st ${i < idx ? 'done' : ''} ${i === idx ? 'cur' : ''}` })));
}

function stepBody(s) {
  if (s.step === 'path') return stepPath(s);
  if (s.step === 'instant') return stepInstant(s);
  if (s.step === 'inbox') return stepInbox(s);
  if (s.step === 'provider') return stepProvider(s);
  if (s.step === 'identity') return s.mode === 'existing' ? stepExisting(s) : stepIdentity(s);
  if (s.step === 'create') return stepCreate(s);
  if (s.step === 'confirm') return stepConfirm(s);
  return stepPath(s);
}

// ---------------- step 1: path ----------------
function stepPath(s) {
  return el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'How do you want to give this workspace an email?' })),
    choiceCard('wand', 'Get an instant address (automatic)',
      'Pigeonhole creates a real working mailbox for you over the free mail.tm service - no CAPTCHA, no forms, nothing personal. The inbox fills in right here. Best when signup sites just need to receive mail.',
      s.mode === 'instant', () => { s.mode = 'instant'; s.step = (S.ws(s.wsId)?.disposable?.address) ? 'inbox' : 'instant'; renderPanel(); }),
    choiceCard('mail', 'Create a new email account (guided)',
      'Pick a provider that does not demand a phone number, generate a numbered identity, and autofill the signup form. You solve the CAPTCHA, Pigeonhole does the typing.',
      s.mode === 'guided', () => { s.mode = 'guided'; s.step = 'provider'; renderPanel(); }),
    choiceCard('key', 'Use an email I already have',
      'Connect a mailbox you already own. Pigeonhole remembers it as this workspace\u2019s identity and autofills it everywhere.',
      s.mode === 'existing', () => { s.mode = 'existing'; s.step = 'identity'; renderPanel(); }),
    el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', lineHeight: '1.5' }, text: 'Every workspace keeps its own cookies, cache and storage - accounts in different workspaces never see each other.' })
  );
}

function choiceCard(ic, title, sub, on, click) {
  return el('button', { class: `choice-card ${on ? 'on' : ''}`, onclick: click },
    el('span', { class: 'cc-ico', html: icon(ic, 17) }),
    el('span', { class: 'grow' },
      el('h4', { text: title }),
      el('p', { text: sub })));
}

// ---------------- step 2: provider ----------------
function stepProvider(s) {
  // Continue unlocks live while the custom URL is being typed, not only on
  // the re-renders triggered by card clicks.
  const gate = () => !s.providerId || (s.providerId === 'other' && !/^https?:\/\//.test(s.customUrl || ''));
  const continueBtn = el('button', {
    class: 'btn btn-primary', text: 'Continue',
    disabled: gate(),
    onclick: () => { s.step = 'identity'; renderPanel(); }
  });
  const syncContinue = () => { continueBtn.disabled = gate(); };

  const cards = PROVIDERS.map(p => {
    const badge = PHONE_LABEL[p.phone];
    return el('div', {
      class: `provider-card ${s.providerId === p.id ? 'on' : ''}`,
      onclick: () => { s.providerId = p.id; s.draft.domain = p.domains[0]; renderPanel(); }
    },
      el('div', { class: 'pc-head' },
        el('h4', { text: p.name }),
        p.recommended ? el('span', { class: 'pill accent', text: 'No phone' }) : null,
        el('span', { class: 'pill muted', text: `${p.domains.length > 1 ? p.domains.length + ' domains' : p.domains[0]}` })),
      el('div', { class: 'pc-note', text: p.notes }),
      el('div', { class: 'pc-badges' },
        el('span', { class: `pill ${badge.cls}`, text: badge.label }),
        el('span', { class: 'pill muted', text: `Human check: ${p.humanCheck}` }),
        el('span', { class: 'pill muted', text: `Free: ${p.free}` })));
  });

  const otherCard = el('div', {
    class: `provider-card ${s.providerId === 'other' ? 'on' : ''}`,
    onclick: () => { s.providerId = 'other'; renderPanel(); }
  },
    el('div', { class: 'pc-head' }, el('h4', { text: 'Other provider' })),
    el('input', {
      class: 'input', type: 'url', placeholder: 'https://signup.example.com/…',
      value: s.customUrl, style: { marginTop: '8px' },
      oninput: (e) => { s.customUrl = e.target.value.trim(); if (s.providerId !== 'other') { s.providerId = 'other'; renderPanel(); } else syncContinue(); },
      onclick: (e) => { e.stopPropagation(); if (s.providerId !== 'other') { s.providerId = 'other'; renderPanel(); } }
    }),
    el('div', { class: 'pc-note', style: { marginTop: '6px' }, text: 'Bring any signup URL. Autofill does its best on unknown forms; you can always type the rest by hand.' }));

  return el('div', {},
    el('div', { class: 'field' }, el('label', { text: 'Where should this mailbox live?' }),
      el('div', { class: 'hint', style: { marginBottom: '10px' }, text: 'These providers do not require a phone number (checked November 2026 - details in Help > Email provider notes).' })),
    ...cards, otherCard,
    el('div', { class: 'row', style: { marginTop: '14px' } },
      el('button', { class: 'btn btn-ghost', html: icon('chevL', 14) + ' Back', onclick: () => { s.step = 'path'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      continueBtn));
}

// ---------------- step 3: identity ----------------
function stepIdentity(s) {
  const d = s.draft;
  const prov = providerById(s.providerId);
  const st = S.settings();

  const preview = emailPreview(s);
  let pwShown = d.pwMode === 'shared' ? null : (d.pwMode === 'generate' ? d.pwGen : d.pwCustom);
  const pwLabel = { shared: 'Shared password', generate: 'Generated', custom: 'Custom' }[d.pwMode];
  const str = strength(pwShown || 'sharedpW!1234');

  // Live elements updated while the user types, so the email preview, the
  // strength meter and the primary button never go stale. (A full re-render
  // on every keystroke would rebuild the DOM and drop input focus.)
  const emailEl = el('div', { class: 'id-email', html: previewHtml(preview) });
  const meterEl = el('div', { class: 'meter' }, el('i', { class: str.cls, style: { width: str.pct + '%' } }));
  const meterHintEl = el('div', { class: 'hint', text: `Strength: ${str.label}` });
  const pwLenEl = el('span', { text: pwLabel + ' · ' + (d.pwMode === 'shared' ? 'from Settings' : (pwShown || '').length + ' chars') });
  const primaryBtn = el('button', {
    class: 'btn btn-primary', text: 'Open signup page',
    disabled: gate(),
    onclick: () => enterCreate(s)
  });
  const sync = () => {
    const prev = emailPreview(s);
    emailEl.innerHTML = previewHtml(prev);
    primaryBtn.disabled = gate();
    pwLenEl.textContent = pwLabel + ' · ' + (d.pwMode === 'shared' ? 'from Settings' : ((d.pwMode === 'generate' ? d.pwGen : d.pwCustom) || '').length + ' chars');
    const pw = d.pwMode === 'shared' ? null : (d.pwMode === 'generate' ? d.pwGen : d.pwCustom);
    if (pw) {
      const st2 = strength(pw);
      meterEl.style.display = '';
      const bar = meterEl.firstChild;
      bar.className = st2.cls; bar.style.width = st2.pct + '%';
      meterHintEl.textContent = `Strength: ${st2.label}`;
    } else { meterEl.style.display = 'none'; meterHintEl.textContent = ''; }
  };
  function previewHtml(p) {
    return p ? `${escapeHtml(p.split('@')[0])}<span style="color:var(--text-faint)">@${escapeHtml(p.split('@')[1] || '')}</span>` : '<span style="color:var(--text-faint)">your-address@…</span>';
  }
  function gate() {
    const prev = emailPreview(s);
    return !prev || (d.pwMode === 'shared' && !st.hasSharedPassword) || (d.pwMode === 'custom' && !d.pwCustom);
  }
  sync();   // normalize meter/hint visibility for the initial state

  const body = el('div', {},
    el('div', { class: 'identity-card' },
      emailEl,
      el('div', { class: 'id-row' },
        pwLenEl,
        el('span', { class: 'pill muted', text: prov ? prov.name : 'Custom provider' }))),
    el('div', { style: { height: '14px' } }),

    // local part mode
    el('div', { class: 'field' },
      el('label', { text: 'Address style' }),
      el('div', { class: 'seg' },
        segBtn('numbered', 'Numbered', d.mode, () => { d.mode = 'numbered'; if (!d.num) d.num = nextNumberFor(d.base); renderPanel(); }, true),
        segBtn('human', 'Human name', d.mode, () => { d.mode = 'human'; renderPanel(); }, true),
        segBtn('words', 'Word pair', d.mode, () => { d.mode = 'words'; renderPanel(); }, true),
        segBtn('custom', 'Custom', d.mode, () => { d.mode = 'custom'; renderPanel(); }, true))),

    d.mode === 'numbered' ? el('div', {},
      el('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
        el('div', { class: 'field grow', style: { marginBottom: '0' } },
          el('label', { text: 'Base handle' }),
          el('input', { class: 'input', value: d.base, placeholder: 'your usual handle', oninput: (e) => { d.base = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, ''); sync(); } })),
        el('div', { class: 'field', style: { marginBottom: '0', width: '92px' } },
          el('label', { text: 'Number' }),
          el('input', { class: 'input', type: 'number', min: 1, value: d.num, oninput: (e) => { d.num = Math.max(1, parseInt(e.target.value) || 1); sync(); } }))),
      el('div', { class: 'row', style: { gap: '8px' } },
        el('div', { class: 'field', style: { marginBottom: '0' } },
          el('label', { text: 'Zero padding' }),
          el('div', { class: 'seg' },
            [1, 2, 3, 4].map(p2 => segBtn('p' + p2, String(p2), 'p' + d.padding, () => { d.padding = p2; renderPanel(); })))),
        el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13) + ' Next number', title: 'Jump to the next free number for this base', onclick: () => { d.num = nextNumberFor(d.base) || d.num; renderPanel(); } })),
      exampleHint(d)
    ) : null,

    d.mode === 'human' ? el('div', { class: 'row', style: { gap: '8px' } },
      nameField('First name', d.first, (v) => { d.first = v; sync(); }, 'first'),
      nameField('Last name', d.last, (v) => { d.last = v; sync(); }, 'last'),
      el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13), title: 'New name', onclick: () => { const e2 = genExtras(); d.first = e2.first; d.last = e2.last; renderPanel(); } })) : null,

    d.mode === 'words' ? el('div', { class: 'row', style: { gap: '8px' } },
      el('div', { class: 'field grow', style: { marginBottom: '0' } },
        el('label', { text: 'Word' }),
        el('input', { class: 'input', value: d.word, oninput: (e) => { d.word = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); sync(); } })),
      el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13), title: 'New word', onclick: () => { d.word = pick(WORDS); renderPanel(); } })) : null,

    d.mode === 'custom' ? el('div', { class: 'field' },
      el('label', { text: 'Local part (before the @)' }),
      el('input', { class: 'input mono', value: d.customLocal, placeholder: 'anything-you-like', oninput: (e) => { d.customLocal = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, ''); sync(); } })) : null,

    // domain
    prov && prov.domains.length > 1 ? el('div', { class: 'field' },
      el('label', { text: 'Domain' }),
      el('select', { class: 'input', onchange: (e) => { d.domain = e.target.value; sync(); } },
        prov.domains.map(dm => el('option', { value: dm, text: '@' + dm, selected: dm === (d.domain || prov.domains[0]) ? '' : null })))) : null,

    s.providerId === 'other' ? el('div', { class: 'field' },
      el('label', { text: 'Email domain (after the @)' }),
      el('input', {
        class: 'input mono', placeholder: 'the part after @ in your new address',
        value: d.domain || '',
        oninput: (e) => { d.domain = e.target.value.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ''); sync(); }
      }),
      el('div', { class: 'hint', text: 'Type the domain the signup form will offer, so the saved identity matches the real address.' })) : null,

    el('div', { class: 'divider' }),

    // password
    el('div', { class: 'field' },
      el('label', { text: 'Password' }),
      el('div', { class: 'seg', style: { marginBottom: '10px' } },
        segBtn('shared', 'Shared', d.pwMode, () => { d.pwMode = 'shared'; renderPanel(); }, !!st.hasSharedPassword),
        segBtn('generate', 'Generate', d.pwMode, () => { d.pwMode = 'generate'; d.pwGen = genPassword(st.pwLength || 16, st.pwSymbols !== false); renderPanel(); }, true),
        segBtn('custom', 'Custom', d.pwMode, () => { d.pwMode = 'custom'; renderPanel(); }, true)),
      d.pwMode === 'shared'
        ? (st.hasSharedPassword
          ? el('div', { class: 'hint', text: 'Uses the shared password from Settings. One password for every mailbox - easy to remember, but a leak exposes all of them.' })
          : el('div', { class: 'hint warn', text: 'No shared password set yet - configure one in Settings > Identities (or pick Generate).' }))
        : null,
      d.pwMode === 'generate'
        ? el('div', { class: 'row' },
            el('input', { class: 'input mono grow', readonly: '', value: d.pwGen }),
            el('button', { class: 'btn btn-sm', html: icon('dice', 13), title: 'New password', onclick: () => { d.pwGen = genPassword(S.settings().pwLength || 16, S.settings().pwSymbols !== false); renderPanel(); } }))
        : null,
      d.pwMode === 'custom'
        ? el('input', { class: 'input mono', type: 'password', placeholder: 'Type a password', value: d.pwCustom, oninput: (e) => { d.pwCustom = e.target.value; sync(); } })
        : null,
      meterEl,
      meterHintEl),

    el('details', { style: { marginTop: '4px' } },
      el('summary', { style: { fontSize: '11.5px', color: 'var(--text-faint)', cursor: 'pointer', marginBottom: '8px' }, text: 'Extra details (for provider forms that ask)' }),
      el('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
        nameField('First', d.extras.first, (v) => { d.extras.first = v; }, 'first'),
        nameField('Last', d.extras.last, (v) => { d.extras.last = v; }, 'last')),
      el('div', { class: 'row', style: { gap: '8px' } },
        el('div', { class: 'field grow', style: { marginBottom: '0' } },
          el('label', { text: 'Birth date (auto)' }),
          el('input', { class: 'input', value: `${d.extras.dob.y}-${zeroPad(d.extras.dob.m, 2)}-${zeroPad(d.extras.dob.d, 2)}`, onchange: (e) => { const p = e.target.value.split('-').map(Number); if (p.length === 3) d.extras.dob = { y: p[0], m: p[1], d: p[2] }; } })),
        el('div', { class: 'field', style: { marginBottom: '0', width: '110px' } },
          el('label', { text: 'Gender' }),
          el('select', { class: 'input', onchange: (e) => { d.extras.gender = e.target.value; } },
            ['male', 'female', 'diverse'].map(g => el('option', { value: g, text: g, selected: g === d.extras.gender ? '' : null })))))),

    el('div', { class: 'row', style: { marginTop: '16px' } },
      el('button', { class: 'btn btn-ghost', html: icon('chevL', 14) + ' Back', onclick: () => { s.step = 'provider'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      primaryBtn)
  );
  return body;
}

// the numbered-mode example line, kept fresh by sync-driven re-renders
function exampleHint(d) {
  return el('div', { class: 'hint', text: `Example: ${d.base || 'yourhandle'}${zeroPad(d.num || 1, d.padding)}@${d.domain || 'provider'}` });
}

function nameField(label, value, oninput, key) {
  return el('div', { class: 'field grow', style: { marginBottom: '0' } },
    el('label', { text: label }),
    el('input', { class: 'input', value: value, oninput: (e) => oninput(e.target.value.replace(/[^a-zA-Z-]/g, '')) }));
}

function segBtn(key, label, cur, click, enabled = true) {
  return el('button', {
    class: `${key === cur ? 'on accent' : ''}`, disabled: enabled ? null : '', text: label,
    onclick: enabled ? click : null,
    title: enabled ? '' : 'Not available'
  });
}

// ---------------- step 4: create ----------------
async function enterCreate(s) {
  const prov = providerById(s.providerId);
  const url = s.providerId === 'other' ? s.customUrl : prov.signupUrl;
  s.providerName = prov ? prov.name : 'Custom provider';
  s.step = 'create';
  s.fillsLeft = 8;
  s.fillReport = null;
  // open the signup page in this workspace (reuse the current tab if it's on the new tab page)
  const wsId = s.wsId;
  const cur = Tabs.currentTab(wsId);
  if (cur && cur.url.startsWith('pigeonhole://newtab')) {
    s.wizardTabId = cur.id;
    Tabs.navigate(wsId, url);
  } else {
    const t = Tabs.createTab(wsId, { url, active: true });
    s.wizardTabId = t.id;
  }
  renderPanel();
}

function stepCreate(s) {
  const prov = providerById(s.providerId);
  const url = s.providerId === 'other' ? s.customUrl : prov?.signupUrl || '';
  const inboxUrl = prov?.inboxUrl || '';
  const report = s.fillReport;

  const items = [
    checkItem(s.pageLoaded, s.pageLoaded ? '' : 'current',
      'Open the signup page', `${prov ? prov.name : 'Custom'} - ${url.replace(/^https?:\/\//, '').slice(0, 48)}…`),
    checkItem(!!s.fillReport, s.fillReport ? '' : (s.pageLoaded ? 'current' : ''),
      'Autofill the form', (() => {
        if (!report) {
          return 'Modern providers show a plan picker first - pick Free and continue. Filling starts the moment the address form appears.';
        }
        if (!report.ok) return 'Could not read this form - fill it by hand';
        const bits = [];
        if (report.filled?.length) bits.push(`Filled ${report.filled.join(', ')}`);
        if (report.missed?.length) bits.push(`not found: ${report.missed.join(', ')}`);
        if (report.notes?.length) bits.push(report.notes.join(' · '));
        if (report.captcha) bits.push('CAPTCHA is left for you');
        return bits.join(' - ') || 'Nothing to fill yet';
      })()),
    checkItem(s.created, s.created ? '' : 'current',
      'Solve the CAPTCHA and submit', `Human check: ${prov?.humanCheck || 'unknown'}. Pigeonhole never touches CAPTCHAs.`),
  ];

  return el('div', {},
    el('div', { class: 'hint', style: { marginBottom: '10px' }, text: 'Pigeonhole watches this tab and fills every field it can as the form appears; the CAPTCHA and the final click are yours.' }),
    el('ul', { class: 'checklist' }, items),
    el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap', gap: '8px' } },
      el('button', { class: 'btn btn-sm', html: icon('wand', 13) + ' Fill again', onclick: () => runFill(s, true) }),
      inboxUrl ? el('button', { class: 'btn btn-sm btn-ghost', html: icon('inbox', 13) + ' Open inbox in a new tab', onclick: () => Tabs.createTab(s.wsId, { url: inboxUrl, active: false }) }) : null,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Change identity', onclick: () => { s.step = 'identity'; renderPanel(); } })),
    el('div', { class: 'divider' }),
    el('p', { style: { fontSize: '11px', color: 'var(--text-faint)', margin: '0 0 14px', lineHeight: '1.55' }, text: 'Pigeonhole also notices when the signup finishes by itself and moves on. If the provider rejected the chosen address, go back, change the identity and try again.' }),
    el('button', { class: 'btn btn-primary btn-block', style: { height: '38px' }, html: icon('check', 15) + ' I have created the account', onclick: () => { s.created = true; s.step = 'confirm'; renderPanel(); } })
  );
}

function checkItem(done, cur, title, sub) {
  return el('li', { class: `${done ? 'done' : ''} ${cur ? 'cur' : ''}` },
    el('span', { class: 'ck', html: icon('check', 11) }),
    el('span', { class: 'ck-body' },
      el('div', { text: title }),
      el('div', { class: 'ck-sub', text: sub })));
}

// ---------------- step 5: confirm ----------------
function stepConfirm(s) {
  const d = s.draft;
  const w = S.ws(s.wsId);
  const email = emailPreview(s) || d.existingEmail || '';
  const local = email.split('@')[0] || '';
  const domain = email.split('@')[1] || '';

  return el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'Email address' }),
      el('div', { class: 'row', style: { gap: '0' } },
        el('input', { class: 'input mono', style: { borderRadius: '7px 0 0 7px' }, value: local, oninput: (e) => { d.confirmLocal = e.target.value.trim(); } }),
        el('span', { class: 'input', style: { borderRadius: '0 7px 7px 0', borderLeft: 'none', color: 'var(--text-faint)', background: 'var(--surface-3)' }, text: '@' + (domain || '…') }))),
    el('div', { class: 'field' },
      el('label', { text: 'Password' }),
      el('div', { class: 'row' },
        el('input', { class: 'input mono grow', type: 'password', id: 'wzPw', value: d.pwMode === 'shared' ? '' : (d.pwMode === 'generate' ? d.pwGen : d.pwCustom), oninput: (e) => { d.pwFinal = e.target.value; } }),
        el('button', { class: 'btn btn-sm', html: icon('eye', 14), title: 'Show', onclick: (e) => { const i = qs('#wzPw'); i.type = i.type === 'password' ? 'text' : 'password'; } }),
        el('button', { class: 'btn btn-sm', html: icon('copy', 14), title: 'Copy', onclick: async () => { await copyText(qs('#wzPw').value || await currentPassword(s), 'Password copied'); } }))),
    el('div', { class: 'field' },
      el('label', { text: 'Display name (optional)' }),
      el('input', { class: 'input', value: d.extras ? `${d.extras.first} ${d.extras.last}` : '', oninput: (e) => { d.displayName = e.target.value; } })),
    el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', lineHeight: '1.5' }, text: 'Stored in this workspace\u2019s vault, encrypted with your operating system\u2019s credential store when available.' }),
    el('div', { class: 'row', style: { marginTop: '14px' } },
      el('button', { class: 'btn btn-ghost', text: 'Back', onclick: () => { s.step = s.mode === 'existing' ? 'identity' : 'create'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn-primary', html: icon('check', 14) + ' Save workspace identity', onclick: () => saveIdentity(s) }))
  );
}

async function currentPassword(s) {
  const d = s.draft;
  if (d.pwMode === 'shared') return (await PH().vault.secret(s.wsId, 'shared')) || '';
  if (d.pwMode === 'generate') return d.pwGen;
  return d.pwCustom;
}

async function saveIdentity(s) {
  const d = s.draft;
  const email = emailPreview(s);
  const local = d.confirmLocal || email.split('@')[0];
  const domain = email.split('@')[1] || '';
  const finalEmail = `${local}@${domain}`.replace(/@+/g, '@');
  if (!finalEmail.includes('@') || !finalEmail.split('@')[1].includes('.')) {
    toast({ title: 'That email address does not look right', sub: finalEmail, ic: 'warn' });
    return;
  }
  const password = d.pwFinal || await currentPassword(s);
  const displayName = (d.displayName ?? (d.extras ? `${d.extras.first} ${d.extras.last}` : '')).trim();
  await PH().vault.setIdentity(s.wsId, { email: finalEmail, password, displayName, provider: s.providerName || 'Existing' });
  await S.refresh();
  bus.emit('chrome-updated');
  s.step = 'done';
  sessions.delete(s.wsId);
  closeWizard();
  const w = S.ws(s.wsId);
  if (!w) return;   // workspace was deleted mid-wizard
  toast({
    title: `Workspace ${w.num} is ready`,
    sub: `${finalEmail} - its own cookies, storage and identity`,
    type: 'success', ic: 'check', timeout: 5200
  });
  import('./sidebar.js').then(m => m.renderSidebar());
  import('./identity.js').then(m => m.syncFillBtn());
}

// ---------------- instant address (mail.tm / mail.gw) ----------------
// local part from the same address-style machinery the guided path uses
function instantLocal(s) {
  const d = s.draft;
  if (d.mode === 'numbered') return d.base ? d.base + zeroPad(d.num || 1, d.padding) : '';
  if (d.mode === 'human') return `${d.first}.${d.last}${d.nameSuffix || 100}`.replace(/[^a-z0-9._-]/g, '');
  if (d.mode === 'words') return d.word + (d.wordSuffix || 100);
  return d.customLocal;
}

function stepInstant(s) {
  const d = s.draft;
  const st = S.settings();
  const inst = s.instant;
  const local = instantLocal(s);
  const prov = S.ws(s.wsId)?.disposable;

  const createBtn = el('button', {
    class: 'btn btn-primary', html: icon('wand', 14) + ' Create the mailbox',
    disabled: inst.busy || !local || (d.pwMode === 'custom' && !d.pwCustom),
    onclick: () => createInstant(s)
  });

  const body = el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'Address style' }),
      el('div', { class: 'seg' },
        segBtn('numbered', 'Numbered', d.mode, () => { d.mode = 'numbered'; if (!d.num) d.num = nextNumberFor(d.base); renderPanel(); }, true),
        segBtn('human', 'Human name', d.mode, () => { d.mode = 'human'; renderPanel(); }, true),
        segBtn('words', 'Word pair', d.mode, () => { d.mode = 'words'; renderPanel(); }, true),
        segBtn('custom', 'Custom', d.mode, () => { d.mode = 'custom'; renderPanel(); }, true))),

    d.mode === 'numbered' ? el('div', {},
      el('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
        el('div', { class: 'field grow', style: { marginBottom: '0' } },
          el('label', { text: 'Base handle' }),
          el('input', { class: 'input', value: d.base, placeholder: 'your usual handle', oninput: (e) => { d.base = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, ''); createBtn.disabled = !instantLocal(s) || inst.busy; } })),
        el('div', { class: 'field', style: { marginBottom: '0', width: '92px' } },
          el('label', { text: 'Number' }),
          el('input', { class: 'input', type: 'number', min: 1, value: d.num, oninput: (e) => { d.num = Math.max(1, parseInt(e.target.value) || 1); } }))),
      el('div', { class: 'hint', text: `Preview: ${local || '…'}@<domain chosen at creation> \u00b7 the mail.tm API picks a free domain for you.` })) : null,

    d.mode === 'human' ? el('div', { class: 'row', style: { gap: '8px' } },
      nameField('First name', d.first, (v) => { d.first = v; }, 'first'),
      nameField('Last name', d.last, (v) => { d.last = v; }, 'last'),
      el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13), title: 'New name', onclick: () => { const e2 = genExtras(); d.first = e2.first; d.last = e2.last; renderPanel(); } })) : null,

    d.mode === 'words' ? el('div', { class: 'row', style: { gap: '8px' } },
      el('div', { class: 'field grow', style: { marginBottom: '0' } },
        el('label', { text: 'Word' }),
        el('input', { class: 'input', value: d.word, oninput: (e) => { d.word = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); createBtn.disabled = !instantLocal(s) || inst.busy; } })),
      el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13), title: 'New word', onclick: () => { d.word = pick(WORDS); renderPanel(); } })) : null,

    d.mode === 'custom' ? el('div', { class: 'field' },
      el('label', { text: 'Local part (before the @)' }),
      el('input', { class: 'input mono', value: d.customLocal, placeholder: 'anything-you-like', oninput: (e) => { d.customLocal = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, ''); createBtn.disabled = !instantLocal(s) || inst.busy; } })) : null,

    el('div', { class: 'divider' }),
    el('div', { class: 'field' },
      el('label', { text: 'Password' }),
      el('div', { class: 'seg', style: { marginBottom: '10px' } },
        segBtn('generate', 'Generate', d.pwMode, () => { d.pwMode = 'generate'; renderPanel(); }, true),
        segBtn('custom', 'Custom', d.pwMode, () => { d.pwMode = 'custom'; renderPanel(); }, true)),
      d.pwMode === 'generate'
        ? el('div', { class: 'row' },
            el('input', { class: 'input mono grow', readonly: '', value: d.pwGen }),
            el('button', { class: 'btn btn-sm', html: icon('dice', 13), title: 'New password', onclick: () => { d.pwGen = genPassword(st.pwLength || 16, st.pwSymbols !== false); renderPanel(); } }))
        : el('input', { class: 'input mono', type: 'password', placeholder: 'Type a password (8+ chars)', value: d.pwCustom, oninput: (e) => { d.pwCustom = e.target.value; createBtn.disabled = !instantLocal(s) || !d.pwCustom || inst.busy; } })),

    inst.error ? el('div', { class: 'hint warn', style: { marginBottom: '10px' }, text: inst.error }) : null,
    inst.busy ? el('div', { class: 'hint', style: { marginBottom: '10px' }, text: 'Creating the mailbox\u2026 (a few seconds)' }) : null,

    el('div', { class: 'row', style: { marginTop: '14px' } },
      el('button', { class: 'btn btn-ghost', html: icon('chevL', 14) + ' Back', onclick: () => { s.step = 'path'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      createBtn),

    el('p', { style: { fontSize: '11px', color: 'var(--text-faint)', lineHeight: '1.55', margin: '10px 0 0' }, html:
      'Powered by <b>mail.tm</b> (with mail.gw as fallback) - free, no CAPTCHA, nothing personal. Mailboxes live until unused for months; a fresh one is always one click away. Instant addresses are disposable: some sites refuse them - use a real provider when a mailbox must last.' }),

    prov?.address ? el('div', { class: 'hint', style: { marginTop: '10px' }, text: `This workspace already has ${prov.address} - creating a new one replaces it.` }) : null
  );
  return body;
}

async function createInstant(s) {
  const inst = s.instant;
  if (inst.busy) return;
  inst.busy = true;
  inst.error = '';
  renderPanel();
  try {
    const local = instantLocal(s);
    const password = s.draft.pwMode === 'custom' ? s.draft.pwCustom : s.draft.pwGen;
    let rec = null, lastErr = '';
    for (let attempt = 0; attempt < 3 && !rec; attempt++) {
      try { rec = await PH().temp.create(s.wsId, attempt === 0 ? local : local + rnd(900)); }
      catch (e) { lastErr = String(e.message || e); }
    }
    if (!rec?.address) throw new Error(lastErr || 'the service did not answer');
    inst.address = rec.address;
    // the workspace identity is this mailbox - fill buttons everywhere work
    const d = s.draft;
    await PH().vault.setIdentity(s.wsId, {
      email: rec.address,
      password,
      displayName: `${d.extras.first} ${d.extras.last}`,
      provider: 'Instant (mail.tm)'
    });
    await S.refresh();
    s.step = 'inbox';
    inst.msgs = [];
    inst.lastPoll = 0;      // poll immediately
    toast({ title: 'Mailbox ready', sub: rec.address + ' - identity saved, the inbox is watching', type: 'success', ic: 'check', timeout: 4200 });
    import('./sidebar.js').then(m => m.renderSidebar());
    import('./identity.js').then(m => m.syncFillBtn());
  } catch (e) {
    inst.error = 'Could not create the mailbox: ' + String(e.message || e).slice(0, 120) + '. The service may be busy - try again.';
  }
  inst.busy = false;
  renderPanel();
}

function stepInbox(s) {
  const inst = s.instant;
  const w = S.ws(s.wsId);
  const address = inst.address || w?.disposable?.address || w?.identity?.email || '';
  const msgs = inst.msgs || [];

  const list = msgs.length
    ? msgs.map(m => {
      const isOpen = inst.openMsg === m.id;
      return el('div', { class: `msg-item ${m.seen ? 'seen' : ''} ${isOpen ? 'open' : ''}` },
        el('div', {
          class: 'msg-row', style: { cursor: 'pointer' },
          onclick: () => { inst.openMsg = isOpen ? null : m.id; inst.msgDetail = null; if (!isOpen) fetchInstantMessage(s, m.id); else renderPanel(); }
        },
          el('span', { class: 'msg-ico', html: icon(m.seen ? 'mail' : 'inbox', 14) }),
          el('span', { class: 'grow' },
            el('div', { class: 'msg-subj', text: m.subject || '(no subject)' }),
            el('div', { class: 'msg-meta', text: `${m.from || 'unknown'} \u00b7 ${fmtDate(new Date(m.createdAt || Date.now()).getTime())}` })),
          el('span', { class: 'pill muted', text: m.hasAttachments ? 'attach' : '' })),
        isOpen && inst.msgDetail ? msgDetailBody(s, m) : (isOpen ? el('div', { class: 'msg-body', text: 'loading\u2026' }) : null));
    })
    : el('div', { class: 'hint', style: { padding: '18px 6px', textAlign: 'center' }, text: inst.busy ? 'checking the inbox\u2026' : 'No mail yet. Verification mails usually arrive within a minute - this panel checks automatically.' });

  return el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'This workspace\u2019s address' }),
      el('div', { class: 'row' },
        el('input', { class: 'input mono grow', readonly: '', value: address }),
        el('button', { class: 'btn btn-sm', html: icon('copy', 14), title: 'Copy address', onclick: async () => { await copyText(address, 'Address copied'); } }))),
    el('div', { class: 'row', style: { margin: '0 0 10px' } },
      el('button', { class: 'btn btn-sm', html: icon('reload', 13) + ' Refresh', onclick: () => { s.instant.lastPoll = 0; renderPanel(); pollInbox(s, true); } }),
      el('span', { class: 'grow' }),
      el('span', { class: 'hint', text: msgs.length ? `${msgs.length} message${msgs.length === 1 ? '' : 's'}` : '' })),
    el('div', { class: 'msg-list' }, list),
    el('p', { style: { fontSize: '10.5px', color: 'var(--text-faint)', margin: '10px 0 0', lineHeight: '1.5' }, html:
      'Instant inboxes by <b>mail.tm</b> \u00b7 this panel polls while it stays open, never through the workspace proxy.' }),
    el('div', { class: 'row', style: { marginTop: '14px' } },
      el('button', { class: 'btn btn-ghost', text: 'Back', onclick: () => { s.step = 'instant'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn-primary', html: icon('check', 14) + ' Done', onclick: () => { sessions.delete(s.wsId); closeWizard(); bus.emit('chrome-updated'); } }))
  );
}

function msgDetailBody(s, m) {
  const det = inst_detail(s);
  return el('div', {},
    el('div', { class: 'msg-intro', text: det.text ? (det.text.slice(0, 600) + (det.text.length > 600 ? '\u2026' : '')) : (m.intro || '(empty body)') }),
    det.links?.length ? el('div', { class: 'msg-links' },
      det.links.slice(0, 6).map(u => el('button', {
        class: 'btn btn-sm', style: { margin: '3px 4px 3px 0', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: 'Open ' + u, text: '\u2192 ' + (u.replace(/^https?:\/\//, '').slice(0, 42)),
        onclick: () => Tabs.createTab(s.wsId, { url: u, active: true })
      }))) : null);
}

// the message detail is cached on the session; helper keeps render functions honest
function inst_detail(s) { return s.instant.msgDetail || { text: '', links: [] }; }

async function fetchInstantMessage(s, msgId) {
  renderPanel();
  try {
    const det = await PH().temp.message(s.wsId, msgId);
    if (s.instant.openMsg === msgId) {
      s.instant.msgDetail = det.ok ? det : { text: det.error || 'could not load', links: [] };
      renderPanel();
    }
  } catch (e) {
    if (s.instant.openMsg === msgId) { s.instant.msgDetail = { text: String(e.message || e), links: [] }; renderPanel(); }
  }
}

// inbox poll - driven by the wizard's existing 1.5s loop, gated to ~8s
async function pollInbox(s, manual = false) {
  const inst = s.instant;
  const now = Date.now();
  if (!manual && now - inst.lastPoll < 8000) return;
  inst.lastPoll = now;
  inst.busy = true;
  try {
    const res = await PH().temp.inbox(s.wsId);
    inst.busy = false;
    if (!res?.ok) { if (manual) toast({ title: 'Inbox check failed', sub: (res?.error || '').slice(0, 90), type: 'error', ic: 'warn' }); return; }
    const known = new Set(inst.known);
    const fresh = (res.messages || []).filter(m => !known.has(m.id));
    inst.msgs = res.messages || [];
    inst.known = (res.messages || []).map(m => m.id);
    if (fresh.length) {
      const first = fresh[0];
      toast({ title: `Mail arrived: ${first.subject || '(no subject)'}`.slice(0, 70), sub: (first.from || '') + ' - click the wizard to read it', type: 'success', ic: 'mail', timeout: 6000 });
    }
    renderPanel();
  } catch { inst.busy = false; }
}

// ---------------- existing-email path ----------------
function stepExisting(s) {
  // Continue must unlock while the user types - the gate is recomputed live
  // instead of being baked in at render time (where it would stay disabled).
  const gate = () => !/.+@.+\..+/.test(s.draft.existingEmail || '') || !(s.draft.existingPw || '').length;
  const sync = (btn) => { btn.disabled = gate(); };
  const continueBtn = el('button', {
    class: 'btn btn-primary', text: 'Continue',
    disabled: gate(),
    onclick: () => {
      s.draft.pwMode = 'custom';
      s.draft.pwCustom = s.draft.existingPw;
      s.draft.confirmLocal = s.draft.existingEmail.split('@')[0];
      s.draft.domainOverride = s.draft.existingEmail.split('@')[1];
      s.providerName = 'Existing';
      s.step = 'confirm';
      renderPanel();
    }
  });
  return el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'Email address' }),
      el('input', { class: 'input mono', type: 'email', placeholder: 'name@provider.com', oninput: (e) => { s.draft.existingEmail = e.target.value.trim(); sync(continueBtn); } })),
    el('div', { class: 'field' },
      el('label', { text: 'Password' }),
      el('input', { class: 'input mono', type: 'password', placeholder: 'Mailbox password', oninput: (e) => { s.draft.existingPw = e.target.value; sync(continueBtn); } })),
    el('div', { class: 'field' },
      el('label', { text: 'Display name (optional)' }),
      el('input', { class: 'input', oninput: (e) => { s.draft.displayName = e.target.value; } })),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-ghost', html: icon('chevL', 14) + ' Back', onclick: () => { s.step = 'path'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      continueBtn));
}

// ---------------- wizard poll loop ----------------
async function wizardPoll() {
  const s = session();
  if (!s || qs('#wizardPanel').classList.contains('hidden')) return;
  // instant-address inbox keeps polling while the panel is open
  if (s.mode === 'instant' && s.step === 'inbox') { pollInbox(s).catch(() => { }); return; }
  if (s.step !== 'create') return;
  const wsId = s.wsId;
  const tab = Tabs.list(wsId).find(t => t.id === s.wizardTabId);
  if (!tab) return;
  if (!s.pageLoaded && tab.domReady && !tab.loading) { s.pageLoaded = true; renderPanel(); }
  const wv = Tabs.webviewOf(wsId, tab);
  if (!wv || !tab.url || tab.url.startsWith('pigeonhole://')) return;

  // auto-fill whenever a recognizable form shows up (until the budget runs
  // out). Multi-step flows are covered: dead screens (plan pickers) never
  // consume the budget, and each new step that shows empty fields is filled.
  // A screen whose identity field already holds OUR value is done - no loops.
  if (s.fillsLeft > 0 && S.settings().autoFillOnLoad !== false) {
    const d = await detectIn(wv);
    if (d && !d.error && (d.hasEmail || d.hasUsername || d.hasPass) && !d.password
      && !((d.hasEmail || d.hasUsername) && d.email && d.emailOurs && !d.hasPass)) {
      await runFill(s, false);
    }
  }

  // success detection: trust the provider's own post-signup pages
  if (!s.created && S.settings().autoDetectSuccess !== false) {
    const prov = providerById(s.providerId);
    const url = tab.url || '';
    if (prov?.successPatterns?.some(re => re.test(url))) {
      s.created = true;
      s.step = 'confirm';
      toast({ title: 'Signup looks complete', sub: 'Confirm the details to save the identity', type: 'success', ic: 'check' });
      renderPanel();
    }
  }
}

async function runFill(s, manual) {
  const wsId = s.wsId;
  const tab = Tabs.list(wsId).find(t => t.id === s.wizardTabId);
  if (!tab) return;
  const wv = Tabs.webviewOf(wsId, tab);
  if (!wv) return;
  const email = emailPreview(s);
  const password = await currentPassword(s);
  const d = s.draft;
  const result = await providerFillIn(wv, {
    email, password,
    first: d.extras.first, last: d.extras.last,
    dob: d.extras.dob, gender: d.extras.gender, answer: d.extras.answer
  });
  // always show what happened - silence reads as "it never even tried"
  s.fillReport = result || { ok: false, error: 'script blocked' };
  if (!manual && result && result.filled && result.filled.length) {
    s.fillsLeft = Math.max(0, s.fillsLeft - 1);   // only successful fills cost
  }
  renderPanel();
  if (manual) {
    toast({
      title: result?.ok && result.filled?.length ? 'Filled ' + result.filled.join(', ') : 'Nothing new to fill',
      sub: [result?.notes?.join(' · '), result?.captcha ? 'CAPTCHA stays yours' : ''].filter(Boolean).join(' · '),
      ic: 'wand', type: 'info', timeout: 4200
    });
  }
}

export function openWizardAt(wsId, step, mode = 'guided', providerId = 'proton') {
  openWizard(wsId);
  const s = session();
  if (s) {
    s.mode = mode;
    if (mode === 'guided') { s.providerId = providerId; s.draft.domain = providerById(providerId)?.domains?.[0] || ''; }
    s.step = step || s.step;
    renderPanel();
  }
}

// ---- dev-only scripted flow against a mock provider signup page ----
export async function driveMockFlow(wsId, mockUrl, { hold = false, domain = 'mockmail.com', base = 'tester', num = 7 } = {}) {
  // the real UI always lands the user on the new workspace before the wizard
  // runs; a hidden webview reports 0x0 rects and the scan finds nothing
  Tabs.switchWorkspace(wsId);
  openWizard(wsId);
  const s = session();
  s.mode = 'guided';
  s.providerId = 'other';
  s.customUrl = mockUrl;
  s.draft.base = base;
  s.draft.num = num;
  s.draft.padding = 3;
  s.draft.pwMode = 'generate';
  s.draft.domain = domain;
  s.step = 'provider';
  await enterCreate(s);
  // wait for the auto-fill to happen
  for (let i = 0; i < 30 && !s.fillReport; i++) await new Promise(r => setTimeout(r, 500));
  console.log('[wizard-test] fillReport:', JSON.stringify(s.fillReport));
  if (hold) { s.step = 'create'; renderPanel(); return { fill: s.fillReport }; }
  s.created = true;
  s.step = 'confirm';
  renderPanel();
  await saveIdentity(s);
  const w = S.ws(wsId);
  console.log('[wizard-test] identity saved:', w?.identity?.email, '| workspace name:', w?.name);
  return { fill: s.fillReport, email: w?.identity?.email };
}

// ---- dev-only scripted instant-address flow (E2E) ----
export async function driveInstantFlow(wsId, { local = 'tester777' } = {}) {
  Tabs.switchWorkspace(wsId);
  openWizard(wsId);
  const s = session();
  s.mode = 'instant';
  s.draft.mode = 'custom';
  s.draft.customLocal = local;
  s.draft.pwMode = 'generate';
  s.step = 'instant';
  renderPanel();
  await createInstant(s);
  const w = S.ws(wsId);
  const out = {
    step: s.step,
    error: s.instant.error || null,
    address: s.instant.address,
    disposable: w?.disposable ? { address: w.disposable.address, api: w.disposable.api } : null,
    identity: w?.identity ? { email: w.identity.email, provider: w.identity.provider } : null
  };
  // let one inbox poll land (mock API answers instantly)
  for (let i = 0; i < 20 && !(s.instant.msgs || []).length; i++) {
    await new Promise(r => setTimeout(r, 400));
    await pollInbox(s, true).catch(() => {});
  }
  out.msgs = (s.instant.msgs || []).map(m => ({ id: m.id, from: m.from, subject: m.subject }));
  console.log('[wizard-test] instant:', JSON.stringify(out));
  return out;
}
