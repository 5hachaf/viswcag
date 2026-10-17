/*
 * VisWCAG front end: home search, streaming scan progress, results list and annotated snapshot.
 * The website report screens live in site.js and use the helpers exposed as window.VisWCAGApp.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPES = ['error', 'alert', 'pass'];
  const TYPE_LABEL = { error: 'Errors', alert: 'Alerts', pass: 'Passed' };
  const TYPE_ONE = { error: 'error', alert: 'alert', pass: 'passed check' };
  const TYPE_TITLE = { error: 'Error', alert: 'Alert', pass: 'Passed check' };
  const STAGES = ['Loading page', 'Rendering lazy content', 'Evaluating WCAG rules', 'Capturing snapshot', 'Checking keyboard focus', 'Checking reflow at 320px'];
  const BADGE = 24; // marker diameter in px

  const state = {
    data: null,
    filters: { error: true, alert: true, pass: true },
    current: null,
    controller: null,
    positions: new Map(),
    back: null,          // { label, action } when a result is opened from the website report
  };

  const els = {
    home: $('#home'), app: $('#app'), report: $('#report'), site: $('#site'),
    homeForm: $('#home-form'), homeUrl: $('#home-url'), homeError: $('#home-error'),
    topForm: $('#top-form'), topUrl: $('#top-url'),
    panelHead: $('#panel-head'), panelBody: $('#panel-body'), stageBody: $('#stage-body'), stage: $('#main-report'),
    live: $('#live'), skip: $('.skip-link'),
  };

  const announce = (msg) => { els.live.textContent = ''; setTimeout(() => { els.live.textContent = msg; }, 30); };

  /* ───────────── Routing ───────────── */

  function route() {
    const q = new URLSearchParams(location.search);
    if (q.get('site')) {
      stopScan();
      window.VisWCAGSite.route(q.get('site'), history.state || {});
    } else if (q.get('url')) {
      window.VisWCAGSite.leave();
      startScan(q.get('url'));
    } else {
      showHome();
    }
  }

  // Shows one of the three screens: 'home', 'report' (single page results) or 'site'.
  function showView(name) {
    els.home.hidden = name !== 'home';
    els.app.hidden = name === 'home';
    els.report.hidden = name !== 'report';
    els.site.hidden = name !== 'site';
    els.skip.setAttribute('href', name === 'home' ? '#main' : name === 'site' ? '#site' : '#main-report');
  }

  function stopScan() {
    if (state.controller) state.controller.abort();
    state.controller = null;
  }

  function showHome() {
    stopScan();
    window.VisWCAGSite.leave();
    showView('home');
    document.title = 'VisWCAG — WCAG 2.2 accessibility checker';
    els.homeError.textContent = '';
    els.homeUrl.removeAttribute('aria-invalid');
    setTimeout(() => els.homeUrl.focus(), 0);
  }

  function go(url) {
    history.pushState({}, '', '/?url=' + encodeURIComponent(url));
    window.VisWCAGSite.leave();
    startScan(url);
  }

  function goSite(url) {
    stopScan();
    history.pushState({}, '', '/?site=' + encodeURIComponent(url));
    window.VisWCAGSite.start(url);
  }

  // Both search forms have two submit buttons: value="page" (Check page) and
  // value="site" (Full website report). Pressing Enter uses the first one.
  const wantsSite = (e) => !!(e.submitter && e.submitter.value === 'site');

  els.homeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = els.homeUrl.value.trim();
    if (!v) {
      els.homeError.textContent = 'Enter a web address, for example https://example.com.';
      els.homeUrl.setAttribute('aria-invalid', 'true');
      els.homeUrl.focus();
      return;
    }
    if (wantsSite(e)) goSite(v); else go(v);
  });
  els.homeUrl.addEventListener('input', () => { els.homeError.textContent = ''; els.homeUrl.removeAttribute('aria-invalid'); });
  els.topForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = els.topUrl.value.trim();
    if (!v) { els.topUrl.focus(); return; }
    if (wantsSite(e)) goSite(v); else go(v);
  });
  $('#brand-link').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', '/');
    showHome();
  });
  window.addEventListener('popstate', route);

  /* ───────────── Scanning ───────────── */

  async function startScan(url) {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.data = null;
    state.current = null;
    state.back = null;

    showView('report');
    els.topUrl.value = url;
    document.title = 'Checking ' + url + ' — VisWCAG';
    renderProgress(url, null);
    announce('Checking ' + url);

    let result = null;
    let error = null;
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('The VisWCAG server returned ' + res.status + '.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.stage) renderProgress(url, msg.stage);
          if (msg.result) result = msg.result;
          if (msg.error) error = msg.error;
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      error = /fetch|network/i.test(e.message) ? 'VisWCAG\'s local server is not reachable. Start it with "npm start" and try again.' : e.message;
    }
    if (controller !== state.controller) return;
    state.controller = null;
    if (result) render(result);
    else renderFailure(url, error || 'The scan ended without a result.');
  }

  function renderProgress(url, stage) {
    const idx = stage ? STAGES.indexOf(stage) : -1;
    els.panelHead.innerHTML = '<p class="page-title">Checking page…</p><p class="page-meta">' + esc(url) + '</p>';
    els.panelBody.innerHTML = '<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:85%"></div><div class="skeleton" style="width:55%"></div>';
    els.stageBody.innerHTML =
      '<section class="progress" aria-labelledby="progress-h">' +
      '<h2 id="progress-h">Checking the page</h2><p class="target">' + esc(url) + '</p>' +
      '<ol class="stages">' + STAGES.map((s, i) => {
        const cls = idx < 0 ? (i === 0 && stage !== null ? 'now' : '') : i < idx ? 'done' : i === idx ? 'now' : '';
        const status = cls === 'done' ? ' (done)' : cls === 'now' ? ' (in progress)' : '';
        return '<li class="' + cls + '"><span class="dot" aria-hidden="true"></span>' + esc(s) + '<span class="visually-hidden">' + status + '</span></li>';
      }).join('') + '</ol></section>';
  }

  function renderFailure(url, message) {
    document.title = 'Check failed — VisWCAG';
    els.panelHead.innerHTML = '<p class="page-title">No results</p><p class="page-meta">' + esc(url) + '</p>';
    els.panelBody.innerHTML = '';
    els.stageBody.innerHTML =
      '<section class="failure" role="alert"><h2>The page could not be checked</h2><p>' + esc(message) + '</p>' +
      '<button type="button" class="btn btn-primary" id="retry">Try again</button></section>';
    $('#retry').addEventListener('click', () => startScan(url));
  }

  /* ───────────── Rendering results ───────────── */

  const shortName = (d) => { const n = d.title || hostOf(d.finalUrl); return n.length > 60 ? n.slice(0, 57) + '…' : n; };

  function hostOf(u) { try { return new URL(u).host || u; } catch (e) { return u; } }

  // Shows a finished result. `back` ({ label, action }) adds a back button above it.
  function render(data, back) {
    state.back = back || null;
    state.current = null;
    showView('report');
    state.data = data;
    // Passed checks are hidden by default; the Passed counter shows them.
    state.filters = { error: true, alert: true, pass: false };
    data.byId = new Map(data.results.map((r) => [r.id, r]));
    const name = data.title || hostOf(data.finalUrl);
    document.title = data.counts.error + ' errors, ' + data.counts.alert + ' alerts — ' + name + ' — VisWCAG';
    renderHead();
    renderList();
    renderStage();
    announce('Check complete. ' + data.counts.error + ' errors, ' + data.counts.alert + ' alerts, ' + data.counts.pass + ' passed.');
  }

  function renderHead() {
    const d = state.data;
    const when = new Date(d.scannedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    els.panelHead.innerHTML =
      (state.back ? '<button type="button" class="back-link" id="back-btn"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + esc(state.back.label) + '</button>' : '') +
      '<h1 class="page-title">' + esc(d.title || hostOf(d.finalUrl)) + '</h1>' +
      '<p class="page-url"><a href="' + esc(d.finalUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(d.finalUrl) + '<span class="visually-hidden"> (opens in a new tab)</span></a></p>' +
      '<p class="page-meta">Checked ' + esc(when) + ' in ' + (d.durationMs / 1000).toFixed(1) + ' s against ' + esc(d.engine.standard) + ' A and AA</p>' +
      '<div class="tallies" role="group" aria-label="Show or hide result types">' +
      TYPES.map((t) =>
        '<button type="button" class="tally tally-' + t + '" data-type="' + t + '" aria-pressed="' + state.filters[t] + '">' +
        '<span class="tally-count">' + d.counts[t] + '</span><span class="tally-label">' + TYPE_LABEL[t] + '</span>' +
        '<span class="tally-state">' + (state.filters[t] ? 'Shown' : 'Hidden') + '</span></button>').join('') +
      '</div>';
    if (state.back) $('#back-btn').addEventListener('click', state.back.action);
    $$('.tally', els.panelHead).forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.type;
      state.filters[t] = !state.filters[t];
      b.setAttribute('aria-pressed', String(state.filters[t]));
      $('.tally-state', b).textContent = state.filters[t] ? 'Shown' : 'Hidden';
      if (state.current && state.data.byId.get(state.current).type === t && !state.filters[t]) state.current = null;
      renderList();
      renderStage();
      announce(TYPE_LABEL[t] + (state.filters[t] ? ' shown' : ' hidden'));
    }));
  }

  function scChips(sc) {
    const w = state.data.wcag;
    return sc.map((code) => '<span class="sc" title="' + esc(w[code] ? w[code].name : '') + '">' + esc(code) + ' ' + esc(w[code] ? w[code].level : '') + '</span>').join('');
  }

  function wcagLinks(sc) {
    const w = state.data.wcag;
    return '<ul class="wcag-links">' + sc.map((code) => {
      const c = w[code];
      if (!c) return '';
      return '<li><a href="' + esc(c.spec) + '" target="_blank" rel="noopener">' +
        esc(code + ' ' + c.name) + ' (Level ' + c.level + ')<span class="visually-hidden"> — WCAG 2.2, opens in a new tab</span></a>' +
        (c.added ? ' <span class="new-tag">New in 2.2</span>' : '') +
        ' · <a href="' + esc(c.understanding) + '" target="_blank" rel="noopener">Understanding<span class="visually-hidden"> ' + esc(code) + ', opens in a new tab</span></a></li>';
    }).join('') + '</ul>';
  }

  const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderList() {
    const d = state.data;
    let html = '';
    for (const t of TYPES) {
      if (!state.filters[t]) continue;
      const items = d.results.filter((r) => r.type === t);
      const groups = new Map();
      for (const r of items) {
        if (!groups.has(r.rule)) groups.set(r.rule, []);
        groups.get(r.rule).push(r);
      }
      html += '<section aria-labelledby="sec-' + t + '"><div class="section-head"><h2 id="sec-' + t + '">' + TYPE_LABEL[t] + '</h2><span>' +
        items.length + ' ' + (items.length === 1 ? 'result' : 'results') + ' in ' + groups.size + ' ' + (groups.size === 1 ? 'check' : 'checks') + '</span></div>';
      if (!items.length) {
        html += '<p class="empty-note">' + (t === 'error' ? 'No errors found by automated checks. Manual review is still needed for full WCAG conformance.' : t === 'alert' ? 'Nothing needs manual review.' : 'No passed checks recorded.') + '</p>';
      }
      for (const [ruleId, rs] of groups) {
        const rule = d.rules[ruleId];
        html += '<details class="group t-' + t + '" data-rule="' + ruleId + '"' + (t !== 'pass' ? ' open' : '') + '>' +
          '<summary>' + CHEVRON + '<span class="group-title">' + esc(rule.title) + '</span><span class="group-count" aria-label="' + rs.length + ' results">' + rs.length + '</span>' +
          '<span class="sc-list">' + scChips(rule.sc) + '</span></summary>' +
          '<div class="group-body"><div class="explain"><p>' + esc(rule.summary) + '</p><p><strong>' + (t === 'pass' ? 'Keep in mind: ' : 'How to fix: ') + '</strong>' + esc(rule.fix) + '</p></div>' +
          wcagLinks(rule.sc) +
          '<ul class="items">' + rs.map(itemHtml).join('') + '</ul></div></details>';
      }
      html += '</section>';
    }
    if (!TYPES.some((t) => state.filters[t])) html = '<p class="empty-note">All result types are hidden. Select Errors, Alerts or Passed above to show them.</p>';
    els.panelBody.innerHTML = html;

    $$('.item', els.panelBody).forEach((b) => {
      const id = +b.dataset.id;
      b.addEventListener('click', () => select(id, 'list'));
      b.addEventListener('mouseenter', () => hoverBox(id, true));
      b.addEventListener('mouseleave', () => hoverBox(id, false));
      b.addEventListener('focus', () => hoverBox(id, true));
      b.addEventListener('blur', () => hoverBox(id, false));
    });
    if (state.current) markCurrentInList(false);
  }

  function itemHtml(r) {
    const rule = state.data.rules[r.rule];
    const where = r.selector ? (r.rect ? r.selector : r.selector + ' (not visible on the snapshot)') : 'Whole page';
    return '<li><button type="button" class="item" data-id="' + r.id + '" aria-current="false" aria-expanded="false">' +
      '<span class="badge ' + r.type + (r.rect ? '' : ' page') + '" aria-hidden="true">' + r.id + '</span>' +
      '<span><span class="visually-hidden">Result ' + r.id + ', ' + TYPE_ONE[r.type] + ': </span>' +
      '<span class="item-msg">' + esc(r.message || rule.title) + '</span>' +
      '<span class="item-where">' + esc(where) + '</span></span></button>' +
      '<div class="item-detail" hidden></div></li>';
  }

  function detailHtml(r) {
    let html = '';
    if (r.extra && r.extra.fg && r.extra.bg) {
      html += '<span class="swatches"><span class="swatch" style="background:' + esc(r.extra.fg) + '"></span>' + esc(r.extra.fg) +
        ' on <span class="swatch" style="background:' + esc(r.extra.bg) + '"></span>' + esc(r.extra.bg) +
        ' = ' + esc(r.extra.ratio) + ':1 (needs ' + esc(r.extra.required) + ':1' + (r.extra.large ? ', large text' : '') + ')</span>';
    }
    if (r.snippet) html += '<code class="snippet">' + esc(r.snippet) + '</code>';
    return html;
  }

  /* ───────────── Snapshot stage ───────────── */

  function visibleResults() {
    return state.data.results.filter((r) => state.filters[r.type]);
  }

  // Lays out badges in snapshot pixels. `scale` is displayed width / natural width, so
  // badges that are a fixed 24px on screen do not overlap when the snapshot is shrunk.
  function layoutMarkers(results, W, H, scale) {
    const pos = new Map();
    const size = BADGE / (scale || 1);
    const gap = 2 / (scale || 1);
    // Bucket placed badges by row band so collision checks stay cheap on big pages.
    const bands = new Map();
    const band = (y) => Math.floor(y / size);
    const collides = (x, y) => {
      for (let b = band(y) - 1; b <= band(y) + 1; b++) {
        const list = bands.get(b);
        if (!list) continue;
        for (const p of list) if (Math.abs(p.x - x) < size + gap && Math.abs(p.y - y) < size) return true;
      }
      return false;
    };
    // Errors claim their spots first so they sit nearest to the element they describe.
    const rank = { error: 0, alert: 1, pass: 2 };
    const ordered = results.slice().sort((a, b) => rank[a.type] - rank[b.type] || a.id - b.id);
    for (const r of ordered) {
      if (!r.rect || r.rect.y >= H) continue;
      let x = Math.min(Math.max(r.rect.x, 4), W - size);
      let y = Math.min(Math.max(r.rect.y, 4), H - size);
      let guard = 0;
      while (collides(x, y) && guard++ < 60) {
        x += size + gap;
        if (x > W - size) { x = Math.min(Math.max(r.rect.x, 4), W - size); y += size + gap; }
      }
      const b = band(y);
      if (!bands.has(b)) bands.set(b, []);
      bands.get(b).push({ x, y });
      pos.set(r.id, { x, y });
    }
    return pos;
  }

  function renderStage() {
    const d = state.data;
    const snap = d.snapshot;
    const results = visibleResults();
    const placeable = (r) => r.rect && r.rect.y < snap.height;
    const unplaced = results.filter((r) => !placeable(r));
    const below = results.filter((r) => r.rect && r.rect.y >= snap.height).length;

    let html = '<div class="stage-toolbar">' +
      '<p class="stage-hint"><span class="mk-sample error" aria-hidden="true">1</span><span class="mk-sample alert" aria-hidden="true">2</span>Select a number to see its details.</p>' +
      '<button type="button" class="btn-ghost" id="dl-png">Download annotated image</button>' +
      '<button type="button" class="btn-ghost" id="dl-report">Download report (HTML)</button>' +
      '<button type="button" class="btn-ghost" id="dl-json">Export JSON</button></div>';

    if (unplaced.length) {
      html += '<section class="page-level" aria-labelledby="pl-h"><h3 id="pl-h">Page-wide findings and elements not shown on the snapshot</h3><ul>' +
        unplaced.map((r) => '<li><button type="button" class="chip" data-id="' + r.id + '" aria-current="false">' +
          '<span class="badge ' + r.type + ' page" aria-hidden="true">' + r.id + '</span>' +
          '<span><span class="visually-hidden">Result ' + r.id + ', ' + TYPE_ONE[r.type] + ': </span>' + esc(d.rules[r.rule].title) + '</span></button></li>').join('') +
        '</ul></section>';
    }

    html += '<div class="sheet" style="max-width:' + snap.width + 'px">' +
      '<img src="' + snap.dataUrl + '" width="' + snap.width + '" height="' + snap.height + '" alt="Snapshot of ' + esc(shortName(d)) + ' with numbered markers. Each one is listed in the results panel.">' +
      '<div class="overlay">';
    html += '</div></div>';
    if (snap.truncated) html += '<p class="sheet-note">The snapshot stops at ' + snap.height.toLocaleString() + ' px of a ' + snap.docHeight.toLocaleString() + ' px page. ' + below + ' results further down are listed in the panel only.</p>';
    els.stageBody.innerHTML = html;

    $('#dl-png').addEventListener('click', downloadAnnotated);
    $('#dl-report').addEventListener('click', downloadReport);
    $('#dl-json').addEventListener('click', downloadJson);
    $$('.chip', els.stageBody).forEach((c) => c.addEventListener('click', () => select(+c.dataset.id, 'marker')));
    placeMarkers();
  }

  function placeMarkers() {
    const d = state.data;
    const snap = d.snapshot;
    const sheet = $('.sheet', els.stageBody);
    const overlay = $('.overlay', els.stageBody);
    if (!sheet || !overlay) return;
    const scale = (sheet.clientWidth || snap.width) / snap.width;
    const results = visibleResults();
    state.positions = layoutMarkers(results, snap.width, snap.height, scale);
    // One button per marker, in number order so Tab moves 1, 2, 3…; CSS z-index keeps
    // errors above alerts above passes where markers overlap.
    const drawOrder = results.filter((r) => state.positions.has(r.id)).sort((a, b) => a.id - b.id);
    overlay.innerHTML = drawOrder.map((r) => {
      const p = state.positions.get(r.id);
      const label = TYPE_TITLE[r.type] + ' ' + r.id + ': ' + d.rules[r.rule].title;
      return '<button type="button" class="badge marker ' + r.type + '" data-id="' + r.id + '" style="left:' + (p.x / snap.width * 100) +
        '%;top:' + (p.y / snap.height * 100) + '%" aria-label="' + esc(label) + '. Show details" title="' + esc(label) + '. Select to see details.">' + r.id + '</button>';
    }).join('');
    $$('.marker', overlay).forEach((m) => {
      const id = +m.dataset.id;
      m.addEventListener('click', () => select(id, 'marker'));
      m.addEventListener('mouseenter', () => hoverBox(id, true));
      m.addEventListener('mouseleave', () => hoverBox(id, false));
    });
    if (state.current) markCurrentOnStage(false);
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.data && !els.report.hidden) placeMarkers(); }, 150);
  });

  function boxFor(id, cls) {
    const r = state.data.byId.get(id);
    const snap = state.data.snapshot;
    if (!r || !r.rect || r.rect.y >= snap.height) return null;
    const overlay = $('.overlay', els.stageBody);
    if (!overlay) return null;
    const x = Math.max(r.rect.x, 0), y = Math.max(r.rect.y, 0);
    const w = Math.max(r.rect.w, 6), h = Math.max(r.rect.h, 6);
    const b = document.createElement('div');
    b.className = 'box ' + r.type + ' ' + cls;
    b.setAttribute('aria-hidden', 'true');
    b.style.left = (x / snap.width * 100) + '%';
    b.style.top = (y / snap.height * 100) + '%';
    b.style.width = (Math.min(w, snap.width - x) / snap.width * 100) + '%';
    b.style.height = (Math.min(h, snap.height - y) / snap.height * 100) + '%';
    overlay.appendChild(b);
    return b;
  }

  function hoverBox(id, on) {
    $$('.box.is-hover', els.stageBody).forEach((b) => b.remove());
    if (on && id !== state.current) boxFor(id, 'is-hover');
  }

  /* ───────────── Selection ───────────── */

  function select(id, from) {
    state.current = id;
    markCurrentInList(from === 'marker');
    markCurrentOnStage(from === 'list');
    const r = state.data.byId.get(id);
    announce('Result ' + id + ', ' + TYPE_ONE[r.type] + ': ' + state.data.rules[r.rule].title + '. ' + (r.message || ''));
  }

  function markCurrentInList(scroll) {
    $$('.item[aria-current="true"]', els.panelBody).forEach((b) => {
      b.setAttribute('aria-current', 'false');
      b.setAttribute('aria-expanded', 'false');
      const det = b.nextElementSibling;
      det.hidden = true;
      det.innerHTML = '';
    });
    const btn = $('.item[data-id="' + state.current + '"]', els.panelBody);
    if (!btn) return;
    const group = btn.closest('details');
    if (group && !group.open) group.open = true;
    btn.setAttribute('aria-current', 'true');
    btn.setAttribute('aria-expanded', 'true');
    const det = btn.nextElementSibling;
    det.innerHTML = detailHtml(state.data.byId.get(state.current));
    det.hidden = !det.innerHTML;
    if (scroll) {
      btn.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      btn.focus({ preventScroll: true });
    }
  }

  function markCurrentOnStage(scroll) {
    $$('.marker.is-current, .chip[aria-current="true"]', els.stageBody).forEach((m) => {
      m.classList.remove('is-current');
      if (m.classList.contains('chip')) m.setAttribute('aria-current', 'false');
    });
    $$('.box.is-current', els.stageBody).forEach((b) => b.remove());
    const id = state.current;
    const chip = $('.chip[data-id="' + id + '"]', els.stageBody);
    if (chip) {
      chip.setAttribute('aria-current', 'true');
      if (scroll) chip.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    const marker = $('.marker[data-id="' + id + '"]', els.stageBody);
    if (marker) marker.classList.add('is-current');
    const box = boxFor(id, 'is-current');
    if (scroll && (box || marker)) {
      const target = box || marker;
      const tr = target.getBoundingClientRect();
      const sr = els.stage.getBoundingClientRect();
      const top = els.stage.scrollTop + (tr.top - sr.top) - Math.max(60, (sr.height - Math.min(tr.height, sr.height * 0.6)) / 2);
      const left = els.stage.scrollLeft + (tr.left - sr.left) - 60;
      // On narrow screens the stage does not scroll on its own; scroll the window instead.
      if (els.stage.scrollHeight > els.stage.clientHeight + 4) {
        els.stage.scrollTo({ top, left, behavior: reducedMotion() ? 'auto' : 'smooth' });
      } else {
        target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }
  }

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────────── Downloads ───────────── */

  function fileBase() {
    let h = 'page';
    try {
      const u = new URL(state.data.finalUrl);
      // Web pages use the host name; local files use the file name without its extension.
      h = u.host || (u.pathname.split('/').pop() || 'page').replace(/\.[a-z0-9]+$/i, '');
    } catch (e) { /* keep default */ }
    h = h.replace(/[^a-z0-9.-]+/gi, '-') || 'page';
    return 'viswcag-' + h + '-' + state.data.scannedAt.slice(0, 10);
  }

  function downloadAnnotated() {
    const d = state.data;
    const snap = d.snapshot;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = snap.width;
      c.height = snap.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      // Same status colours as --error/--alert/--pass in app.css.
      const colors = { error: '#ab1418', alert: '#f08c1a', pass: '#17642f' };
      const textColors = { error: '#ffffff', alert: '#000000', pass: '#ffffff' };
      const positions = layoutMarkers(visibleResults(), snap.width, snap.height, 1);
      const results = visibleResults().filter((r) => positions.has(r.id))
        .sort((a, b) => ['pass', 'alert', 'error'].indexOf(a.type) - ['pass', 'alert', 'error'].indexOf(b.type));
      ctx.lineWidth = 2;
      for (const r of results) {
        ctx.strokeStyle = colors[r.type];
        ctx.strokeRect(Math.max(r.rect.x, 0) + 1, Math.max(r.rect.y, 0) + 1, Math.max(r.rect.w, 4) - 2, Math.max(r.rect.h, 4) - 2);
      }
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const r of results) {
        const p = positions.get(r.id);
        const label = String(r.id);
        const w = Math.max(BADGE, ctx.measureText(label).width + 12);
        const x = p.x - 4, y = p.y - 4;
        ctx.beginPath();
        ctx.roundRect(x, y, w, BADGE, BADGE / 2);
        ctx.fillStyle = colors[r.type];
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.fillStyle = textColors[r.type];
        ctx.fillText(label, x + w / 2, y + BADGE / 2 + 0.5);
      }
      c.toBlob((blob) => save(blob, fileBase() + '.png'), 'image/png');
    };
    img.src = snap.dataUrl;
    announce('Preparing annotated image');
  }

  // Self-contained HTML report with the annotated snapshot and all errors and alerts
  // (built by public/report.js; independent of the current filters).
  function downloadReport() {
    const html = window.VisWCAGReport.build(state.data, { layoutMarkers });
    save(new Blob([html], { type: 'text/html;charset=utf-8' }), fileBase() + '.html');
  }

  function downloadJson() {
    const d = state.data;
    const out = {
      url: d.url, finalUrl: d.finalUrl, title: d.title, scannedAt: d.scannedAt, engine: d.engine, counts: d.counts,
      results: d.results.map((r) => ({
        id: r.id, type: r.type, rule: r.rule, title: d.rules[r.rule].title,
        wcag: d.rules[r.rule].sc.map((code) => ({ sc: code, name: d.wcag[code].name, level: d.wcag[code].level, url: d.wcag[code].spec })),
        message: r.message, selector: r.selector, snippet: r.snippet, rect: r.rect, extra: r.extra,
      })),
    };
    save(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), fileBase() + '.json');
  }

  function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    announce('Downloaded ' + name);
  }

  /* ───────────── Shared with site.js ───────────── */

  // POSTs JSON and calls onMessage for each line of a newline-delimited JSON response.
  async function streamNdjson(path, body, onMessage, signal) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new Error('The VisWCAG server returned ' + res.status + '.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onMessage(JSON.parse(line));
      }
    }
  }

  const serverDown = (e) => /fetch|network/i.test(e.message)
    ? 'VisWCAG\'s local server is not reachable. Start it with "npm start" and try again.' : e.message;

  window.VisWCAGApp = {
    $, $$, esc, announce, save, layoutMarkers, hostOf, showView, streamNdjson, serverDown,
    renderResult: render,
    setTopUrl: (u) => { els.topUrl.value = u; },
  };

  route();
})();
