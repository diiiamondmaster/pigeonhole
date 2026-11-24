// Pigeonhole - internal pigeonhole:// protocol.
//   pigeonhole://newtab?ws=<id>   -> the per-workspace new tab page
//   pigeonhole://error?code=..&url=.. -> the styled network error page
// Both pages are self-contained HTML files under app/ntp and app/error; the
// handler injects workspace data at serve time (newtab) so nothing sensitive
// is baked into the files on disk.
const path = require('path');
const fs = require('fs');

let store = null;
let ntpCache = null;

function readTemplate(rel) {
  return fs.readFileSync(path.join(__dirname, '..', 'app', rel), 'utf8');
}

// The handler is attached to the default session here and to every workspace
// partition session via attachProtocolToSession - webviews do not share the
// default session's protocol handlers.
function makeHandler(scope) {
  return (request) => {
    try {
      const u = new URL(request.url);
      const host = u.hostname;

      if (host === 'newtab') {
        const wsId = u.searchParams.get('ws') || '';
        const ws = store.getWorkspace(wsId);
        const identity = ws?.identity ? {
          email: ws.identity.email,
          displayName: ws.identity.displayName,
          provider: ws.identity.provider,
          createdAt: ws.identity.createdAt
        } : null;
        const data = {
          ws: ws ? { num: ws.num, name: ws.name, id: ws.id } : null,
          identity,
          history: (store.state.history[wsId] || []).slice(-6).reverse(),
          engine: store.state.settings.searchEngine
        };
        if (!ntpCache) ntpCache = readTemplate(path.join('ntp', 'ntp.html'));
        const html = ntpCache.replace('"__NTP_DATA__"', JSON.stringify(data));
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (host === 'error') {
        const html = readTemplate(path.join('error', 'error.html'));
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response('Bad request', { status: 400 });
    }
  };
}

function registerProtocol(storeRef) {
  store = storeRef;
  const { protocol } = require('electron');
  protocol.handle('pigeonhole', makeHandler('default'));
}

function attachProtocolToSession(ses) {
  try { ses.protocol.handle('pigeonhole', makeHandler('partition')); }
  catch (e) { console.error('[protocol] attach failed:', e.message); }
}

module.exports = { registerProtocol, attachProtocolToSession };
