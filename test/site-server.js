'use strict';
/*
 * Serves test/fixtures/site on a local port (random by default) for crawler and site-scan tests.
 * robots.txt and sitemap.xml are generated so they can contain the real port.
 */
const path = require('path');
const express = require('express');

function startSiteServer(port = 0) {
  const app = express();
  let base = '';
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /private/\n\nSitemap: ' + base + '/sitemap.xml\n');
  });
  app.get('/sitemap.xml', (req, res) => {
    const urls = ['/', '/about/', '/orphan/', '/private/secret/'];
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      urls.map((u) => '<url><loc>' + base + u + '</loc></url>').join('') + '</urlset>');
  });
  app.use(express.static(path.join(__dirname, 'fixtures', 'site')));
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      base = (port ? 'http://localhost:' : 'http://127.0.0.1:') + server.address().port;
      resolve({ base, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startSiteServer };
