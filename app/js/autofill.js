// The form engine. Two page-world scripts (DETECT / FILL) are built here as
// strings and executed inside the active webview via <webview>.executeJavaScript.
//
// Design rules:
//  - heuristic field discovery by label text, name/id/autocomplete/placeholder
//  - React/Vue-safe value setting (native setter + input/change events)
//  - never touches CAPTCHA fields
//  - provider mode knows how to split an address into local part + domain select

// ------------------------------------------------------------------
// shared page-world helpers (inlined into both scripts)
// ------------------------------------------------------------------
const PAGE_HELPERS = `
  const visible = (el) => {
    try {
      if (el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const st = getComputedStyle(el);
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
  const setVal = (el, v) => {
    try {
      const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    } catch {}
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
  const scanFields = () => {
    const forms = [];
    const nodes = [...document.querySelectorAll('input, select, textarea')];
    const slots = { email: null, username: null, passNew: [], passCur: [], first: null, last: null, full: null,
      dobDay: null, dobMonth: null, dobYear: null, dobDate: null, gender: null, terms: [], answer: null, domainSel: null, captcha: false };
    for (const el of nodes) {
      if (!visible(el)) continue;
      const tag = el.tagName;
      const type = tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || 'text').toLowerCase();
      const h = hintsOf(el);
      if (/captcha|robot|human.?verif|recaptcha|hcaptcha|turnstile|arkose/.test(h)) { slots.captcha = true; continue; }
      if (type === 'checkbox') {
        if (/terms|agree|accept|condition|policy|\\btos\\b|consent/.test(h)) slots.terms.push(el);
        continue;
      }
      if (type === 'select' && /male|female/.test(el.textContent || '') && /gender|sex|title/.test(h)) { slots.gender = el; continue; }
      if (type === 'select' && /@(\\w+\\.)+\\w+/.test(el.textContent || '')) { slots.domainSel = el; continue; }
      if (type === 'password') {
        if (/confirm|repeat|again|retype|re-?enter|verify|match/.test(h)) slots.passNew.push({ el, confirm: true });
        else if (/new/.test(h) || el.getAttribute('autocomplete') === 'new-password') slots.passNew.push({ el, confirm: false });
        else slots.passCur.push(el);
        continue;
      }
      if (type === 'email' || /e-?mail/.test(h) && !/confirm|repeat/.test(h)) { slots.email = el; continue; }
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
    return slots;
  };
  const kindOf = (slots) => {
    const hasPass = slots.passNew.length || slots.passCur.length;
    const hasId = !!(slots.email || slots.username);
    if (!hasPass || !hasId) return 'none';
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
`;

// ------------------------------------------------------------------
// DETECT - classify the page and read typed credentials (for save prompts)
// ------------------------------------------------------------------
export function detectScript() {
  return `(() => { try { ${PAGE_HELPERS}
    const slots = scanFields();
    const kind = kindOf(slots);
    const idEl = slots.email || slots.username;
    const passEl = (slots.passCur[0] || slots.passNew[0]?.el || null);
    return JSON.parse(JSON.stringify({
      kind,
      hasEmail: !!slots.email,
      hasUsername: !!slots.username,
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
  return `(() => { try { ${PAGE_HELPERS}
    const v = ${data};
    const slots = scanFields();
    const filled = [], missed = [];
    const local = (v.email || '').split('@')[0];
    const domain = (v.email || '').split('@')[1] || '';

    // username / email
    const idEl = slots.email || slots.username;
    if (idEl) {
      if (slots.domainSel && setSelect(slots.domainSel, domain)) {
        setVal(idEl, local);
        filled.push('username');
      } else if (idEl.getAttribute('type') === 'email') {
        setVal(idEl, v.email); filled.push('email');
      } else { setVal(idEl, local); filled.push('username'); }
    } else missed.push('username/email');

    // passwords
    const pw = v.password || '';
    const pws = slots.passNew.length ? slots.passNew : slots.passCur.map(el => ({ el, confirm: false }));
    if (pws.length) { for (const p of pws) setVal(p.el, pw); filled.push(pws.length > 1 ? 'password + confirm' : 'password'); }
    else missed.push('password');

    // names
    if (slots.first || slots.last || slots.full) {
      if (slots.first) { setVal(slots.first, v.first || ''); filled.push('first name'); }
      if (slots.last) { setVal(slots.last, v.last || ''); filled.push('last name'); }
      if (slots.full && !slots.first && !slots.last) { setVal(slots.full, (v.first || '') + ' ' + (v.last || '')); filled.push('name'); }
    }
    if (slots.answer && v.answer) { setVal(slots.answer, v.answer); filled.push('security answer'); }

    // date of birth
    const dob = v.dob || null; // {y, m, d}
    if (dob) {
      const dayEl = slots.dobDay;
      if (dayEl && dayEl.tagName === 'INPUT') {
        setVal(dayEl, dob.y + '-' + String(dob.m).padStart(2, '0') + '-' + String(dob.d).padStart(2, '0'));
        filled.push('date of birth');
      } else {
        if (slots.dobDay) setSelect(slots.dobDay, String(dob.d).padStart(2, '0'), [String(dob.d), String(dob.d).padStart(2, '0')]) ? filled.push('birth day') : missed.push('birth day');
        if (slots.dobMonth) setSelect(slots.dobMonth, String(dob.m).padStart(2, '0'), [String(dob.m), String(dob.m).padStart(2, '0'), ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][dob.m - 1]]) ? filled.push('birth month') : missed.push('birth month');
        if (slots.dobYear) setSelect(slots.dobYear, String(dob.y)) ? filled.push('birth year') : missed.push('birth year');
      }
    }

    // gender
    if (slots.gender && v.gender) { setSelect(slots.gender, v.gender, [v.gender, v.gender[0]]) ? filled.push('gender') : missed.push('gender'); }

    // terms
    for (const t of slots.terms) { if (!t.checked) t.click(); }
    if (slots.terms.length) filled.push('terms');

    return JSON.parse(JSON.stringify({ ok: true, filled, missed, captcha: !!slots.captcha || capCount() > 0 }));
  } catch (e) { return { ok: false, error: String(e) }; } })()`;
}

// ------------------------------------------------------------------
// FILL - site mode: use the workspace identity on a normal site's
// login or signup form (email + password, terms checkbox)
// ------------------------------------------------------------------
export function siteFillScript(v) {
  const data = JSON.stringify(v);
  return `(() => { try { ${PAGE_HELPERS}
    const v = ${data};
    const slots = scanFields();
    const filled = [], missed = [];
    const idEl = slots.email || slots.username;
    if (idEl) { setVal(idEl, v.email); filled.push(slots.email ? 'email' : 'username'); }
    else missed.push('email');
    const pws = slots.passNew.length ? slots.passNew : slots.passCur.map(el => ({ el, confirm: false }));
    if (pws.length && v.password) { for (const p of pws) setVal(p.el, v.password); filled.push('password' + (pws.length > 1 ? ' + confirm' : '')); }
    else if (!pws.length) missed.push('password');
    for (const t of slots.terms) { if (!t.checked) t.click(); }
    if (slots.terms.length) filled.push('terms');
    if (slots.first && v.first) { setVal(slots.first, v.first); filled.push('first name'); }
    if (slots.last && v.last) { setVal(slots.last, v.last); filled.push('last name'); }
    return JSON.parse(JSON.stringify({ ok: true, filled, missed, captcha: !!slots.captcha || capCount() > 0 }));
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
