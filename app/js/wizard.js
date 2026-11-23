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
  const w = S.ws(wsId);
  if (!w) return;
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
        first: extras.first, last: extras.last, word: pick(WORDS), customLocal: '',
        domain: '', pwMode: st.hasSharedPassword ? 'shared' : 'generate',
        pwCustom: '', pwGen: genPassword(st.pwLength || 16, st.pwSymbols !== false),
        extras
      },
      fillsLeft: 2, fillReport: null, wizardTabId: null, created: false, providerName: ''
    });
  }
  renderPanel();
  if (!pollTimer) pollTimer = setInterval(wizardPoll, 1500);
}

export function closeWizard() {
  qs('#wizardPanel').classList.add('hidden');
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
  else if (d.mode === 'human') local = `${d.first}.${d.last}${100 + rnd(0)}`.replace(/[^a-z0-9._-]/g, '');
  else if (d.mode === 'words') local = d.word + (100 + rnd(900));
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
        el('div', { class: 'sub', text: `Workspace ${w.num} · ${w.name}` })),
      el('button', { class: 'icon-btn sm', html: icon('close', 15), title: 'Close (you can resume later)', onclick: closeWizard })
    ),
    stepsBar(s),
    el('div', { class: 'panel-body' }, stepBody(s))
  );
}

function stepsBar(s) {
  const steps = s.mode === 'existing' ? ['path', 'identity', 'confirm'] : ['path', 'provider', 'identity', 'create', 'confirm'];
  const idx = steps.indexOf(s.step);
  return el('div', { class: 'wz-steps' },
    steps.map((_, i) => el('div', { class: `st ${i < idx ? 'done' : ''} ${i === idx ? 'cur' : ''}` })));
}

function stepBody(s) {
  if (s.step === 'path') return stepPath(s);
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
    choiceCard('wand', 'Create a new email account (guided)',
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
      oninput: (e) => { s.customUrl = e.target.value.trim(); },
      onclick: (e) => { e.stopPropagation(); s.providerId = 'other'; renderPanel(); }
    }),
    el('div', { class: 'pc-note', style: { marginTop: '6px' }, text: 'Bring any signup URL. Autofill does its best on unknown forms; you can always type the rest by hand.' }));

  return el('div', {},
    el('div', { class: 'field' }, el('label', { text: 'Where should this mailbox live?' }),
      el('div', { class: 'hint', style: { marginBottom: '10px' }, text: 'These providers do not require a phone number (checked November 2026 - details in Help > Email provider notes).' })),
    ...cards, otherCard,
    el('div', { class: 'row', style: { marginTop: '14px' } },
      el('button', { class: 'btn btn-ghost', html: icon('chevL', 14) + ' Back', onclick: () => { s.step = 'path'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      el('button', {
        class: 'btn btn-primary', text: 'Continue',
        disabled: !s.providerId || (s.providerId === 'other' && !/^https?:\/\//.test(s.customUrl || '')),
        onclick: () => { s.step = 'identity'; renderPanel(); }
      })));
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

  const body = el('div', {},
    el('div', { class: 'identity-card' },
      el('div', { class: 'id-email', html: preview ? `${escapeHtml(preview.split('@')[0])}<span style="color:var(--text-faint)">@${escapeHtml(preview.split('@')[1] || '')}</span>` : '<span style="color:var(--text-faint)">your-address@…</span>' }),
      el('div', { class: 'id-row' },
        el('span', { text: pwLabel + ' · ' + (d.pwMode === 'shared' ? 'from Settings' : (pwShown || '').length + ' chars') }),
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
          el('input', { class: 'input', value: d.base, placeholder: 'your usual handle', oninput: (e) => { d.base = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, ''); } })),
        el('div', { class: 'field', style: { marginBottom: '0', width: '92px' } },
          el('label', { text: 'Number' }),
          el('input', { class: 'input', type: 'number', min: 1, value: d.num, oninput: (e) => { d.num = Math.max(1, parseInt(e.target.value) || 1); } }))),
      el('div', { class: 'row', style: { gap: '8px' } },
        el('div', { class: 'field', style: { marginBottom: '0' } },
          el('label', { text: 'Zero padding' }),
          el('div', { class: 'seg' },
            [1, 2, 3, 4].map(p2 => segBtn('p' + p2, 'p' + p2.replace('p', ''), 'p' + d.padding, () => { d.padding = p2; renderPanel(); })))) ,
        el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13) + ' Next number', title: 'Jump to the next free number for this base', onclick: () => { d.num = nextNumberFor(d.base) || d.num; renderPanel(); } })),
      el('div', { class: 'hint', text: `Example: ${d.base || 'yourhandle'}${zeroPad(d.num || 1, d.padding)}@${d.domain || 'provider'}` })
    ) : null,

    d.mode === 'human' ? el('div', { class: 'row', style: { gap: '8px' } },
      nameField('First name', d.first, (v) => { d.first = v; }, 'first'),
      nameField('Last name', d.last, (v) => { d.last = v; }, 'last'),
      el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13), title: 'New name', onclick: () => { const e2 = genExtras(); d.first = e2.first; d.last = e2.last; renderPanel(); } })) : null,

    d.mode === 'words' ? el('div', { class: 'row', style: { gap: '8px' } },
      el('div', { class: 'field grow', style: { marginBottom: '0' } },
        el('label', { text: 'Word' }),
        el('input', { class: 'input', value: d.word, oninput: (e) => { d.word = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); } })),
      el('button', { class: 'btn btn-ghost btn-sm', style: { alignSelf: 'flex-end' }, html: icon('dice', 13), title: 'New word', onclick: () => { d.word = pick(WORDS); renderPanel(); } })) : null,

    d.mode === 'custom' ? el('div', { class: 'field' },
      el('label', { text: 'Local part (before the @)' }),
      el('input', { class: 'input mono', value: d.customLocal, placeholder: 'anything-you-like', oninput: (e) => { d.customLocal = e.target.value.trim().replace(/[^a-zA-Z0-9._-]/g, ''); } })) : null,

    // domain
    prov && prov.domains.length > 1 ? el('div', { class: 'field' },
      el('label', { text: 'Domain' }),
      el('select', { class: 'input', onchange: (e) => { d.domain = e.target.value; } },
        prov.domains.map(dm => el('option', { value: dm, text: '@' + dm, selected: dm === (d.domain || prov.domains[0]) ? '' : null })))) : null,

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
        ? el('input', { class: 'input mono', type: 'password', placeholder: 'Type a password', value: d.pwCustom, oninput: (e) => { d.pwCustom = e.target.value; } })
        : null,
      pwShown ? el('div', { class: 'meter' }, el('i', { class: str.cls, style: { width: str.pct + '%' } })) : null,
      pwShown ? el('div', { class: 'hint', text: `Strength: ${str.label}` }) : null),

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
      el('button', {
        class: 'btn btn-primary', text: 'Open signup page',
        disabled: !preview || (d.pwMode === 'shared' && !st.hasSharedPassword) || (d.pwMode === 'custom' && !d.pwCustom),
        onclick: () => enterCreate(s)
      }))
  );
  return body;
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
  s.fillsLeft = 2;
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
      'Autofill the form', report
        ? (report.ok
          ? `Filled ${report.filled.join(', ') || 'nothing'}${report.missed.length ? ' - not found: ' + report.missed.join(', ') : ''}${report.captcha ? ' - CAPTCHA is left for you' : ''}`
          : 'Could not read this form - fill it by hand')
        : 'Runs automatically as soon as the form appears. You can also fill manually.'),
    checkItem(s.created, s.created ? '' : 'current',
      'Solve the CAPTCHA and submit', `Human check: ${prov?.humanCheck || 'unknown'}. Pigeonhole never touches CAPTCHAs.`),
  ];

  return el('div', {},
    el('ul', { class: 'checklist' }, items),
    el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap', gap: '8px' } },
      el('button', { class: 'btn btn-sm', html: icon('wand', 13) + ' Fill again', onclick: () => runFill(s, true) }),
      inboxUrl ? el('button', { class: 'btn btn-sm btn-ghost', html: icon('inbox', 13) + ' Open inbox in a new tab', onclick: () => Tabs.createTab(s.wsId, { url: inboxUrl, active: false }) }) : null,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Change identity', onclick: () => { s.step = 'identity'; renderPanel(); } })),
    el('div', { class: 'divider' }),
    el('button', { class: 'btn btn-primary btn-block', html: icon('check', 14) + ' I have created the account', onclick: () => { s.created = true; s.step = 'confirm'; renderPanel(); } }),
    el('p', { style: { fontSize: '11px', color: 'var(--text-faint)', marginTop: '9px', lineHeight: '1.5' }, text: 'Pigeonhole also notices when the signup finishes by itself and moves on. If the provider blocked the chosen address, go back, change the identity and try again.' })
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
  toast({
    title: `Workspace ${w.num} is ready`,
    sub: `${finalEmail} - its own cookies, storage and identity`,
    type: 'success', ic: 'check', timeout: 5200
  });
  import('./sidebar.js').then(m => m.renderSidebar());
  import('./identity.js').then(m => m.syncFillBtn());
}

// ---------------- existing-email path ----------------
function stepExisting(s) {
  return el('div', {},
    el('div', { class: 'field' },
      el('label', { text: 'Email address' }),
      el('input', { class: 'input mono', type: 'email', placeholder: 'name@provider.com', oninput: (e) => { s.draft.existingEmail = e.target.value.trim(); } })),
    el('div', { class: 'field' },
      el('label', { text: 'Password' }),
      el('input', { class: 'input mono', type: 'password', placeholder: 'Mailbox password', oninput: (e) => { s.draft.existingPw = e.target.value; } })),
    el('div', { class: 'field' },
      el('label', { text: 'Display name (optional)' }),
      el('input', { class: 'input', oninput: (e) => { s.draft.displayName = e.target.value; } })),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-ghost', html: icon('chevL', 14) + ' Back', onclick: () => { s.step = 'path'; renderPanel(); } }),
      el('span', { class: 'grow' }),
      el('button', {
        class: 'btn btn-primary', text: 'Continue',
        disabled: !/.+@.+\..+/.test(s.draft.existingEmail || '') || !(s.draft.existingPw || '').length,
        onclick: () => {
          s.draft.pwMode = 'custom';
          s.draft.pwCustom = s.draft.existingPw;
          s.draft.confirmLocal = s.draft.existingEmail.split('@')[0];
          s.draft.domainOverride = s.draft.existingEmail.split('@')[1];
          s.providerName = 'Existing';
          s.step = 'confirm';
          renderPanel();
        }
      })));
}

// ---------------- wizard poll loop ----------------
async function wizardPoll() {
  const s = session();
  if (!s || qs('#wizardPanel').classList.contains('hidden')) return;
  if (s.step !== 'create') return;
  const wsId = s.wsId;
  const tab = Tabs.list(wsId).find(t => t.id === s.wizardTabId);
  if (!tab) return;
  if (!s.pageLoaded && tab.domReady && !tab.loading) { s.pageLoaded = true; renderPanel(); }
  const wv = Tabs.webviewOf(wsId, tab);
  if (!wv || !tab.url || tab.url.startsWith('pigeonhole://')) return;

  // auto-fill when the form shows up (until the budget runs out)
  if (s.fillsLeft > 0 && S.settings().autoFillOnLoad !== false) {
    const d = await detectIn(wv);
    if (d && d.kind !== 'none' && !d.password) {
      await runFill(s, false);
    }
  }

  // success detection
  if (!s.created && S.settings().autoDetectSuccess !== false) {
    const prov = providerById(s.providerId);
    const url = tab.url || '';
    let done = false;
    if (prov?.successPatterns?.some(re => re.test(url))) done = true;
    else if (prov && !url.startsWith('https://' + prov.host) && !url.startsWith('https://' + prov.host.replace('www.', 'www.')) ) {
      // navigated off the signup host entirely (and not to an error page)
      if (!url.startsWith('pigeonhole://') && !/signup|register|create/i.test(url)) done = true;
    }
    if (done) {
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
  if (result) {
    s.fillReport = result;
    if (!manual) s.fillsLeft = Math.max(0, s.fillsLeft - 1);
    renderPanel();
  }
}
