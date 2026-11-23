// Small DOM + string helpers shared across the chrome.

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) n.style.setProperty(sk, String(sv));
        else n.style[sk] = sv;
      }
    }
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q='
};

export function searchUrl(q, engine) {
  return (ENGINES[engine] || ENGINES.google) + encodeURIComponent(q);
}

export function isLikelyUrl(s) {
  const t = (s || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (/^(https?|pigeonhole):\/\//i.test(t)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(t);
}

export function normalizeInput(s, engine) {
  const t = (s || '').trim();
  if (!t) return null;
  if (/^(https?|pigeonhole):\/\//i.test(t)) return t;
  if (isLikelyUrl(t)) {
    if (/^localhost/i.test(t)) return 'http://' + t;
    return 'https://' + t;
  }
  return searchUrl(t, engine);
}

export function prettyUrl(url) {
  if (!url) return '';
  if (url.startsWith('pigeonhole://')) return '';
  return url.replace(/^https:\/\//, '').replace(/^http:\/\//, '').replace(/^www\./, '');
}

export function fmtDate(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function strength(pw) {
  if (!pw) return { score: 0, label: 'Empty', cls: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (/(.)\1{2,}/.test(pw)) score--;
  const map = [[0, 1, 'Very weak', ''], [2, 'Weak', ''], [3, 4, 'Fair', 'mid'], [5, 6, 'Strong', 'good'], [7, 8, 'Excellent', 'good']];
  if (score <= 1) return { score, label: 'Very weak', cls: '', pct: 12 };
  if (score <= 2) return { score, label: 'Weak', cls: '', pct: 28 };
  if (score <= 4) return { score, label: 'Fair', cls: 'mid', pct: 55 };
  return { score, label: 'Strong', cls: 'good', pct: 100 };
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API blocked (no gesture) - textarea fallback
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return true;
  }
}
