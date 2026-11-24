#!/usr/bin/env node
// v1.0.2 E2E suite. Boots the real app (app/ over HTTP + Electron + CDP),
// then drives the wizard, the form engine and the tab drag-reorder with real
// clicks / real pointer gestures against local mock pages built from the
// ground-truth DOM structures of the real providers.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const ROOT = '/home/z/pigeonhole';
const APP_PORT = 8177;
const CDP_PORT = 9222;
const DEV = 'http://127.0.0.1:8123';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  [' + String(detail).slice(0, 300) + ']' : ''}`); }
};

function startStatic() {
  const dir = path.join(ROOT, 'app');
  const srv = http.createServer((req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(dir, path.normalize(rel));
      if (!file.startsWith(dir)) { res.statusCode = 403; return res.end(); }
      res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch { res.statusCode = 404; res.end('nf'); }
  });
  return new Promise(r => srv.listen(APP_PORT, '127.0.0.1', () => r(srv)));
}

async function bootApp() {
  fs.rmSync('/tmp/e2e-cfg', { recursive: true, force: true });
  const env = { ...process.env, PH_E2E: '1', PH_APP_URL: `http://127.0.0.1:${APP_PORT}/index.html`, XDG_CONFIG_HOME: '/tmp/e2e-cfg', DISPLAY: process.env.DISPLAY || ':99', ELECTRON_ENABLE_LOGGING: '1' };
  const elec = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [ROOT, '--serve-dev', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--enable-unsafe-swiftshader'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  const t0 = Date.now();
  let browser = null;
  while (!browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); }
    catch { if (Date.now() - t0 > 40000) throw new Error('electron never came up'); await new Promise(r => setTimeout(r, 400)); }
  }
  let page = null;
  while (!page) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith(`http://127.0.0.1:${APP_PORT}`)) page = p;
    if (!page) await new Promise(r => setTimeout(r, 300));
  }
  await page.waitForTimeout(2200);
  return { browser, page, elec };
}

async function main() {
  const srv = await startStatic();
  const { browser, page, elec } = await bootApp();
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  // fresh session helpers
  const newWs = () => ev(async () => {
    const { refresh } = await import('/js/state.js');
    const { id } = await window.pigeonhole.workspaces.create({});
    await refresh();
    return id;
  });
  const drive = (wsId, url, opts) => ev(async ([wsId, url, opts]) => {
    const { refresh } = await import('/js/state.js');
    const { driveMockFlow } = await import('/js/wizard.js');
    await refresh();
    return driveMockFlow(wsId, url, opts);
  }, [wsId, url, opts]);
  // read the mock page's live state from inside its webview
  const mockState = (wsId, expr) => ev(async ([wsId, expr]) => {
    const Tabs = await import('/js/tabs.js');
    const t = Tabs.list(wsId).find(t => t.active);
    const wv = Tabs.webviewOf(wsId, t);
    return wv.executeJavaScript(expr, false);
  }, [wsId, expr]);

  // ============ A. form engine ============
  console.log('\n== A1. classic mock (regression) ==');
  {
    const ws = await newWs();
    const r = await drive(ws, `${DEV}/provider-mock.html`);
    check('fills username+passwords+names+dob+terms', r.fill?.ok && ['username', 'password + confirm', 'first name', 'last name', 'date of birth'].every(f => r.fill.filled.includes(f)) && /terms/.test(r.fill.filled.join(',')), JSON.stringify(r.fill));
    check('captcha left untouched', r.fill?.captcha === true);
    const st = await mockState(ws, `JSON.stringify({
      u: document.getElementById('emailLocal').value,
      d: document.getElementById('domain').value,
      pw: document.getElementById('pw').value,
      pw2: document.getElementById('pw2').value,
      terms: document.getElementById('terms').checked,
      cap: document.getElementById('cap').value })`);
    const s = JSON.parse(st);
    check('username typed into local-part input', s.u === 'tester007', s.u);
    check('domain select set', s.d === 'mockmail.com', s.d);
    check('passwords set', s.pw && s.pw === s.pw2 && s.pw.length >= 16, s.pw);
    check('terms ticked', s.terms === true);
    check('captcha NOT filled', s.cap === '');
    check('identity saved', r.email === 'tester007@mockmail.com', r.email);
  }

  console.log('\n== A2. Tuta-structure mock (plan picker -> aria-only fields, custom domain dropdown, unlabeled checkboxes) ==');
  {
    const ws = await newWs();
    // hold on create step; first the plan picker shows: autofill must NOT fire
    await ev(async ([ws, url]) => {
      const { refresh } = await import('/js/state.js');
      const { driveMockFlow } = await import('/js/wizard.js');
      await refresh();
      await driveMockFlow(ws, url, { hold: true, domain: 'tutamail.com', base: 'silent', num: 4 });
    }, [ws, `${DEV}/provider-tuta-mock.html`]);
    await page.waitForTimeout(4500);
    const before = await ev(async ([ws]) => {
      const wizardTxt = document.querySelector('#wizardPanel')?.innerText || '';
      const Tabs = await import('/js/tabs.js');
      const t = Tabs.list(ws).find(t => t.active);
      const wv = Tabs.webviewOf(ws, t);
      const planVisible = await wv.executeJavaScript(`!document.getElementById('plan-step').hidden`, false);
      return { planVisible, autofillTxt: (wizardTxt.match(/Autofill the form\n([^\n]*)/) || [])[1] || '' };
    }, [ws]);
    check('plan picker screen shows first', before.planVisible === true);
    check('no premature fill on plan picker', /plan picker|moment/.test(before.autofillTxt), before.autofillTxt);
    // user picks Free + Continue inside the mock page
    await ev(async ([ws]) => {
      const Tabs = await import('/js/tabs.js');
      const t = Tabs.list(ws).find(t => t.active);
      const wv = Tabs.webviewOf(ws, t);
      await wv.executeJavaScript(`(async () => {
        document.querySelector('#plan-step [data-plan="free"]').click();
        document.getElementById('plan-continue').click();
      })()`, false);
    }, [ws]);
    await page.waitForTimeout(5000);
    const after = await ev(async ([ws]) => {
      const Tabs = await import('/js/tabs.js');
      const t = Tabs.list(ws).find(t => t.active);
      const wv = Tabs.webviewOf(ws, t);
      const state = await wv.executeJavaScript(`JSON.stringify({
        u: document.getElementById('u').value,
        dom: window.__phDomain || null,
        openLabel: document.getElementById('dd-open').textContent,
        pw: document.getElementById('pw').value, pw2: document.getElementById('pw2').value,
        c1: document.getElementById('c1').checked, c2: document.getElementById('c2').checked,
        cap: document.querySelector('.captcha input').value,
        submitOn: !document.getElementById('submit').disabled })`, false);
      const wiz = document.querySelector('#wizardPanel')?.innerText || '';
      return { state: JSON.parse(state), autofillTxt: (wiz.match(/Autofill the form\n([^\n]*)/) || [])[1] || '' };
    }, [ws]);
    const st = after.state;
    check('autofill fired after form appeared', /Filled/.test(after.autofillTxt), after.autofillTxt);
    check('aria-label-only username filled', st.u === 'silent004', st.u);
    check('custom domain dropdown picked tutamail.com', st.dom === 'tutamail.com' && st.openLabel === 'tutamail.com', JSON.stringify({ dom: st.dom, openLabel: st.openLabel }));
    check('both password fields filled (set + repeat)', st.pw && st.pw === st.pw2 && st.pw.length >= 16, st.pw);
    check('unlabeled declaration checkbox ticked', st.c1 === true);
    check('terms checkbox ticked', st.c2 === true);
    check('captcha untouched', st.cap === '');
    check('mock submit now enabled (all required fields satisfied)', st.submitOn === true);
  }

  console.log('\n== A3. shadow-DOM form ==');
  {
    const ws = await newWs();
    const r = await drive(ws, `${DEV}/provider-shadow-mock.html`);
    check('fills fields inside shadow root', r.fill?.ok && r.fill.filled.includes('email') && r.fill.filled.includes('username') && r.fill.filled.includes('password + confirm'), JSON.stringify(r.fill));
    const st = await mockState(ws, `JSON.stringify({ u: document.querySelector('#host').shadowRoot.getElementById('u').value, e: document.querySelector('#host').shadowRoot.getElementById('e').value, pw: document.querySelector('#host').shadowRoot.getElementById('pw').value, terms: document.querySelector('#host').shadowRoot.getElementById('terms').checked })`);
    const s = JSON.parse(st);
    check('shadow username + email both set', s.u === 'tester007' && s.e === 'tester007@mockmail.com', st);
    check('shadow password set', s.pw && s.pw.length >= 16, s.pw);
    check('shadow terms ticked', s.terms === true);
  }

  console.log('\n== A4. same-origin iframe form ==');
  {
    const ws = await newWs();
    const r = await drive(ws, `${DEV}/provider-iframe-mock.html`);
    const st = await mockState(ws, `JSON.stringify({
      u: document.querySelector('#frame').contentDocument.querySelector('[name=username]').value,
      e: document.querySelector('#frame').contentDocument.querySelector('[name=email]').value,
      pw2: document.querySelector('#frame').contentDocument.querySelector('[name=password2]').value,
      topPw: document.body.querySelector('input[type=password]').value })`);
    const s = JSON.parse(st);
    check('iframe username filled (local part)', s.u === 'tester007', s.u);
    check('iframe confirm password filled', s.pw2 && s.pw2.length >= 16, s.pw2);
    check('top-frame password filled', s.topPw && s.topPw === s.pw2, s.topPw);
    check('email filled with full address (email field)', s.e === 'tester007@mockmail.com', s.e);
  }

  console.log('\n== A5. two-step flow (username screen -> password screen) ==');
  {
    const ws = await newWs();
    await ev(async ([ws, url]) => {
      const { refresh } = await import('/js/state.js');
      const { driveMockFlow } = await import('/js/wizard.js');
      await refresh();
      // drive only to the create step; the multi-step page needs manual stepping
      await driveMockFlow(ws, url, { hold: true, base: 'stepper', num: 5 });
    }, [ws, `${DEV}/provider-step-mock.html`]);
    await page.waitForTimeout(4500);   // step1 fill
    const step1 = await mockState(ws, `JSON.stringify({ u: document.getElementById('u').value })`);
    check('step 1 username filled', JSON.parse(step1).u === 'stepper005', step1);
    await ev(async ([ws]) => {
      const Tabs = await import('/js/tabs.js');
      const t = Tabs.list(ws).find(t => t.active);
      await Tabs.webviewOf(ws, t).executeJavaScript(`document.getElementById('next').click()`, false);
    }, [ws]);
    await page.waitForTimeout(4500);   // step2 fill
    const step2 = await mockState(ws, `JSON.stringify({ pw: document.getElementById('pw').value, pw2: document.getElementById('pw2').value, terms: document.getElementById('terms').checked })`);
    const s2 = JSON.parse(step2);
    check('step 2 passwords filled after navigation', s2.pw && s2.pw === s2.pw2 && s2.pw.length >= 16, step2);
    check('step 2 terms ticked', s2.terms === true);
  }

  // ============ B. wizard UI click-through (real clicks) ============
  console.log('\n== B1. guided path with Tuta ==');
  {
    const ws = await newWs();
    await ev(async ([ws]) => { const Tabs = await import('/js/tabs.js'); const { refresh } = await import('/js/state.js'); await refresh(); Tabs.switchWorkspace(ws); }, [ws]);
    await page.waitForTimeout(800);
    // open the wizard via the sidebar's context action? simplest: the "+" new-workspace flow already opens it.
    // here: open via the module directly, then interact with the UI by real clicks
    await ev(async ([ws]) => { const { openWizard } = await import('/js/wizard.js'); openWizard(ws); }, [ws]);
    await page.waitForTimeout(300);
    await page.getByText('Create a new email account (guided)').click();
    await page.waitForTimeout(300);
    check('provider step reached', await page.getByText('Where should this mailbox live?').isVisible());
    const domCount = await page.locator('#wizardPanel select option').count();
    check('tuta offers 6 domains in wizard', (await ev(async () => {
      const { PROVIDERS } = await import('/js/providers.js');
      const t = PROVIDERS.find(p => p.id === 'tuta');
      return t.domains.length === 6 && t.domains.includes('tutamail.com') && t.domains.includes('tutanota.de') && t.domains.includes('keemail.me');
    })));
    // pick Tuta card, choose tutamail.com domain, continue
    await page.getByText('Tuta', { exact: false }).first().click();
    await page.waitForTimeout(300);
    await page.locator('#wizardPanel button:has-text("Continue")').first().click();
    await page.waitForTimeout(300);
    check('identity step reached', await page.locator('#wizardPanel .id-email').isVisible());
    // type a base handle so the preview has a local part, then switch domain
    await page.locator('#wizardPanel input.input').first().fill('bluebird');
    await page.waitForTimeout(200);
    // switch domain to tutamail.com (the Domain field's select is the first one)
    await page.locator('#wizardPanel select').first().selectOption('tutamail.com');
    const preview = await page.locator('#wizardPanel .id-email').innerText();
    check('preview shows @tutamail.com', preview.includes('@tutamail.com'), preview);
  }

  console.log('\n== B2. existing-email path ==');
  {
    const ws = await newWs();
    await ev(async ([ws]) => { const { refresh } = await import('/js/state.js'); await refresh(); const Tabs = await import('/js/tabs.js'); Tabs.switchWorkspace(ws); }, [ws]);
    await page.waitForTimeout(600);
    await ev(async ([ws]) => { const { openWizard } = await import('/js/wizard.js'); openWizard(ws); }, [ws]);
    await page.waitForTimeout(300);
    await page.getByText('Use an email I already have').click();
    await page.waitForTimeout(300);
    const cont = page.locator('#wizardPanel button:has-text("Continue")').first();
    check('existing: Continue disabled until both fields typed', await cont.isDisabled());
    await page.locator('#wizardPanel input[type=email]').fill('someone@fastmail.com');
    await page.locator('#wizardPanel input[type=password]').fill('sup3rsecret!');
    check('existing: Continue unlocks live', !(await cont.isDisabled()));
    await cont.click();
    await page.waitForTimeout(300);
    await page.locator('#wizardPanel button:has-text("Save workspace identity")').click();
    await page.waitForTimeout(800);
    const saved = await ev(async ([ws]) => {
      const S = await import('/js/state.js');
      await S.refresh();
      return S.ws(ws)?.identity?.email;
    }, [ws]);
    check('existing identity saved', saved === 'someone@fastmail.com', saved);
  }

  // ============ C. tab reorder ============
  await ev(async () => { const { closeWizard } = await import('/js/wizard.js'); closeWizard(); });
  console.log('\n== C1. drag reorder (real pointer gestures) ==');
  {
    const ws = await newWs();
    await ev(async ([ws]) => {
      const Tabs = await import('/js/tabs.js');
      const { refresh } = await import('/js/state.js');
      await refresh();
      Tabs.switchWorkspace(ws);
      for (let i = 0; i < 3; i++) Tabs.createTab(ws, { url: `http://127.0.0.1:8123/form-playground.html?q=${i}`, active: false });
      await new Promise(r => setTimeout(r, 600));
    }, [ws]);
    const before = await ev(async ([ws]) => (await import('/js/tabs.js')).list(ws).map(t => t.id), [ws]);
    // drag the LAST tab to the front with real pointer events (one continuous
    // gesture; the final single move lands solidly inside the first tab's half)
    const rects = await page.evaluate(() => [...document.querySelectorAll('#tabstrip .tab')].map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, id: n.getAttribute('data-tab') }; }));
    const last = rects[rects.length - 1], first = rects[0];
    const cy = last.y + last.h / 2;
    await page.mouse.move(last.x + last.w / 2, cy);
    await page.mouse.down();
    await page.mouse.move(first.x + first.w / 2, cy, { steps: 15 });
    await page.waitForTimeout(120);
    await page.mouse.move(first.x + 30, cy);
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(600);
    const after = await ev(async ([ws]) => (await import('/js/tabs.js')).list(ws).map(t => t.id), [ws]);
    check('drag moved last tab to front', after[0] === before[before.length - 1] && after.length === before.length, JSON.stringify({ before, after }));
    // persist check: what the store received
    const saved = await ev(async ([ws]) => {
      const S = await import('/js/state.js');
      await new Promise(r => setTimeout(r, 700));   // persist is debounced
      await S.refresh();
      return (S.tabsFor(ws) || []).map(t => t.id);
    }, [ws]);
    check('reorder persisted to store', saved[0] === before[before.length - 1], JSON.stringify(saved));
  }

  console.log('\n== C2. moveTab + context menu ==');
  {
    const ws = await newWs();
    await ev(async ([ws]) => {
      const Tabs = await import('/js/tabs.js');
      const { refresh } = await import('/js/state.js');
      await refresh();
      Tabs.switchWorkspace(ws);
      for (let i = 0; i < 3; i++) Tabs.createTab(ws, { url: `http://127.0.0.1:8123/form-playground.html?m=${i}`, active: false });
      await new Promise(r => setTimeout(r, 500));
    }, [ws]);
    await page.waitForTimeout(500);
    const before = await ev(async ([ws]) => (await import('/js/tabs.js')).list(ws).map(t => t.id), [ws]);
    await ev(async ([ws]) => { const Tabs = await import('/js/tabs.js'); Tabs.moveTab(ws, (await import('/js/tabs.js')).list(ws)[2].id, -2); }, [ws]);
    const after = await ev(async ([ws]) => (await import('/js/tabs.js')).list(ws).map(t => t.id), [ws]);
    check('moveTab reorders the array', after[0] === before[2], JSON.stringify({ before, after }));
    // right-click a tab -> menu shows Move left/right
    const r = await page.evaluate(() => { const t = document.querySelectorAll('#tabstrip .tab')[1]; if (!t) return null; const b = t.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), n: document.querySelectorAll('#tabstrip .tab').length }; });
    console.log('  [c2] right-click target:', JSON.stringify(r));
    await page.mouse.click(r.x, r.y, { button: 'right' });
    await page.waitForTimeout(300);
    const menuText = await page.evaluate(() => document.querySelector('#menuRoot')?.innerText || '');
    check('tab context menu offers move actions', /Move left/.test(menuText) && /Move right/.test(menuText), menuText);
    await page.keyboard.press('Escape');
  }

  // ============ D. misc sanity ============
  console.log('\n== D. misc ==');
  {
    check('provider list intact (4 providers)', await ev(async () => { const { PROVIDERS } = await import('/js/providers.js'); return PROVIDERS.length === 4; }));
    check('fill button present in toolbar', (await page.locator('#fillBtn').count()) === 1);
    check('no console errors during run', (await page.evaluate(() => (window.__errs || []).length)) === 0);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  fs.rmSync('/tmp/e2e-cfg', { recursive: true, force: true });
  elec.kill(); srv.close();
  try { await browser.close(); } catch { }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[e2e] CRASHED', e); process.exit(1); });
