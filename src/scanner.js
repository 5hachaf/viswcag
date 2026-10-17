'use strict';
/*
 * Drives a local headless Chrome: loads the page, lets its CSS and JavaScript run,
 * injects the audit engine into the rendered DOM, takes a full-page snapshot and
 * runs the checks that change the page state, in this order: keyboard focus
 * (focus visible, focus not obscured), then reflow at a 320px viewport.
 *
 * scan(url, options) resolves to the result object described in the README
 * ("Result format"); the browser is started once and reused between scans.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { RULES } = require('./engine/rules');
const { WCAG22 } = require('./engine/wcag');

const ENGINE_SOURCE = fs.readFileSync(path.join(__dirname, 'engine', 'engine.browser.js'), 'utf8');

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const MAX_SNAPSHOT_HEIGHT = 15000;
const TYPE_ORDER = { error: 0, alert: 1, pass: 2 };

let browserPromise = null;

function launchOptions() {
  const args = ['--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot || process.env.VISWCAG_NO_SANDBOX) args.push('--no-sandbox', '--disable-setuid-sandbox');
  const opts = { headless: true, args };
  const exe = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (exe) opts.executablePath = exe;
  return opts;
}

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.connected) return b;
  }
  browserPromise = puppeteer.launch(launchOptions());
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw userError('Enter a web address to scan.');
  if (/^(localhost|127\.|\[?::1)/i.test(raw)) raw = 'http://' + raw;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch (e) { throw userError('"' + input + '" is not a valid web address.'); }
  if (!['http:', 'https:', 'file:'].includes(u.protocol)) throw userError('Only http, https and file addresses can be scanned.');
  return u.href;
}

function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

function friendlyNavError(err, url) {
  const m = String(err && err.message || err);
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return userError('The address could not be found. Check the spelling of ' + new URL(url).hostname + '.');
  if (/ERR_CONNECTION_REFUSED/.test(m)) return userError('The server at ' + new URL(url).host + ' refused the connection. Is it running?');
  if (/ERR_CERT|SSL/.test(m)) return userError('The site\'s security certificate is not valid, so the page was not loaded.');
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK/.test(m)) return userError('This computer appears to be offline.');
  if (/ERR_FILE_NOT_FOUND/.test(m)) return userError('That file does not exist.');
  if (/Timeout|timeout/.test(m)) return userError('The page took longer than 45 seconds to load.');
  return userError('The page could not be loaded: ' + m.split('\n')[0]);
}

async function autoScroll(page) {
  // Trigger lazy-loaded images and content, then return to the top.
  await page.evaluate(async () => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
    const max = Math.min(document.documentElement.scrollHeight, 20000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
}

function finalise(raw) {
  const results = raw
    .filter((r) => RULES[r.rule])
    .map((r) => ({ ...r, type: RULES[r.rule].type }));
  results.sort((a, b) =>
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
    a.order - b.order ||
    a.rule.localeCompare(b.rule));
  results.forEach((r, i) => { r.id = i + 1; });
  return results;
}

/*
 * Options:
 *   onProgress(stage)   called with each stage name
 *   snapshotMaxHeight   cap on snapshot height in px (default 15000)
 *   snapshotQuality     JPEG quality 1-100 (default 82)
 */
async function scan(input, { onProgress, snapshotMaxHeight = MAX_SNAPSHOT_HEIGHT, snapshotQuality = 82 } = {}) {
  const url = normalizeUrl(input);
  const progress = (stage) => { if (onProgress) onProgress(stage); };
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const started = Date.now();
  try {
    await page.setBypassCSP(true);
    await page.setViewport(VIEWPORT);
    progress('Loading page');
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    } catch (err) {
      throw friendlyNavError(err, url);
    }
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    const status = response ? response.status() : null;

    progress('Rendering lazy content');
    await autoScroll(page);

    progress('Evaluating WCAG rules');
    await page.evaluate(ENGINE_SOURCE);
    const main = await page.evaluate(() => window.__viswcag.scan());

    progress('Capturing snapshot');
    const width = Math.min(Math.max(main.meta.docWidth, VIEWPORT.width), 4000);
    const height = Math.min(main.meta.docHeight, snapshotMaxHeight);
    const shot = await page.screenshot({
      type: 'jpeg', quality: snapshotQuality, encoding: 'base64',
      clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true,
    });

    progress('Checking keyboard focus');
    // A key press makes Chrome treat programmatic focus like keyboard focus (:focus-visible).
    await page.keyboard.press('Shift').catch(() => {});
    const focus = await page.evaluate(() => window.__viswcag.focusCheck(150)).catch(() => ({ results: [] }));

    progress('Checking reflow at 320px');
    const reflow = await checkReflow(page);

    const results = finalise([...main.results, ...focus.results, ...reflow]);
    const counts = { error: 0, alert: 0, pass: 0 };
    results.forEach((r) => { counts[r.type]++; });

    return {
      url,
      finalUrl: page.url(),
      status,
      title: main.meta.title,
      lang: main.meta.lang,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      engine: { name: 'VisWCAG', version: require('../package.json').version, standard: 'WCAG 2.2' },
      snapshot: {
        dataUrl: 'data:image/jpeg;base64,' + shot,
        width,
        height,
        docHeight: main.meta.docHeight,
        truncated: main.meta.docHeight > snapshotMaxHeight,
      },
      counts,
      results,
      rules: RULES,
      wcag: WCAG22,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function checkReflow(page) {
  try {
    await page.setViewport({ width: 320, height: 640, deviceScaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 500));
    const info = await page.evaluate(() => {
      const de = document.documentElement;
      const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
      const vw = de.clientWidth || window.innerWidth;
      const offenders = [];
      if (sw > vw + 1) {
        const all = document.body ? document.body.querySelectorAll('*') : [];
        for (const el of all) {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 1 && r.width > 0 && r.height > 0) {
            const s = getComputedStyle(el);
            if (s.position === 'fixed' || s.visibility === 'hidden') continue;
            const parent = el.parentElement && el.parentElement.getBoundingClientRect();
            if (parent && parent.right > vw + 1) continue; // report the outermost offender only
            let sel = el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
            offenders.push(sel + ' (' + Math.round(r.width) + 'px wide)');
            if (offenders.length >= 5) break;
          }
        }
      }
      return { scrollWidth: sw, viewportWidth: vw, offenders };
    });
    await page.setViewport(VIEWPORT);
    if (info.scrollWidth > info.viewportWidth + 1) {
      return [{
        rule: 'reflow', order: -1, rect: null, selector: null, snippet: null,
        message: 'At 320px the page is ' + info.scrollWidth + 'px wide and scrolls horizontally.' +
          (info.offenders.length ? ' Widest elements: ' + info.offenders.join('; ') + '.' : ''),
        extra: info,
      }];
    }
    return [{ rule: 'reflow_ok', order: -1, rect: null, selector: null, snippet: null, message: 'No horizontal scrolling at 320px.', extra: info }];
  } catch (e) {
    return [];
  }
}

module.exports = { scan, normalizeUrl, closeBrowser, getBrowser, launchOptions, userError };
