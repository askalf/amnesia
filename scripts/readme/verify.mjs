#!/usr/bin/env node
// README "check it yourself" terminal, generated from a LIVE run.
//
//   node scripts/readme/verify.mjs
//
// Each command shown in the picture is actually performed against the
// production endpoints (with fetch, the same request curl would make), and
// the picture prints what came back. If any answer differs from the claim the
// README makes next to it, the script exits 1 and writes nothing: a stale or
// false screenshot of a security claim is worse than no screenshot.
//
// Output: .github/readme/verify.svg — an animated SVG (commands
// type out, answers appear), self-contained, no JavaScript.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAR_W, OUT_DIR, THEMES, esc, svgDoc, windowChrome } from './lib.mjs';

const status = async (url) => String((await fetch(url, { redirect: 'manual' })).status);

const CHECKS = [
  {
    cmd: "curl -so /dev/null -w '%{http_code}' https://amnesia.tax/",
    run: () => status('https://amnesia.tax/'),
    expect: '200',
    note: 'the site',
  },
  {
    cmd: "curl -so /dev/null -w '%{http_code}' 'https://api.amnesia.tax/search?q=test&format=json'",
    run: () => status('https://api.amnesia.tax/search?q=test&format=json'),
    expect: '401',
    note: 'no session, no search',
  },
  {
    cmd: "curl -so /dev/null -w '%{http_code}' 'https://search-origin.amnesia.tax/search?q=test'",
    run: () => status('https://search-origin.amnesia.tax/search?q=test'),
    expect: '403',
    note: 'the backend answers only to the gate',
  },
  {
    cmd: 'curl -sI https://amnesia.tax/ | grep -c unsafe-inline',
    run: async () => {
      const res = await fetch('https://amnesia.tax/', { method: 'HEAD' });
      let n = 0;
      for (const [k, v] of res.headers) if (`${k}: ${v}`.includes('unsafe-inline')) n++;
      return String(n);
    },
    expect: '0',
    note: "CSP allows the page's own script by hash only",
  },
];

// ── run the checks ───────────────────────────────────────────────────
const results = [];
for (const c of CHECKS) {
  const got = await c.run();
  if (got !== c.expect) {
    console.error(`verify.mjs: "${c.cmd}" returned ${got}, the README claims ${c.expect}. Nothing written.`);
    process.exit(1);
  }
  results.push({ ...c, got });
}
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// ── lay out timed rows ───────────────────────────────────────────────
const FS = 13.5;
const CW = +(FS * CHAR_W).toFixed(3);
const LH = 21;
const PAD = 22, CHROME = 38;
const TYPE_S = 0.03, HOLD_S = 7;

const rows = [];            // { kind:'cmd', text, t } | { kind:'out', segs:[{text,tone}], t }
let t = 0.6;
for (const r of results) {
  rows.push({ kind: 'cmd', text: r.cmd, t });
  t += r.cmd.length * TYPE_S + 0.5;
  rows.push({ kind: 'out', segs: [{ text: r.got.padEnd(6), tone: 'green' }, { text: `# ${r.note}`, tone: 'dim' }], t });
  t += 0.45;
}
rows.push({ kind: 'out', segs: [{ text: `# checked against the live endpoints, ${stamp}`, tone: 'muted' }], t });
t += 0.3;
const END = t;
const LOOP = +(END + HOLD_S).toFixed(2);

const COLS = Math.max(...rows.map((r) => (r.kind === 'cmd' ? r.text.length + 2 : r.segs.reduce((n, s) => n + s.text.length, 0))));
const W = Math.round(PAD * 2 + COLS * CW);
const H = Math.round(CHROME + PAD + (rows.length + 1) * LH + PAD);

function render(th) {
  const y = (i) => CHROME + PAD + i * LH + FS;
  const kt = (s) => Math.min(1, s / LOOP).toFixed(4);
  const appear = (s) => `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${kt(s)};${kt(s)};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/>`;
  const els = [];
  rows.forEach((r, i) => {
    if (r.kind === 'cmd') {
      const n = r.text.length;
      const w = +(n * CW).toFixed(2);
      const vals = [], keys = [];
      for (let k = 0; k <= n; k++) { vals.push((k * CW).toFixed(2)); keys.push(kt(r.t + k * TYPE_S)); }
      vals.push(w.toFixed(2)); keys.push('1');
      const id = `c${i}`;
      els.push(`<clipPath id="${id}"><rect x="${PAD + 2 * CW}" y="${y(i) - FS}" height="${LH}" width="0">
  <animate attributeName="width" values="0;${vals.join(';')}" keyTimes="0;${keys.join(';')}" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/></rect></clipPath>`);
      els.push(`<text x="${PAD}" y="${y(i)}" font-size="${FS}" fill="${th.accent}" opacity="0">${appear(r.t)}$</text>`);
      els.push(`<text x="${PAD + 2 * CW}" y="${y(i)}" font-size="${FS}" fill="${th.text}" xml:space="preserve" textLength="${w}" lengthAdjust="spacingAndGlyphs" clip-path="url(#${id})">${esc(r.text)}</text>`);
    } else {
      let col = 0;
      const parts = r.segs.map((s) => {
        const x = +(PAD + col * CW).toFixed(2);
        const w = +(s.text.trimEnd().length * CW).toFixed(2);
        col += s.text.length;
        return `<text x="${x}" y="${y(i)}" font-size="${FS}" fill="${th[s.tone]}" xml:space="preserve" textLength="${w}" lengthAdjust="spacingAndGlyphs">${esc(s.text.trimEnd())}</text>`;
      });
      els.push(`<g opacity="0">${appear(r.t)}${parts.join('')}</g>`);
    }
  });
  const last = rows.length;
  els.push(`<g opacity="0">${appear(END)}
  <text x="${PAD}" y="${y(last)}" font-size="${FS}" fill="${th.accent}">$</text>
  <rect class="blink" x="${PAD + 2 * CW}" y="${y(last) - FS + 1}" width="${CW.toFixed(2)}" height="${LH - 3}" fill="${th.bright}"/></g>`);

  return svgDoc({
    w: W, h: H, bold: false,
    title: 'Check the claims yourself: four commands against the live amnesia.tax endpoints',
    desc: results.map((r) => `$ ${r.cmd} returns ${r.got} (${r.note})`).join('. ') + `. Checked ${stamp}.`,
    style: '.blink{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}',
    body: windowChrome({ w: W, h: H, chromeH: CHROME, title: 'check it yourself', right: 'live', theme: th }) + '\n' + els.join('\n'),
  });
}

mkdirSync(OUT_DIR, { recursive: true });
// One dark terminal serves both GitHub themes; a dark terminal reads fine on
// a light page, so there is no light variant to keep in sync.
const file = join(OUT_DIR, 'verify.svg');
writeFileSync(file, render(THEMES.dark));
console.log('wrote', file, `${W}x${H}`, `loop ${LOOP}s`);
