// Vault drawer: the workspace identity + every site login saved inside it.
// Passwords are only fetched from the main process on demand (reveal/copy).
import { el, qs, escapeHtml, fmtDate, copyText, originOf } from './util.js';
import { icon } from './icons.js';
import * as S from './state.js';
import { bus, PH } from './state.js';

export function closeVault() { qs('#vaultPanel').classList.add('hidden'); }

export async function openVault(wsId) {
  const panel = qs('#vaultPanel');
  const w = S.ws(wsId || S.getActiveWsId());
  if (!w) return;
  panel.classList.remove('hidden');
  const st = S.settings();
  const accounts = await PH().vault.accounts(w.id);

  // ---- identity card ----
  const idCard = w.identity
    ? el('div', { class: 'vault-id-card', style: { '--h': w.hue } },
        el('div', { class: 'row' },
          el('span', { class: 'ws-avatar', style: { '--h': w.hue }, text: w.num }),
          el('div', { class: 'grow' },
            el('div', { style: { fontWeight: 650, fontSize: '13.5px', wordBreak: 'break-all' }, text: w.identity.email }),
            el('div', { style: { fontSize: '11px', color: 'var(--text-faint)', marginTop: '2px' }, text: `${w.identity.provider || 'Email identity'} · added ${fmtDate(w.identity.createdAt)}` }))),
        el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap', gap: '7px' } },
          el('button', { class: 'btn btn-sm', html: icon('copy', 13) + ' Copy email', onclick: async () => copyText(w.identity.email) }),
          el('button', { class: 'btn btn-sm', html: icon('copy', 13) + ' Copy password', onclick: async () => { const pw = await PH().vault.secret(w.id, 'identity'); await copyText(pw || ''); toastMini('Password copied'); } }),
          el('button', { class: 'btn btn-sm btn-ghost', html: icon('key', 13) + ' Show password', onclick: async (e) => { const pw = await PH().vault.secret(w.id, 'identity'); alertBox(panel, `Password for ${w.identity.email}:`, pw || '(none stored)'); } }),
          el('button', { class: 'btn btn-sm btn-ghost', html: icon('gear', 13) + ' Edit', onclick: () => editIdentity(w) }))
      )
    : el('div', { class: 'empty-note' },
        icon('mail', 26), el('div', { style: { marginTop: '8px' }, text: 'No email identity in this workspace yet.' }),
        el('button', { class: 'btn btn-sm btn-primary', style: { marginTop: '10px' }, text: 'Set one up', onclick: () => { closeVault(); import('./wizard.js').then(m => m.openWizard(w.id)); } }));

  // ---- accounts ----
  const accountRows = accounts.length ? accounts.map(a => {
    const host = originOf(a.origin).replace(/^https?:\/\//, '');
    return el('div', { class: 'vault-account' },
      el('span', { class: 'ws-avatar', style: { '--h': (host.charCodeAt(0) % 360), background: 'var(--surface-3)', border: '1px solid var(--border-strong)', color: 'var(--text-dim)', fontSize: '12px' }, text: (host[0] || '?').toUpperCase() }),
      el('div', { class: 'grow', style: { minWidth: 0 } },
        el('div', { class: 'va-origin', text: a.title || host }),
        el('div', { class: 'va-email', text: a.email })),
      el('div', { class: 'va-actions' },
        el('button', { class: 'icon-btn sm', html: icon('copy', 13), title: 'Copy email', onclick: async () => copyText(a.email) }),
        el('button', { class: 'icon-btn sm', html: icon('key', 13), title: 'Copy password', onclick: async () => { const pw = await PH().vault.secret(w.id, 'account', { origin: a.origin, email: a.email }); await copyText(pw || ''); toastMini('Password copied'); } }),
        el('button', { class: 'icon-btn sm', html: icon('trash', 13), title: 'Remove', onclick: async () => { await PH().vault.removeAccount(w.id, a.origin, a.email); openVault(w.id); } })));
  }) : [el('div', { class: 'empty-note', text: 'No site logins saved yet. After you sign in to a site, Pigeonhole offers to save it here.' })];

  // ---- manual add ----
  const fOrigin = el('input', { class: 'input', type: 'url', placeholder: 'https://site.com' });
  const fEmail = el('input', { class: 'input', type: 'email', placeholder: 'email used on the site' });
  const fPass = el('input', { class: 'input', type: 'password', placeholder: 'password' });
  const addForm = el('details', {},
    el('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--text-dim)', fontWeight: 600 }, text: '+ Add a login manually' }),
    el('div', { style: { marginTop: '10px' } },
      el('div', { class: 'field' }, el('label', { text: 'Site' }), fOrigin),
      el('div', { class: 'field' }, el('label', { text: 'Email / username' }), fEmail),
      el('div', { class: 'field' }, el('label', { text: 'Password' }), fPass),
      el('button', {
        class: 'btn btn-sm btn-primary', text: 'Add login', onclick: async () => {
          if (!/^https?:\/\//.test(fOrigin.value.trim()) || !fEmail.value.trim()) return toastMini('Fill site + email first');
          await PH().vault.addAccount(w.id, { origin: fOrigin.value.trim(), email: fEmail.value.trim(), password: fPass.value, title: '' });
          openVault(w.id);
        }
      })));

  panel.replaceChildren(
    el('div', { class: 'panel-head' },
      el('div', { class: 'grow' },
        el('h2', { text: 'Vault' }),
        el('div', { class: 'sub', text: `Workspace ${w.num} · ${w.name}` })),
      el('button', { class: 'icon-btn sm', html: icon('external', 13), title: 'Export this vault (plain text)', onclick: async () => { const r = await PH().vault.exportVault(w.id); if (r?.ok) toastMini('Vault exported'); } }),
      el('button', { class: 'icon-btn sm', html: icon('close', 15), title: 'Close', onclick: closeVault })),
    el('div', { class: 'panel-body' },
      !st.vaultEncrypted ? el('div', { class: 'pill danger', style: { marginBottom: '12px' }, title: 'Your OS keyring is unavailable; secrets are stored in plain text in the app data folder', text: 'Vault stored without OS encryption' }) : el('div', { class: 'pill success', style: { marginBottom: '12px' }, text: 'Encrypted at rest (OS keyring)' }),
      idCard,
      el('div', { class: 'section', style: { marginTop: '18px' } },
        el('h3', { text: `Site logins (${accounts.length})` }),
        ...accountRows,
        addForm)));
}

function toastMini(msg) { import('./toasts.js').then(m => m.toast({ title: msg, ic: 'check', type: 'success', timeout: 2200 })); }

function editIdentity(w) {
  import('./modals.js').then(({ openModal }) => {
    const fEmail = el('input', { class: 'input mono', value: w.identity.email });
    const fName = el('input', { class: 'input', value: w.identity.displayName || '' });
    const fPw = el('input', { class: 'input mono', type: 'password', placeholder: 'unchanged' });
    openModal({
      title: 'Edit identity', size: 'sm',
      body: el('div', {},
        el('div', { class: 'field' }, el('label', { text: 'Email address' }), fEmail),
        el('div', { class: 'field' }, el('label', { text: 'Display name' }), fName),
        el('div', { class: 'field' }, el('label', { text: 'New password (leave blank to keep)' }), fPw)),
      footer: [
        { label: 'Cancel' },
        {
          label: 'Save', primary: true, onClick: async () => {
            if (!fEmail.value.includes('@')) { toastMini('Email looks wrong'); return false; }
            const patch = { email: fEmail.value.trim(), displayName: fName.value.trim() };
            if (fPw.value) patch.password = fPw.value;
            await PH().vault.updateIdentity(w.id, patch);
            await S.refresh();
            toastMini('Identity updated');
            openVault(w.id);
          }
        }
      ]
    });
  });
}
function alertBox(panel, title, body) {
  import('./modals.js').then(m => m.openModal({
    title, size: 'sm',
    body: el('div', { class: 'input mono', style: { wordBreak: 'break-all', userSelect: 'text' }, text: body }),
    footer: [{ label: 'Close', primary: true }]
  }));
}

export function initVault() {
  bus.on('ws-activated', () => {
    if (!qs('#vaultPanel').classList.contains('hidden')) openVault();
  });
}
