/*
 * VisWCAG theme handling. Loaded in <head> without defer so the saved choice is
 * applied before the first paint (no flash of the wrong theme).
 *
 * - No saved choice: follow the system setting (prefers-color-scheme), live.
 * - Toggle pressed: save "light" or "dark" and set <html data-theme="…">.
 * - Toggling back to whatever the system prefers clears the saved choice, so
 *   the page follows the system again.
 *
 * Any button with [data-theme-toggle] becomes a toggle (aria-pressed = dark on).
 */
(function () {
  'use strict';
  var KEY = 'viswcag-theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function systemTheme() { return mq && mq.matches ? 'dark' : 'light'; }
  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) { return null; }
  }
  function save(v) {
    try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
  }
  function current() { return root.getAttribute('data-theme') || systemTheme(); }

  function sync() {
    var dark = current() === 'dark';
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', String(dark));
  }

  function set(theme) {
    if (theme === systemTheme()) { save(null); root.removeAttribute('data-theme'); }
    else { save(theme); root.setAttribute('data-theme', theme); }
    sync();
  }

  // Apply the saved choice immediately, before the body renders.
  var initial = saved();
  if (initial) root.setAttribute('data-theme', initial);

  if (mq) {
    var onChange = function () { sync(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    set(current() === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('DOMContentLoaded', sync);

  window.VisWCAGTheme = { current: current, set: set };
})();
