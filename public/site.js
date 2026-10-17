/*
 * VisWCAG "Full website report" screens.
 *
 *   crawling  → finds the site's pages (POST /api/crawl)
 *   select    → the user picks pages, grouped by section
 *   scanning  → checks the chosen pages (POST /api/site-scan)
 *   done      → overview with the report downloads; any page opens in the normal
 *               results screen, and the browser Back button returns here
 *
 * Results are cached by URL for the session, so changing the selection and
 * checking again only checks the new pages.
 */
(function () {
  'use strict';

  const A = () => window.VisWCAGApp;
  const SECONDS_PER_PAGE = 4;   // rough, for the time estimate
  const SAMPLE_PER_SECTION = 3;
  const SELECT_ALL_UP_TO = 25;

  const S = {
    url: null,          // the address the user entered
    phase: null,        // 'crawling' | 'select' | 'scanning' | 'done' | 'error'
    controller: null,   // AbortController for the running request
    crawlId: null,
    crawl: null,        // /api/crawl result
    selected: new Set(),
    filter: '',
    cache: new Map(),   // url -> scan result
    run: null,          // { pages: [...], startedAt, finishedAt, stopped }
    config: { maxSitePages: 200, concurrency: 2, crawlMaxPages: 300 },
  };

  fetch('/api/config').then((r) => r.json()).then((c) => { S.config = c; }).catch(() => {});

  const root = () => document.getElementById('site');
  const esc = (s) => A().esc(s);
  const plural = (n, one, many) => n.toLocaleString('en') + ' ' + (n === 1 ? one : many);
  const pathOf = (u) => { try { const x = new URL(u); return decodeURI(x.pathname + x.search); } catch (e) { return u; } };
  const hostOf = (u) => A().hostOf(u);

  function abort() {
    if (S.controller) S.controller.abort();
    S.controller = null;
  }

  function paint(html, title, focus) {
    A().showView('site');
    root().innerHTML = '<div class="site-wrap">' + html + '</div>';
    document.title = title + ' — VisWCAG';
    if (focus !== false) {
      const h1 = root().querySelector('h1');
      if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
      root().scrollTop = 0;
      window.scrollTo(0, 0);
    }
  }

  /* ───────────── Entry points (called from app.js) ───────────── */

  function start(url) {
    abort();
    S.url = url;
    S.crawl = null;
    S.run = null;
    S.selected = new Set();
    S.filter = '';
    S.cache = new Map();
    A().setTopUrl(url);
    crawl();
  }

  // Back/forward navigation: reuse what is in memory instead of crawling again.
  function route(url, histState) {
    if (S.url !== url || !S.phase || S.phase === 'crawling' || S.phase === 'error') return start(url);
    A().setTopUrl(url);
    if (S.phase === 'done' && S.run) {
      if (histState.sitePage != null && S.run.pages[histState.sitePage] && S.run.pages[histState.sitePage].result) return openPage(histState.sitePage, false);
      return renderDone();
    }
    if (S.phase === 'scanning') return renderScanning();
    return renderSelect();
  }

  function leave() {
    if (S.phase === 'crawling' || S.phase === 'scanning') {
      abort();
      // A stopped crawl or check can't be resumed from memory, so forget it.
      if (S.phase === 'crawling') S.phase = null;
      if (S.phase === 'scanning') finishScan(true, false);
    }
  }

  /* ───────────── 1. Finding pages ───────────── */

  const CRAWL_STAGES = ['Loading the start page', 'Reading robots.txt and sitemap', 'Following links'];

  async function crawl() {
    S.phase = 'crawling';
    const controller = new AbortController();
    S.controller = controller;
    S.crawlId = null;
    let found = 0;
    let current = '';
    let stage = null;
    let lastAnnounce = 0;

    const draw = () => {
      const idx = stage ? CRAWL_STAGES.indexOf(stage) : -1;
      paint(
        '<section class="site-card" aria-labelledby="crawl-h">' +
        '<h1 id="crawl-h">Finding pages</h1>' +
        '<p class="target">' + esc(S.url) + '</p>' +
        '<p class="big-count"><span class="n">' + found.toLocaleString('en') + '</span> ' + (found === 1 ? 'page' : 'pages') + ' found</p>' +
        '<p class="current">' + (current ? 'Reading ' + esc(pathOf(current)) : '&nbsp;') + '</p>' +
        '<ol class="stages">' + CRAWL_STAGES.map((s, i) => {
          const cls = idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'now' : '';
          return '<li class="' + cls + '"><span class="dot" aria-hidden="true"></span>' + esc(s) +
            '<span class="visually-hidden">' + (cls === 'done' ? ' (done)' : cls === 'now' ? ' (in progress)' : '') + '</span></li>';
        }).join('') + '</ol>' +
        '<p class="hint">VisWCAG follows links on the same site, reads its sitemap and respects robots.txt. It stops at ' + plural(S.config.crawlMaxPages, 'page', 'pages') + '.</p>' +
        '<button type="button" class="btn btn-secondary" id="stop-crawl">Stop and choose from pages found</button>' +
        '</section>', 'Finding pages on ' + hostOf(S.url), false);
      const btn = document.getElementById('stop-crawl');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Stopping…';
        if (S.crawlId) fetch('/api/crawl/' + S.crawlId + '/stop', { method: 'POST' }).catch(() => {});
      });
    };
    // Redraw at most a few times a second; keep the stop button's state when it was pressed.
    let pending = false;
    const update = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (S.phase !== 'crawling' || controller !== S.controller) return;
        const btn = document.getElementById('stop-crawl');
        const stopping = btn && btn.disabled;
        const hadFocus = btn && document.activeElement === btn;
        draw();
        const nb = document.getElementById('stop-crawl');
        if (stopping) { nb.disabled = true; nb.textContent = 'Stopping…'; }
        if (hadFocus) nb.focus();
      });
    };
    draw();
    root().querySelector('h1').setAttribute('tabindex', '-1');
    root().querySelector('h1').focus();
    A().announce('Finding pages on ' + hostOf(S.url));

    let result = null;
    let error = null;
    try {
      await A().streamNdjson('/api/crawl', { url: S.url }, (msg) => {
        if (msg.crawl) S.crawlId = msg.crawl.id;
        if (msg.stage) { stage = msg.stage; update(); }
        if (msg.progress) {
          found = msg.progress.found || found;
          current = msg.progress.url || current;
          update();
          if (Date.now() - lastAnnounce > 8000) { lastAnnounce = Date.now(); A().announce(plural(found, 'page', 'pages') + ' found'); }
        }
        if (msg.result) result = msg.result;
        if (msg.error) error = msg.error;
      }, controller.signal);
    } catch (e) {
      if (e.name === 'AbortError') return;
      error = A().serverDown(e);
    }
    if (controller !== S.controller) return;
    S.controller = null;
    if (!result) return renderError('No pages found', error || 'The search for pages ended without a result.', crawl);

    S.crawl = result;
    S.selected = defaultSelection(result);
    S.phase = 'select';
    renderSelect();
    A().announce(plural(result.pages.length, 'page', 'pages') + ' found. Choose the pages to check.');
  }

  function defaultSelection(crawl) {
    if (crawl.pages.length <= SELECT_ALL_UP_TO) return new Set(crawl.pages.map((p) => p.url));
    return sampleSelection(crawl);
  }

  // A few pages from each section: pages built from the same template usually share issues.
  function sampleSelection(crawl) {
    const sel = new Set();
    const per = new Map();
    for (const p of crawl.pages) {
      const n = per.get(p.category) || 0;
      const cat = crawl.categories.find((c) => c.key === p.category);
      const limit = cat && cat.label.startsWith('Main pages') ? 10 : SAMPLE_PER_SECTION;
      if (n < limit) { sel.add(p.url); per.set(p.category, n + 1); }
    }
    return sel;
  }

  /* ───────────── 2. Choosing pages ───────────── */

  function crawlNotes(c) {
    const st = c.stats;
    const notes = [];
    if (c.stopped) notes.push('The search was stopped early.');
    if (st.limitReached) notes.push('The search stopped at its page limit, so the site may have more pages.');
    if (st.sitemap) notes.push('The sitemap was used.');
    if (st.robotsBlocked) notes.push(plural(st.robotsBlocked, 'page is', 'pages are') + ' excluded by robots.txt.');
    if (st.files) notes.push(plural(st.files, 'file', 'files') + ' (PDF, images, downloads) not listed.');
    if (st.failed) notes.push(plural(st.failed, 'link', 'links') + ' could not be loaded.');
    return notes.join(' ');
  }

  function estimate(n) {
    const secs = Math.ceil(n * SECONDS_PER_PAGE / Math.max(1, S.config.concurrency));
    if (secs < 60) return 'less than a minute';
    const mins = Math.round(secs / 60);
    return 'about ' + plural(mins, 'minute', 'minutes');
  }

  function renderSelect() {
    S.phase = 'select';
    const c = S.crawl;
    const total = c.pages.length;
    const openAll = total <= 60;
    let html =
      '<header class="site-head">' +
        '<h1>Choose pages to check</h1>' +
        '<p>' + plural(total, 'page', 'pages') + ' found on <strong>' + esc(c.host) + '</strong>, in ' + plural(c.categories.length, 'section', 'sections') + '. ' + esc(crawlNotes(c)) + '</p>' +
      '</header>' +
      '<div class="pick-tools">' +
        '<div class="pick-filter"><label for="pick-filter">Filter pages</label>' +
        '<input id="pick-filter" type="search" autocomplete="off" spellcheck="false" value="' + esc(S.filter) + '" placeholder="Title or address" aria-describedby="filter-count"></div>' +
        '<div class="quick" role="group" aria-label="Quick selection">' +
          '<button type="button" class="btn-ghost" data-pick="all">Select all</button>' +
          '<button type="button" class="btn-ghost" data-pick="sample">Sample of each section</button>' +
          '<button type="button" class="btn-ghost" data-pick="none">Clear selection</button>' +
        '</div>' +
        '<p id="filter-count" class="filter-count" aria-live="polite"></p>' +
      '</div>' +
      '<div class="cats">';
    c.categories.forEach((cat, ci) => {
      const pages = c.pages.filter((p) => p.category === cat.key);
      html += '<details class="cat" data-cat="' + ci + '"' + (openAll || ci === 0 ? ' open' : '') + '>' +
        '<summary><h2 class="cat-title"><span class="cat-name">' + esc(cat.label) + '</span>' +
        '<span class="cat-sel" data-cat-sel="' + ci + '"></span></h2></summary>' +
        '<div class="cat-body">' +
        '<label class="cat-all"><input type="checkbox" data-cat-all="' + ci + '"> Select all ' + plural(pages.length, 'page', 'pages') + ' in ' + esc(cat.label) + '</label>' +
        '<ul class="links">' + pages.map((p) =>
          '<li data-text="' + esc((p.title + ' ' + pathOf(p.url)).toLowerCase()) + '"><label class="link-row">' +
          '<input type="checkbox" value="' + esc(p.url) + '" data-cat="' + ci + '"' + (S.selected.has(p.url) ? ' checked' : '') + '>' +
          '<span class="link-text"><span class="link-title">' + esc(p.title || pathOf(p.url)) + '</span>' +
          '<span class="link-path">' + esc(pathOf(p.url)) + '</span></span></label></li>').join('') +
        '</ul></div></details>';
    });
    html += '</div>' +
      '<div class="pick-bar">' +
        '<p id="pick-count" class="pick-count" role="status"></p>' +
        '<button type="button" class="btn btn-primary" id="create-report">Check pages</button>' +
      '</div>';
    paint(html, 'Choose pages on ' + c.host);

    const box = root();
    box.querySelectorAll('input[type="checkbox"][value]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) S.selected.add(cb.value); else S.selected.delete(cb.value);
      syncSelection();
    }));
    box.querySelectorAll('[data-cat-all]').forEach((cb) => cb.addEventListener('change', () => {
      box.querySelectorAll('input[data-cat="' + cb.dataset.catAll + '"]').forEach((x) => {
        x.checked = cb.checked;
        if (cb.checked) S.selected.add(x.value); else S.selected.delete(x.value);
      });
      syncSelection();
    }));
    box.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.pick;
      S.selected = kind === 'all' ? new Set(c.pages.map((p) => p.url)) : kind === 'sample' ? sampleSelection(c) : new Set();
      box.querySelectorAll('input[type="checkbox"][value]').forEach((x) => { x.checked = S.selected.has(x.value); });
      syncSelection();
    }));
    const filter = document.getElementById('pick-filter');
    filter.addEventListener('input', () => { S.filter = filter.value; applyFilter(); });
    document.getElementById('create-report').addEventListener('click', () => {
      const urls = c.pages.filter((p) => S.selected.has(p.url)).map((p) => p.url);
      if (urls.length) scanPages(urls);
    });
    applyFilter();
    syncSelection();
  }

  function applyFilter() {
    const q = S.filter.trim().toLowerCase();
    let shown = 0;
    root().querySelectorAll('.cat').forEach((cat) => {
      let catShown = 0;
      cat.querySelectorAll('li[data-text]').forEach((li) => {
        const match = !q || li.dataset.text.includes(q);
        li.hidden = !match;
        if (match) catShown++;
      });
      cat.hidden = catShown === 0;
      if (q && catShown) cat.open = true;
      shown += catShown;
    });
    const fc = document.getElementById('filter-count');
    fc.textContent = q ? plural(shown, 'page matches', 'pages match') + ' the filter.' : '';
  }

  function syncSelection() {
    const c = S.crawl;
    const box = root();
    c.categories.forEach((cat, ci) => {
      const all = box.querySelectorAll('input[data-cat="' + ci + '"]');
      const n = Array.prototype.filter.call(all, (x) => x.checked).length;
      const head = box.querySelector('[data-cat-all="' + ci + '"]');
      head.checked = n === all.length && n > 0;
      head.indeterminate = n > 0 && n < all.length;
      box.querySelector('[data-cat-sel="' + ci + '"]').textContent = n + ' of ' + all.length + ' selected';
    });
    const n = S.selected.size;
    const max = S.config.maxSitePages;
    const btn = document.getElementById('create-report');
    const count = document.getElementById('pick-count');
    btn.disabled = n === 0 || n > max;
    btn.textContent = n ? 'Check ' + plural(n, 'page', 'pages') : 'Check pages';
    count.textContent = n === 0 ? 'Select at least one page.'
      : n > max ? plural(n, 'page', 'pages') + ' selected. One report can include up to ' + max + '.'
      : plural(n, 'page', 'pages') + ' of ' + c.pages.length + ' selected. Checking takes ' + estimate(n - [...S.selected].filter((u) => S.cache.has(u)).length) + '.';
  }

  /* ───────────── 3. Checking pages ───────────── */

  async function scanPages(urls) {
    abort();
    const byUrl = new Map(S.crawl.pages.map((p) => [p.url, p]));
    S.run = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stopped: false,
      pages: urls.map((u) => {
        const p = byUrl.get(u) || { url: u, title: '', category: '' };
        return { url: u, title: p.title, category: p.category, result: S.cache.get(u) || null, error: null, status: S.cache.has(u) ? 'done' : 'waiting' };
      }),
    };
    S.phase = 'scanning';
    const pending = S.run.pages.filter((p) => p.status === 'waiting');
    renderScanning();
    A().announce('Checking ' + plural(S.run.pages.length, 'page', 'pages'));
    if (!pending.length) return finishScan(false);

    const controller = new AbortController();
    S.controller = controller;
    try {
      await A().streamNdjson('/api/site-scan', { urls: pending.map((p) => p.url) }, (msg) => {
        if (msg.pageStart) { pending[msg.pageStart.index].status = 'running'; updateScanning(); }
        if (msg.page) {
          const p = pending[msg.page.index];
          if (msg.page.result) { p.result = msg.page.result; p.status = 'done'; S.cache.set(p.url, p.result); }
          else { p.error = msg.page.error; p.status = 'failed'; }
          updateScanning();
        }
        if (msg.error) pending.forEach((p) => { if (p.status !== 'done') { p.status = 'failed'; p.error = msg.error; } });
      }, controller.signal);
    } catch (e) {
      if (e.name === 'AbortError') return; // stopped by the user: finishScan already ran
      pending.forEach((p) => { if (p.status !== 'done') { p.status = 'failed'; p.error = A().serverDown(e); } });
    }
    if (controller !== S.controller) return;
    S.controller = null;
    finishScan(false);
  }

  function scanCounts() {
    const pages = S.run.pages;
    return {
      total: pages.length,
      done: pages.filter((p) => p.status === 'done').length,
      failed: pages.filter((p) => p.status === 'failed').length,
      running: pages.filter((p) => p.status === 'running'),
    };
  }

  function renderScanning() {
    const k = scanCounts();
    paint(
      '<section class="site-card" aria-labelledby="scan-h">' +
      '<h1 id="scan-h">Checking ' + plural(k.total, 'page', 'pages') + '</h1>' +
      '<p class="target">' + esc(S.crawl ? S.crawl.host : hostOf(S.url)) + '</p>' +
      '<progress id="scan-progress" max="' + k.total + '" value="' + (k.done + k.failed) + '" aria-labelledby="scan-status"></progress>' +
      '<p id="scan-status" class="scan-status" role="status"></p>' +
      '<p id="scan-current" class="current">&nbsp;</p>' +
      '<button type="button" class="btn btn-secondary" id="stop-scan">Stop and make the report from checked pages</button>' +
      '<h2 class="list-title">Pages</h2>' +
      '<ol class="scan-list" id="scan-list"></ol>' +
      '</section>', 'Checking pages on ' + (S.crawl ? S.crawl.host : hostOf(S.url)));
    document.getElementById('stop-scan').addEventListener('click', () => { abort(); finishScan(true); });
    updateScanning();
  }

  function updateScanning() {
    if (S.phase !== 'scanning' || !document.getElementById('scan-list')) return;
    const k = scanCounts();
    document.getElementById('scan-progress').value = k.done + k.failed;
    document.getElementById('scan-status').textContent = (k.done + k.failed) + ' of ' + k.total + ' pages checked' + (k.failed ? ', ' + k.failed + ' could not be checked' : '') + '.';
    document.getElementById('scan-current').textContent = k.running.length ? 'Now checking ' + k.running.map((p) => pathOf(p.url)).join(' and ') : ' ';
    document.getElementById('scan-list').innerHTML = S.run.pages.map((p) => {
      const label = p.status === 'done' ? plural(p.result.counts.error, 'error', 'errors') + ', ' + plural(p.result.counts.alert, 'alert', 'alerts')
        : p.status === 'failed' ? 'Could not be checked' : p.status === 'running' ? 'Checking…' : 'Waiting';
      return '<li class="scan-item is-' + p.status + '"><span class="scan-path">' + esc(pathOf(p.url)) + '</span><span class="scan-state">' + esc(label) + '</span></li>';
    }).join('');
  }

  function finishScan(stopped, show = true) {
    if (!S.run) return;
    S.run.stopped = stopped || S.run.pages.some((p) => p.status === 'waiting' || p.status === 'running');
    S.run.pages.forEach((p) => { if (p.status === 'waiting' || p.status === 'running') { p.status = 'skipped'; p.error = 'Not checked because the check was stopped.'; } });
    S.run.finishedAt = new Date().toISOString();
    if (!S.run.pages.some((p) => p.result)) {
      S.phase = 'select';
      if (show) renderError('No pages were checked', S.run.pages.map((p) => p.error).find(Boolean) || 'The check was stopped before any page finished.', () => renderSelect(), 'Choose pages again');
      return;
    }
    S.phase = 'done';
    if (show) {
      renderDone();
      const k = scanCounts();
      A().announce('Website check complete. ' + plural(k.done, 'page', 'pages') + ' checked.');
    }
  }

  /* ───────────── 4. Overview ───────────── */

  function siteModel() {
    return {
      start: S.crawl ? S.crawl.start : S.url,
      host: S.crawl ? S.crawl.host : hostOf(S.url),
      startedAt: S.run.startedAt,
      finishedAt: S.run.finishedAt,
      stopped: S.run.stopped,
      categories: S.crawl ? S.crawl.categories : [],
      pages: S.run.pages,
    };
  }

  function renderDone() {
    S.phase = 'done';
    const site = siteModel();
    const done = site.pages.filter((p) => p.result);
    const notDone = site.pages.filter((p) => !p.result);
    const sum = { error: 0, alert: 0, pass: 0 };
    done.forEach((p) => { for (const t in sum) sum[t] += p.result.counts[t]; });
    const catLabel = new Map(site.categories.map((c) => [c.key, c.label]));
    const ref = done[0].result;

    const common = new Map();
    for (const p of done) for (const r of p.result.results) {
      if (r.type === 'pass') continue;
      if (!common.has(r.rule)) common.set(r.rule, { rule: r.rule, type: r.type, pages: new Set(), count: 0 });
      const c = common.get(r.rule); c.pages.add(p.url); c.count++;
    }
    const commonRows = [...common.values()].sort((a, b) =>
      (a.type === 'error' ? 0 : 1) - (b.type === 'error' ? 0 : 1) || b.pages.size - a.pages.size || b.count - a.count).slice(0, 10);

    let html =
      '<header class="site-head">' +
        '<h1>Website Report for ' + esc(site.host) + '</h1>' +
        '<p>' + plural(done.length, 'page', 'pages') + ' checked on ' + esc(new Date(site.finishedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) +
        (notDone.length ? '. ' + plural(notDone.length, 'page', 'pages') + ' could not be checked' : '') + (site.stopped ? '. The check was stopped early' : '') + '.</p>' +
      '</header>' +
      '<ul class="stats">' +
        '<li class="stat error"><span class="n">' + sum.error + '</span> ' + (sum.error === 1 ? 'error' : 'errors') + '</li>' +
        '<li class="stat alert"><span class="n">' + sum.alert + '</span> ' + (sum.alert === 1 ? 'alert' : 'alerts') + '</li>' +
        '<li class="stat pass"><span class="n">' + sum.pass + '</span> passed ' + (sum.pass === 1 ? 'check' : 'checks') + '</li>' +
        '<li class="stat pages"><span class="n">' + done.length + '</span> ' + (done.length === 1 ? 'page' : 'pages') + '</li>' +
      '</ul>' +
      '<div class="site-actions">' +
        '<button type="button" class="btn btn-primary" id="open-site-report">Open report</button>' +
        '<button type="button" class="btn-ghost" id="dl-site-report">Download report (HTML)</button>' +
        '<button type="button" class="btn-ghost" id="dl-site-json">Export JSON</button>' +
        '<button type="button" class="btn-ghost" id="change-pages">Change pages</button>' +
      '</div>';

    html += '<section class="site-section" aria-labelledby="common-h"><h2 id="common-h">Most common issues</h2>';
    if (commonRows.length) {
      html += '<div class="table-wrap" role="region" aria-labelledby="common-cap" tabindex="0"><table class="data-table">' +
        '<caption id="common-cap">The ' + (commonRows.length < common.size ? commonRows.length + ' most common of ' + common.size : commonRows.length) + ' checks with errors or alerts</caption>' +
        '<thead><tr><th scope="col">Issue</th><th scope="col">Type</th><th scope="col" class="num">Pages</th><th scope="col" class="num">Instances</th></tr></thead><tbody>' +
        commonRows.map((c) => '<tr><th scope="row">' + esc(ref.rules[c.rule].title) + '</th>' +
          '<td><span class="type-dot ' + c.type + '" aria-hidden="true"></span>' + (c.type === 'error' ? 'Error' : 'Alert') + '</td>' +
          '<td class="num">' + c.pages.size + '</td><td class="num">' + c.count + '</td></tr>').join('') +
        '</tbody></table></div>';
    } else {
      html += '<p>Automated checks found no errors or alerts on these pages.</p>';
    }
    html += '</section>';

    const byCat = new Map();
    site.pages.forEach((p, i) => { if (!p.result) return; if (!byCat.has(p.category)) byCat.set(p.category, []); byCat.get(p.category).push(i); });
    html += '<section class="site-section" aria-labelledby="pages-h"><h2 id="pages-h">Pages</h2>' +
      '<div class="table-wrap" role="region" aria-labelledby="pages-cap" tabindex="0"><table class="data-table pages-table">' +
      '<caption id="pages-cap">Checked pages by section. Open a page to see its results and snapshot.</caption>' +
      '<thead><tr><th scope="col">Page</th><th scope="col" class="num">Errors</th><th scope="col" class="num">Alerts</th><th scope="col" class="num">Passed</th></tr></thead>';
    for (const [key, idxs] of byCat) {
      html += '<tbody><tr class="group-row"><th scope="rowgroup" colspan="4">' + esc(catLabel.get(key) || 'Pages') + ' (' + idxs.length + ')</th></tr>' +
        idxs.map((i) => {
          const p = site.pages[i];
          const c = p.result.counts;
          return '<tr><th scope="row"><button type="button" class="link-btn" data-open="' + i + '">' + esc(p.result.title || p.title || pathOf(p.url)) + '</button>' +
            '<span class="row-path">' + esc(pathOf(p.url)) + '</span></th>' +
            '<td class="num' + (c.error ? ' has-error' : '') + '">' + c.error + '</td>' +
            '<td class="num' + (c.alert ? ' has-alert' : '') + '">' + c.alert + '</td>' +
            '<td class="num">' + c.pass + '</td></tr>';
        }).join('') + '</tbody>';
    }
    html += '</table></div></section>';
    if (notDone.length) {
      html += '<section class="site-section" aria-labelledby="failed-h"><h2 id="failed-h">Pages not checked</h2><ul class="failed-list">' +
        notDone.map((p) => '<li><span class="row-path-strong">' + esc(pathOf(p.url)) + '</span><span class="note">' + esc(p.error || '') + '</span></li>').join('') + '</ul></section>';
    }
    paint(html, 'Website Report for ' + site.host);

    document.getElementById('open-site-report').addEventListener('click', openReport);
    document.getElementById('dl-site-report').addEventListener('click', () => {
      A().save(new Blob([buildHtml()], { type: 'text/html;charset=utf-8' }), fileBase() + '.html');
    });
    document.getElementById('dl-site-json').addEventListener('click', downloadJson);
    document.getElementById('change-pages').addEventListener('click', () => { renderSelect(); });
    root().querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openPage(+b.dataset.open, true)));
  }

  function openPage(i, push) {
    const p = S.run.pages[i];
    if (push) history.pushState({ sitePage: i }, '', location.href);
    A().renderResult(p.result, { label: 'Back to website report', action: () => history.back() });
  }

  function buildHtml() {
    return window.VisWCAGReport.buildSite(siteModel(), { layoutMarkers: A().layoutMarkers });
  }

  function openReport() {
    const url = URL.createObjectURL(new Blob([buildHtml()], { type: 'text/html;charset=utf-8' }));
    const win = window.open(url, '_blank');
    if (!win) A().save(new Blob([buildHtml()], { type: 'text/html;charset=utf-8' }), fileBase() + '.html');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function fileBase() {
    const host = (S.crawl ? S.crawl.host : hostOf(S.url)).replace(/[^a-z0-9.-]+/gi, '-');
    return 'viswcag-site-' + host + '-' + (S.run.finishedAt || new Date().toISOString()).slice(0, 10);
  }

  function downloadJson() {
    const site = siteModel();
    const out = {
      start: site.start, host: site.host, startedAt: site.startedAt, finishedAt: site.finishedAt, stopped: site.stopped,
      categories: site.categories,
      pages: site.pages.map((p) => {
        const base = { url: p.url, title: (p.result && p.result.title) || p.title, category: p.category };
        if (!p.result) return { ...base, error: p.error };
        const d = p.result;
        return {
          ...base, finalUrl: d.finalUrl, status: d.status, scannedAt: d.scannedAt, counts: d.counts,
          results: d.results.map((r) => ({
            id: r.id, type: r.type, rule: r.rule, title: d.rules[r.rule].title, wcag: d.rules[r.rule].sc,
            message: r.message, selector: r.selector, snippet: r.snippet, rect: r.rect, extra: r.extra,
          })),
        };
      }),
    };
    A().save(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), fileBase() + '.json');
  }

  /* ───────────── Errors ───────────── */

  function renderError(title, message, retry, retryLabel) {
    S.phase = S.phase === 'crawling' ? 'error' : S.phase;
    paint('<section class="failure" role="alert"><h1 class="failure-title">' + esc(title) + '</h1><p>' + esc(message) + '</p>' +
      '<button type="button" class="btn btn-primary" id="site-retry">' + esc(retryLabel || 'Try again') + '</button></section>', title);
    document.getElementById('site-retry').addEventListener('click', retry);
  }

  window.VisWCAGSite = { start, route, leave };
})();
