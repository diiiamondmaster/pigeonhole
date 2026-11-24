// Autoplayed regression test for the form engine.
// Serves dev/ over http, loads each test page in a webview, runs DETECT and
// FILL exactly as the chrome would, and prints a PASS/FAIL matrix.
//   electron scripts/test-autofill.mjs   (from the repo root, DISPLAY set)
import { app, BrowserWindow, protocol } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectScript, providerFillScript, siteFillScript } from '../app/js/autofill.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev');
const PORT = 8123;

const results = [];
const check = (name, pass, extra = '') => results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`);

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const file = path.join(DIR, req.url === '/' ? 'provider-mock.html' : req.url.split('?')[0]);
      try { res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(file)); }
      catch { res.statusCode = 404; res.end('nope'); }
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function inPage(win, url, fn) {
  await win.webContents.executeJavaScript(`(async () => {
    const wv = document.querySelector('webview');
    wv.setAttribute('src', '${url}');
    return true;
  })()`);
  // wait for load
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const done = await win.webContents.executeJavaScript(`(async () => {
      const wv = document.querySelector('webview');
      try { await wv.getWebContentsId(); } catch { return false; }
      return wv.getURL().startsWith('${url.split('/').slice(0, 3).join('/')}') && (await wv.executeJavaScript('document.readyState')) === 'complete';
    })()`);
    if (done) { await sleep(400); return; }
  }
  throw new Error('page never loaded: ' + url);
}

async function runInWebview(win, script) {
  return win.webContents.executeJavaScript(`(async () => {
    const wv = document.querySelector('webview');
    return await wv.executeJavaScript(${JSON.stringify(script)}, false);
  })()`);
}

const IDENTITY = {
  email: 'testuser042@mockmail.com', password: 'Sturdy-Birch-42!',
  first: 'Test', last: 'User',
  dob: { y: 1993, m: 7, d: 14 }, gender: 'female', answer: 'otter482'
};

app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  const srv = await serve();
  const win = new BrowserWindow({
    width: 1100, height: 800, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('data:text/html,<body><webview partition="persist:test-ws" style="width:100%;height:100%"></webview></body>');
  await sleep(600);

  // ---------- provider mock ----------
  try {
    await inPage(win, `http://127.0.0.1:${PORT}/provider-mock.html`);
    const d = await runInWebview(win, detectScript());
    check('provider mock: detect kind=signup', d.kind === 'signup', JSON.stringify(d).slice(0, 120));
    check('provider mock: captcha detected', d.captcha === true);
    const f = await runInWebview(win, providerFillScript(IDENTITY));
    check('provider mock: fill ok', f.ok === true, JSON.stringify(f).slice(0, 200));
    const vals = await runInWebview(win, `(() => ({
      user: document.getElementById('desired').value,
      dom: document.getElementById('dom').value,
      fn: document.getElementById('fn').value,
      ln: document.getElementById('ln').value,
      bd: document.getElementById('bd').value,
      bm: document.getElementById('bm').value,
      by: document.getElementById('by').value,
      g: document.getElementById('g').value,
      pw: document.getElementById('pw').value,
      pw2: document.getElementById('pw2').value,
      sq: document.getElementById('sq').value,
      tos: document.getElementById('tos').checked
    }))()`);
    check('provider mock: local part filled', vals.user === 'testuser042', vals.user);
    check('provider mock: domain selected', vals.dom === 'mockmail.com', vals.dom);
    check('provider mock: names filled', vals.fn === 'Test' && vals.ln === 'User');
    check('provider mock: dob filled', vals.bd === '14' && vals.bm === '07' && vals.by === '1993', vals.bd + '/' + vals.bm + '/' + vals.by);
    check('provider mock: gender selected', vals.g === 'female', vals.g);
    check('provider mock: password + confirm', vals.pw === IDENTITY.password && vals.pw2 === IDENTITY.password);
    check('provider mock: security answer', vals.sq === IDENTITY.answer);
    check('provider mock: terms checked', vals.tos === true);
    const captchaUntouched = await runInWebview(win, `document.getElementById('cap').value === ''`);
    check('provider mock: captcha untouched', captchaUntouched === true);
  } catch (e) { check('provider mock run', false, String(e)); }

  // ---------- site login / signup playground ----------
  try {
    await inPage(win, `http://127.0.0.1:${PORT}/form-playground.html`);
    let d = await runInWebview(win, detectScript());
    check('site playground: login detected', d.kind === 'login', JSON.stringify(d).slice(0, 100));
    let f = await runInWebview(win, siteFillScript({ email: IDENTITY.email, password: IDENTITY.password }));
    check('site playground: login fill ok', f.ok && f.filled.join(',').includes('email') && f.filled.join(',').includes('password'), JSON.stringify(f));
    const em = await runInWebview(win, `document.getElementById('em').value`);
    check('site playground: login email value', em === IDENTITY.email, em);

    // switch to signup form
    await runInWebview(win, `document.getElementById('toggle').click()`);
    await sleep(250);
    d = await runInWebview(win, detectScript());
    check('site playground: signup detected after toggle', d.kind === 'signup', JSON.stringify(d).slice(0, 100));
    f = await runInWebview(win, siteFillScript({ email: IDENTITY.email, password: IDENTITY.password, first: 'Test', last: 'User' }));
    check('site playground: signup fill ok', f.ok, JSON.stringify(f));
    const pw2 = await runInWebview(win, `document.getElementById('rpw2').value`);
    check('site playground: confirm password value', pw2 === IDENTITY.password, pw2);

    // credential read-back (save prompt source)
    await runInWebview(win, `document.getElementById('rem').value = 'other@mail.com'; document.getElementById('rpw').value = 'hunter22';`);
    d = await runInWebview(win, detectScript());
    check('site playground: typed credentials captured', d.email === 'other@mail.com' && d.password === 'hunter22', JSON.stringify(d).slice(0, 90));
  } catch (e) { check('site playground run', false, String(e)); }

  // ---------- live pages: detection only ----------
  for (const [name, url, expectKind] of [
    ['proton signup', 'https://account.proton.me/signup', ['signup', 'none']],
    ['example.com', 'https://example.com/', ['none']]
  ]) {
    try {
      await inPage(win, url);
      const d = await runInWebview(win, detectScript());
      check(`live ${name}: detect=${expectKind.join('|')}`, expectKind.includes(d.kind), JSON.stringify(d).slice(0, 90));
    } catch (e) { check(`live ${name}`, false, String(e).slice(0, 90)); }
  }

  console.log('\n===== autofill engine tests =====');
  console.log(results.join('\n'));
  fs.writeFileSync('/home/z/my-project/pigeonhole/dev-shots/autofill-tests.txt', results.join('\n'));
  const fails = results.filter(r => r.startsWith('FAIL')).length;
  srv.close();
  app.exit(fails ? 1 : 0);
});
