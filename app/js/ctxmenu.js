// Lightweight context menu used by the chrome (workspace tiles etc.).
import { el, qs } from './util.js';
import { icon } from './icons.js';

export function closeMenu() {
  const root = qs('#menuRoot');
  root.replaceChildren();
  window.removeEventListener('mousedown', outsideHandler, { capture: true });
  window.removeEventListener('keydown', escHandler);
  window.removeEventListener('blur', closeMenu);
}

let outsideHandler = null, escHandler = null;

export function showMenu(x, y, items) {
  closeMenu();
  const root = qs('#menuRoot');
  const menu = el('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (it.sep) { menu.append(el('div', { class: 'sep' })); continue; }
    menu.append(el('button', {
      class: `mi ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`.trim(),
      disabled: it.disabled ? '' : null,
      onclick: () => { if (it.disabled) return; closeMenu(); it.action?.(); }
    },
      el('span', { html: icon(it.icon || '', 15) }),
      el('span', { text: it.label }),
      it.kbd ? el('span', { class: 'kbd', text: it.kbd }) : null
    ));
  }
  root.append(menu);
  const r = menu.getBoundingClientRect();
  const maxX = window.innerWidth - r.width - 8, maxY = window.innerHeight - r.height - 8;
  menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  outsideHandler = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  escHandler = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => {
    window.addEventListener('mousedown', outsideHandler, { capture: true });
    window.addEventListener('keydown', escHandler);
    window.addEventListener('blur', closeMenu);
  }, 0);
}
