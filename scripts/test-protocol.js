// Isolation test: does the pigeonhole:// protocol serve the NTP?
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'pigeonhole', privileges: { standard: true, secure: true } }
]);

app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  protocol.handle('pigeonhole', (req) => {
    console.log('[proto] request:', req.url);
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'ntp', 'ntp.html'), 'utf8');
    const data = { ws: { num: 3, name: 'Test', id: 'x' }, identity: null, history: [], engine: 'google' };
    const out = html.replace('"__NTP_DATA__"', JSON.stringify(data));
    console.log('[proto] serving', out.length, 'bytes, data-injected:', out.includes('"ws"'));
    return new Response(out, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  await win.loadURL('pigeonhole://newtab?ws=test');
  await new Promise(r => setTimeout(r, 1500));
  const title = await win.webContents.executeJavaScript('document.title');
  const body = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 200)');
  console.log('[proto] title:', title);
  console.log('[proto] body:', JSON.stringify(body));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/proto-test.png', img.toPNG());
  app.quit();
});
