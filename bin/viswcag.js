#!/usr/bin/env node
'use strict';
/*
 * Command-line scanner, handy for CI:
 *   viswcag https://example.com                      human-readable summary
 *   viswcag https://example.com --json               full JSON (without the snapshot image)
 *   viswcag https://example.com --snapshot page.jpg  also save the page snapshot (JPEG)
 * Exit codes: 0 no errors, 1 errors found (use --no-fail to always exit 0), 2 the scan failed.
 * `--png` is accepted as an older name for `--snapshot`.
 */
const fs = require('fs');
const { scan, closeBrowser } = require('../src/scanner');

const args = process.argv.slice(2);
const SNAPSHOT_FLAGS = ['--snapshot', '--png'];
const url = args.find((a, i) => !a.startsWith('--') && !SNAPSHOT_FLAGS.includes(args[i - 1]));
if (!url || args.includes('--help')) {
  console.log('Usage: viswcag <url> [--json] [--snapshot page.jpg] [--no-fail]');
  process.exit(url ? 0 : 2);
}

const colour = process.stdout.isTTY ? { error: '\x1b[31m', alert: '\x1b[33m', pass: '\x1b[32m', dim: '\x1b[2m', reset: '\x1b[0m' } : { error: '', alert: '', pass: '', dim: '', reset: '' };

(async () => {
  try {
    const r = await scan(url, { onProgress: (s) => { if (!args.includes('--json')) process.stderr.write(colour.dim + '… ' + s + colour.reset + '\n'); } });
    const snapIdx = args.findIndex((a) => SNAPSHOT_FLAGS.includes(a));
    if (snapIdx >= 0 && args[snapIdx + 1]) fs.writeFileSync(args[snapIdx + 1], Buffer.from(r.snapshot.dataUrl.split(',')[1], 'base64'));
    if (args.includes('--json')) {
      const { snapshot, rules, wcag, ...rest } = r;
      console.log(JSON.stringify({ ...rest, snapshot: { width: snapshot.width, height: snapshot.height } }, null, 2));
    } else {
      console.log('\n' + (r.title || r.finalUrl) + '\n' + r.finalUrl + '\n');
      console.log(`${colour.error}${r.counts.error} errors${colour.reset}   ${colour.alert}${r.counts.alert} alerts${colour.reset}   ${colour.pass}${r.counts.pass} passed${colour.reset}\n`);
      for (const res of r.results) {
        if (res.type === 'pass') continue;
        const rule = r.rules[res.rule];
        console.log(`${colour[res.type]}#${res.id} ${res.type.toUpperCase()}${colour.reset} ${rule.title} [WCAG ${rule.sc.join(', ')}]`);
        if (res.message) console.log('   ' + res.message);
        if (res.selector) console.log(colour.dim + '   ' + res.selector + colour.reset);
      }
    }
    await closeBrowser();
    process.exit(r.counts.error && !args.includes('--no-fail') ? 1 : 0);
  } catch (e) {
    console.error(e.message);
    await closeBrowser();
    process.exit(2);
  }
})();
