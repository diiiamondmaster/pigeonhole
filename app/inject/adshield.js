// Pigeonhole "Ad Shield" cosmetic layer. Injected into guest pages by
// main/extensions.js whenever Ad Shield is active at Standard or Strict
// level for that page. Pure CSS hiding (network-level blocking happens in
// the main process via webRequest) - a <style> element with per-site rules.
// Re-running this function on the same document just updates the rules;
// passing an empty string removes them.
(function (css) {
  var st = document.getElementById('ph-adshield');
  if (!st) {
    st = document.createElement('style');
    st.id = 'ph-adshield';
    (document.head || document.documentElement).appendChild(st);
  }
  st.textContent = css || '';
  window.__phAds = {
    set: function (c) { st.textContent = c || ''; },
    active: function () { return !!(st.textContent || '').length; }
  };
})
