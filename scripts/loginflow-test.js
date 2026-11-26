// Decisive test: workspace proxy with CREDENTIALS on an HTTP proxy that
// demands Proxy-Authorization (the PL fake). Does the webview page load
// (login event -> stored creds) and does the request transit the proxy?
const { app, session } = require('electron');
const { BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  // fake ws store data: use a plain session with the proxy set the same way
  // applyWorkspaceProxy would (no inline creds - they are unsupported), then
  // rely on the app 'login' event answering from "the store"
  const ses = session.fromPartition('persist:ws-testlogin');
  // no creds in the rules (Chromium refuses them); the rules point at PL
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: 'http=127.0.0.1:8304;https=127.0.0.1:8304',
    proxyBypassRules: '<-loopback>'
  });
  app.on('login', (event, wc, _request, authInfo, callback) => {
    console.log('LOGIN EVENT fired, isProxy =', authInfo && authInfo.isProxy);
    if (!authInfo || !authInfo.isProxy) return;
    try { event.preventDefault(); } catch { }
    callback('u1', 'p9');   // "from the store"
  });
  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true } });
  await win.loadURL('http://127.0.0.1:8195/pool-target.html?loginflow');
  console.log('loaded, title:', await win.webContents.executeJavaScript('document.body.innerText').catch(() => 'ERR'));
  app.exit(0);
});
