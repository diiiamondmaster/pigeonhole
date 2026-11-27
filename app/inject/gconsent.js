// Google consent helper - auto-dismisses Google's cookie-consent walls.
// Runs once per guest page at dom-ready. If the page is a Google/YouTube
// property and shows the "Before you continue" consent wall, it clicks the
// same button a human would (preferring "Reject all" - less tracking, the
// search results keep working either way), so the page continues to the
// content you actually navigated to.
(function () {
  try {
    var h = location.hostname;
    if (!/(^|\.)(google\.[a-z.]{2,6}|youtube\.com|youtube-nocookie\.com)$/i.test(h)) return;

    var clickConsent = function () {
      // full-page consent.google.com interstitial + the same dialog embedded
      // in YouTube/Google pages
      var btns = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      var byText = function (re) {
        for (var i = 0; i < btns.length; i++) {
          var t = (btns[i].textContent || btns[i].value || '').trim();
          if (t && re.test(t)) return btns[i];
        }
        return null;
      };
      var target =
        byText(/^(reject all|alles ablehnen|refuser tout|rechazar todo)$/i) ||
        byText(/^(accept all|alle akzeptieren|tout accepter|aceptar todo)$/i) ||
        document.getElementById('L2AGLb') ||
        document.querySelector('form[action*="consent"] button[type="submit"]');
      if (target && typeof target.click === 'function') {
        try { target.click(); return true; } catch (e) { }
      }
      return false;
    };

    if (!clickConsent()) {
      // the wall sometimes renders a beat after dom-ready - one retry
      setTimeout(function () { clickConsent(); }, 350);
    }
  } catch (e) { /* never break a page */ }
})();
