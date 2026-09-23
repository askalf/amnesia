#!/usr/bin/env node
// Page-load and search latency of the amnesia front end, measured in a real
// browser the way a visitor meets it.
//
//   node scripts/bench/live.mjs [--site https://amnesia.tax] [--runs 3]
//                               [--cookie amns=VALUE] [--headed] [--json out.json]
//
// Each run, in a fresh browser profile:
//   cold   first visit: empty cache, new DNS/TCP/TLS; also times the page's
//          Turnstile warm-up (GET /session) when the site has an API gate
//   warm   reload in the same profile: HTTP cache and open connections
//   search type a query and press Enter; time to the /search response and to
//          rendered results. The x-amnesia-cache header says edge hit or miss.
//   repeat the same query again, which the Worker's edge cache should answer
//
// Turnstile is invisible but can refuse a headless browser; the search rows
// then show 401/403. Pass --headed, or copy the `amns` cookie for
// api.amnesia.tax from a browser that has searched and pass --cookie amns=...
// It also works against a self-host (--site http://localhost:8080), where
// the page calls SearXNG on its own origin with no gate.
//
// Needs Playwright with Chromium (`npm i -g playwright`, or any install Node
// can resolve). Not a repo dependency on purpose, like the rest of scripts/.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    site: { type: 'string', default: 'https://amnesia.tax' },
    runs: { type: 'string', default: '3' },
    cookie: { type: 'string' },
    headed: { type: 'boolean', default: false },
    json: { type: 'string' },
    timeout: { type: 'string', default: '30000' },
  },
});
const SITE = opt.site.replace(/\/$/, '');
const RUNS = Number(opt.runs);
const TIMEOUT = Number(opt.timeout);
// Distinct everyday queries so each run's first search is an edge-cache miss
// (the Worker keys on the query text for 3 minutes).
const QUERIES = ['tide tables explained', 'cast iron seasoning', 'how do vaccines work', 'aurora forecast tonight',
  'tcp slow start', 'best hiking boots', 'sourdough hydration', 'roman aqueducts', 'solar panel efficiency', 'jazz chord voicings'];

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return createRequire(join(root, 'noop.js'))('playwright');
}

const fmt = (ms) => (ms == null || Number.isNaN(ms) ? '-' : (ms / 1000).toFixed(2) + 's');
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

// Navigation Timing for the document, plus bytes that crossed the network.
const navMetrics = () => {
  const n = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const bytes = [n, ...res].reduce((a, e) => a + (e.transferSize || 0), 0);
  return {
    dns: n.domainLookupEnd - n.domainLookupStart,
    connect: n.connectEnd - n.connectStart,
    ttfb: n.responseStart - n.startTime,
    html: n.responseEnd - n.startTime,
    dcl: n.domContentLoadedEventEnd - n.startTime,
    load: n.loadEventEnd - n.startTime,
    bytes,
    requests: res.length + 1,
  };
};

async function pageLoad(page, how) {
  const session = page.waitForResponse((r) => new URL(r.url()).pathname === '/session', { timeout: TIMEOUT })
    .catch(() => null);
  const t0 = Date.now();
  if (how === 'cold') await page.goto(SITE + '/', { waitUntil: 'load', timeout: TIMEOUT });
  else await page.reload({ waitUntil: 'load', timeout: TIMEOUT });
  await page.waitForFunction(() => performance.getEntriesByType('navigation')[0]?.loadEventEnd > 0);
  const m = await page.evaluate(navMetrics);
  // Only the hosted page warms a session; a self-host has no gate to warm.
  const gated = await page.evaluate(() => typeof API_BASE === 'string' && API_BASE !== '').catch(() => false);
  m.gated = gated;
  if (gated) {
    const r = await session;
    m.session = r ? Date.now() - t0 : null;
    m.sessionStatus = r ? r.status() : 'none';
  }
  return m;
}

async function search(page, query, gated) {
  const q = page.locator('#q');
  await q.fill(query);
  // Wait out the autocomplete debounce so its dropdown doesn't swallow Enter.
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  const resp = page.waitForResponse((r) => new URL(r.url()).pathname === '/search', { timeout: TIMEOUT });
  await page.evaluate(() => { document.getElementById('content').innerHTML = ''; });
  const t0 = Date.now();
  await q.press('Enter');
  const r = await resp;
  const tResp = Date.now() - t0;
  const done = '#content .result-item, #content .image-grid, #content .no-results, #content .error-msg';
  await page.waitForSelector(done, { timeout: TIMEOUT });
  const tRender = Date.now() - t0;
  const out = await page.evaluate(() => ({
    results: document.querySelectorAll('#content .result-item').length,
    error: document.querySelector('#content .error-msg')?.textContent || null,
  }));
  return { status: r.status(), // The Worker marks only hits; a self-host has no edge cache at all.
    cache: r.headers()['x-amnesia-cache'] || (gated ? 'miss' : 'none'), response: tResp, render: tRender, ...out };
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !opt.headed });
  const runs = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext();
      if (opt.cookie) {
        const [name, ...v] = opt.cookie.split('=');
        const api = new URL(SITE).hostname === 'amnesia.tax' ? 'api.amnesia.tax' : new URL(SITE).hostname;
        await ctx.addCookies([{ name, value: v.join('='), domain: api, path: '/', secure: true, sameSite: 'None' }]);
      }
      const page = await ctx.newPage();
      const query = QUERIES[(Date.now() / 1000 + i) % QUERIES.length | 0];
      const run = { query };
      try {
        run.cold = await pageLoad(page, 'cold');
        run.warm = await pageLoad(page, 'warm');
        run.search = await search(page, query, run.cold.gated);
        run.repeat = await search(page, query, run.cold.gated);
      } catch (e) {
        run.error = e.message.split('\n')[0];
      }
      await ctx.close();
      runs.push(run);
      const s = run.search, r = run.repeat;
      console.error(`run ${i + 1}: cold ${fmt(run.cold?.load)}  warm ${fmt(run.warm?.load)}  ` +
        `search ${fmt(s?.render)} (${s?.status} ${s?.cache})  repeat ${fmt(r?.render)} (${r?.status} ${r?.cache})` +
        (run.error ? `  error: ${run.error}` : '') + (s?.error ? `  page said: ${s.error}` : ''));
    }
  } finally {
    await browser.close();
  }

  const col = (get) => median(runs.map(get));
  const rows = [
    ['cold load', 'TTFB', col((r) => r.cold?.ttfb)],
    ['', 'DNS + connect', col((r) => r.cold && r.cold.dns + r.cold.connect)],
    ['', 'DOMContentLoaded', col((r) => r.cold?.dcl)],
    ['', 'load event', col((r) => r.cold?.load)],
    ['', 'session warm-up (Turnstile + /session)', col((r) => r.cold?.session)],
    ['warm load', 'TTFB', col((r) => r.warm?.ttfb)],
    ['', 'load event', col((r) => r.warm?.load)],
    ['search', '/search response', col((r) => r.search?.response)],
    ['', 'results rendered', col((r) => r.search?.render)],
    ['repeat search', '/search response', col((r) => r.repeat?.response)],
    ['', 'results rendered', col((r) => r.repeat?.render)],
  ].filter(([, , v]) => v != null);
  const kb = (b) => (b == null ? '-' : Math.round(b / 1024) + ' KB');
  console.log(`\n${SITE}, median of ${RUNS} run(s):\n`);
  for (const [a, b, v] of rows) console.log(`  ${a.padEnd(14)} ${b.padEnd(40)} ${fmt(v).padStart(7)}`);
  console.log(`\n  transferred: cold ${kb(col((r) => r.cold?.bytes))} in ${col((r) => r.cold?.requests) ?? '-'} requests, ` +
    `warm ${kb(col((r) => r.warm?.bytes))}`);
  console.log(`  edge cache: first search ${runs.map((r) => r.search?.cache ?? '-').join(',')}; ` +
    `repeat ${runs.map((r) => r.repeat?.cache ?? '-').join(',')}`);
  if (opt.json) writeFileSync(opt.json, JSON.stringify({ site: SITE, runs }, null, 2));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
