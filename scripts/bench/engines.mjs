#!/usr/bin/env node
// Per-engine latency from a private SearXNG running amnesia's production
// settings (infra/searxng/settings.yml).
//
//   node scripts/bench/engines.mjs [--rounds 3] [--port 8890] [--proxy URL]
//                                  [--ca FILE] [--json out.json] [--keep]
//
// Starts the digest-pinned SearXNG image from infra/docker-compose.yml with
// the production settings, runs a fixed set of searches across eight
// SearXNG categories (the SPA's four tabs and four reachable by ?cat=), and reads each response's Server-Timing header,
// where SearXNG reports every engine that answered and how long it took
// (`total_N_<engine>`: request + parse; `load_N_<engine>`: the HTTP fetch
// alone). Engines that failed come from the JSON body's unresponsive_engines.
// The hosted Worker drops Server-Timing, so this only works against a
// SearXNG you run yourself.
//
// The one change to the settings: a gluetun:8888 proxy, which does not exist
// here, is removed, and --proxy is added when given. Without --proxy, engines
// see this machine's IP, not a ProtonVPN exit: expect different blocking
// (Google, Qwant) and a shorter network path than the hosted instance. Use
// --proxy to measure through a VPN or an egress proxy; a loopback proxy
// switches the container to host networking so it can reach it, and --ca adds
// that proxy's CA to the container's trust store.
//
// Needs Docker and Node 20+. Zero dependencies.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values: opt } = parseArgs({
  options: {
    rounds: { type: 'string', default: '3' },
    port: { type: 'string', default: '8890' },
    proxy: { type: 'string' },
    ca: { type: 'string' },
    settings: { type: 'string', default: join(ROOT, 'infra', 'searxng', 'settings.yml') },
    json: { type: 'string' },
    pause: { type: 'string', default: '1000' },
    keep: { type: 'boolean', default: false },
  },
});
const ROUNDS = Number(opt.rounds);
const PORT = Number(opt.port);
const PAUSE_MS = Number(opt.pause);

// One query per category per round; each round uses a different query so no
// engine sees the same request twice in a row.
const QUERIES = {
  general: ['linux kernel scheduler', 'how does wireguard work', 'sourdough starter ratio', 'history of the printing press', 'rust borrow checker explained'],
  news: ['climate summit', 'central bank interest rates', 'space launch', 'election results', 'semiconductor exports'],
  images: ['aurora borealis', 'red panda', 'mountain lake', 'lighthouse at night', 'bonsai tree'],
  videos: ['bread baking tutorial', 'guitar chord basics', 'kubernetes explained', 'chess opening traps', 'woodworking joints'],
  it: ['python asyncio gather', 'nginx reverse proxy', 'postgres vacuum', 'react useeffect cleanup', 'docker multi stage build'],
  science: ['crispr off target effects', 'dark matter detection', 'protein folding', 'graphene conductivity', 'coral bleaching'],
  'social media': ['self hosting', 'mechanical keyboards', 'open source funding', 'home lab', 'privacy tools'],
  map: ['eiffel tower', 'central park', 'lake geneva', 'mount fuji', 'sydney opera house'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function composeImage() {
  const compose = readFileSync(join(ROOT, 'infra', 'docker-compose.yml'), 'utf8');
  const m = compose.match(/image:\s*(searxng\/searxng@sha256:[0-9a-f]{64})/);
  if (!m) throw new Error('no digest-pinned searxng image in infra/docker-compose.yml');
  return m[1];
}

function patchSettings(text, proxy) {
  // The rollback shape pins gluetun:8888 here; the VPN-namespace shape has no
  // proxy at all. Accept either, then add --proxy if one was given.
  let out = text.replace(/^  proxies:\n    all:\/\/:\n      - http:\/\/gluetun:8888\n/m, '');
  if (/^  proxies:/m.test(out)) throw new Error('settings.yml: unexpected outgoing.proxies block; edit a copy and pass --settings');
  if (!proxy) return out;
  const block = `  proxies:\n    all://:\n      - ${proxy}\n`;
  return /^outgoing:\n/m.test(out) ? out.replace(/^outgoing:\n/m, 'outgoing:\n' + block) : out + '\noutgoing:\n' + block;
}

function isLoopback(url) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

async function waitHealthy(base, name) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return;
    } catch {}
    await sleep(1000);
  }
  let logs = '';
  try { logs = docker(['logs', '--tail', '40', name]); } catch {}
  throw new Error('SearXNG did not become healthy in 90s\n' + logs);
}

// "total;dur=812.2, render;dur=0, total_0_bing;dur=401.3, load_0_bing;dur=380.1, ..."
export function parseServerTiming(header) {
  const out = { total: null, engines: {} };
  for (const part of (header || '').split(',')) {
    const m = part.trim().match(/^([^;]+);dur=([\d.]+)$/);
    if (!m) continue;
    const [, key, dur] = m;
    const ms = Number(dur);
    if (key === 'total') { out.total = ms; continue; }
    const e = key.match(/^(total|load)_\d+_(.+)$/);
    if (!e) continue;
    (out.engines[e[2]] ||= {})[e[1]] = ms;
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

const fmt = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(2) + 's');

function table(rows, headers) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ');
  return [line(headers), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

async function main() {
  const image = composeImage();
  const dir = mkdtempSync(join(tmpdir(), 'amnesia-bench-'));
  const conf = join(dir, 'searxng');
  mkdirSync(conf);
  writeFileSync(join(conf, 'settings.yml'), patchSettings(readFileSync(resolve(opt.settings), 'utf8'), opt.proxy));
  chmodSync(dir, 0o755);
  chmodSync(conf, 0o755);

  const hostNet = opt.proxy && isLoopback(opt.proxy);
  const name = 'amnesia-bench-' + process.pid;
  const base = `http://127.0.0.1:${PORT}`;
  const run = ['run', '-d', '--name', name,
    '-e', 'SEARXNG_SECRET=' + randomBytes(32).toString('hex'),
    '-e', `SEARXNG_BASE_URL=${base}/`,
    '-v', `${conf}:/etc/searxng:ro`,
    '--tmpfs', '/var/cache/searxng:mode=1777'];
  if (hostNet) run.push('--network', 'host', '-e', `GRANIAN_PORT=${PORT}`, '-e', 'GRANIAN_HOST=127.0.0.1');
  // 0.0.0.0, not the image's ::, so hosts without IPv6 in Docker still start.
  else run.push('-p', `127.0.0.1:${PORT}:8080`, '-e', 'GRANIAN_HOST=0.0.0.0');
  // The image's entrypoint runs update-ca-certificates, which picks this up.
  if (opt.ca) run.push('-v', `${resolve(opt.ca)}:/usr/local/share/ca-certificates/amnesia-bench.crt:ro`);
  run.push(image);

  console.error(`starting ${image.slice(0, 40)}... as ${name}` + (opt.proxy ? ` via ${opt.proxy}` : ' (direct egress, no VPN)'));
  docker(run);
  const cleanup = () => {
    if (!opt.keep) { try { docker(['rm', '-f', name]); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const searches = [];
  const engines = {}; // name -> { ok: [ms], load: [ms], fail: {reason: n}, last: n }
  const eng = (n) => (engines[n] ||= { ok: [], load: [], fail: {}, last: 0, runs: 0 });

  try {
    await waitHealthy(base, name);
    for (let round = 0; round < ROUNDS; round++) {
      for (const [cat, pool] of Object.entries(QUERIES)) {
        const q = pool[round % pool.length];
        const url = `${base}/search?q=${encodeURIComponent(q)}&format=json&categories=${encodeURIComponent(cat)}`;
        const t0 = performance.now();
        let res, body = null;
        try {
          res = await fetch(url);
          body = await res.json();
        } catch (e) {
          console.error(`  ${cat.padEnd(12)} ${q}: request failed (${e.message})`);
          continue;
        }
        const wall = performance.now() - t0;
        const st = parseServerTiming(res.headers.get('server-timing'));
        const failed = body?.unresponsive_engines || [];
        const answered = Object.entries(st.engines).filter(([, t]) => t.total != null);
        let slowest = null;
        for (const [n, t] of answered) {
          const e = eng(n);
          e.runs++;
          e.ok.push(t.total);
          if (t.load != null) e.load.push(t.load);
          if (!slowest || t.total > slowest[1]) slowest = [n, t.total];
        }
        for (const [n, reason] of failed) {
          const e = eng(n);
          e.runs++;
          e.fail[reason] = (e.fail[reason] || 0) + 1;
        }
        // A search is as slow as its slowest engine; a failed engine that ran
        // to its timeout is what pinned it, so it takes precedence.
        const timedOut = failed.filter(([, r]) => /timeout/i.test(r)).map(([n]) => n);
        const pinnedBy = timedOut.length ? timedOut.join('+') + ' (timeout)' : slowest ? slowest[0] : '-';
        if (timedOut.length) timedOut.forEach((n) => eng(n).last++);
        else if (slowest) eng(slowest[0]).last++;
        searches.push({ category: cat, query: q, status: res.status, wall_ms: Math.round(wall), searxng_ms: st.total,
          results: body?.results?.length ?? 0, answered: answered.length, failed: failed.length, pinned_by: pinnedBy });
        console.error(`  ${cat.padEnd(12)} ${fmt(wall).padStart(6)}  ${String(body?.results?.length ?? 0).padStart(3)} results  ` +
          `${answered.length} ok / ${failed.length} failed  slowest: ${pinnedBy}`);
        await sleep(PAUSE_MS);
      }
    }
  } finally {
    cleanup();
  }

  // Per category: wall time of each search.
  const byCat = {};
  for (const s of searches) (byCat[s.category] ||= []).push(s.wall_ms);
  const catRows = Object.entries(byCat).map(([c, ms]) => {
    const s = [...ms].sort((a, b) => a - b);
    return [c, s.length, fmt(pct(s, 50)), fmt(s.at(-1))];
  });

  const engRows = Object.entries(engines).map(([n, e]) => {
    const s = [...e.ok].sort((a, b) => a - b);
    const l = [...e.load].sort((a, b) => a - b);
    const fails = Object.entries(e.fail).map(([r, k]) => `${k}x ${r}`).join(', ');
    return { n, row: [n, `${e.ok.length}/${e.runs}`, fmt(pct(s, 50)), fmt(pct(s, 95)), fmt(s.at(-1)), fmt(pct(l, 50)), e.last, fails || ''],
      sortKey: (Object.values(e.fail).length ? 1e9 : 0) + (pct(s, 95) ?? 0) };
  }).sort((a, b) => b.sortKey - a.sortKey);

  console.log(`\nSearches (${searches.length}, ${ROUNDS} per category), wall time at the client:\n`);
  console.log(table(catRows, ['category', 'n', 'p50', 'max']));
  console.log('\nEngines, slowest first (failing engines on top). ok = answered/ran; ' +
    'total = request+parse, load = HTTP fetch; slowest = searches this engine finished last in:\n');
  console.log(table(engRows.map((r) => r.row), ['engine', 'ok', 'p50', 'p95', 'max', 'load p50', 'slowest', 'failures']));

  if (opt.json) {
    writeFileSync(opt.json, JSON.stringify({ image, proxy: opt.proxy || null, rounds: ROUNDS, searches, engines }, null, 2));
    console.error(`\nwrote ${opt.json}`);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
