// Light/dark theme: saved choice, else the OS preference. Loaded in <head> to avoid a flash.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('rkc-theme'); } catch (e) {}
  var theme = saved || (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-bs-theme', theme);
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-bs-theme', next);
      try { localStorage.setItem('rkc-theme', next); } catch (e) {}
      document.dispatchEvent(new CustomEvent('rkc-theme', { detail: next }));
    });
  });
})();
