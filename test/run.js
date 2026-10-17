#!/usr/bin/env node
'use strict';
/*
 * Test suite (no framework): `npm test`.
 *   - test/fixtures/bad.html: a deliberately inaccessible page; every planted issue,
 *     including the WCAG 2.2 cases, must be reported with the right type.
 *   - test/fixtures/good.html: must produce no errors or alerts.
 *   - test/fixtures/site/: a small website for the crawler and the website-report API.
 *   - Both HTML report builders: unique ids, working in-page links, theme toggle.
 * Needs Chrome (Puppeteer's, or CHROME_PATH).
 */
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { scan, closeBrowser } = require('../src/scanner');

const fileUrl = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;

const EXPECT_BAD = {
  error: ['lang_missing', 'viewport_zoom', 'reflow', 'skip_link_broken', 'alt_link_missing', 'button_empty', 'contrast',
    'alt_missing', 'heading_empty', 'label_orphaned', 'autocomplete_invalid', 'label_missing', 'aria_ref_broken',
    'aria_role_invalid', 'id_duplicate_ref', 'li_orphan', 'nested_interactive', 'link_empty', 'iframe_title_missing',
    // WCAG 2.2
    'target_size', 'focus_obscured', 'auth_paste_blocked'],
  alert: ['link_redundant', 'tabindex_positive', 'contrast_unknown', 'heading_possible', 'link_suspicious', 'heading_skipped',
    'alt_suspicious', 'table_no_headers', 'text_small', 'label_placeholder_only', 'autocomplete_missing', 'fieldset_missing',
    'label_in_name', 'focus_visible', 'id_duplicate', 'dragging', 'auth_autocomplete_off'],
  pass: ['title_ok', 'h1_ok', 'landmark_main_ok', 'alt_ok', 'alt_decorative', 'contrast_ok', 'link_ok', 'label_ok', 'focus_visible_ok',
    'target_size_ok', 'focus_obscured_ok'],
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('broken fixture reports every planted issue', async () => {
  const r = await scan(fileUrl('test/fixtures/bad.html'));
  for (const [type, rules] of Object.entries(EXPECT_BAD)) {
    for (const rule of rules) {
      const hit = r.results.find((x) => x.rule === rule);
      assert.ok(hit, 'expected a "' + rule + '" result');
      assert.strictEqual(hit.type, type, rule + ' should be ' + type);
    }
  }
  // Numbering: 1..n, errors first, then alerts, then passes.
  r.results.forEach((x, i) => assert.strictEqual(x.id, i + 1));
  const order = r.results.map((x) => ({ error: 0, alert: 1, pass: 2 })[x.type]);
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b), 'results grouped by type');
  // Positions line up with the snapshot.
  const lowContrast = r.results.find((x) => x.rule === 'contrast' && /a8a8a8/.test(x.message));
  assert.ok(lowContrast.rect && lowContrast.rect.w > 100 && lowContrast.rect.y > 0 && lowContrast.rect.y < r.snapshot.height);
  assert.ok(r.snapshot.dataUrl.startsWith('data:image/jpeg;base64,'));
  // Focus check: only the outline:none link should be flagged.
  const focusAlerts = r.results.filter((x) => x.rule === 'focus_visible');
  assert.strictEqual(focusAlerts.length, 1);
  assert.match(focusAlerts[0].message, /Contact/);
});

test('accessible fixture has no errors or alerts', async () => {
  const r = await scan(fileUrl('test/fixtures/good.html'));
  const problems = r.results.filter((x) => x.type !== 'pass').map((x) => x.rule + ': ' + x.message);
  assert.deepStrictEqual(problems, []);
  assert.ok(r.counts.pass > 10);
  for (const rule of ['auth_ok', 'target_size_ok', 'focus_obscured_ok']) assert.ok(r.results.some((x) => x.rule === rule), 'expected ' + rule);
  assert.strictEqual(r.engine.standard, 'WCAG 2.2');
});

test('WCAG 2.2 checks find the planted cases', async () => {
  const r = await scan(fileUrl('test/fixtures/bad.html'));
  const by = (rule) => r.results.filter((x) => x.rule === rule);
  assert.deepStrictEqual(by('target_size').map((x) => x.extra.width).sort(), [16, 16], 'both 16 px gallery buttons');
  assert.ok(by('focus_obscured').some((x) => /Privacy/.test(x.snippet)), 'footer link under the cookie banner');
  assert.ok(by('focus_obscured').every((x) => /cookie/.test(x.message)));
  assert.strictEqual(by('auth_paste_blocked').length, 1);
  assert.match(by('id_duplicate_ref')[0].message, /aria-describedby/);
  assert.strictEqual(by('id_duplicate')[0].type, 'alert');
  assert.strictEqual(by('dragging').length, 2);
  // 4.1.1 Parsing is gone from WCAG 2.2.
  assert.ok(!r.wcag['4.1.1']);
  assert.ok(!Object.values(r.rules).some((rule) => rule.sc.includes('4.1.1')));
  assert.strictEqual(r.wcag['2.5.8'].added, '2.2');
  assert.match(r.wcag['2.5.8'].spec, /^https:\/\/www\.w3\.org\/TR\/WCAG22\/#target-size-minimum$/);
});

/* ───────────── Full website report ───────────── */

const { startSiteServer } = require('./site-server');
const { discover, categorize } = require('../src/crawler');

test('crawler finds the test site pages and skips the rest', async () => {
  const srv = await startSiteServer();
  try {
    const r = await discover(srv.base + '/');
    const paths = r.pages.map((p) => { const u = new URL(p.url); return u.pathname + u.search; }).sort();
    for (const want of ['/', '/about/', '/contact/', '/blog/', '/blog/first-post/', '/products/kayak/',
      '/orphan/', '/js-only/', '/search/?q=kayak', '/blog/?page=2']) {
      assert.ok(paths.includes(want), 'expected ' + want);
    }
    for (const never of ['/private/secret/', '/nofollow-target/', '/missing/', '/logout', '/files/guide.pdf', '/index.html']) {
      assert.ok(!paths.includes(never), 'did not expect ' + never);
    }
    assert.strictEqual(paths.filter((p) => p.startsWith('/blog/?page=')).length, 5, 'query variants are capped at 5');
    assert.strictEqual(r.pages.length, 19);
    assert.deepStrictEqual(r.categories.map((c) => c.label), ['Main pages', 'Blog', 'Products']);
    assert.strictEqual(r.stats.robotsBlocked, 1);
    assert.strictEqual(r.stats.offsite, 1);
    assert.ok(r.stats.sitemap);
    const limited = await discover(srv.base + '/', { maxPages: 4 });
    assert.strictEqual(limited.pages.length, 4);
    assert.ok(limited.stats.limitReached);
  } finally {
    await srv.close();
  }
});

test('categories keep language prefixes apart', () => {
  const pages = ['/en/', '/en/blog/a/', '/en/blog/b/', '/fr/', '/fr/blog/a/', '/en/about/']
    .map((p) => ({ url: 'https://example.com' + p, depth: 1 }));
  const cats = categorize(pages).map((c) => c.label + ' ' + c.count);
  assert.deepStrictEqual(cats.sort(), ['Blog (EN) 2', 'Blog (FR) 1', 'Main pages (EN) 2', 'Main pages (FR) 1'].sort());
});

test('crawl and site-scan endpoints stream results and can be stopped', async () => {
  const { start } = require('../server');
  const app = await start(0, '127.0.0.1');
  const api = 'http://127.0.0.1:' + app.address().port;
  const srv = await startSiteServer();
  const stream = async (route, body, onMsg) => {
    const res = await fetch(api + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    for (const line of text.split('\n')) if (line.trim()) await onMsg(JSON.parse(line));
  };
  try {
    let crawl = null;
    await stream('/api/crawl', { url: srv.base }, (m) => { if (m.result) crawl = m.result; });
    assert.strictEqual(crawl.pages.length, 19);

    const urls = [srv.base + '/', srv.base + '/contact/', 'http://127.0.0.1:1/'];
    const pages = [];
    let done = null;
    await stream('/api/site-scan', { urls }, (m) => { if (m.page) pages.push(m.page); if (m.done) done = m.done; });
    assert.deepStrictEqual(done, { completed: 2, failed: 1, stopped: false });
    const contact = pages.find((p) => p.url.endsWith('/contact/'));
    assert.ok(contact.result.counts.error >= 2, 'contact page has unlabeled fields');
    assert.ok(pages.find((p) => p.index === 2).error);

    // Stopping a crawl right away still returns the start page.
    let stopped = null;
    const res = await fetch(api + '/api/crawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: srv.base }) });
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.crawl) await fetch(api + '/api/crawl/' + m.crawl.id + '/stop', { method: 'POST' });
        if (m.result) stopped = m.result;
      }
    }
    assert.ok(stopped && stopped.stopped && stopped.pages.length >= 1);

    let err = null;
    await stream('/api/site-scan', { urls: [] }, (m) => { if (m.error) err = m.error; });
    assert.match(err, /at least one page/);
  } finally {
    await srv.close();
    await new Promise((r) => app.close(r));
  }
});

test('report builders produce valid single-page and website reports', async () => {
  const vm = require('vm');
  const fs = require('fs');
  const ctx = { window: {}, URL, Date, Math, String, Map, Set, Number, Error };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'report.js'), 'utf8'), ctx);
  const { build, buildSite } = ctx.window.VisWCAGReport;
  const layoutMarkers = (rs) => new Map(rs.filter((r) => r.rect).map((r) => [r.id, { x: r.rect.x, y: r.rect.y }]));
  const a = await scan(fileUrl('test/fixtures/bad.html'));
  const b = await scan(fileUrl('test/fixtures/good.html'));
  const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const hrefs = (html) => [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const check = (html) => {
    const all = ids(html);
    assert.strictEqual(new Set(all).size, all.length, 'ids are unique');
    for (const h of hrefs(html)) assert.ok(all.includes(h), 'link target exists: #' + h);
    assert.match(html, /data-theme-toggle/);
    assert.match(html, /localStorage/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href="http/, 'no external resources');
  };
  const single = build(a, { layoutMarkers });
  check(single);
  const site = buildSite({
    start: 'https://example.com/', host: 'example.com', startedAt: a.scannedAt, finishedAt: b.scannedAt, stopped: false,
    categories: [{ key: '|', label: 'Main pages' }, { key: '|blog', label: 'Blog' }],
    pages: [
      { url: a.finalUrl, title: 'Bad', category: '|', result: a },
      { url: b.finalUrl, title: 'Good', category: '|blog', result: b },
      { url: 'https://example.com/broken/', title: '', category: '|blog', result: null, error: 'Timed out' },
    ],
  }, { layoutMarkers });
  check(site);
  assert.match(site, /id="page-1"/);
  assert.match(site, /id="page-2"/);
  assert.match(site, /Pages not checked/);
  assert.match(site, /Most common issues/);
});

test('rejects unsupported schemes', async () => {
  await assert.rejects(() => scan('javascript:alert(1)'), /Only http, https and file/);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('✓ ' + t.name);
    } catch (e) {
      failed++;
      console.log('✗ ' + t.name + '\n  ' + e.message);
    }
  }
  await closeBrowser();
  console.log(failed ? '\n' + failed + ' failed' : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
})();
