// Toast notifications (bottom-right stack) + the downloads toast variant.
import { el, qs } from './util.js';
import { icon } from './icons.js';

export function toast({ title, sub = '', type = 'info', icon: ic = 'info', actions = [], timeout = 4200, progress = null, id = null }) {
  const root = qs('#toasts');
  const node = el('div', { class: `toast ${type}`, ...(id ? { 'data-id': id } : {}) },
    el('span', { class: 't-ico', html: icon(ic, 17) }),
    el('div', { class: 't-body' },
      el('div', { class: 't-title', text: title }),
      sub ? el('div', { class: 't-sub', text: sub }) : null,
      progress != null ? el('div', { class: 't-sub t-prog' }) : null,
      actions.length ? el('div', { class: 't-actions' },
        actions.map(a => el('button', { class: `btn btn-sm ${a.primary ? 'btn-primary' : ''}`, text: a.label, onclick: () => { a.onClick?.(); dismiss(); } }))
      ) : null
    )
  );
  root.append(node);
  if (progress != null) node.querySelector('.t-prog').textContent = progress != null && progress >= 0 ? `${progress}%` : '';

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    node.classList.add('out');
    setTimeout(() => node.remove(), 190);
  };
  if (timeout > 0 && !actions.length) setTimeout(dismiss, timeout);
  else if (timeout > 0) setTimeout(dismiss, Math.max(timeout, 8000));
  return { dismiss, node, setProgress: (p) => { const n = node.querySelector('.t-prog'); if (n) n.textContent = p >= 0 ? `${p}%` : ''; } };
}

// ---- download lifecycle toasts ----
const dlToasts = new Map();

export function downloadToast(payload) {
  const { phase, id, name } = payload;
  if (phase === 'start') {
    const t = toast({
      id, title: 'Downloading', sub: name, ic: 'download', type: 'info',
      progress: 0, timeout: 0,
      actions: [{ label: 'Cancel', onClick: () => window.pigeonhole.app.cancelDownload(id) }]
    });
    dlToasts.set(id, t);
  } else if (phase === 'progress') {
    dlToasts.get(id)?.setProgress(payload.pct ?? -1);
  } else if (phase === 'done') {
    const t = dlToasts.get(id);
    dlToasts.delete(id);
    const ok = payload.state === 'completed';
    t?.dismiss();
    toast({
      title: ok ? 'Download complete' : 'Download failed',
      sub: name,
      type: ok ? 'success' : 'error',
      ic: ok ? 'check' : 'warn',
      actions: ok ? [{ label: 'Show in folder', primary: true, onClick: () => window.pigeonhole.app.showItem(payload.path) }] : [],
      timeout: 6000
    });
  } else if (phase === 'error') {
    dlToasts.get(id)?.dismiss();
    dlToasts.delete(id);
  }
}
