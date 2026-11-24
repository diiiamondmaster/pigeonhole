// The form engine. Two page-world scripts (DETECT / FILL) are built here as
// strings and executed inside the active webview via <webview>.executeJavaScript.
//
// Design rules:
//  - heuristic field discovery by label text, name/id/autocomplete/placeholder
//  - React/Vue-safe value setting (native setter + input/change events)
//  - scans shadow DOM and same-origin iframes (many modern signups render
//    their form inside one); detects cross-origin "protected" boxes and says so
//  - never touches CAPTCHA fields
//  - never overwrites values the user (or the site) already typed
//  - provider mode knows how to split an address into local part + domain,
//    including custom (non-<select>) domain dropdowns

// ------------------------------------------------------------------
// shared page-world helpers (inlined into both scripts)
// ------------------------------------------------------------------
const PAGE_HELPERS = `
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const visible = (el, doc) => {
    try {
      if (el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const st = (doc || document).defaultView.getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    } catch { return false; }
  };
  const hintsOf = (el) => {
    const parts = [el.name || '', el.id || '', el.getAttribute('autocomplete') || '',
      el.placeholder || '', el.getAttribute('aria-label') || ''];
    try {
      if (el.labels && el.labels.length) parts.push([...el.labels].map(l => l.textContent || '').join(' '));
      const lb = el.closest('label'); if (lb) parts.push(lb.textContent || '');
      const lbBy = el.getAttribute('aria-labelledby');
      if (lbBy) parts.push(lbBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
      const grp = el.closest('[data-hint]'); if (grp) parts.push(grp.getAttribute('data-hint') || '');
    } catch {}
    return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
  };
  // text around an element (parent chain) - for checkboxes that carry no
  // label markup but sit next to the consent sentence
  const aroundText = (el) => {
    const parts = [];
    try {
      let n = el.parentElement;
      for (let i = 0; i < 2 && n; i++) { parts.push(n.textContent || ''); n = n.parentElement; }
    } catch {}
    return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase().slice(0, 400);
  };
  const setVal = (el, v) => {
    try {
      const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
      return true;
    } catch { return false; }
  };
  const setSelect = (sel, v, opts) => {
    try {
      const match = [...sel.options].find(o => {
        const ov = (o.value || '').toLowerCase(), ot = (o.textContent || '').trim().toLowerCase();
        if (opts && opts.length) return opts.includes(ov) || opts.includes(ot);
        return ov === String(v).toLowerCase() || ot === String(v).toLowerCase();
      });
      if (match) { sel.value = match.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    } catch {}
    return false;
  };
  // filled-by-us bookkeeping so repeated attempts never overwrite user input
  const ours = (window.__phFilled = window.__phFilled || new WeakSet());
  const fillIfEmpty = (el, v) => {
    if (!el) return false;
    const had = (el.value || '') !== '';
    if (had && !ours.has(el)) return false;   // user/site value - hands off
    if (had && ours.has(el) && el.value === v) return true;   // already ours
    if (setVal(el, v)) { ours.add(el); return true; }
    return false;
  };
  const CAPTCHA_RE = /captcha|robot|human.?verif|recaptcha|hcaptcha|turnstile|arkose|challenge/i;
  const isCaptchaish = (el) => {
    try {
      const t = (hintsOf(el) + ' ' + (el.getAttribute('class') || '')).toLowerCase();
      if (CAPTCHA_RE.test(t)) return true;
      const frame = el.closest('iframe, [class*="captcha" i], [id*="captcha" i]');
      return !!frame;
    } catch { return false; }
  };
  // scan one document (or shadow root, or same-origin iframe document)
  const scanRoot = (root, doc, slots, out) => {
    let nodes = [];
    try { nodes = [...root.querySelectorAll('input, select, textarea')]; } catch { return; }
    for (const el of nodes) {
      if (!visible(el, doc)) continue;
      const tag = el.tagName;
      const type = tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || 'text').toLowerCase();
      const h = hintsOf(el);
      if (CAPTCHA_RE.test(h)) { slots.captcha = true; continue; }
      if (type === 'checkbox') {
        // ids can leak into the hint ("c1") - the consent sentence usually
        // lives in the surrounding markup, so look there too
        const near = (h + ' ' + aroundText(el)).trim();
        if (/terms|agree|accept|condition|policy|\\btos\\b|consent|have read|acknowledge|declare|confirm that/.test(near)
          || /\\bi (do not|don't|will|will not|have|am not)\\b/.test(near)) slots.terms.push(el);
        continue;
      }
      if (type === 'radio') continue;
      if (type === 'select' && /male|female|diverse/.test(el.textContent || '') && /gender|sex|title/.test(h)) { slots.gender = el; continue; }
      if (type === 'select' && /@(\\w+\\.)+\\w+/.test(el.textContent || '')) { slots.domainSel = el; continue; }
      if (type === 'password') {
        if (/confirm|repeat|again|retype|re-?enter|verify|match/.test(h)) slots.passNew.push({ el, confirm: true });
        else if (/new/.test(h) || el.getAttribute('autocomplete') === 'new-password') slots.passNew.push({ el, confirm: false });
        else slots.passCur.push(el);
        continue;
      }
      if (type === 'email' || (/e-?mail/.test(h) && !/confirm|repeat/.test(h))) { slots.email = el; continue; }
      if (/user(name)?|login|handle|screen.?name|nickname|alias/.test(h) && type !== 'select') { slots.username = el; continue; }
      if (/first(\\s?name)?|given|forename/.test(h)) { slots.first = el; continue; }
      if (/last(\\s?name)?|family|surname/.test(h)) { slots.last = el; continue; }
      if (/^(full|your|display)?\\s*name$|full.?name|display.?name/.test(h) && /name/.test(h)) { slots.full = el; continue; }
      if (/birth|dob|b-?day|date.?of.?birth/.test(h)) {
        if (/month|^mm$/.test(h)) slots.dobMonth = el;
        else if (/year|yyyy|^yy$/.test(h)) slots.dobYear = el;
        else slots.dobDay = el;   // day select, day input or a single date field
        continue;
      }
      if (type === 'select' && /month|^mm$/.test(h)) { slots.dobMonth = el; continue; }
      if (type === 'select' && /year|yyyy/.test(h)) { slots.dobYear = el; continue; }
      if (type === 'select' && /day|^dd$/.test(h)) { slots.dobDay = el; continue; }
      if (/security|answer|mother|pet|city.?of|first.?pet/.test(h) && type !== 'select') { slots.answer = el; continue; }
    }
    // recurse into shadow roots
    try {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) scanRoot(el.shadowRoot, doc, slots, out);
      }
    } catch {}
    // recurse into same-origin iframes; note cross-origin ones as protected
    try {
      for (const f of root.querySelectorAll('iframe')) {
        const label = ((f.getAttribute('title') || '') + ' ' + (f.getAttribute('aria-label') || '')).toLowerCase();
        let fd = null;
        try { fd = f.contentDocument; } catch {}
        if (fd) scanRoot(fd, fd, slots, out);
        else if (/e-?mail|user(name)?|address|login/.test(label)) out.protectedBoxes.push({ host: (f.src || '').split('/')[2] || '', label: label.trim() });
      }
    } catch {}
  };
  const scanFields = () => {
    const slots = { email: null, username: null, passNew: [], passCur: [], first: null, last: null, full: null,
      dobDay: null, dobMonth: null, dobYear: null, dobDate: null, gender: null, terms: [], answer: null, domainSel: null, captcha: false };
    const out = { protectedBoxes: [] };
    scanRoot(document, document, slots, out);
    return { slots, protectedBoxes: out.protectedBoxes };
  };
  const kindOf = (slots) => {
    const hasPass = slots.passNew.length || slots.passCur.length;
    const hasId = !!(slots.email || slots.username);
    if (!hasPass && !hasId) return 'none';
    if (!hasId) return 'protected';   // password without a reachable identity field
    if (slots.passNew.length >= 2) return 'signup';
    const passEl = slots.passNew[0]?.el || slots.passCur[0];
    const formEl = passEl?.closest('form') || document.body;
    const formText = ((formEl && formEl.innerText) || '').slice(0, 2000).toLowerCase();
    const urlish = /signup|register|join|create/.test(location.href);
    const formish = /sign\\s?up|create (an )?account|register|join/.test(formText);
    if (slots.passNew.length >= 1 && (formish || urlish)) return 'signup';
    if (formish && !/sign\\s?in|log\\s?in/.test(formText)) return 'signup';
    return 'login';
  };
  const capCount = () => document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, [data-sitekey]').length;
  // custom (non-select) domain picker: open the dropdown, click the matching option
  const pickCustomDomain = async (domain) => {
    const lc = String(domain || '').toLowerCase();
    if (!lc) return false;
    const candidates = () => [...document.querySelectorAll('button, [role="button"], li')]
      .filter(el => visible(el, document))
      .filter(el => (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length < 42)
      .filter(el => !isCaptchaish(el));
    // opener: a control named "domain", or one already showing a bare domain
    let opener = candidates().find(el => /domain/i.test((el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '')));
    if (!opener) opener = candidates().find(el => /^@?[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$/i.test((el.textContent || '').trim()));
    if (!opener) return false;
    try { opener.click(); } catch { return false; }
    await sleep(320);
    const opts = candidates().filter(el => (el.textContent || '').trim().toLowerCase() === lc)
      .filter(el => el !== opener);
    if (!opts.length) return false;   // dropdown may have opened via the click
    try { opts[0].click(); } catch { return false; }
    await sleep(150);
    return true;
  };
`;

// ------------------------------------------------------------------
// DETECT - classify the page and read typed credentials (for save prompts)
// ------------------------------------------------------------------
export function detectScript() {
  return `(() => { try { ${PAGE_HELPERS}
    const { slots, protectedBoxes } = scanFields();
    const kind = kindOf(slots);
    const idEl = slots.email || slots.username;
    const passEl = (slots.passCur[0] || slots.passNew[0]?.el || null);
    return JSON.parse(JSON.stringify({
      kind,
      hasEmail: !!slots.email, hasUsername: !!slots.username,
      hasPass: !!(slots.passNew.length || slots.passCur.length),
      emailOurs: idEl ? ours.has(idEl) : false,
      passOurs: passEl ? ours.has(passEl) : false,
      protectedBoxes,
      email: idEl ? idEl.value || '' : '',
      password: passEl ? passEl.value || '' : '',
      password2: slots.passCur[1] ? slots.passCur[1].value || '' : '',
      captcha: !!slots.captcha || capCount() > 0,
      gender: !!slots.gender, dob: !!(slots.dobDay || slots.dobDate),
      terms: slots.terms.length
    }));
  } catch (e) { return { kind: 'none', error: String(e) }; } })()`;
}

// ------------------------------------------------------------------
// FILL - provider mode: build a mailbox on an email provider's signup form
// ------------------------------------------------------------------
export function providerFillScript(v) {
  const data = JSON.stringify(v);
  return `(async () => { try { ${PAGE_HELPERS}
    const v = ${data};
    const { slots, protectedBoxes } = scanFields();
    const filled = [], missed = [], notes = [];
    const local = (v.email || '').split('@')[0];
    const domain = (v.email || '').split('@')[1] || '';

    // username / email
    let idEl = slots.email || slots.username;
    let idDone = false;
    if (idEl) {
      if (slots.domainSel && setSelect(slots.domainSel, domain)) {
        idDone = fillIfEmpty(idEl, local);
        filled.push('username');
      } else {
        // custom dropdown (Tuta-style): set the local part, then pick the domain
        idDone = fillIfEmpty(idEl, local);
        let domPicked = false;
        if (domain && await pickCustomDomain(domain)) domPicked = true;
        if (domPicked) {
          // SPAs can clear the input when the domain changes - put the local part back
          if (idEl.value !== local) fillIfEmpty(idEl, local);
          filled.push('username' + (idDone ? '' : ' (kept)'));
        } else if (idEl.getAttribute('type') === 'email') {
          fillIfEmpty(idEl, v.email); filled.push('email');
        } else {
          filled.push('username' + (idDone ? '' : ' (kept)'));
          if (domain) notes.push('domain dropdown: ' + domain + ' not found - pick it by hand');
        }
      }
      // a form with BOTH a username and an email field (some providers ask for
      // both) gets each its own value instead of only the preferred one
      if (slots.username && slots.email && slots.username !== slots.email) {
        if (fillIfEmpty(slots.username, local)) filled.push('username');
        if (fillIfEmpty(slots.email, v.email)) filled.push('email');
      }
    } else {
      missed.push('username/email');
      if (protectedBoxes.length) notes.push('username box is a protected widget (' + protectedBoxes.map(b => b.host).filter(Boolean)[0] + ') - type it by hand');
    }

    // passwords - ALL of them: signups mix "set password" (passCur) and
    // "repeat password" (passNew) classifications on the same form
    const pw = v.password || '';
    const seenEl = new Set();
    const pws = [...slots.passNew, ...slots.passCur.map(el => ({ el, confirm: false }))]
      .filter(p => { if (seenEl.has(p.el)) return false; seenEl.add(p.el); return true; });
    if (pws.length && pw) {
      let any = false;
      for (const p of pws) if (fillIfEmpty(p.el, pw)) any = true;
      if (any) filled.push(pws.length > 1 ? 'password + confirm' : 'password');
      else if (pws.every(p => p.el.value)) filled.push('password (kept)');
      else missed.push('password');
    } else if (!pws.length) missed.push('password');

    // names
    if (slots.first || slots.last || slots.full) {
      if (slots.first && fillIfEmpty(slots.first, v.first || '')) filled.push('first name');
      if (slots.last && fillIfEmpty(slots.last, v.last || '')) filled.push('last name');
      if (slots.full && !slots.first && !slots.last && fillIfEmpty(slots.full, (v.first || '') + ' ' + (v.last || ''))) filled.push('name');
    }
    if (slots.answer && v.answer && fillIfEmpty(slots.answer, v.answer)) filled.push('security answer');

    // date of birth
    const dob = v.dob || null; // {y, m, d}
    if (dob) {
      const dayEl = slots.dobDay;
      if (dayEl && dayEl.tagName === 'INPUT') {
        if (fillIfEmpty(dayEl, dob.y + '-' + String(dob.m).padStart(2, '0') + '-' + String(dob.d).padStart(2, '0'))) filled.push('date of birth');
      } else {
        if (slots.dobDay) setSelect(slots.dobDay, String(dob.d).padStart(2, '0'), [String(dob.d), String(dob.d).padStart(2, '0')]) ? filled.push('birth day') : missed.push('birth day');
        if (slots.dobMonth) setSelect(slots.dobMonth, String(dob.m).padStart(2, '0'), [String(dob.m), String(dob.m).padStart(2, '0'), ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][dob.m - 1]]) ? filled.push('birth month') : missed.push('birth month');
        if (slots.dobYear) setSelect(slots.dobYear, String(dob.y)) ? filled.push('birth year') : missed.push('birth year');
      }
    }

    // gender
    if (slots.gender && v.gender) { setSelect(slots.gender, v.gender, [v.gender, v.gender[0]]) ? filled.push('gender') : missed.push('gender'); }

    // terms
    let ticked = 0;
    for (const t of slots.terms) { if (!t.checked) { try { t.click(); ticked++; } catch {} } }
    if (slots.terms.length) filled.push(ticked ? 'terms (' + ticked + ')' : 'terms (already on)');

    return JSON.parse(JSON.stringify({ ok: true, filled: [...new Set(filled)], missed, notes, protectedBoxes,
      captcha: !!slots.captcha || capCount() > 0 }));
  } catch (e) { return { ok: false, error: String(e) }; } })()`;
}

// ------------------------------------------------------------------
// FILL - site mode: use the workspace identity on a normal site's
// login or signup form (email + password, terms checkbox)
// ------------------------------------------------------------------
export function siteFillScript(v) {
  const data = JSON.stringify(v);
  return `(async () => { try { ${PAGE_HELPERS}
    const v = ${data};
    const { slots, protectedBoxes } = scanFields();
    const filled = [], missed = [], notes = [];
    const idEl = slots.email || slots.username;
    if (idEl) { if (fillIfEmpty(idEl, v.email)) filled.push(slots.email ? 'email' : 'username'); else filled.push(slots.email ? 'email (kept)' : 'username (kept)'); }
    else { missed.push('email'); if (protectedBoxes.length) notes.push('username box is a protected widget - type it by hand'); }
    const pws2 = (() => { const seenEl = new Set(); return [...slots.passNew, ...slots.passCur.map(el => ({ el, confirm: false }))]
      .filter(p => { if (seenEl.has(p.el)) return false; seenEl.add(p.el); return true; }) })();
    if (pws2.length && v.password) {
      let any = false;
      for (const p of pws2) if (fillIfEmpty(p.el, v.password)) any = true;
      if (any) filled.push('password' + (pws2.length > 1 ? ' + confirm' : ''));
      else if (pws2.every(p => p.el.value)) filled.push('password (kept)');
      else missed.push('password');
    } else if (!pws2.length) missed.push('password');
    let ticked = 0;
    for (const t of slots.terms) { if (!t.checked) { try { t.click(); ticked++; } catch {} } }
    if (slots.terms.length) filled.push(ticked ? 'terms' : 'terms (already on)');
    if (slots.first && v.first && fillIfEmpty(slots.first, v.first)) filled.push('first name');
    if (slots.last && v.last && fillIfEmpty(slots.last, v.last)) filled.push('last name');
    return JSON.parse(JSON.stringify({ ok: true, filled: [...new Set(filled)], missed, notes, protectedBoxes,
      captcha: !!slots.captcha || capCount() > 0 }));
  } catch (e) { return { ok: false, error: String(e) }; } })()`;
}

// ------------------------------------------------------------------
// run helpers (execute inside a webview, never throw to the caller)
// ------------------------------------------------------------------
export async function runIn(wv, script) {
  if (!wv) return null;
  try {
    const result = await wv.executeJavaScript(script, false);
    return result;
  } catch { return null; }
}

export const detectIn = (wv) => runIn(wv, detectScript());
export const providerFillIn = (wv, values) => runIn(wv, providerFillScript(values));
export const siteFillIn = (wv, values) => runIn(wv, siteFillScript(values));
