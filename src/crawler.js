'use strict';
/*
 * Website page discovery for the "Full website report".
 *
 * discover(startUrl, options) finds the HTML pages of one site:
 *   1. reads robots.txt (rules for "*", and Sitemap: lines) and the sitemap(s);
 *   2. renders the start page in the shared headless Chrome, so menus that are
 *      built with JavaScript contribute their links;
 *   3. crawls breadth-first over plain HTTP with Crawlee's CheerioCrawler.
 *
 * Only pages on the same host (www. ignored) are kept. robots.txt Disallow rules
 * are respected. Files (PDF, images, archives…), logout links, tracking parameters
 * and endless query-string variants are filtered out.
 *
 * Returns { start, host, pages: [{ url, title, depth, source, category }],
 *           categories: [{ key, label, count }], stats: {…} }.
 */
const { CheerioCrawler, Configuration, log } = require('@crawlee/cheerio');
const { MemoryStorage } = require('@crawlee/memory-storage');
const { RobotsTxtFile, Sitemap } = require('@crawlee/utils');
const { normalizeUrl, getBrowser, userError } = require('./scanner');

log.setLevel(log.LEVELS.OFF); // Crawlee's console logging would drown the server log.

const DEFAULT_MAX_PAGES = parseInt(process.env.VISWCAG_CRAWL_MAX_PAGES, 10) || 300;
const MAX_SITEMAP_URLS = 2000;
const MAX_QUERY_VARIANTS = 5;

const FILE_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|heic|zip|gz|tgz|rar|7z|tar|bz2|exe|dmg|msi|pkg|apk|deb|rpm|iso|mp3|mp4|m4a|m4v|wav|ogg|oga|webm|mov|avi|mkv|flac|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|tsv|txt|json|xml|rss|atom|css|js|mjs|map|woff2?|ttf|otf|eot|ics|vcf|epub|swf)$/i;
const SIDE_EFFECT_PATH = /(^|\/)(log-?out|sign-?out|log-?off|sign-?off|unsubscribe)(\/|$|\.)/i;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|ref_src|igshid)$/i;
const INDEX_FILE = /\/index\.(html?|php|aspx?)$/i;

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');

/* ───────────── URL cleaning ───────────── */

function makeCleaner(start, skips) {
  const host = bareHost(new URL(start).hostname);
  const queryVariants = new Map(); // pathname -> Set of query strings

  return function clean(raw, base) {
    let u;
    try { u = new URL(raw, base); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (bareHost(u.hostname) !== host) { skips.offsite.add(u.origin + u.pathname); return null; }
    u.hash = '';
    if (FILE_EXT.test(u.pathname)) { skips.files.add(u.href); return null; }
    if (SIDE_EFFECT_PATH.test(u.pathname)) { skips.skipped.add(u.pathname); return null; }
    u.pathname = u.pathname.replace(INDEX_FILE, '/');
    // Drop tracking parameters and sort the rest so equivalent URLs match.
    const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
    u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
    if (u.search) {
      if (!queryVariants.has(u.pathname)) queryVariants.set(u.pathname, new Set());
      const set = queryVariants.get(u.pathname);
      if (!set.has(u.search)) {
        if (set.size >= MAX_QUERY_VARIANTS) { skips.skipped.add(u.pathname + u.search); return null; }
        set.add(u.search);
      }
    }
    return u.href;
  };
}

// Key used to detect duplicates: ignores http/https and www.
const keyOf = (href) => { const u = new URL(href); return bareHost(u.hostname) + u.pathname + u.search; };

/* ───────────── Categories ───────────── */

const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const LOCALE = /^[a-z]{2}([-_][a-z]{2,4})?$/i;

function prettify(segment) {
  const words = decode(segment).replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : segment;
}

/*
 * Groups pages by their first path segment ("/blog/…" → Blog). A section needs at
 * least one page below it; one-off top-level pages (/about, /contact) go to
 * "Main pages". When most URLs start with a language code (/en/, /fr/), the
 * language is kept as part of the category: "Blog (EN)".
 */
const pathKey = (u) => { const x = new URL(u); return x.pathname + x.search; };

function categorize(pages) {
  const parts = pages.map((p) => new URL(p.url).pathname.split('/').filter(Boolean));
  const localeCount = parts.filter((s) => s.length && LOCALE.test(s[0])).length;
  const locales = new Set(parts.filter((s) => s.length && LOCALE.test(s[0])).map((s) => s[0].toLowerCase()));
  const useLocale = locales.size >= 2 || (locales.size === 1 && localeCount >= pages.length * 0.6 && pages.length > 2);

  const split = (segs) => {
    if (useLocale && segs.length && LOCALE.test(segs[0])) return { locale: segs[0].toLowerCase(), rest: segs.slice(1) };
    return { locale: '', rest: segs };
  };
  const hasChildren = new Set();
  for (const segs of parts) {
    const { locale, rest } = split(segs);
    if (rest.length >= 2) hasChildren.add(locale + '|' + rest[0]);
  }
  const cats = new Map();
  pages.forEach((p, i) => {
    const { locale, rest } = split(parts[i]);
    const section = rest.length && hasChildren.has(locale + '|' + rest[0]) ? rest[0] : '';
    const key = locale + '|' + section;
    if (!cats.has(key)) {
      const base = section ? prettify(section) : 'Main pages';
      cats.set(key, { key, label: locale ? base + ' (' + locale.toUpperCase() + ')' : base, count: 0, main: !section });
    }
    cats.get(key).count++;
    p.category = key;
  });
  const categories = [...cats.values()].sort((a, b) =>
    (b.main - a.main) || (b.count - a.count) || a.label.localeCompare(b.label));
  const order = new Map(categories.map((c, i) => [c.key, i]));
  pages.sort((a, b) => order.get(a.category) - order.get(b.category) ||
    a.depth - b.depth || pathKey(a.url).localeCompare(pathKey(b.url), 'en', { numeric: true }));
  return categories.map(({ key, label, count }) => ({ key, label, count }));
}

/* ───────────── Discovery ───────────── */

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

async function renderedLinks(url) {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const res = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href], area[href]'))
      .filter((a) => !/\bnofollow\b/i.test(a.getAttribute('rel') || ''))
      .map((a) => a.href));
    return { finalUrl: page.url(), links, ok: !!res && res.ok(), title: await page.title() };
  } finally {
    await context.close().catch(() => {});
  }
}

async function discover(input, { maxPages = DEFAULT_MAX_PAGES, onProgress, signal } = {}) {
  let start = normalizeUrl(input);
  if (!/^https?:/.test(start)) throw userError('A full website report needs a web address that starts with http:// or https://.');
  const progress = (msg) => { if (onProgress) onProgress(msg); };
  // Skipped URLs are collected in sets so a link repeated on every page counts once.
  const skips = { offsite: new Set(), files: new Set(), skipped: new Set(), robotsBlocked: new Set(), failed: new Set() };
  const stats = { sitemapUrls: 0, renderedLinks: 0, limitReached: false, robots: false, sitemap: false };
  maxPages = Math.max(1, Math.min(maxPages, 2000));

  // Follow a redirect on the start page (http → https, example.com → www.example.com).
  progress({ stage: 'Loading the start page' });
  let rendered = null;
  try { rendered = await renderedLinks(start); } catch (e) { rendered = null; }
  if (rendered && rendered.finalUrl && /^https?:/.test(rendered.finalUrl)) start = rendered.finalUrl;

  const clean = makeCleaner(start, skips);
  const startClean = clean(start) || start;

  progress({ stage: 'Reading robots.txt and sitemap' });
  let robots = null;
  try { robots = await withTimeout(RobotsTxtFile.find(start), 10000); } catch (e) { robots = null; }
  stats.robots = !!robots;
  const allowed = (u) => { try { return !robots || robots.isAllowed(u); } catch (e) { return true; } };

  const sitemapSources = new Set([new URL('/sitemap.xml', start).href]);
  if (robots) for (const s of robots.getSitemaps()) sitemapSources.add(s);
  let sitemapUrls = [];
  try {
    const sm = await withTimeout(Sitemap.load([...sitemapSources]), 15000);
    if (sm && sm.urls) sitemapUrls = sm.urls.slice(0, MAX_SITEMAP_URLS);
  } catch (e) { sitemapUrls = []; }
  stats.sitemap = sitemapUrls.length > 0;

  // Seeds: start page, links from the rendered start page, sitemap entries.
  const pages = [];
  const seen = new Set();      // keys of pages already recorded
  const queued = new Set();    // keys already sent to the crawler
  const seeds = [];
  const addSeed = (raw, base, depth, source) => {
    const u = clean(raw, base);
    if (!u) return;
    const k = keyOf(u);
    if (queued.has(k)) return;
    if (!allowed(u)) { skips.robotsBlocked.add(k); return; }
    queued.add(k);
    seeds.push({ url: u, uniqueKey: k, userData: { depth, source } });
  };
  addSeed(startClean, start, 0, 'start');
  if (rendered) for (const l of rendered.links) { const before = seeds.length; addSeed(l, rendered.finalUrl, 1, 'link'); stats.renderedLinks += seeds.length - before; }
  for (const u of sitemapUrls) { const before = seeds.length; addSeed(u, start, 1, 'sitemap'); stats.sitemapUrls += seeds.length - before; }

  progress({ stage: 'Following links', found: 0 });

  const config = new Configuration({ persistStorage: false, purgeOnStart: true, storageClient: new MemoryStorage({ persistStorage: false }) });
  let stopped = false;
  const crawler = new CheerioCrawler({
    maxConcurrency: 4,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 30,
    navigationTimeoutSecs: 20,
    maxRequestsPerCrawl: maxPages * 3,
    additionalMimeTypes: ['application/xhtml+xml'],
    async requestHandler({ request, $, response }) {
      if (stopped) return;
      const finalUrl = clean(request.loadedUrl || request.url);
      if (!finalUrl) return; // redirected off-site or to a file
      const k = keyOf(finalUrl);
      if (seen.has(k)) return;
      const type = String((response && response.headers && response.headers['content-type']) || '');
      const status = response && response.statusCode;
      if (status >= 400) { skips.failed.add(k); return; }
      if (type && !/html/i.test(type)) { skips.files.add(k); return; }
      seen.add(k);
      const depth = request.userData.depth || 0;
      const title = $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 200);
      pages.push({ url: finalUrl, title, depth, source: request.userData.source || 'link' });
      progress({ found: pages.length, url: finalUrl });
      if (pages.length >= maxPages) {
        stopped = true;
        stats.limitReached = true;
        crawler.stop();
        return;
      }
      // Respect <meta name="robots" content="nofollow">.
      if (/nofollow/i.test($('meta[name="robots" i]').attr('content') || '')) return;
      const next = [];
      $('a[href], area[href]').each((_, el) => {
        if (/\bnofollow\b/i.test($(el).attr('rel') || '')) return;
        const u = clean($(el).attr('href'), finalUrl);
        if (!u) return;
        const key = keyOf(u);
        if (queued.has(key)) return;
        if (!allowed(u)) { skips.robotsBlocked.add(key); queued.add(key); return; }
        queued.add(key);
        next.push({ url: u, uniqueKey: key, userData: { depth: depth + 1, source: 'link' } });
      });
      if (next.length) await crawler.addRequests(next);
    },
    failedRequestHandler({ request }) { skips.failed.add(request.uniqueKey || request.url); },
  }, config);

  const onAbort = () => { stopped = true; crawler.stop(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    if (!stopped) await crawler.run(seeds);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await crawler.teardown().catch(() => {});
  }

  // If plain HTTP could not read the start page (some sites block it) but Chrome
  // could, keep the start page so the user can still check it.
  if (!pages.length && rendered && rendered.ok) {
    pages.push({ url: startClean, title: rendered.title || '', depth: 0, source: 'start' });
  }
  if (!pages.length) throw userError('No pages could be loaded from ' + new URL(start).host + '. Check the address, or try checking a single page.');

  for (const [name, set] of Object.entries(skips)) stats[name] = set.size;
  const categories = categorize(pages);
  return {
    start: startClean,
    host: new URL(start).host,
    discoveredAt: new Date().toISOString(),
    stopped: !!(signal && signal.aborted),
    pages,
    categories,
    stats,
  };
}

module.exports = { discover, categorize, makeCleaner, DEFAULT_MAX_PAGES };
