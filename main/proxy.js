// Pigeonhole - per-workspace proxy routing.
// Each workspace is an isolated Chromium partition, so each can carry its own
// fixed proxy: HTTP (http://host:port) or SOCKS5 (socks5://host:port),
// optional credentials and a bypass list. The exit IP is per workspace -
// accounts never share a network identity unless you want them to.
const { app } = require('electron');
const { store } = require('./store');

// ProxyConfig for Electron's session.setProxy:
//   http     -> "http=host:port;https=host:port"   (one HTTP proxy for both)
//   socks5   -> "socks5://host:port"              (all traffic through SOCKS)
function proxyRulesFor(cfg) {
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port);
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return '';
  if (cfg.scheme === 'socks5') return `socks5://${host}:${port}`;
  return `http=${host}:${port};https=${host}:${port}`;
}

// Apply (or clear) the proxy of a workspace onto its session.
async function applyWorkspaceProxy(wsId, ses) {
  const ws = store.getWorkspace(wsId);
  const cfg = ws && ws.proxy && ws.proxy.enabled ? ws.proxy : null;
  if (!cfg || !proxyRulesFor(cfg)) {
    await ses.setProxy({ mode: 'direct' });
    return false;
  }
  const bypass = String(cfg.bypass || '').trim();
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxyRulesFor(cfg),
    proxyBypassRules: bypass || '<local>'
  });
  return true;
}

// Which workspace does this webContents belong to? webview guests carry their
// partition ("persist:ws-<id>"); the chrome itself has none.
function wsIdOfWebContents(wc) {
  try {
    const part = wc && wc.session ? (wc.session.partition || '') : '';
    return part.startsWith('persist:ws-') ? part.slice('persist:'.length) : null;
  } catch { return null; }
}

// Proxy credential handler. Only proxy auth is answered (authInfo.isProxy);
// website basic-auth is left to the page's own UI.
function registerProxyAuthHandler() {
  app.on('login', (event, wc, _request, authInfo, callback) => {
    if (!authInfo || !authInfo.isProxy) return;         // not ours to answer
    const wsId = wsIdOfWebContents(wc);
    const ws = wsId ? store.getWorkspace(wsId) : null;
    if (ws && ws.proxy && ws.proxy.enabled) {
      const user = String(ws.proxy.username ?? '');
      const pass = String(store.decryptSecret(ws.proxy.password) ?? '');
      if (user || pass) { try { event.preventDefault(); } catch { } callback(user, pass); return; }
    }
    // no credentials on file: deny rather than hang the auth prompt
    try { event.preventDefault(); } catch { }
    callback();
  });
}

// Route every workspace through its configured proxy at boot.
async function applyAllProxies(sessionForPartition) {
  for (const w of store.state.workspaces) {
    try { await applyWorkspaceProxy(w.id, sessionForPartition('persist:' + w.id)); } catch { }
  }
}

module.exports = { proxyRulesFor, applyWorkspaceProxy, registerProxyAuthHandler, applyAllProxies, wsIdOfWebContents };
