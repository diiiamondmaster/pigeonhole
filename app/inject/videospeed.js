// Pigeonhole "Video Speed" content script. Runs inside every guest page of
// every workspace (injected by main/extensions.js at dom-ready; no Node -
// plain page JS). A built-in take on the classic Video Speed Controller:
//   - hover a video -> speed badge follows the cursor, controller appears
//     at the video's top-left corner; drag it anywhere, or pin it with V
//   - S slower / D faster / R reset / V show-hide / Z X seek +-10s /
//     G remember the current speed for this site (per-workspace storage)
// The main process calls window.__phVSC.setEnabled(true|false) live.
(function () {
  'use strict';
  if (window.__phVSC) return;               // re-injection after toggle/nav
  var STEP = 0.1, MIN = 0.07, MAX = 16;
  var st = { enabled: false, rate: 1, pinned: false, prefUsed: false };
  var ctl = null, badge = null, hideT = null;

  function clamp(r) { r = Math.round(r * 100) / 100; return Math.min(MAX, Math.max(MIN, r)); }
  function prefKey() { return 'phVSC:' + location.host; }
  function readPref() {
    try { var v = parseFloat(localStorage.getItem(prefKey())); return isFinite(v) ? clamp(v) : null; } catch (e) { return null; }
  }
  function writePref(r) {
    try {
      if (r) localStorage.setItem(prefKey(), String(r));
      else localStorage.removeItem(prefKey());
    } catch (e) { }
  }

  function videos() {
    var out = [].slice.call(document.querySelectorAll('video'));
    var fr = document.querySelectorAll('iframe');
    for (var i = 0; i < fr.length; i++) {
      try {
        var d = fr[i].contentDocument;
        if (d) out = out.concat([].slice.call(d.querySelectorAll('video')));
      } catch (e) { /* cross-origin frame */ }
    }
    return out;
  }

  function applyRate(r, persist) {
    st.rate = clamp(r);
    var vs = videos();
    for (var i = 0; i < vs.length; i++) { try { vs[i].playbackRate = st.rate; } catch (e) { } }
    if (persist) writePref(st.rate);
    paint();
  }

  function paint() {
    if (ctl && ctl.rateEl) ctl.rateEl.textContent = st.rate.toFixed(2) + '\u00d7';
    if (badge) badge.textContent = st.rate.toFixed(2) + '\u00d7';
  }

  // ---------- controller + badge ----------
  function build() {
    if (ctl) return;
    ctl = document.createElement('div');
    ctl.setAttribute('data-ph-vsc', '');
    ctl.setAttribute('style', 'position:fixed;top:34%;left:14px;z-index:2147483646;display:none;align-items:center;gap:4px;padding:5px 7px;background:rgba(24,26,31,.93);border:1px solid rgba(255,255,255,.15);border-radius:9px;font:12px/1 "Segoe UI",Arial,sans-serif;color:#e9e7e2;box-shadow:0 6px 22px rgba(0,0,0,.45);cursor:move;user-select:none;-webkit-user-select:none;');
    function mkBtn(label, title, fn, strong) {
      var b = document.createElement('button');
      b.textContent = label; b.title = title;
      b.setAttribute('style', 'min-width:22px;height:20px;padding:0 5px;border:none;border-radius:6px;background:' +
        (strong ? 'rgba(242,177,85,.25)' : 'rgba(255,255,255,.07)') +
        ';color:' + (strong ? '#f2b155' : '#e9e7e2') + ';font:600 12px/1 inherit;cursor:pointer;');
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      return b;
    }
    ctl.rateEl = document.createElement('span');
    ctl.rateEl.setAttribute('style', 'min-width:46px;text-align:center;font-variant-numeric:tabular-nums;color:#f2b155;font-weight:600;');
    ctl.rateEl.title = 'Current speed';
    ctl.appendChild(mkBtn('\u2212', 'Slower (S)', function () { applyRate(st.rate - STEP, true); }));
    ctl.appendChild(ctl.rateEl);
    ctl.appendChild(mkBtn('+', 'Faster (D)', function () { applyRate(st.rate + STEP, true); }));
    ctl.appendChild(mkBtn('\u21ba', 'Reset to 1.00 (R)', function () { writePref(null); applyRate(1, false); }));
    ctl.appendChild(mkBtn('\u2605', 'Remember this speed for this site (G)', function () { writePref(st.rate); flash(); }, true));
    ctl.appendChild(mkBtn('\u00d7', 'Hide (V)', function () { st.pinned = false; ctl.style.display = 'none'; }));
    (document.body || document.documentElement).appendChild(ctl);

    // dragging the controller
    var drag = null;
    ctl.addEventListener('pointerdown', function (e) {
      if (e.target.tagName === 'BUTTON' || e.target === ctl.rateEl) return;
      drag = { x: e.clientX, y: e.clientY, l: ctl.offsetLeft, t: ctl.offsetTop };
    });
    document.addEventListener('pointermove', function (e) {
      if (!drag) return;
      ctl.style.left = Math.max(4, Math.min(drag.l + e.clientX - drag.x, innerWidth - 200)) + 'px';
      ctl.style.top = Math.max(4, Math.min(drag.t + e.clientY - drag.y, innerHeight - 40)) + 'px';
    });
    document.addEventListener('pointerup', function () { drag = null; });

    badge = document.createElement('div');
    badge.setAttribute('style', 'position:fixed;z-index:2147483646;display:none;padding:3px 7px;background:rgba(24,26,31,.93);border:1px solid rgba(255,255,255,.15);border-radius:7px;font:600 11px/1 "Segoe UI",Arial,sans-serif;color:#f2b155;pointer-events:none;');
    (document.body || document.documentElement).appendChild(badge);
  }

  function flash() {
    if (!badge) return;
    badge.style.color = '#5fbd8b';
    setTimeout(function () { badge.style.color = '#f2b155'; }, 500);
  }

  function showCtl(left, top) {
    if (!ctl) return;
    ctl.style.display = 'flex';
    if (left != null) {
      ctl.style.left = Math.max(6, Math.min(left, innerWidth - 210)) + 'px';
      ctl.style.top = Math.max(6, Math.min(top, innerHeight - 44)) + 'px';
    }
  }
  function hideCtlSoon() {
    clearTimeout(hideT);
    hideT = setTimeout(function () { if (!st.pinned && ctl) ctl.style.display = 'none'; }, 800);
  }

  document.addEventListener('mousemove', function (e) {
    if (!st.enabled) return;
    var t = e.target;
    var vid = t && t.tagName === 'VIDEO' ? t : (t && t.closest ? t.closest('video') : null);
    if (vid) {
      if (badge) {
        badge.style.display = 'block';
        badge.style.left = (e.clientX + 14) + 'px';
        badge.style.top = (e.clientY + 14) + 'px';
      }
      if (ctl && !st.pinned) {
        var r = vid.getBoundingClientRect();
        showCtl(r.left + 10, r.top + 10);
      }
    } else {
      if (badge) badge.style.display = 'none';
      hideCtlSoon();
    }
  }, true);

  function consume(e) { e.preventDefault(); e.stopPropagation(); }

  document.addEventListener('keydown', function (e) {
    if (!st.enabled) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    var k = (e.key || '').toLowerCase();
    var vs = videos();
    if (!vs.length && !st.pinned && k !== 'v') return;
    if (k === 's') { applyRate(st.rate - STEP, true); consume(e); }
    else if (k === 'd') { applyRate(st.rate + STEP, true); consume(e); }
    else if (k === 'r' || k === '0') { writePref(null); applyRate(1, false); consume(e); }
    else if (k === 'v') { st.pinned = !st.pinned; if (ctl) ctl.style.display = st.pinned ? 'flex' : 'none'; consume(e); }
    else if (k === 'z' || k === 'x') {
      var d = (k === 'z' ? -1 : 1) * 10;
      for (var i = 0; i < vs.length; i++) { try { vs[i].currentTime += d; } catch (err) { } }
      consume(e);
    }
    else if (k === 'g') { writePref(st.rate); flash(); consume(e); }
  }, true);

  // players attach late (SPA swaps, ad slots) - keep rates in sync
  var mo = new MutationObserver(function () {
    if (!st.enabled) return;
    var vs = videos();
    if (!vs.length) return;
    if (!st.prefUsed) {
      st.prefUsed = true;
      var p = readPref();
      if (p) applyRate(p, false);
      return;
    }
    for (var i = 0; i < vs.length; i++) {
      try { if (vs[i].playbackRate !== st.rate) vs[i].playbackRate = st.rate; } catch (e) { }
    }
  });
  function arm() { try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
  else arm();

  function setEnabled(v) {
    st.enabled = !!v;
    build();
    if (!st.enabled) {
      st.pinned = false;
      if (ctl) ctl.style.display = 'none';
      if (badge) badge.style.display = 'none';
    } else if (!st.prefUsed) {
      st.prefUsed = true;
      var p = readPref();
      if (p) applyRate(p, false);
    }
    paint();
  }

  window.__phVSC = {
    setEnabled: setEnabled,
    applyRate: function (r) { applyRate(Number(r) || 1, true); },
    get enabled() { return st.enabled; },
    version: '1.0.0'
  };
})();
