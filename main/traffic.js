// Traffic meter (beta.7): bytes in/out per workspace.
// Chromium does not expose a per-session byte counter, so this is an
// approximation built from the webRequest layer: response bodies via
// Content-Length on completed requests, uploads via the request's
// Content-Length. Requests without those headers (chunked streams, h2
// without length) are undercounted - the meter says "approximate" in the UI
// and means it. Totals reset when the app restarts.
const counters = new Map();   // wsId -> {down, up, since}
let sfp = null;               // sessionForPartition, set by attach()

const of = (wsId) => {
  let c = counters.get(wsId);
  if (!c) { c = { down: 0, up: 0, since: Date.now() }; counters.set(wsId, c); }
  return c;
};

function attach(sessionForPartition, store) {
  sfp = sessionForPartition;
  for (const w of store.state.workspaces) hook(w.id);
}
const hooked = new Set();
function hook(wsId) {
  if (hooked.has(wsId) || !sfp) return;
  const ses = sfp('persist:' + wsId);
  if (!ses) return;
  hooked.add(wsId);
  try {
    const c = of(wsId);
    // IMPORTANT: url-filter to http/https (unfiltered listeners stall
    // pigeonhole:// requests), and the CALLBACK form - without calling back
    // with the headers, onBeforeSendHeaders stalls every request in this
    // Electron build.
    const HTTP_ONLY = { urls: ['http://*/*', 'https://*/*'] };
    ses.webRequest.onBeforeSendHeaders(HTTP_ONLY, (details, cb) => {
      try {
        const len = Number(details.requestHeaders['Content-Length'] || details.requestHeaders['content-length'] || 0);
        if (len > 0) c.up += len;
      } catch { }
      cb({ requestHeaders: details.requestHeaders });
    });
    ses.webRequest.onCompleted(HTTP_ONLY, (details) => {
      try {
        const len = Number(details.responseHeaders['Content-Length'] || details.responseHeaders['content-length'] || 0);
        if (len > 0) c.down += len;
      } catch { }
    });
  } catch (e) {
    console.error('[traffic] hook failed for', wsId, e.message);
  }
}

function read() {
  const out = {};
  for (const [wsId, c] of counters) out[wsId] = { down: c.down, up: c.up, since: c.since };
  return out;
}
function fmt(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

module.exports = { attach, hook, read, fmt };
