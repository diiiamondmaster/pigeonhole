// Modal system: generic openModal + the Settings and Workspace-settings dialogs.
import { el, qs, escapeHtml, strength, fmtDate } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';
import * as Tabs from './tabs.js';
import { renderSidebar, applyCollapsed } from './sidebar.js';
import { genPassword } from './wizard.js';
import { toast } from './toasts.js';
import { checkUpdates } from './updates.js';

let openCount = 0;

export function openModal({ title, size = '', body, footer = [], onClose }) {
  const root = qs('#modalRoot');
  const id = ++openCount;
  const overlay = el('div', { class: 'overlay', style: { zIndex: 100 + id } });
  const modal = el('div', { class: `modal ${size}` },
    el('div', { class: 'modal-head' }, el('h2', { text: title })),
    el('div', { class: 'modal-body' }, body));
  if (footer.length) modal.append(el('div', { class: 'modal-foot' },
    footer.map(f => el('button', {
      class: `btn ${f.primary ? 'btn-primary' : ''} ${f.danger ? 'btn-danger' : ''}`,
      text: f.label,
      // every footer button closes the modal; a handler's return value is
      // forwarded to onClose so dialogs like promptModal can capture it.
      // Async handlers are awaited first: an awaited `false` (validation
      // failure) keeps the dialog open, a resolved Promise must not.
      onclick: async () => {
        try {
          const r = f.onClick ? f.onClick() : undefined;
          const val = (r && typeof r.then === 'function') ? await r : r;
          if (val !== false) close(val);
        } catch (err) { console.error('[modal] footer handler failed', err); }
      }
    }))));
  overlay.append(modal);

  const close = (result) => {
    overlay.remove();
    window.removeEventListener('keydown', onKey);
    onClose?.(result);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(undefined); });
  window.addEventListener('keydown', onKey);
  root.append(overlay);
  return { close, overlay, modal };
}

export function confirmModal({ title, body, actionLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title, size: 'sm',
      body: el('p', { style: { fontSize: '12.5px', color: 'var(--text-dim)', lineHeight: '1.6' }, text: body }),
      onClose: () => resolve(false),
      footer: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: actionLabel, primary: !danger, danger, onClick: () => resolve(true) }
      ]
    });
  });
}

// =====================================================================
// Settings
// =====================================================================
const TABS_LIST = [
  ['general', 'General'], ['identity', 'Identities'], ['onboarding', 'Onboarding'],
  ['privacy', 'Data & privacy'], ['about', 'About']
];

export async function settingsModal(activeTab = 'general') {
  // settings replaces itself on tab switches - never stack overlays
  qs('#modalRoot').replaceChildren();
  const st = S.settings();
  const appInfo = await PH().app.info();

  const tabContent = {
    general: () => el('div', {},
      section('Search engine',
        field('What the address bar falls back to',
          el('div', { class: 'seg' }, ['google', 'duckduckgo', 'bing'].map(en =>
            el('button', { class: st.searchEngine === en ? 'on accent' : '', text: en[0].toUpperCase() + en.slice(1), onclick: async () => { await PH().settings.set({ searchEngine: en }); await S.refresh(); settingsModal('general'); } }))))),
      section('Downloads',
        field('Save files to',
          el('div', { class: 'row' },
            el('input', { class: 'input grow', readonly: '', value: st.downloadsDir || '(system Downloads folder)' }),
            el('button', { class: 'btn', text: 'Browse…', onclick: async () => { const dir = await PH().app.pickDownloadsDir(); if (dir) { await PH().settings.set({ downloadsDir: dir }); await S.refresh(); settingsModal('general'); } } })))),
    ),

    identity: () => {
      const sharedPw = el('input', { class: 'input mono grow', type: 'password', placeholder: st.hasSharedPassword ? '••••••••••••' : 'Type a shared password' });
      const meter = el('div', { class: 'meter' }, el('i', { id: 'sharedMeter' }));
      sharedPw.addEventListener('input', () => { const s = strength(sharedPw.value); const i = qs('#sharedMeter'); i.style.width = sharedPw.value ? s.pct + '%' : '0'; i.className = s.cls; });
      return el('div', {},
        section('Generated addresses',
          field('Base handle (your usual username)', el('input', { class: 'input mono', value: st.identityBase, placeholder: 'e.g. yourhandle', oninput: (e) => { PH().settings.set({ identityBase: e.target.value.replace(/[^a-zA-Z0-9._-]/g, '') }); } })),
          field('Default address style',
            el('div', { class: 'seg' }, [['numbered', 'Numbered'], ['human', 'Human name'], ['words', 'Word pair'], ['custom', 'Custom']].map(([k, l]) =>
              el('button', { class: st.identityMode === k ? 'on accent' : '', text: l, onclick: async () => { await PH().settings.set({ identityMode: k }); await S.refresh(); settingsModal('identity'); } })))),
          field('Zero padding', el('div', { class: 'seg' }, [1, 2, 3, 4].map(p =>
            el('button', { class: st.identityPadding === p ? 'on accent' : '', text: String(p), onclick: async () => { await PH().settings.set({ identityPadding: p }); await S.refresh(); settingsModal('identity'); } }))),
            `${st.identityBase || 'yourhandle'}00${st.identityStart} style addresses`)),
        section('Shared password',
          el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', lineHeight: '1.55', marginBottom: '10px' }, text: 'One password for every mailbox you create - convenient, but a single leak exposes all of them. The choice is yours.' }),
          field('', el('div', { class: 'row' },
            sharedPw,
            el('button', { class: 'btn', text: 'Save', onclick: async () => { if (sharedPw.value.length >= 6) { await PH().settings.setSharedPassword(sharedPw.value); await S.refresh(); toast({ title: 'Shared password saved', type: 'success', ic: 'check' }); settingsModal('identity'); } } }),
            st.hasSharedPassword ? el('button', { class: 'btn btn-danger', text: 'Remove', onclick: async () => { await PH().settings.setSharedPassword(null); await S.refresh(); settingsModal('identity'); } }) : null), ''),
          field('Generator length', el('div', { class: 'row' },
            el('input', { class: 'input', type: 'range', min: 10, max: 32, value: st.pwLength, style: { flex: 1, padding: 0, background: 'none', border: 'none' }, oninput: async (e) => { await PH().settings.set({ pwLength: Number(e.target.value) }); qs('#pwLenVal').textContent = e.target.value + ' chars'; } }),
            el('span', { id: 'pwLenVal', style: { fontSize: '11.5px', color: 'var(--text-dim)', minWidth: '56px', textAlign: 'right' }, text: st.pwLength + ' chars' })), '')),
      );
    },

    onboarding: () => el('div', {},
      section('Wizard behaviour',
        toggleRow('Autofill the signup form automatically',
          'As soon as the provider\u2019s form appears, Pigeonhole fills it. You still review and submit.',
          st.autoFillOnLoad, async (v) => { await PH().settings.set({ autoFillOnLoad: v }); await S.refresh(); }),
        toggleRow('Detect account creation automatically',
          'When the signup page moves on to the inbox, the wizard advances by itself.',
          st.autoDetectSuccess, async (v) => { await PH().settings.set({ autoDetectSuccess: v }); await S.refresh(); })),
      section('Email providers',
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-dim)', lineHeight: '1.6' }, text: 'The wizard shows a provider table every time. Current favourites: Proton Mail, Tuta and Mailfence - none require a phone number. Full notes: ' },
          el('span', {
            class: 'link-btn', text: 'docs/email-providers.md',
            onclick: () => PH().app.open('docs-providers')
          })))),

    privacy: () => el('div', {},
      section('What Pigeonhole stores',
        el('p', { style: { fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.65' }, text: 'Everything lives on this computer, in the app data folder: one state file (workspaces, settings, vault) plus one isolated browser profile per workspace. The app itself makes no network requests except loading the pages you visit - and one background check of the GitHub Releases feed (api.github.com) that powers the built-in updater. There is no telemetry, no analytics, no account.' }),
        st.vaultEncrypted
          ? el('div', { class: 'pill success', text: 'Passwords encrypted with the OS credential store' })
          : el('div', { class: 'pill danger', text: 'OS credential store unavailable - vault stored in plain text' })),
      section('Data tools',
        field('', el('div', { class: 'row' },
          el('button', { class: 'btn', html: icon('docs', 14) + ' Open data folder', onclick: () => PH().app.open('userData') }),
          el('button', { class: 'btn', html: icon('download', 14) + ' Export all vaults', title: 'Plain text - handle with care', onclick: async () => { const r = await PH().vault.exportVault(null); if (r?.ok) toast({ title: 'Vault exported', sub: 'Plain text file - store it safely and delete it when done', type: 'success', ic: 'check' }); } })), 'Exports include passwords in plain text.')),
    ),

    about: () => el('div', { style: { textAlign: 'center', padding: '18px 6px' } },
      el('div', { style: { color: 'var(--accent)', display: 'flex', justifyContent: 'center', marginBottom: '10px' }, html: icon('logo', 54) }),
      el('h2', { style: { fontSize: '19px', marginBottom: '4px' }, text: 'Pigeonhole' }),
      el('div', { style: { color: 'var(--text-faint)', fontSize: '12px', marginBottom: '14px' }, text: `v${appInfo.version} · Electron ${appInfo.electron} · Chromium ${appInfo.chrome}` }),
      el('div', { class: 'row', style: { justifyContent: 'center', gap: '8px', flexWrap: 'wrap' } },
        el('button', { class: 'btn btn-sm', html: icon('download', 13) + ' Check for updates', onclick: () => checkUpdates({ manual: true }) })),
      el('p', { style: { marginTop: '8px', fontSize: '11px', color: 'var(--text-faint)', lineHeight: '1.55', marginBottom: '16px' }, text: 'Updates pull from GitHub Releases automatically: the app checks on its own, downloads in the background and installs itself when you quit. Workspaces, vault and settings are never touched.' }),
      el('p', { style: { fontSize: '12.5px', color: 'var(--text-dim)', lineHeight: '1.6', marginBottom: '18px' }, text: 'A lightweight multi-identity workspace browser. Every account gets its own clean room - separate cookies, cache and storage - under one roof.' }),
      el('div', { class: 'row', style: { justifyContent: 'center', gap: '8px', flexWrap: 'wrap' } },
        el('button', { class: 'btn btn-sm', html: icon('docs', 13) + ' Documentation', onclick: () => PH().app.open('docs') }),
        el('button', { class: 'btn btn-sm', html: icon('download', 13) + ' Releases', onclick: () => PH().app.open('releases') }),
        el('button', { class: 'btn btn-sm', html: icon('external', 13) + ' GitHub', onclick: () => PH().app.open('repo') })),
      el('p', { style: { marginTop: '18px', fontSize: '11px', color: 'var(--text-faint)' }, text: 'MIT licensed. Built on Electron and Chromium.' }))
  };

  const tabsNav = el('div', { class: 'modal-tabs' }, TABS_LIST.map(([k, l]) =>
    el('button', { class: k === activeTab ? 'on' : '', text: l, onclick: () => settingsModal(k) })));

  openModal({
    title: 'Settings', size: 'lg',
    body: el('div', {}, tabsNav, el('div', { style: { paddingTop: '16px' } }, tabContent[activeTab]?.() || tabContent.general()))
  });
}

// =====================================================================
// Workspace settings
// =====================================================================
export async function wsSettingsModal(wsId) {
  const w = S.ws(wsId);
  if (!w) return;
  qs('#modalRoot').replaceChildren();
  const nameInput = el('input', { class: 'input', value: /^Workspace \d+$/.test(w.name) ? '' : w.name, placeholder: `Workspace ${w.num} (default name)` });

  const hues = [36, 12, 350, 320, 262, 220, 190, 160, 90, 45];
  const colorDots = el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
    hues.map(h => el('button', {
      style: {
        width: '30px', height: '30px', borderRadius: '9px', cursor: 'pointer',
        background: `hsl(${h} 26% 22%)`, border: w.hue === h ? `2px solid hsl(${h} 60% 55%)` : '1px solid var(--border-strong)',
        boxShadow: w.hue === h ? `0 0 0 3px hsl(${h} 60% 52% / .25)` : 'none'
      },
      title: 'Tile colour', onclick: async () => { await PH().workspaces.setHue(w.id, h); await S.refresh(); renderSidebar(); wsSettingsModal(wsId); }
    })));

  // network visual (proxy routing lands in v1.1)
  const netSection = section('Network',
    el('div', { class: 'row', style: { marginBottom: '12px' } },
      el('span', { class: 'net-chip direct' }, el('span', { class: 'dot' }), el('span', { text: 'Direct connection - your own IP' })),
      el('span', { class: 'pill muted', text: 'v1.1 roadmap' })),
    el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', lineHeight: '1.5', marginBottom: '10px' }, text: 'Each workspace will be routable through its own SOCKS5/HTTP proxy so accounts never share an IP. The fields below are a preview - routing is not active in this build.' }),
    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', opacity: 0.45, pointerEvents: 'none' } },
      el('input', { class: 'input', placeholder: 'proxy host (e.g. nl.proxy.io)', disabled: '' }),
      el('input', { class: 'input', placeholder: 'port (e.g. 1080)', disabled: '' }),
      el('input', { class: 'input', placeholder: 'username (optional)', disabled: '' }),
      el('input', { class: 'input', type: 'password', placeholder: 'password (optional)', disabled: '' })),
    el('div', { class: 'hint', style: { marginTop: '8px' }, text: 'Follow the Releases page for the 1.1 update.' }));

  openModal({
    title: `Workspace ${w.num} settings`, size: '',
    body: el('div', {},
      section('Name', nameInput,
        `Shown in the sidebar tooltip and the top bar. Default: “Workspace ${w.num}”${w.identity ? ` - currently named after ${w.identity.email}` : ''}.`),
      section('Tile colour', colorDots),
      netSection,
      section('Danger zone',
        el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
          el('button', {
            class: 'btn', text: 'Clear browsing data', onclick: async () => {
              const ok = await confirmModal({ title: 'Clear workspace data?', body: `Wipes cookies, cache, local storage and service workers for workspace ${w.num}. Vault entries stay.`, actionLabel: 'Clear data' });
              if (ok) { await PH().workspaces.clearData(w.id); toast({ title: `Workspace ${w.num} data cleared`, type: 'success', ic: 'check' }); }
            }
          }),
          el('button', {
            class: 'btn btn-danger', text: 'Delete workspace', onclick: async () => {
              const ok = await confirmModal({ title: `Delete workspace ${w.num}?`, body: 'Removes the workspace, its isolated profile and its vault. This cannot be undone.', actionLabel: 'Delete workspace', danger: true });
              if (ok) {
                Tabs.destroyWorkspace(w.id);
                await PH().workspaces.remove(w.id);
                await S.refresh();
                const next = S.workspaces()[0];
                if (next) Tabs.switchWorkspace(next.id, { fromBoot: true });
                renderSidebar();
              }
            }
          })))
    ),
    footer: [
      { label: 'Close' },
      {
        label: 'Save', primary: true, onClick: async () => {
          if (nameInput.value.trim()) { await PH().workspaces.rename(w.id, nameInput.value.trim().slice(0, 80)); await S.refresh(); renderSidebar(); }
        }
      }
    ]
  });
}

// =====================================================================
// small helpers
// =====================================================================
function section(title, ...children) {
  return el('div', { class: 'section' }, el('h3', { text: title }), ...children);
}
function field(label, control, hint = '') {
  return el('div', { class: 'field' },
    label ? el('label', { text: label }) : null,
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null);
}
function toggleRow(label, sub, value, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'row between', style: { padding: '9px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' } },
    el('span', { class: 'grow', style: { paddingRight: '12px' } },
      el('div', { style: { fontWeight: 550, fontSize: '12.5px' }, text: label }),
      el('div', { style: { fontSize: '11px', color: 'var(--text-faint)', marginTop: '2px' }, text: sub })),
    el('span', { class: 'switch' }, input, el('i', {})));
}
