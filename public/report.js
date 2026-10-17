/*
 * VisWCAG HTML report builder.
 *
 *   VisWCAGReport.build(data, { layoutMarkers })      one page (a /api/scan result)
 *   VisWCAGReport.buildSite(site, { layoutMarkers })  a website (several scan results)
 *
 * Both return a complete, self-contained HTML document as a string. Snapshots are
 * embedded as data URLs and all styles are inline, so the file works offline and
 * makes no network requests. The only script is a small inline theme toggle
 * (light/dark, following the system until the reader chooses; ignored in print).
 * Every value that came from a scanned page goes through esc().
 */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REPORT_WIDTH = 1040;   // max displayed width of a snapshot, used for marker layout
  const TYPE = {
    error: { plural: 'Errors', one: 'error', title: 'Error', fixLabel: 'How to fix' },
    alert: { plural: 'Alerts', one: 'alert', title: 'Alert', fixLabel: 'What to check' },
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  function safeHref(u) {
    try {
      const p = new URL(u).protocol;
      return p === 'http:' || p === 'https:' ? u : null;
    } catch (e) { return null; }
  }
  function hostOf(u) { try { return new URL(u).host || u; } catch (e) { return u; } }
  function pathOf(u) { try { const x = new URL(u); return decodeURI(x.pathname + x.search); } catch (e) { return u; } }
  const urlLink = (u) => { const h = safeHref(u); return h ? '<a href="' + esc(h) + '">' + esc(u) + '</a>' : esc(u); };
  const when = (iso) => new Date(iso).toLocaleString('en', { dateStyle: 'long', timeStyle: 'short' });
  const h = (level, attrs, inner) => '<h' + level + attrs + '>' + inner + '</h' + level + '>';

  /* ───────────── Shared building blocks ───────────── */

  function wcagRefs(data, sc) {
    return sc.map((code) => {
      const c = data.wcag[code];
      if (!c) return esc(code);
      return '<a href="' + esc(c.spec) + '">' + esc(code + ' ' + c.name) + '</a> (Level ' + esc(c.level) + (c.added ? ', new in 2.2' : '') + ')' +
        ' · <a href="' + esc(c.understanding) + '">Understanding ' + esc(code) + '</a>';
    }).join('<br>');
  }

  function instanceHtml(data, r, ns) {
    const rule = data.rules[r.rule];
    let html = '<li class="instance" id="' + ns + 'r-' + r.id + '">' +
      '<span class="badge ' + r.type + (r.rect ? '' : ' page') + '" aria-hidden="true">' + r.id + '</span>' +
      '<div class="instance-body">' +
      '<p class="msg"><span class="vh">Result ' + r.id + ', ' + TYPE[r.type].one + ': </span>' + esc(r.message || rule.title) + '</p>';
    if (r.selector) {
      html += '<p class="where">Location: <code>' + esc(r.selector) + '</code>' +
        (r.rect ? '' : ' <span class="note">(not visible on the snapshot)</span>') + '</p>';
    } else {
      html += '<p class="where">Location: whole page</p>';
    }
    if (r.extra && r.extra.fg && r.extra.bg) {
      html += '<p class="swatches"><span class="swatch" style="background:' + esc(r.extra.fg) + '"></span>' + esc(r.extra.fg) +
        ' on <span class="swatch" style="background:' + esc(r.extra.bg) + '"></span>' + esc(r.extra.bg) +
        ': ' + esc(r.extra.ratio) + ':1, needs ' + esc(r.extra.required) + ':1' + (r.extra.large ? ' (large text)' : '') + '</p>';
    }
    if (r.snippet) html += '<pre><code>' + esc(r.snippet) + '</code></pre>';
    if (isMarked(data, r)) html += '<p class="to-mark"><a href="#' + ns + 'm-' + r.id + '">Show on snapshot<span class="vh"> (result ' + r.id + ')</span></a></p>';
    return html + '</div></li>';
  }

  // Errors and alerts with a position on the snapshot get a numbered marker.
  const isMarked = (data, r) => (r.type === 'error' || r.type === 'alert') && !!r.rect && r.rect.y < data.snapshot.height;

  // Errors or alerts for one page, grouped by check. `level` is the section heading level.
  function typeSection(data, type, ns, level) {
    const items = data.results.filter((r) => r.type === type);
    const groups = new Map();
    for (const r of items) {
      if (!groups.has(r.rule)) groups.set(r.rule, []);
      groups.get(r.rule).push(r);
    }
    let html = '<section class="results" id="' + ns + type + 's" aria-labelledby="' + ns + 'h-' + type + '">' +
      h(level, ' class="sec-title" id="' + ns + 'h-' + type + '"', '<span class="dot ' + type + '" aria-hidden="true"></span>' +
        TYPE[type].plural + ' <span class="h-count">(' + items.length + ')</span>');
    if (!items.length) {
      html += '<p class="empty">' + (type === 'error'
        ? 'Automated checks found no errors. Manual review is still needed for full WCAG conformance.'
        : 'Automated checks found nothing that needs manual review.') + '</p>';
    }
    for (const [ruleId, rs] of groups) {
      const rule = data.rules[ruleId];
      html += '<article class="rule ' + type + '" aria-labelledby="' + ns + 'g-' + ruleId + '">' +
        h(level + 1, ' class="rule-title" id="' + ns + 'g-' + ruleId + '"', esc(rule.title) + ' <span class="g-count">' + plural(rs.length, 'instance', 'instances') + '</span>') +
        '<p class="refs">' + wcagRefs(data, rule.sc) + '</p>' +
        '<p>' + esc(rule.summary) + '</p>' +
        '<p><strong>' + TYPE[type].fixLabel + ':</strong> ' + esc(rule.fix) + '</p>' +
        '<ul class="instances">' + rs.map((r) => instanceHtml(data, r, ns)).join('') + '</ul></article>';
    }
    return html + '</section>';
  }

  function snapshotSection(data, layoutMarkers, ns, level) {
    const snap = data.snapshot;
    const shown = data.results.filter((r) => r.type === 'error' || r.type === 'alert');
    const scale = Math.min(1, REPORT_WIDTH / snap.width);
    const positions = layoutMarkers(shown, snap.width, snap.height, scale);
    const pct = (v, total) => (v / total * 100).toFixed(4) + '%';

    // Outlines first (decorative), then one link per marker in number order, so keyboard
    // and screen reader users meet them 1, 2, 3…; CSS z-index keeps errors on top.
    const order = shown.filter((r) => positions.has(r.id)).sort((a, b) => a.id - b.id);
    let overlay = '';
    for (const r of order) {
      const x = Math.max(r.rect.x, 0), y = Math.max(r.rect.y, 0);
      const w = Math.min(Math.max(r.rect.w, 4), snap.width - x), hh = Math.min(Math.max(r.rect.h, 4), snap.height - y);
      overlay += '<span class="box ' + r.type + '" aria-hidden="true" style="left:' + pct(x, snap.width) + ';top:' + pct(y, snap.height) +
        ';width:' + pct(w, snap.width) + ';height:' + pct(hh, snap.height) + '"></span>';
    }
    for (const r of order) {
      const p = positions.get(r.id);
      const label = TYPE[r.type].title + ' ' + r.id + ': ' + data.rules[r.rule].title;
      overlay += '<a class="badge mk ' + r.type + '" id="' + ns + 'm-' + r.id + '" href="#' + ns + 'r-' + r.id + '" style="left:' + pct(p.x, snap.width) +
        ';top:' + pct(p.y, snap.height) + '" aria-label="' + esc(label) + '. Go to details" title="' + esc(label) + '. Select to see details.">' + r.id + '</a>';
    }

    const unplaced = shown.filter((r) => !positions.has(r.id));
    const name = data.title || hostOf(data.finalUrl);
    let html = '<section id="' + ns + 'snapshot" aria-labelledby="' + ns + 'h-snapshot">' +
      h(level, ' class="sec-title" id="' + ns + 'h-snapshot"', 'Annotated snapshot') +
      '<p class="mk-hint"><span class="mk-sample error" aria-hidden="true">1</span><span class="mk-sample alert" aria-hidden="true">2</span>' +
        'Select a number to jump to its details. Red marks are errors and orange marks are alerts; passed checks are not marked.</p>' +
      '<figure class="sheet" style="max-width:' + snap.width + 'px">' +
      '<img src="' + snap.dataUrl + '" width="' + snap.width + '" height="' + snap.height + '" alt="Screenshot of ' +
      esc(name.length > 60 ? name.slice(0, 57) + '…' : name) + ' with ' + order.length + ' numbered marks, each described below.">' +
      '<div class="overlay">' + overlay + '</div></figure>';
    if (unplaced.length) {
      html += '<p class="note">Not marked on the snapshot (page-wide or not visible): ' +
        unplaced.map((r) => '<a href="#' + ns + 'r-' + r.id + '">' + r.id + '</a>').join(', ') + '.</p>';
    }
    if (snap.truncated) {
      html += '<p class="note">The snapshot shows the first ' + snap.height.toLocaleString('en') + ' px of a ' +
        snap.docHeight.toLocaleString('en') + ' px page. Results further down are listed below but not marked.</p>';
    }
    return html + '</section>';
  }

  function totals(items) {
    return '<ul class="totals">' + items.map(([cls, n, one, many]) =>
      '<li class="total ' + cls + '"><span class="n">' + n.toLocaleString('en') + '</span> ' + (n === 1 ? one : many) + '</li>').join('') + '</ul>';
  }

  const EXPLAIN = '<p><strong>Errors</strong> are failures that automated testing can confirm. <strong>Alerts</strong> are likely problems that a person needs to review. ' +
    'Automated testing finds only part of all accessibility problems, so also test pages with a keyboard and a screen reader.</p>';

  const TOGGLE = '<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false" title="Dark mode" hidden>' +
    '<span class="vh">Dark mode</span>' +
    '<svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>' +
    '<svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
    '</button>';

  function masthead(kind, title, url, meta, engine) {
    return '<header class="masthead">' +
      '<div class="masthead-top">' +
        '<p class="brand"><span class="brand-dots" aria-hidden="true"><i class="error"></i><i class="alert"></i><i class="pass"></i></span>VisWCAG ' + kind + '</p>' +
        TOGGLE +
      '</div>' +
      '<h1>' + esc(title) + '</h1>' +
      '<p class="url">' + urlLink(url) + '</p>' +
      '<dl class="meta">' + meta.map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') +
        '<div><dt>Standard</dt><dd>' + esc(engine.standard) + ' Level A and AA</dd></div>' +
        '<div><dt>Tool</dt><dd>' + esc(engine.name) + ' ' + esc(engine.version) + '</dd></div>' +
      '</dl></header>';
  }

  function footer(engine, iso, extra) {
    return '<footer class="foot"><p>Generated by ' + esc(engine.name) + ' ' + esc(engine.version) + ' on ' + esc(when(iso)) +
      '. ' + (extra || '') + 'This report lists automated findings only and is not a statement of WCAG conformance.</p></footer>';
  }

  function documentHtml(title, engine, body) {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta name="color-scheme" content="light dark">\n' +
      '<meta name="generator" content="' + esc(engine.name + ' ' + engine.version) + '">\n' +
      '<title>' + esc(title) + '</title>\n' +
      '<script>' + THEME_SCRIPT + '</script>\n' +
      '<style>' + CSS + '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  }

  /* ───────────── Single page report ───────────── */

  function build(data, opts) {
    const layoutMarkers = opts.layoutMarkers;
    const name = data.title || hostOf(data.finalUrl);
    const c = data.counts;
    const body =
      '<a class="skip" href="#main">Skip to results</a>' +
      masthead('Accessibility Report', name, data.finalUrl,
        [['Checked', '<time datetime="' + esc(data.scannedAt) + '">' + esc(when(data.scannedAt)) + '</time>']], data.engine) +
      '<main id="main">' +
        '<section aria-labelledby="h-summary">' + h(2, ' class="sec-title" id="h-summary"', 'Summary') +
          totals([['error', c.error, 'error', 'errors'], ['alert', c.alert, 'alert', 'alerts'], ['pass', c.pass, 'passed check', 'passed checks']]) +
          EXPLAIN +
          '<nav aria-label="Report contents"><ul class="toc">' +
            '<li><a href="#snapshot">Annotated snapshot</a></li>' +
            '<li><a href="#errors">Errors (' + c.error + ')</a></li>' +
            '<li><a href="#alerts">Alerts (' + c.alert + ')</a></li>' +
          '</ul></nav>' +
        '</section>' +
        snapshotSection(data, layoutMarkers, '', 2) +
        typeSection(data, 'error', '', 2) +
        typeSection(data, 'alert', '', 2) +
      '</main>' +
      footer(data.engine, data.scannedAt);
    return documentHtml('VisWCAG Accessibility Report: ' + name + ' (' + c.error + ' errors, ' + c.alert + ' alerts)', data.engine, body);
  }

  /* ───────────── Website report ───────────── */

  /*
   * site = {
   *   start, host, startedAt, finishedAt, stopped,
   *   categories: [{ key, label }],
   *   pages: [{ url, title, category, result? , error? }]   // in report order
   * }
   */
  function buildSite(site, opts) {
    const layoutMarkers = opts.layoutMarkers;
    const done = site.pages.filter((p) => p.result);
    const failed = site.pages.filter((p) => !p.result);
    if (!done.length) throw new Error('No page in this report was checked successfully.');
    const ref = done[0].result;  // rules, WCAG table and engine are the same for every page
    const engine = ref.engine;
    const catLabel = new Map((site.categories || []).map((c) => [c.key, c.label]));
    const sum = { error: 0, alert: 0, pass: 0 };
    done.forEach((p) => { for (const t in sum) sum[t] += p.result.counts[t]; });
    const withErrors = done.filter((p) => p.result.counts.error > 0).length;
    const pageName = (p) => (p.result && p.result.title) || p.title || pathOf(p.url);
    const ids = new Map(done.map((p, i) => [p, i + 1]));

    // Most common issues across pages.
    const common = new Map();
    for (const p of done) {
      for (const r of p.result.results) {
        if (r.type === 'pass') continue;
        if (!common.has(r.rule)) common.set(r.rule, { rule: r.rule, type: r.type, pages: new Set(), count: 0 });
        const c = common.get(r.rule);
        c.pages.add(p);
        c.count++;
      }
    }
    const commonRows = [...common.values()].sort((a, b) =>
      (a.type === 'error' ? 0 : 1) - (b.type === 'error' ? 0 : 1) || b.pages.size - a.pages.size || b.count - a.count);

    let html = '<a class="skip" href="#main">Skip to results</a>' +
      masthead('Website Report', site.host, site.start, [
        ['Checked', '<time datetime="' + esc(site.finishedAt) + '">' + esc(when(site.finishedAt)) + '</time>'],
        ['Pages checked', String(done.length)],
      ], engine) +
      '<main id="main">' +
      '<section aria-labelledby="h-summary">' + h(2, ' class="sec-title" id="h-summary"', 'Summary') +
        totals([['error', sum.error, 'error', 'errors'], ['alert', sum.alert, 'alert', 'alerts'],
          ['pass', sum.pass, 'passed check', 'passed checks'], ['pages', done.length, 'page', 'pages']]) +
        '<p><strong>' + withErrors + ' of ' + plural(done.length, 'page', 'pages') + '</strong> ' + (withErrors === 1 ? 'has' : 'have') + ' at least one error.' +
        (failed.length ? ' ' + plural(failed.length, 'page', 'pages') + ' could not be checked.' : '') +
        (site.stopped ? ' The check was stopped before every chosen page was checked.' : '') + '</p>' +
        EXPLAIN +
        '<nav aria-label="Report contents"><ul class="toc">' +
          '<li><a href="#common">Most common issues</a></li>' +
          '<li><a href="#pages">Pages (' + done.length + ')</a></li>' +
          (failed.length ? '<li><a href="#failed">Pages not checked (' + failed.length + ')</a></li>' : '') +
        '</ul></nav>' +
      '</section>';

    html += '<section id="common" aria-labelledby="h-common">' + h(2, ' class="sec-title" id="h-common"', 'Most common issues');
    if (commonRows.length) {
      html += '<p>Issues that repeat across pages often come from a shared template or component, so one fix can solve them everywhere.</p>' +
        '<div class="table-wrap" role="region" aria-labelledby="cap-common" tabindex="0"><table>' +
        '<caption id="cap-common">Errors and alerts by check, across ' + plural(done.length, 'page', 'pages') + '</caption>' +
        '<thead><tr><th scope="col">Issue</th><th scope="col">Type</th><th scope="col" class="num">Pages</th><th scope="col" class="num">Instances</th><th scope="col">WCAG 2.2</th></tr></thead><tbody>' +
        commonRows.map((c) => {
          const rule = ref.rules[c.rule];
          return '<tr><th scope="row">' + esc(rule.title) + '</th>' +
            '<td><span class="dot ' + c.type + '" aria-hidden="true"></span>' + TYPE[c.type].title + '</td>' +
            '<td class="num">' + c.pages.size + '</td><td class="num">' + c.count + '</td>' +
            '<td>' + rule.sc.map((code) => ref.wcag[code] ? '<a href="' + esc(ref.wcag[code].spec) + '">' + esc(code) + '</a>' : esc(code)).join(', ') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      html += '<p class="empty">Automated checks found no errors or alerts on the checked pages.</p>';
    }
    html += '</section>';

    // Pages table, grouped by category.
    const byCat = new Map();
    for (const p of done) {
      const k = p.category || '';
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push(p);
    }
    html += '<section id="pages" aria-labelledby="h-pages">' + h(2, ' class="sec-title" id="h-pages"', 'Pages') +
      '<div class="table-wrap" role="region" aria-labelledby="cap-pages" tabindex="0"><table class="pages">' +
      '<caption id="cap-pages">Checked pages by section. Select a page to see its findings.</caption>' +
      '<thead><tr><th scope="col">Page</th><th scope="col" class="num">Errors</th><th scope="col" class="num">Alerts</th><th scope="col" class="num">Passed</th></tr></thead>';
    for (const [k, list] of byCat) {
      html += '<tbody><tr class="group-row"><th scope="rowgroup" colspan="4">' + esc(catLabel.get(k) || 'Pages') + ' <span class="h-count">(' + list.length + ')</span></th></tr>' +
        list.map((p) => {
          const c = p.result.counts;
          return '<tr><th scope="row"><a href="#page-' + ids.get(p) + '">' + esc(pageName(p)) + '</a><span class="path">' + esc(pathOf(p.url)) + '</span></th>' +
            '<td class="num' + (c.error ? ' has-error' : '') + '">' + c.error + '</td>' +
            '<td class="num' + (c.alert ? ' has-alert' : '') + '">' + c.alert + '</td>' +
            '<td class="num">' + c.pass + '</td></tr>';
        }).join('') + '</tbody>';
    }
    html += '</table></div></section>';

    if (failed.length) {
      html += '<section id="failed" aria-labelledby="h-failed">' + h(2, ' class="sec-title" id="h-failed"', 'Pages not checked') +
        '<ul class="failed-list">' + failed.map((p) => '<li>' + urlLink(p.url) + '<span class="note">' + esc(p.error || 'Not checked because the check was stopped.') + '</span></li>').join('') + '</ul></section>';
    }

    // One section per page, using the single-page building blocks one heading level down.
    for (const p of done) {
      const i = ids.get(p);
      const ns = 'p' + i + '-';
      const d = p.result;
      const c = d.counts;
      html += '<section class="page-report" id="page-' + i + '" aria-labelledby="page-' + i + '-h">' +
        '<p class="kicker">' + esc(catLabel.get(p.category) || 'Page') + '</p>' +
        h(2, ' class="page-title" id="page-' + i + '-h"', esc(pageName(p))) +
        '<p class="url">' + urlLink(d.finalUrl) + '</p>' +
        '<p class="page-counts">' + plural(c.error, 'error', 'errors') + ', ' + plural(c.alert, 'alert', 'alerts') + ', ' + plural(c.pass, 'passed check', 'passed checks') + '.' +
        (d.status >= 400 ? ' <strong>The server answered with HTTP ' + esc(d.status) + '.</strong>' : '') + '</p>' +
        snapshotSection(d, layoutMarkers, ns, 3) +
        typeSection(d, 'error', ns, 3) +
        typeSection(d, 'alert', ns, 3) +
        '<p class="back"><a href="#pages">Back to the page list</a></p>' +
        '</section>';
    }
    html += '</main>' + footer(engine, site.finishedAt, 'Pages were discovered from ' + esc(site.host) + ' and chosen by the person who ran the check. ');
    return documentHtml('VisWCAG Website Report: ' + site.host + ' (' + plural(done.length, 'page', 'pages') + ', ' + sum.error + ' errors, ' + sum.alert + ' alerts)', engine, html);
  }

  /* ───────────── Theme script and styles ───────────── */

  // Same behaviour as the app: follow the system until the reader picks a theme;
  // picking the theme the system already uses goes back to following it.
  const THEME_SCRIPT = "(function(){var K='viswcag-theme',r=document.documentElement,m=window.matchMedia?matchMedia('(prefers-color-scheme: dark)'):null;" +
    "function sys(){return m&&m.matches?'dark':'light'}" +
    "function get(){try{var v=localStorage.getItem(K);return v==='light'||v==='dark'?v:null}catch(e){return null}}" +
    "function put(v){try{if(v)localStorage.setItem(K,v);else localStorage.removeItem(K)}catch(e){}}" +
    "function cur(){return r.getAttribute('data-theme')||sys()}" +
    "function sync(){var b=document.querySelectorAll('[data-theme-toggle]');for(var i=0;i<b.length;i++){b[i].hidden=false;b[i].setAttribute('aria-pressed',String(cur()==='dark'))}}" +
    "var s=get();if(s)r.setAttribute('data-theme',s);" +
    "if(m){if(m.addEventListener)m.addEventListener('change',sync);else if(m.addListener)m.addListener(sync)}" +
    "document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-theme-toggle]');if(!t)return;" +
    "var n=cur()==='dark'?'light':'dark';if(n===sys()){put(null);r.removeAttribute('data-theme')}else{put(n);r.setAttribute('data-theme',n)}sync()});" +
    "document.addEventListener('DOMContentLoaded',sync)})();";

  // Same tokens and contrast targets as public/app.css (text 7:1, borders 3:1).
  const LIGHT = `color-scheme: light;
  --ink: #102a43; --ink-2: #344456; --ink-3: #425164; --paper: #ffffff; --surface: #ffffff;
  --wash: #f3f5f8; --rule: #d5dbe2; --rule-strong: #76879a; --link: #1747a6; --code-bg: #f6f8fa; --code-ink: #24323f;
  --error-text: #9c1518; --alert-text: #7a3a00; --pass-text: #145626;
  --error-tint: #fdeeee; --alert-tint: #fff3e3; --pass-tint: #eaf6ee;
  --swatch-border: rgba(0, 0, 0, .25);`;
  const DARK = `color-scheme: dark;
  --ink: #ededee; --ink-2: #c9cbcf; --ink-3: #b3b6bb; --paper: #161718; --surface: #1e1f21;
  --wash: #26282a; --rule: #383a3e; --rule-strong: #73787f; --link: #a6c8ff; --code-bg: #121314; --code-ink: #e1e3e6;
  --error-text: #ffb3b0; --alert-text: #ffc680; --pass-text: #92dfa9;
  --error-tint: #3a2223; --alert-tint: #372b1b; --pass-tint: #1b3022;
  --swatch-border: rgba(255, 255, 255, .4);`;

  const CSS = `
:root { ${LIGHT}
  --error: #ab1418; --alert: #f08c1a; --pass: #17642f; --on-error: #ffffff; --on-alert: #000000; --on-pass: #ffffff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
:root[data-theme="dark"] { ${DARK} }
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 16px/1.55 "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--link); text-underline-offset: 2px; }
:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
[hidden] { display: none !important; }
code, pre { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 13px; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: 12px; top: -60px; background: var(--ink); color: var(--paper); padding: 8px 14px; border-radius: 6px; z-index: 10; }
.skip:focus { top: 12px; }

.masthead, main, .foot { max-width: 1104px; margin: 0 auto; padding: 0 32px; }
.masthead { padding-top: 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rule); }
.masthead-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.brand { margin: 0; font-weight: 700; color: var(--ink-2); display: flex; align-items: center; gap: 10px; }
.brand-dots { display: inline-flex; gap: 3px; }
.brand-dots i { width: 9px; height: 9px; border-radius: 50%; display: block; }
.brand-dots .error, .dot.error { background: var(--error); }
.brand-dots .alert, .dot.alert { background: var(--alert); }
.brand-dots .pass { background: var(--pass); }
.theme-toggle {
  flex: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  background: var(--surface); color: var(--ink); border: 1.5px solid var(--rule-strong);
}
.theme-toggle:hover { background: var(--wash); }
.theme-toggle svg { width: 20px; height: 20px; }
.theme-toggle .icon-sun { display: none; }
.theme-toggle[aria-pressed="true"] .icon-sun { display: block; }
.theme-toggle[aria-pressed="true"] .icon-moon { display: none; }
h1 { margin: 0; font-size: 34px; line-height: 1.2; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.url { margin: 6px 0 18px; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 36px; margin: 0; }
.meta dt { font-size: 13px; color: var(--ink-3); }
.meta dd { margin: 0; font-weight: 700; }

.sec-title { font-size: 24px; margin: 44px 0 12px; display: flex; align-items: center; gap: 10px; }
h3.sec-title { font-size: 21px; margin-top: 32px; }
.h-count { color: var(--ink-3); font-weight: 400; }
.dot { width: 14px; height: 14px; border-radius: 50%; display: inline-block; flex: none; }
.totals { list-style: none; padding: 0; margin: 0 0 16px; display: flex; flex-wrap: wrap; gap: 12px; }
.total { border: 1px solid var(--rule); border-top: 4px solid; border-radius: 10px; padding: 10px 18px 12px; min-width: 150px; font-weight: 700; }
.total .n { display: block; font-size: 34px; line-height: 1.1; letter-spacing: -0.02em; }
.total.error { border-top-color: var(--error); background: var(--error-tint); } .total.error .n { color: var(--error-text); }
.total.alert { border-top-color: var(--alert); background: var(--alert-tint); } .total.alert .n { color: var(--alert-text); }
.total.pass { border-top-color: var(--pass); background: var(--pass-tint); } .total.pass .n { color: var(--pass-text); }
.total.pages { border-top-color: var(--ink-3); background: var(--wash); }
.toc { display: flex; flex-wrap: wrap; gap: 6px 24px; padding: 0; list-style: none; margin: 8px 0 0; }
p { max-width: 75ch; }
.note, .empty { color: var(--ink-2); }

.table-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
caption { text-align: left; padding: 10px 14px; color: var(--ink-2); font-size: 14px; border-bottom: 1px solid var(--rule); }
th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; }
thead th { font-size: 13px; color: var(--ink-2); background: var(--wash); }
tbody th { font-weight: 700; }
tbody tr:last-child > * { border-bottom: 0; }
table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td .dot { width: 10px; height: 10px; margin-right: 7px; }
.group-row th { background: var(--wash); font-size: 14px; border-top: 1px solid var(--rule); }
.pages tbody th .path { display: block; font-weight: 400; font-size: 13px; color: var(--ink-3); overflow-wrap: anywhere; }
.has-error { color: var(--error-text); font-weight: 700; }
.has-alert { color: var(--alert-text); font-weight: 700; }
.failed-list { padding-left: 20px; }
.failed-list li { margin-bottom: 6px; overflow-wrap: anywhere; }
.failed-list .note { display: block; font-size: 14px; }

.page-report { margin-top: 56px; padding-top: 28px; border-top: 3px solid var(--ink); }
.kicker { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: var(--ink-2); }
.page-title { margin: 0; font-size: 28px; line-height: 1.25; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.page-report .url { margin-bottom: 6px; }
.page-counts { margin: 0; color: var(--ink-2); }
.back { margin: 20px 0 0; }

.sheet { position: relative; margin: 16px 0 0; width: 100%; background: #fff; border: 1px solid var(--rule); }
.sheet img { display: block; width: 100%; height: auto; }
.overlay { position: absolute; inset: 0; }
.box { position: absolute; border: 2px solid; border-radius: 2px; }
.box.error { border-color: var(--error); } .box.alert { border-color: var(--alert); }

.badge {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  min-width: 24px; height: 24px; padding: 0 6px; border-radius: 12px;
  font-size: 12px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; text-decoration: none;
  border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(16, 42, 67, .4);
}
.badge.error { background: var(--error); color: var(--on-error); }
.badge.alert { background: var(--alert); color: var(--on-alert); }
.badge.page { border-radius: 6px; }
.mk {
  position: absolute; z-index: 2; transform: translate(-4px, -4px); cursor: pointer; scroll-margin: 160px;
  outline: 2px solid transparent; transition: transform .12s, box-shadow .12s;
}
.mk.error { z-index: 3; }
/* Markers sit on the page snapshot, which is usually light: use a dark ring there in both themes. */
.mk:hover, .mk:focus-visible { z-index: 5; transform: translate(-4px, -4px) scale(1.2); box-shadow: 0 0 0 3px #fff, 0 0 0 6px #102a43; outline-color: transparent; }
.mk:target { z-index: 5; box-shadow: 0 0 0 3px #fff, 0 0 0 6px #102a43; animation: mk-pulse 1s ease-out 2; }
@keyframes mk-pulse { 50% { transform: translate(-4px, -4px) scale(1.35); } }
@media (prefers-reduced-motion: reduce) { .mk { transition: none; } .mk:target { animation: none; } }
.mk-sample { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 11px; font-size: 12px; font-weight: 800; vertical-align: -5px; margin-right: 4px; }
.mk-sample.error { background: var(--error); color: var(--on-error); }
.mk-sample.alert { background: var(--alert); color: var(--on-alert); margin-right: 6px; }
.to-mark { margin: 6px 0 0 !important; font-size: 14px; }
.to-mark a { display: inline-block; padding: 3px 0; }

.rule { border-top: 1px solid var(--rule); padding: 18px 0 8px; }
.rule-title { margin: 0 0 6px; font-size: 19px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.g-count { font-size: 14px; font-weight: 700; padding: 1px 10px; border-radius: 12px; }
.rule.error .g-count { background: var(--error-tint); color: var(--error-text); }
.rule.alert .g-count { background: var(--alert-tint); color: var(--alert-text); }
.rule > p { margin: 6px 0; color: var(--ink-2); }
.rule > p strong { color: var(--ink); }
.refs { font-size: 15px; }
.instances { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 10px; }
.instance { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; background: var(--wash); border-radius: 8px; break-inside: avoid; scroll-margin-top: 16px; }
.instance:target { outline: 3px solid var(--link); outline-offset: 2px; }
.instance-body { min-width: 0; flex: 1; }
.instance p { margin: 0 0 4px; }
.msg { font-weight: 700; overflow-wrap: anywhere; }
.where { font-size: 14px; color: var(--ink-2); overflow-wrap: anywhere; }
.swatches { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 14px; }
.swatch { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--swatch-border); display: inline-block; }
pre { margin: 6px 0 0; padding: 8px 10px; background: var(--code-bg); color: var(--code-ink); border: 1px solid var(--rule); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.foot { margin-top: 48px; padding-top: 18px; padding-bottom: 48px; border-top: 1px solid var(--rule); color: var(--ink-2); font-size: 14px; }

@media (max-width: 640px) {
  .masthead, main, .foot { padding-left: 16px; padding-right: 16px; }
  h1 { font-size: 26px; }
  .page-title { font-size: 23px; }
  th, td { padding: 8px 10px; }
}
/* Print: always light, no toggle, each page of a website report starts on a new sheet. */
@media print {
  :root, :root[data-theme] { ${LIGHT} }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .skip, .toc, .theme-toggle, .back, .to-mark { display: none !important; }
  .masthead, main, .foot { max-width: none; padding-left: 0; padding-right: 0; }
  .table-wrap { overflow: visible; }
  .page-report { break-before: page; margin-top: 0; }
  .rule-title, .sec-title { break-after: avoid; }
}
`;

  window.VisWCAGReport = { build, buildSite };
})();
