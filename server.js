#!/usr/bin/env node
'use strict';
/*
 * VisWCAG local server.
 *
 * Serves the web interface (public/) and a small streaming API:
 *   POST /api/scan              check one page             → stage lines, then {result}
 *   POST /api/crawl             find a site's pages         → stage/progress lines, then {result}
 *   POST /api/crawl/:id/stop    end a crawl early (the pages found so far are returned)
 *   POST /api/site-scan         check several pages         → one {page} line per page, then {done}
 *   GET  /api/rules             rule catalogue, WCAG 2.2 criteria and 2.2 coverage notes
 *   GET  /api/config            limits the interface shows
 * Responses are newline-delimited JSON (application/x-ndjson) so the interface can
 * show progress while Chrome works.
 *
 * The server binds to 127.0.0.1 by default. It loads any address it is given,
 * including file:// and local network addresses, so do not expose it publicly
 * without adding restrictions (see "Security" in the README).
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { scan, closeBrowser } = require('./src/scanner');
const { discover, DEFAULT_MAX_PAGES } = require('./src/crawler');

const PORT = parseInt(process.env.PORT, 10) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CONCURRENT = parseInt(process.env.VISWCAG_CONCURRENCY, 10) || 2;
const MAX_SITE_PAGES = parseInt(process.env.VISWCAG_SITE_MAX_PAGES, 10) || 200;
// Snapshots in website reports are a little lighter, since there are many of them.
const SITE_SNAPSHOT = { snapshotMaxHeight: 10000, snapshotQuality: 72 };

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Fonts are served from their npm packages so the interface never contacts another site.
const fontDir = (pkg) => path.dirname(require.resolve(pkg + '/package.json'));
app.use('/fonts/next', express.static(fontDir('@fontsource/atkinson-hyperlegible-next'), { maxAge: '30d' }));
app.use('/fonts/mono', express.static(fontDir('@fontsource/atkinson-hyperlegible-mono'), { maxAge: '30d' }));

app.get('/api/rules', (req, res) => {
  const { WCAG22, COVERAGE_22 } = require('./src/engine/wcag');
  res.json({ rules: require('./src/engine/rules').RULES, wcag: WCAG22, coverage22: COVERAGE_22 });
});

app.get('/api/config', (req, res) => {
  res.json({ maxSitePages: MAX_SITE_PAGES, concurrency: MAX_CONCURRENT, crawlMaxPages: DEFAULT_MAX_PAGES });
});

/* Tiny semaphore so a burst of scans doesn't open dozens of browser tabs. */
let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

/* Newline-delimited JSON stream helper. `closed()` is true once the client has gone. */
function ndjson(res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  let gone = false;
  res.on('close', () => { if (!res.writableEnded) gone = true; });
  return {
    send: (obj) => { if (!gone && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); },
    closed: () => gone,
    onClose: (fn) => res.on('close', () => { if (gone) fn(); }),
    end: () => { if (!res.writableEnded) res.end(); },
  };
}

const publicError = (err, what) => {
  if (!err.userFacing) console.error('[' + what + ' failed]', err);
  return err.userFacing ? err.message : 'The ' + what + ' failed: ' + String(err.message || err).split('\n')[0];
};

/*
 * POST /api/scan  { "url": "https://example.com" }
 * Streams {"stage": "..."} progress lines, then {"result": {...}} or {"error": "..."}.
 */
app.post('/api/scan', async (req, res) => {
  const out = ndjson(res);
  const url = req.body && req.body.url;
  out.send({ stage: 'Queued' });
  try {
    const result = await withSlot(() => scan(url, { onProgress: (stage) => out.send({ stage }) }));
    out.send({ result });
  } catch (err) {
    out.send({ error: publicError(err, 'scan') });
  }
  out.end();
});

/*
 * POST /api/crawl  { "url": "https://example.com", "maxPages": 300 }
 * Streams {"crawl": {"id"}}, {"stage"}, {"progress": {"found", "url"}}, then
 * {"result": {...}} (see src/crawler.js) or {"error"}.
 * POST /api/crawl/:id/stop ends the crawl early; the pages found so far are returned.
 */
const crawls = new Map();
app.post('/api/crawl', async (req, res) => {
  const out = ndjson(res);
  const id = crypto.randomUUID();
  const controller = new AbortController();
  crawls.set(id, controller);
  out.onClose(() => controller.abort());
  out.send({ crawl: { id } });
  try {
    const maxPages = parseInt(req.body && req.body.maxPages, 10) || undefined;
    const result = await discover(req.body && req.body.url, {
      maxPages,
      signal: controller.signal,
      onProgress: (msg) => out.send(msg.stage ? { stage: msg.stage } : { progress: msg }),
    });
    out.send({ result });
  } catch (err) {
    out.send({ error: publicError(err, 'crawl') });
  } finally {
    crawls.delete(id);
  }
  out.end();
});

app.post('/api/crawl/:id/stop', (req, res) => {
  const c = crawls.get(req.params.id);
  if (c) c.abort();
  res.status(c ? 204 : 404).end();
});

/*
 * POST /api/site-scan  { "urls": ["https://example.com/", …] }
 * Streams {"pageStart": {index, url}}, {"page": {index, url, result | error}} for each
 * page as it finishes, then {"done": {completed, failed, stopped}}.
 * Closing the connection stops the run after the pages in progress.
 */
app.post('/api/site-scan', async (req, res) => {
  const out = ndjson(res);
  const urls = req.body && Array.isArray(req.body.urls) ? req.body.urls.filter((u) => typeof u === 'string' && u.trim()) : [];
  if (!urls.length) { out.send({ error: 'Choose at least one page to check.' }); return out.end(); }
  if (urls.length > MAX_SITE_PAGES) { out.send({ error: 'Choose at most ' + MAX_SITE_PAGES + ' pages for one report.' }); return out.end(); }

  let next = 0;
  let completed = 0;
  let failed = 0;
  const worker = async () => {
    while (!out.closed() && next < urls.length) {
      const index = next++;
      const url = urls[index];
      await withSlot(async () => {
        if (out.closed()) return;
        out.send({ pageStart: { index, url } });
        try {
          const result = await scan(url, SITE_SNAPSHOT);
          completed++;
          out.send({ page: { index, url, result } });
        } catch (err) {
          failed++;
          out.send({ page: { index, url, error: publicError(err, 'scan') } });
        }
      });
    }
  };
  out.send({ stage: 'Started', total: urls.length });
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, urls.length) }, worker));
  out.send({ done: { completed, failed, stopped: out.closed() } });
  out.end();
});

function start(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => resolve(server));
  });
}

if (require.main === module) {
  start().then((server) => {
    console.log(`VisWCAG is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    const shutdown = async () => {
      server.close();
      await closeBrowser();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

module.exports = { app, start };
