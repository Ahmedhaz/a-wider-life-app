// Loaded first on every page of the app (never on the website). Two jobs:
//  1. Links the site's own scripts build at runtime (search results, home picks, framework lists)
//     still point at folders ("book/hikam/3/"). Capacitor would serve those as the root page, so
//     the click is pointed at the folder's index.html; build-www.mjs already did this for static links.
//  2. The status bar follows the site's light/dark theme.
(function () {
  var LIVE = 'https://ahmedhaz.github.io/turath-2026/';
  var d = document;

  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var u = new URL(a.href, location.href);
    if (u.origin !== location.origin) {
      // Outside the app: Capacitor hands main-frame navigations to the system browser.
      a.removeAttribute('target');
      return;
    }
    if (/\.pdf$/i.test(u.pathname)) {
      a.href = LIVE + u.pathname.replace(/^\/+/, '');
      a.removeAttribute('target');
    } else if (u.pathname.slice(-1) === '/') {
      u.pathname += 'index.html';
      a.href = u.href;
    }
  }, true);

  function statusBar() {
    var sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
    if (!sb) return;
    var t = d.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var bg = getComputedStyle(d.body || d.documentElement).backgroundColor;
    sb.setStyle({ style: t === 'dark' ? 'DARK' : 'LIGHT' }).catch(function () {});
    if (window.Capacitor.getPlatform() === 'android' && /^rgb/.test(bg)) {
      var hex = '#' + bg.match(/\d+/g).slice(0, 3).map(function (n) { return (+n).toString(16).padStart(2, '0') }).join('');
      sb.setBackgroundColor({ color: hex }).catch(function () {});
    }
  }
  d.addEventListener('DOMContentLoaded', function () {
    statusBar();
    new MutationObserver(statusBar).observe(d.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', statusBar);
  });
})();
