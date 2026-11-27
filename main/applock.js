// App lock (beta.7): a PIN on the front door.
// Ctrl+Shift+L (or menu / idle timeout) locks the whole browser: the chrome
// blurs behind an opaque overlay, workspace names and tab titles are hidden
// until the PIN is entered. Everything stays in place - no restart, no
// session loss. The PIN itself is stored as a scrypt hash (never plaintext);
// lock state lives in the main process so native menu accelerators can lock
// even when the renderer is busy.
const crypto = require('crypto');

let store = null;
let send = () => { };
let locked = false;

const cfg = () => store.state.settings.appLock || (store.state.settings.appLock = {});
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

function init(storeRef, sendRef) {
  store = storeRef;
  send = sendRef;
}
function hasPin() { return !!(cfg() && cfg().salt && cfg().hash); }

function setPin(pin) {
  const pinStr = String(pin || '');
  if (!/^\d{4,12}$/.test(pinStr)) throw new Error('PIN must be 4-12 digits');
  const salt = crypto.randomBytes(16);
  cfg().salt = salt.toString('base64');
  cfg().hash = hashPin(pinStr, salt).toString('base64');
  store.save();
  return true;
}
function clearPin() {
  delete store.state.settings.appLock;
  store.save();
  locked = false;
  send('lock-state', { locked: false });
  return true;
}

function lock() {
  if (!hasPin()) return { locked: false, reason: 'no-pin' };
  locked = true;
  send('lock-state', { locked: true });
  return { locked: true };
}
function tryUnlock(pin) {
  if (!locked) return { ok: true, alreadyUnlocked: true };
  const c = cfg();
  try {
    const salt = Buffer.from(c.salt, 'base64');
    const want = Buffer.from(c.hash, 'base64');
    const got = hashPin(pin, salt);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) {
      locked = false;
      send('lock-state', { locked: false });
      return { ok: true };
    }
  } catch { }
  return { ok: false };
}
function isLocked() { return { locked: locked && hasPin(), hasPin: hasPin(), idleMinutes: cfg().idle || 0, lockOnMinimize: !!cfg().lockOnMinimize }; }

// idle auto-lock: the renderer reports activity ticks; the timer lives here
let lastActivity = Date.now();
let idleTimer = null;
function noteActivity() { lastActivity = Date.now(); }
function startIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    const mins = Number(cfg().idle) || 0;
    if (!mins || locked || !hasPin()) return;
    if (Date.now() - lastActivity > mins * 60 * 1000) lock();
  }, 15 * 1000);
}

module.exports = { init, hasPin, setPin, clearPin, lock, tryUnlock, isLocked, noteActivity, startIdleWatch };
