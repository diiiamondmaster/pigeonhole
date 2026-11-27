// App lock (beta.7): the chrome-side of the PIN lock. The main process owns
// the state (and the boss-key accelerator); this renders the lock screen -
// an opaque cover over everything (workspace names, tab titles, page
// content all hidden), a PIN field, and unlock-in-place. Activity reporting
// feeds the idle auto-lock.
import { el, qs } from './util.js';
import { icon } from './icons.js';
import { PH } from './state.js';

let overlay = null;

export function initLock() {
  // idle auto-lock clock: every user gesture is a tick
  let last = 0;
  const tick = () => {
    const now = Date.now();
    if (now - last > 20 * 1000) { last = now; try { PH().lock.activity(); } catch { } }
  };
  window.addEventListener('pointerdown', tick, { capture: true });
  window.addEventListener('keydown', tick, { capture: true });
  // if the app was locked when it closed, it comes back locked
  PH().lock.status().then(st => { if (st && st.locked) setLocked(true); }).catch(() => { });
}

export function setLocked(locked) {
  if (locked) showLock(); else hideLock();
}

function showLock() {
  if (overlay) return;
  const input = el('input', {
    class: 'input lock-pin', type: 'password', inputmode: 'numeric',
    placeholder: 'PIN', autocomplete: 'off', maxlength: '12',
    style: { textAlign: 'center', letterSpacing: '0.35em', fontSize: '18px' }
  });
  const err = el('div', { class: 'lock-err', text: '' });
  const tryUnlock = async () => {
    const pin = input.value;
    if (!pin) return;
    const r = await PH().lock.unlock(pin);
    if (!r.ok) {
      err.textContent = 'Wrong PIN';
      input.value = '';
      input.focus();
      input.classList.remove('shake');
      requestAnimationFrame(() => input.classList.add('shake'));
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });
  input.addEventListener('input', () => { err.textContent = ''; });
  overlay = el('div', { class: 'lock-ovr', role: 'dialog', 'aria-label': 'Pigeonhole is locked' },
    el('div', { class: 'lock-box' },
      el('div', { class: 'lock-ic', html: icon('lock', 26) }),
      el('div', { class: 'lock-title', text: 'Pigeonhole is locked' }),
      el('div', { class: 'lock-sub', text: 'Enter your PIN to pick up where you left off — everything stayed in place.' }),
      input, err,
      el('button', { class: 'btn btn-primary', text: 'Unlock', onclick: tryUnlock })));
  document.body.append(overlay);
  setTimeout(() => input.focus(), 60);
}

function hideLock() {
  overlay?.remove();
  overlay = null;
}
