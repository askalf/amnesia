#!/usr/bin/env node
// CSP hashes for the single-file SPA.
//
// src/_headers allows the page's own inline <style> and <script> by SHA-256
// hash, not 'unsafe-inline'. That makes the header a function of the HTML:
// change a byte of either block and the browser refuses to run it. So the
// header is generated from the HTML here, and CI refuses a commit where the
// two disagree — a silently broken site is the failure mode this exists to
// prevent, and it would look like "search does nothing" with no error a user
// would see.
//
//   node scripts/csp-hashes.mjs            print the hashes
//   node scripts/csp-hashes.mjs --write    rewrite the CSP line in src/_headers
//   node scripts/csp-hashes.mjs --check    exit 1 when src/_headers is stale
//
// Only inline blocks count: a <script src=…> is governed by its origin, not a
// hash. Hashes are over the exact bytes between the tags, which is what the
// browser hashes; the deploy copies the file verbatim, so what is hashed here
// is what is served.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
export const HTML_PATH = resolve(here, '..', 'src', 'amnesia-search.html');
export const HEADERS_PATH = resolve(here, '..', 'src', '_headers');

/** The inline blocks of one kind, in document order — bytes between the tags, untouched. */
export function inlineBlocks(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
  for (const m of html.matchAll(re)) {
    if (tag === 'script' && /\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

export const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** { script: [...hashes], style: [...hashes] } for the HTML text. */
export function cspHashes(html) {
  return {
    script: inlineBlocks(html, 'script').map(sha256),
    style: inlineBlocks(html, 'style').map(sha256),
  };
}

/**
 * The full CSP for the site, with the hashes in place of 'unsafe-inline'.
 * Everything else in it is a deliberate choice documented in src/_headers;
 * keep this the single place the string is assembled.
 */
export function buildCsp({ script, style }) {
  return [
    `default-src 'self'`,
    `script-src 'self' ${script.join(' ')} https://challenges.cloudflare.com`,
    `style-src 'self' ${style.join(' ')}`,
    `font-src 'self'`,
    `img-src 'self' data: https:`,
    `connect-src 'self' https://api.amnesia.tax https://challenges.cloudflare.com`,
    `frame-src https://challenges.cloudflare.com`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
}

const CSP_LINE = /^(\s*Content-Security-Policy:\s*).*$/m;

/** Replace the CSP line in _headers text; throws if there is none. */
export function withCsp(headersText, csp) {
  if (!CSP_LINE.test(headersText)) throw new Error('src/_headers has no Content-Security-Policy line');
  return headersText.replace(CSP_LINE, `$1${csp}`);
}

export function currentCsp(headersText) {
  const m = CSP_LINE.exec(headersText);
  return m ? headersText.slice(m.index + m[1].length, m.index + m[0].length).trim() : null;
}

function main() {
  const args = process.argv.slice(2);
  const html = readFileSync(HTML_PATH, 'utf8');
  const hashes = cspHashes(html);
  const csp = buildCsp(hashes);
  const headers = readFileSync(HEADERS_PATH, 'utf8');

  if (args.includes('--write')) {
    const next = withCsp(headers, csp);
    if (next === headers) console.log('src/_headers already matches src/amnesia-search.html');
    else { writeFileSync(HEADERS_PATH, next); console.log('src/_headers updated'); }
    return;
  }
  if (args.includes('--check')) {
    const have = currentCsp(headers);
    if (have === csp) { console.log(`ok  src/_headers matches src/amnesia-search.html (${hashes.script.length} script, ${hashes.style.length} style hash${hashes.style.length === 1 ? '' : 'es'})`); return; }
    console.error('FAIL: src/_headers does not match src/amnesia-search.html — the inline <script>/<style> changed without regenerating the CSP.');
    console.error('      Run: node scripts/csp-hashes.mjs --write');
    console.error(`      expected: ${csp}`);
    console.error(`      have:     ${have}`);
    process.exit(1);
  }
  console.log(JSON.stringify(hashes, null, 2));
  console.log(csp);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
