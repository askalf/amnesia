// The README figure's CSP check (scripts/readme/lib.mjs): verify.mjs writes the picture only when
// one GET of the page, not followed if it redirects, is a 200 whose script-src holds a complete
// hash, because a page with no CSP at all also has zero 'unsafe-inline'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasHashedScriptSrc, unsafeInlineHeaders } from '../scripts/readme/lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = "'sha256-" + 'A'.repeat(43) + "='";

test('the header this repo deploys passes', () => {
  const line = readFileSync(resolve(root, 'src/_headers'), 'utf8').split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
  assert.ok(line, 'src/_headers has a Content-Security-Policy line');
  assert.equal(hasHashedScriptSrc(line.trim().slice('Content-Security-Policy:'.length)), true);
});

test('a missing header fails', () => {
  for (const csp of [null, undefined, '']) assert.equal(hasHashedScriptSrc(csp), false);
});

test('a cut-off hash fails, at any length short of a whole digest', () => {
  assert.equal(hasHashedScriptSrc("default-src 'self'; script-src 'self' 'sha256-"), false);
  assert.equal(hasHashedScriptSrc("script-src 'self' 'sha256-" + 'A'.repeat(20)), false);
  assert.equal(hasHashedScriptSrc("script-src 'self' 'sha256-" + 'A'.repeat(43) + '='), false, 'no closing quote');
});

test('the hash has to be in script-src, not in another directive', () => {
  assert.equal(hasHashedScriptSrc(`default-src 'self'; style-src 'self' ${HASH}`), false);
  assert.equal(hasHashedScriptSrc(`script-src-elem 'self' ${HASH}`), false);
  assert.equal(hasHashedScriptSrc(`default-src 'self'; script-src 'self' ${HASH} https://challenges.cloudflare.com; style-src 'self'`), true);
  assert.equal(hasHashedScriptSrc(`SCRIPT-SRC ${HASH}`), true, 'directive names are case-insensitive');
  assert.equal(hasHashedScriptSrc(`script-src ${HASH.replace('sha256', 'SHA256')}`), true, 'so is the algorithm name');
});

/** A fetch stand-in that answers one fixed response and records what it was asked. */
function stubFetch(status, headers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 200 ? '<!doctype html>' : null, { status, headers });
  };
  return { fetchImpl, calls };
}
const deployedCsp = () => readFileSync(resolve(root, 'src/_headers'), 'utf8').split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:')).trim().slice('Content-Security-Policy:'.length).trim();
const PAGE = 'https://amnesia.sprayberrylabs.com/';

test('the figure asks for the page once, with a GET that does not follow redirects', async () => {
  const { fetchImpl, calls } = stubFetch(200, { 'content-security-policy': deployedCsp() });
  await unsafeInlineHeaders(PAGE, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PAGE);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.method === undefined || calls[0].init.method === 'GET', 'a GET, the request that serves the page');
});

test('a 200 with the deployed policy counts zero', async () => {
  const { fetchImpl } = stubFetch(200, { 'content-security-policy': deployedCsp(), 'x-frame-options': 'DENY' });
  assert.equal(await unsafeInlineHeaders(PAGE, fetchImpl), '0');
});

test('a redirect is refused even when it carries a hashed policy', async () => {
  for (const status of [301, 302, 307, 308]) {
    const { fetchImpl } = stubFetch(status, { location: 'https://elsewhere.example/', 'content-security-policy': deployedCsp() });
    assert.equal(await unsafeInlineHeaders(PAGE, fetchImpl), `no hashed CSP (HTTP ${status})`);
  }
});

test('a 200 with no policy, or with a cut-off hash, is refused instead of counted as zero', async () => {
  assert.equal(await unsafeInlineHeaders(PAGE, stubFetch(200, {}).fetchImpl), 'no hashed CSP (HTTP 200)');
  assert.equal(await unsafeInlineHeaders(PAGE, stubFetch(200, { 'content-security-policy': "script-src 'self' 'sha256-" }).fetchImpl), 'no hashed CSP (HTTP 200)');
});

test("a hashed policy that still lets 'unsafe-inline' in somewhere is counted, not passed", async () => {
  const csp = `script-src 'self' ${HASH}; style-src 'self' 'unsafe-inline'`;
  assert.equal(await unsafeInlineHeaders(PAGE, stubFetch(200, { 'content-security-policy': csp }).fetchImpl), '1');
  const shouted = `script-src 'self' ${HASH}; style-src 'self' 'UNSAFE-INLINE'`;
  assert.equal(await unsafeInlineHeaders(PAGE, stubFetch(200, { 'content-security-policy': shouted }).fetchImpl), '1', 'the keyword counts in any case');
});

test('an error page is refused', async () => {
  const { fetchImpl } = stubFetch(503, { 'content-security-policy': deployedCsp() });
  assert.equal(await unsafeInlineHeaders(PAGE, fetchImpl), 'no hashed CSP (HTTP 503)');
});
