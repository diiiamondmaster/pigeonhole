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
  ['general', 'General'], ['appearance', 'Appearance'], ['identity', 'Identities'], ['onboarding', 'Onboarding'],
  ['extensions', 'Extensions'], ['privacy', 'Data & privacy'], ['about', 'About']
];

export async function settingsModal(activeTab = 'general') {
  // settings replaces itself on tab switches - never stack overlays
  qs('#modalRoot').replaceChildren();
  const st = S.settings();
  const appInfo = await PH().app.info();
  const exts = PH().extensions ? await PH().extensions.list() : [];

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

    appearance: () => el('div', {},
      section('Scale',
        field('Interface scale',
          el('div', { class: 'seg' }, [['compact', 'Compact'], ['normal', 'Normal'], ['large', 'Large']].map(([k, l]) =>
            el('button', { class: st.uiScale === k ? 'on accent' : '', text: l, onclick: async () => { await PH().settings.set({ uiScale: k }); await S.refresh(); applyUiFromChrome(); settingsModal('appearance'); } })))),
        field('Workspace tiles',
          el('div', { class: 'seg' }, [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']].map(([k, l]) =>
            el('button', { class: st.tileSize === k ? 'on accent' : '', text: l, onclick: async () => { await PH().settings.set({ tileSize: k }); await S.refresh(); applyUiFromChrome(); settingsModal('appearance'); } }))))),
      section('Workspace switching',
        toggleRow('Fading switch trail',
          'Switching workspaces leaves a short fading glow on the tile you left, in that workspace\u2019s colour.',
          st.wsAnim !== false, async (v) => { await PH().settings.set({ wsAnim: v }); await S.refresh(); }),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-faint)', lineHeight: '1.55' }, text: 'The active workspace is also called out three more ways, always on: the hue line under the top bar, the highlighted tile, and the status bar text.' }))),

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

    extensions: () => el('div', {},
      section('Built-in extensions',
        el('p', { style: { fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6', marginBottom: '12px' }, text: 'Extensions are small features that run inside Pigeonhole and apply to every workspace. Each one is switched on or off individually, takes effect immediately, and there are no installs or external stores - everything ships with the app. The puzzle button in the top bar opens the same list as a quick panel.' })),
      ...exts.map(x => extCard(x, st))),

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
      el('div', { style: { marginTop: '10px', textAlign: 'left', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '10px', padding: '4px 12px', marginBottom: '2px' } },
        toggleRow('Beta updates',
          'Ride pre-release builds: checks include GitHub releases marked as pre-release (e.g. v1.1.0-beta.1). Turn it off any time to settle back on stable.',
          !!st.betaUpdates, async (v) => {
            await PH().settings.set({ betaUpdates: v });
            await S.refresh();
            toast({ title: v ? 'Beta updates on' : 'Beta updates off', sub: v ? 'The next check looks at pre-release builds too.' : 'Checking stable releases only from now on.', type: 'info', ic: 'check', timeout: 4000 });
            checkUpdates({ manual: true });
          })),
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

  // ---------- per-workspace proxy routing ----------
  const p = w.proxy || { enabled: false, scheme: 'socks5', host: '', port: '', username: '', hasPassword: false, bypass: '' };
  let scheme = p.scheme === 'http' ? 'http' : 'socks5';
  const hostIn = el('input', { class: 'input mono', placeholder: 'proxy host, e.g. 127.0.0.1 or nl.proxy.io', value: p.host || '' });
  const portIn = el('input', { class: 'input mono', placeholder: '1080', value: p.port || '' });
  const userIn = el('input', { class: 'input mono', placeholder: 'username (optional)', value: p.username || '' });
  const passIn = el('input', { class: 'input mono', type: 'password', placeholder: p.hasPassword ? 'saved - type to replace' : 'password (optional)' });
  const bypassIn = el('input', { class: 'input mono span2', placeholder: 'bypass list, e.g. *.company.com;<local>', value: p.bypass || '' });

  // duplicate-exit warning: another workspace already exits through the
  // exact same proxy -> accounts would share an IP
  const dupOf = () => S.workspaces().find(x =>
    x.id !== w.id && x.proxy && x.proxy.enabled &&
    String(x.proxy.host || '').toLowerCase() === String(hostIn.value || '').trim().toLowerCase() &&
    Number(x.proxy.port) === Number(portIn.value) &&
    (x.proxy.scheme === 'socks5') === (scheme === 'socks5'));
  const dupWarn = el('div', { class: 'pill danger', style: { display: 'none', marginTop: '10px' } });
  const syncDup = () => {
    const o = proxyChk.checked ? dupOf() : null;
    dupWarn.style.display = o ? '' : 'none';
    dupWarn.textContent = o ? `Workspace ${o.num} already exits through this exact proxy - both would share one IP.` : '';
  };

  // live exit-IP probe: fetches an IP service through THIS workspace's session
  const ipOut = el('div', { class: 'hint', style: { marginTop: '8px', minHeight: '14px' }, text: '' });
  const testIpBtn = el('button', {
    class: 'btn btn-sm', html: icon('globe', 13) + ' Test exit IP', title: 'Asks an IP service through this workspace\u2019s connection',
    onclick: async () => {
      ipOut.textContent = 'Testing…';
      const r = await PH().workspaces.testProxy(w.id);
      if (r?.ok) ipOut.textContent = `Exit IP: ${r.ip} · ${r.ms || 0} ms · via ${r.via}`;
      else ipOut.textContent = `Test failed - ${r?.error || 'no answer'}`;
    }
  });

  const proxyChk = el('input', { type: 'checkbox' });
  proxyChk.checked = !!p.enabled;
  const schemeSeg = el('div', { class: 'seg span2' }, [['socks5', 'SOCKS5'], ['http', 'HTTP']].map(([k, l]) =>
    el('button', {
      class: scheme === k ? 'on accent' : '', text: l,
      onclick: () => { scheme = k; [...schemeSeg.children].forEach((b, i) => b.classList.toggle('on', i === (k === 'socks5' ? 0 : 1))); [...schemeSeg.children].forEach(b => b.classList.toggle('accent', b.classList.contains('on'))); syncDup(); }
    })));
  const proxyFields = el('div', { class: 'proxy-grid' }, schemeSeg, hostIn, portIn, userIn, passIn, bypassIn);
  const syncProxyFields = () => {
    proxyFields.style.opacity = proxyChk.checked ? '' : '0.45';
    proxyFields.querySelectorAll('input, button').forEach(x => { x.disabled = !proxyChk.checked; });
    syncDup();
  };
  proxyChk.addEventListener('change', syncProxyFields);
  hostIn.addEventListener('input', syncDup);
  portIn.addEventListener('input', syncDup);

  const netSection = section('Network',
    el('label', { class: 'row between', style: { padding: '9px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', marginBottom: '10px' } },
      el('span', { class: 'grow', style: { paddingRight: '12px' } },
        el('div', { style: { fontWeight: 550, fontSize: '12.5px' }, text: 'Route this workspace through a proxy' }),
        el('div', { style: { fontSize: '11px', color: 'var(--text-faint)', marginTop: '2px' }, text: 'All of this workspace\u2019s page traffic exits through it - accounts never share an IP unless you want them to.' })),
      el('span', { class: 'switch' }, proxyChk, el('i', {}))),
    el('div', { class: 'row', style: { marginBottom: '12px' } },
      el('span', { class: 'net-chip ' + (p.enabled ? 'proxy' : 'direct') }, el('span', { class: 'dot' }),
        el('span', { text: p.enabled ? `Routed via ${p.scheme.toUpperCase()} ${p.host}:${p.port}` : 'Direct connection - your own IP' }))),
    proxyFields,
    el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
      testIpBtn,
      el('span', { class: 'hint', style: { margin: '0' }, text: 'Proves the real exit IP this workspace uses right now.' })),
    ipOut,
    dupWarn,
    el('div', { class: 'hint', style: { marginTop: '8px' }, text: 'SOCKS5 or HTTP proxy, with optional credentials (stored encrypted like the vault). Applies immediately and reloads the open tab. Bypass list follows Chromium rules; leave empty for just <local>.' }));
  syncProxyFields();

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
          if (nameInput.value.trim()) { await PH().workspaces.rename(w.id, nameInput.value.trim().slice(0, 80)); }
          // per-workspace proxy
          if (proxyChk.checked) {
            const host = hostIn.value.trim();
            const port = Number(portIn.value);
            if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
              toast({ title: 'Proxy not saved', sub: 'A host and a port between 1 and 65535 are required.', type: 'error', ic: 'warn', timeout: 6000 });
              return false;   // keep the dialog open so the fields can be fixed
            }
            await PH().workspaces.setProxy(w.id, {
              enabled: true, scheme, host, port,
              username: userIn.value.trim(),
              password: passIn.value,
              keepPassword: !passIn.value && !!p.hasPassword,
              bypass: bypassIn.value.trim()
            });
            await S.refresh();
            const other = S.workspaces().find(x => x.id !== w.id && x.proxy && x.proxy.enabled &&
              String(x.proxy.host).toLowerCase() === host.toLowerCase() && Number(x.proxy.port) === port &&
              x.proxy.scheme === scheme);
            toast({
              title: other ? `Workspace ${w.num} routed - but so is ${other.num}` : `Workspace ${w.num} routed`,
              sub: other ? 'Both exit through the same proxy, so those accounts share one IP. Change one of them if that was not the plan.' : `${scheme.toUpperCase()} ${host}:${port} - the open tab reloads through it.`,
              type: other ? 'warn' : 'success', ic: other ? 'warn' : 'check', timeout: other ? 8000 : 5000
            });
          } else if (p.enabled) {
            await PH().workspaces.setProxy(w.id, { enabled: false });
            toast({ title: `Workspace ${w.num} is back on a direct connection`, type: 'success', ic: 'check' });
          }
          await S.refresh(); renderSidebar(); bus.emit('chrome-updated');
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

// a bare switch for cards (the same .switch component, without a wrapping row)
function switchEl(value, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  return el('span', { class: 'switch' }, input, el('i', {}));
}

// extension card for Settings > Extensions (+ quick panel)
function extCard(x, st = {}) {
  const card = el('div', { class: 'ext-card' },
    el('div', { class: 'row between', style: { alignItems: 'flex-start', gap: '10px' } },
      el('div', { class: 'grow' },
        el('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          el('b', { style: { fontSize: '12.5px', fontWeight: 600 }, text: x.name }),
          el('span', { class: 'pill muted', text: 'v' + x.version }),
          el('span', { class: 'pill muted', text: 'Built-in' })),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-dim)', marginTop: '5px', lineHeight: '1.5' }, text: x.description })),
      switchEl(x.enabled, async (v) => {
        try {
          await PH().extensions.setEnabled(x.id, v);
          toast({ title: `${x.name} ${v ? 'on' : 'off'}`, sub: v ? 'Applies to every workspace right away.' : 'Off everywhere until you switch it back on.', type: 'info', ic: 'check', timeout: 3500 });
        } catch (e) {
          toast({ title: 'Could not switch the extension', sub: String(e?.message || e), type: 'error', ic: 'warn' });
        }
      })));

  if (x.id === 'adshield') {
    const level = st.adshield?.level || x.config?.level || 'standard';
    const sites = st.adshield?.sites || {};
    const n = Object.keys(sites).length;
    card.append(el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginTop: '9px' } },
      el('div', { class: 'seg' }, [['basic', 'Basic'], ['standard', 'Standard'], ['strict', 'Strict']].map(([k, l]) =>
        el('button', { class: k === level ? 'on accent' : '', text: l, onclick: async () => { await PH().extensions.setConfig({ level: k }); await S.refresh(); settingsModal('extensions'); } }))),
      n ? el('span', { class: 'pill muted', text: `${n} site rule${n > 1 ? 's' : ''}` }) : null,
      n ? el('button', { class: 'btn btn-sm', text: 'Reset site rules', onclick: async () => { await PH().extensions.setConfig({ resetSites: true }); await S.refresh(); settingsModal('extensions'); } }) : null));
  }
  if (x.id === 'videospeed') {
    card.append(el('div', { class: 'hint', style: { marginTop: '8px' }, text: 'S slower · D faster · R reset · V show/hide · Z/X seek ±10s · G remember speed for this site' }));
  }
  return card;
}

// appearance changes re-apply live: the chrome listens on the bus
function applyUiFromChrome() { bus.emit('chrome-updated'); }
