// Pigeonhole - built-in extension engine.
// Extensions are small, session-level features with a global on/off toggle in
// Settings > Extensions. Each extension is registered here with an id, a
// description and a wiring function; the wiring runs on every workspace
// session (workspaces are isolated Chromium partitions - see main.js).
//
// Design notes:
// - Toggles are LIVE: the webRequest hooks consult the current setting on
//   every request, and stateful extensions (spell check) are re-applied to
//   every open session the moment the toggle flips.
// - Enabling state persists in settings.extensions under the store; there is
//   no install/uninstall story - everything here ships with the app.
const { session } = require('electron');
const { store } = require('./store');

// ---- tracker shield: analytics / ad beacons, deliberately conservative ----
// Login SDKs (connect.facebook.net, accounts.google.com, appleid…) are NOT
// blocked on purpose: multi-account sign-in must keep working.
const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
  'adservice.google.com', 'scorecardresearch.com', 'quantserve.com',
  'outbrain.com', 'taboola.com', 'criteo.com', 'criteo.net',
  'adnxs.com', 'adsrvr.org', 'amazon-adsystem.com', 'bat.bing.com',
  'analytics.tiktok.com', 'ads-twitter.com', 'sentry-cdn.com'
];

function isTrackerUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return TRACKER_HOSTS.some(t => host === t || host.endsWith('.' + t));
  } catch { return false; }
}

const BUILTIN = [
  {
    id: 'spellcheck',
    name: 'Spell Check',
    version: '1.0.0',
    defaultEnabled: true,
    description: 'Underlines misspellings in text boxes and search fields inside every workspace, and puts corrections (plus Add to dictionary) in the right-click menu. Languages follow the app language (en-US).'
  },
  {
    id: 'trackershield',
    name: 'Tracker Shield',
    version: '1.0.0',
    defaultEnabled: true,
    description: 'Blocks a built-in list of common analytics and ad beacons (Google Analytics, DoubleClick, Taboola, Criteo, …) in every workspace. Login SDKs are never blocked. If a site misbehaves, just switch it off - it applies immediately.'
  },
  {
    id: 'historyguard',
    name: 'History Guard',
    version: '1.0.0',
    defaultEnabled: false,
    description: 'Pigeonhole stops recording the pages you visit into per-workspace history - the address bar and new-tab page will no longer suggest them. Nothing already stored is deleted; clear it from workspace settings.'
  }
];

function extEnabled(id) {
  const m = store.state.settings.extensions || {};
  const def = BUILTIN.find(x => x.id === id);
  return m[id] === undefined ? !!(def && def.defaultEnabled) : !!m[id];
}

// ---- wiring (run for every workspace session, exactly what it needs) ----
function applyToSession(ses) {
  // Spell Check: a session-level switch, re-applied when the toggle moves.
  try { ses.setSpellCheckerEnabled(extEnabled('spellcheck')); } catch { }
  try { if (extEnabled('spellcheck')) ses.setSpellCheckerLanguages(['en-US']); } catch { }

  // Tracker Shield: the listener stays attached; the live setting decides.
  try {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
      if (extEnabled('trackershield') && details.resourceType !== 'mainFrame' && isTrackerUrl(details.url)) {
        return cb({ cancel: true });
      }
      cb({});
    });
  } catch { }
}

// Toggling from the UI: persist, then re-apply the stateful parts to every
// open workspace session (webRequest hooks already read the live setting).
function refreshAllSessions() {
  for (const w of store.state.workspaces) {
    try { applyToSession(session.fromPartition('persist:' + w.id)); } catch { }
  }
}

function setEnabled(id, on) {
  if (!BUILTIN.some(x => x.id === id)) return false;
  const exts = { ...(store.state.settings.extensions || {}) };
  exts[id] = !!on;
  store.state.settings.extensions = exts;
  store.save();
  refreshAllSessions();
  return true;
}

function list() {
  return BUILTIN.map(x => ({
    id: x.id, name: x.name, version: x.version, description: x.description,
    source: 'Built-in', enabled: extEnabled(x.id), defaultEnabled: !!x.defaultEnabled
  }));
}

module.exports = {
  BUILTIN, list, setEnabled, extEnabled, applyToSession, refreshAllSessions,
  isTrackerUrl, TRACKER_HOSTS
};
