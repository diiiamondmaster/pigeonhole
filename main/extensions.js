// Pigeonhole - built-in extension engine.
// Extensions are small, session-level features with a global on/off toggle in
// Settings > Extensions (and the quick panel on the toolbar puzzle button).
// Each extension is registered here with an id, description and wiring; the
// wiring runs on every workspace session (workspaces are isolated Chromium
// partitions - see main.js).
//
// Extensions shipped:
//   spellcheck     Chromium spell check per session + right-click fixes
//   trackershield  conservative tracker-beacon blocking (background hygiene)
//   videospeed     Video Speed Controller clone, injected into guest pages
//   adshield       ad blocker with Basic/Standard/Strict levels, per-site
//                  override, cosmetic hiding and a blocked counter
//
// Design notes:
// - Toggles are LIVE: webRequest hooks consult the current setting on every
//   request, stateful bits (spell check, injected content scripts) are
//   re-applied to every open guest when a toggle flips.
// - Ad Shield blocking order: its own listener runs before Tracker Shield's
//   so blocked ad requests feed the visible counter.
const { app, session, webContents: WC } = require('electron');
const fs = require('fs');
const path = require('path');
const { store } = require('./store');

// ---- injected content scripts (packed with the app, read once at boot) ----
const INJECT_DIR = path.join(__dirname, '..', 'app', 'inject');
let VSC_SRC = '', ADS_SRC = '';
function loadInjectSources() {
  try { VSC_SRC = fs.readFileSync(path.join(INJECT_DIR, 'videospeed.js'), 'utf8'); } catch (e) { console.error('[ext] videospeed.js missing', e.message); }
  try { ADS_SRC = fs.readFileSync(path.join(INJECT_DIR, 'adshield.js'), 'utf8'); } catch (e) { console.error('[ext] adshield.js missing', e.message); }
}

// ===================== blocking lists =====================
// Basic tier + Tracker Shield: analytics / ad beacons, deliberately
// conservative. Login SDKs (connect.facebook.net, accounts.google.com,
// appleid...) are NOT blocked on purpose: multi-account sign-in must work.
const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
  'adservice.google.com', 'scorecardresearch.com', 'quantserve.com',
  'outbrain.com', 'taboola.com', 'criteo.com', 'criteo.net',
  'adnxs.com', 'adsrvr.org', 'amazon-adsystem.com', 'bat.bing.com',
  'analytics.tiktok.com', 'ads-twitter.com', 'sentry-cdn.com'
];

// Standard tier adds common ad-serving hosts.
const AD_HOSTS = [
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'smartadserver.com', 'moatads.com', 'adsafeprotected.com', 'teads.tv',
  'sonobi.com', 'indexww.com', '33across.com', 'sharethrough.com',
  'spotx.tv', 'springserve.com', 'popads.net', 'propellerads.com',
  'adroll.com', 'bidswitch.net', 'yieldmo.com', 'media.net',
  'invitemedia.com', 'zedo.com', 'sitescout.com', 'advertising.com',
  'adform.net', 'appnexus.com', 'mgid.com', 'revcontent.com'
];

// Strict tier adds the aggressive tail plus URL-pattern blocking.
const STRICT_HOSTS = [
  'loopme.me', 'yieldlab.net', 'smartclip.net', 'e-planning.net',
  'adcash.com', 'adpone.com', 'adhigh.net', 'bidgear.com'
];

const URL_PATTERNS_STRICT = [
  /\/pagead\//i, /\/ptracking/i, /\/api\/stats\/ads/i, /get_midroll/i,
  /\/adframe/i, /\/adserver\//i, /prebid/i, /&ad_type=/i, /\/ptrack\?/i
];
// YouTube ad calls on youtube.com paths (applied when the PAGE is YouTube).
const URL_PATTERNS_YT = [
  /\/api\/stats\/ads/i, /\/ptracking/i, /get_midroll/i, /&ad_type=/i, /\/pagead\//i
];
const YT_PAGE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;

// ===================== cosmetic hiding =====================
const COS_GENERIC =
  'ins.adsbygoogle,[id^="div-gpt-ad"],[id^="google_ads_"],[id^="google_ads_iframe"],' +
  'iframe[src*="doubleclick.net"],iframe[src*="/adframe"],[class~="ad-slot"],' +
  '[class~="ad-banner"],[class~="advertisement"]';
const COS_YT =
  '#player-ads,.video-ads,masthead-ad,#masthead-ad,ytd-promoted-video-renderer,' +
  'ytd-promoted-sparkles-web-renderer,ytd-ad-slot-renderer,.ytp-ad-badge,' +
  '.ytp-ad-progress-list,ytd-companion-slot-renderer';
const COS_STRICT =
  '[class*="advert"],[id*="advert"],[class^="ad_"],[id^="ad_"],' +
  'iframe[src*="ad-iframe"],[id*="adslot"]';

function hostOf(raw) { try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; } }
function inList(host, list) { return list.some(t => host === t || host.endsWith('.' + t)); }
function isTrackerUrl(raw) { return inList(hostOf(raw), TRACKER_HOSTS); }

// The full Ad Shield decision. pageOrigin is the origin of the page the
// request belongs to (per-site override); level is the effective level.
function isAdUrl(raw, level, pageOrigin) {
  const host = hostOf(raw);
  if (!host) return false;
  if (isTrackerUrl(raw)) return true;                     // every tier covers beacons
  const pageHost = pageOrigin ? hostOf(pageOrigin) : '';
  const ytPage = YT_PAGE.test(pageHost);
  if (level === 'standard' || level === 'strict') {
    if (inList(host, AD_HOSTS)) return true;
    if (ytPage && URL_PATTERNS_YT.some(p => p.test(raw))) return true;
  }
  if (level === 'strict') {
    if (inList(host, STRICT_HOSTS)) return true;
    if (URL_PATTERNS_STRICT.some(p => p.test(raw))) return true;
  }
  return false;
}

function cosmeticCssFor(origin, level) {
  const host = hostOf(origin);
  const parts = [];
  if (level === 'standard' || level === 'strict') parts.push(COS_GENERIC);
  if (YT_PAGE.test(host)) parts.push(COS_YT);
  if (level === 'strict') parts.push(COS_STRICT);
  return parts.length ? parts.join(',') + '{display:none!important;}' : '';
}

// ===================== registry =====================
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
    version: '1.0.1',
    defaultEnabled: true,
    description: 'Quiet background hygiene: blocks a conservative built-in list of analytics and ad beacons (Google Analytics, DoubleClick, Taboola, Criteo, ...) in every workspace. Login SDKs are never blocked, so multi-account sign-in keeps working.'
  },
  {
    id: 'videospeed',
    name: 'Video Speed',
    version: '1.0.0',
    defaultEnabled: true,
    description: 'A Video Speed Controller, built in. Hover a video for the speed badge and controller: S slower, D faster, R reset, V pin the controller, Z/X jump 10 seconds, G remembers a speed per site. Applies to every video in every workspace.'
  },
  {
    id: 'adshield',
    name: 'Ad Shield',
    version: '1.0.0',
    defaultEnabled: true,
    description: 'Ad blocking with levels: Basic stops tracking beacons; Standard removes common ad networks and, best effort, YouTube ad slots; Strict adds aggressive pattern blocking and cosmetic hiding. Per-site override lives in the toolbar shield button and the right-click menu.'
  }
];

function extEnabled(id) {
  const m = store.state.settings.extensions || {};
  const def = BUILTIN.find(x => x.id === id);
  return m[id] === undefined ? !!(def && def.defaultEnabled) : !!m[id];
}

// ===================== Ad Shield config (level + per-site) =====================
const LEVELS = ['basic', 'standard', 'strict'];
const SITE_LEVELS = ['off', ...LEVELS];

function ensureAdshield() {
  const s = store.state.settings;
  if (!s.adshield || typeof s.adshield !== 'object') s.adshield = { level: 'standard', sites: {} };
  const a = s.adshield;
  if (!LEVELS.includes(a.level)) a.level = 'standard';
  if (!a.sites || typeof a.sites !== 'object') a.sites = {};
  const keys = Object.keys(a.sites);
  for (const k of keys) {
    if (!/^https?:\/\//.test(k) || !SITE_LEVELS.includes(a.sites[k])) delete a.sites[k];
  }
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete a.sites[k];
  return a;
}
function adLevel() { return ensureAdshield().level; }

// effective level for a page origin: per-site value or the global level
function effectiveLevelFor(pageOrigin) {
  if (!pageOrigin) return adLevel();
  const v = ensureAdshield().sites[pageOrigin];
  return (v && SITE_LEVELS.includes(v)) ? v : adLevel();
}

// cfg: { level?, site?: { origin, level|null }, resetSites? }
function setConfig(cfg) {
  const a = ensureAdshield();
  if (cfg && typeof cfg.level === 'string') {
    if (!LEVELS.includes(cfg.level)) return false;
    a.level = cfg.level;
  }
  if (cfg && cfg.site && typeof cfg.site === 'object') {
    const raw = String(cfg.site.origin || '');
    if (!/^https?:\/\//i.test(raw)) return false;
    let origin;
    try { origin = new URL(raw).origin; } catch { return false; }
    const lvl = cfg.site.level;
    if (lvl == null || lvl === 'default') delete a.sites[origin];
    else if (SITE_LEVELS.includes(lvl)) a.sites[origin] = lvl;
    else return false;
  }
  if (cfg && cfg.resetSites) a.sites = {};
  store.save();
  reinjectAll();
  return true;
}

function setSiteLevel(origin, level) {   // level null = follow global
  return setConfig({ site: { origin, level } });
}

function getConfig() {
  const a = ensureAdshield();
  return { level: a.level, sites: { ...a.sites } };
}

// ===================== blocked counter =====================
const ads = { total: 0, perWs: {}, _t: 0 };
let emitFn = () => { };
function setEmitter(fn) { emitFn = fn; }
function noteBlocked(wsId) {
  ads.total++;
  const k = wsId || 'unknown';
  ads.perWs[k] = (ads.perWs[k] || 0) + 1;
  const now = Date.now();
  if (now - ads._t > 700) {
    ads._t = now;
    emitFn('ads-blocked', { total: ads.total, perWs: { ...ads.perWs } });
  }
}
function adsCounts() { return { total: ads.total, perWs: { ...ads.perWs } }; }

// ===================== session wiring =====================
// ONE webRequest listener per workspace session covering Tracker Shield and
// Ad Shield (Electron allows a single onBeforeRequest listener per session,
// so the checks are combined).
function applyToSession(ses) {
  const part = ses.partition || '';
  const wsId = part.startsWith('persist:ws-') ? part.slice('persist:'.length) : null;

  try { ses.setSpellCheckerEnabled(extEnabled('spellcheck')); } catch { }
  try { if (extEnabled('spellcheck')) ses.setSpellCheckerLanguages(['en-US']); } catch { }

  try {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
      if (details.resourceType === 'mainFrame') return cb({});
      const url = details.url;
      // Ad Shield first - its Basic tier is a superset of the tracker list,
      // and its blocks feed the visible counter.
      if (extEnabled('adshield')) {
        const pageOrigin = origins.get(details.webContentsId) || null;
        const level = effectiveLevelFor(pageOrigin);
        if (level !== 'off' && isAdUrl(url, level, pageOrigin)) {
          noteBlocked(wsId);
          return cb({ cancel: true });
        }
      }
      if (extEnabled('trackershield') && isTrackerUrl(url)) {
        return cb({ cancel: true });
      }
      cb({});
    });
  } catch { }
}

// re-apply the stateful parts (spell check) to every open workspace session
function refreshAllSessions() {
  for (const w of store.state.workspaces) {
    try { applyToSession(session.fromPartition('persist:' + w.id)); } catch { }
  }
}

// ===================== content-script injection =====================
// Track the top-frame origin of every guest page so per-site Ad Shield
// rules apply to the page being viewed.
const origins = new Map();   // webContentsId -> origin

function isGuest(wc) {
  try { return wc.getType() === 'webview'; } catch { return false; }
}

function trackOrigin(wc) {
  try {
    const u = new URL(wc.getURL());
    if (/^https?:$/.test(u.protocol)) origins.set(wc.id, u.origin);
    else origins.delete(wc.id);
  } catch { origins.delete(wc.id); }
}

function guestOrigin(wc) {
  try {
    const u = new URL(wc.getURL());
    if (/^https?:$/.test(u.protocol)) return u.origin;
  } catch { }
  return null;
}

function adshieldCssFor(origin) {
  if (!extEnabled('adshield') || !origin) return '';
  const level = effectiveLevelFor(origin);
  if (level === 'off' || level === 'basic') return '';
  return cosmeticCssFor(origin, level);
}

async function injectForGuest(wc) {
  const origin = guestOrigin(wc);
  if (!origin) return;
  // Video Speed: inject when on, live-disable when off (no-op if absent)
  if (VSC_SRC) {
    const on = extEnabled('videospeed');
    const tail = on
      ? VSC_SRC + ';window.__phVSC&&window.__phVSC.setEnabled(true);void 0'
      : 'window.__phVSC&&window.__phVSC.setEnabled(false);void 0';
    try { await wc.executeJavaScript(tail, false); } catch { }
  }
  if (ADS_SRC) {
    const css = adshieldCssFor(origin);
    try { await wc.executeJavaScript('(' + ADS_SRC + ')(' + JSON.stringify(css) + ');void 0', false); } catch { }
  }
}

function reinjectAll() {
  for (const wc of WC.getAllWebContents()) {
    if (!isGuest(wc)) continue;
    injectForGuest(wc).catch(() => { });
  }
}

// register at boot: track guest origins, inject content scripts on dom-ready
function init() {
  loadInjectSources();
  app.on('web-contents-created', (_e, wc) => {
    if (!isGuest(wc)) return;
    wc.on('did-navigate', () => trackOrigin(wc));
    wc.on('dom-ready', () => {
      trackOrigin(wc);
      injectForGuest(wc).catch(() => { });
    });
    wc.on('destroyed', () => origins.delete(wc.id));
  });
}

// toggling from the UI: persist, re-apply stateful parts, re-inject scripts
function setEnabled(id, on) {
  if (!BUILTIN.some(x => x.id === id)) return false;
  const exts = { ...(store.state.settings.extensions || {}) };
  exts[id] = !!on;
  store.state.settings.extensions = exts;
  store.save();
  refreshAllSessions();   // spell check live re-apply (+ listener re-arm)
  reinjectAll();          // videospeed / adshield live re-apply
  return true;
}

function list() {
  const a = ensureAdshield();
  return BUILTIN.map(x => ({
    id: x.id, name: x.name, version: x.version, description: x.description,
    source: 'Built-in', enabled: extEnabled(x.id), defaultEnabled: !!x.defaultEnabled,
    ...(x.id === 'adshield' ? { config: { level: a.level, siteCount: Object.keys(a.sites).length } } : {})
  }));
}

module.exports = {
  BUILTIN, list, setEnabled, extEnabled, applyToSession, refreshAllSessions,
  isTrackerUrl, TRACKER_HOSTS, isAdUrl, cosmeticCssFor,
  init, setConfig, getConfig, setSiteLevel, effectiveLevelFor,
  adsCounts, setEmitter
};
