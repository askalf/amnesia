// The API gate, driven through its real default export.
//
// Nothing here edits worker/src: the Worker runs as deployed, with the
// Workers-runtime globals it touches (fetch, caches.default, ctx.waitUntil)
// replaced by in-memory stubs. Every upstream call the gate makes is
// recorded, so each test can assert both the answer the client got and
// what did (or did not) leave the gate.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildCookie, hmac, verifySession, COOKIE_NAME } from '../worker/src/index.js';

const SITE = 'https://amnesia.tax';
const API = 'https://api.amnesia.tax';
const ORIGIN = 'https://origin.test';
const ENV = Object.freeze({
  SESSION_SECRET: 'test-session-secret',
  TURNSTILE_SECRET: 'test-turnstile-secret',
  ORIGIN_SECRET: 'test-origin-secret',
  ALLOWED_ORIGIN: SITE,
  ORIGIN_HOST: ORIGIN,
  SESSION_TTL: '1800',
});

let calls; // every fetch the Worker made: { url, init }
let cache; // caches.default contents: key URL -> { body, headers, key }
let pending; // ctx.waitUntil promises
let siteverify; // what Turnstile's siteverify answers (object, or an Error to throw)
let origin; // (url, init) => Response for the SearXNG origin

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;

beforeEach(() => {
  calls = [];
  cache = new Map();
  pending = [];
  siteverify = { success: true, hostname: 'amnesia.tax' };
  origin = () =>
    new Response(JSON.stringify({ query: 'q', results: [{ url: 'https://example.com/' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url.startsWith('https://challenges.cloudflare.com/')) {
      if (siteverify instanceof Error) throw siteverify;
      return new Response(JSON.stringify(siteverify), { headers: { 'content-type': 'application/json' } });
    }
    return origin(url, init);
  };
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = cache.get(req.url);
        return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
      },
      async put(req, res) {
        cache.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers), key: req });
      },
    },
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.caches = realCaches;
});

async function call(path, { method = 'GET', headers = {}, env = ENV } = {}) {
  const ctx = { waitUntil: (p) => pending.push(p) };
  const res = await worker.fetch(new Request(API + path, { method, headers }), env, ctx);
  const body = await res.text();
  await Promise.all(pending.splice(0));
  return { res, status: res.status, body, json: () => JSON.parse(body), header: (h) => res.headers.get(h) };
}

const originCalls = () => calls.filter((c) => c.url.startsWith(ORIGIN));
const verifyCalls = () => calls.filter((c) => c.url.startsWith('https://challenges.cloudflare.com/'));

/** The cookie VALUE (exp.sig) from a Set-Cookie line. */
const cookieValue = (setCookie) => setCookie.split(';')[0].slice(COOKIE_NAME.length + 1);
const validCookie = async (ttl = 60, secret = ENV.SESSION_SECRET) =>
  `${COOKIE_NAME}=${cookieValue(await buildCookie(secret, ttl))}`;
const nowS = () => Math.floor(Date.now() / 1000);

describe('fails closed without its secrets', () => {
  for (const missing of ['SESSION_SECRET', 'TURNSTILE_SECRET']) {
    test(`missing ${missing} → 500 before any routing or upstream call`, async () => {
      const env = { ...ENV, [missing]: undefined };
      for (const path of ['/search?q=x', '/session', '/healthz']) {
        const r = await call(path, { env, headers: { cookie: await validCookie(), 'cf-turnstile-token': 't' } });
        assert.equal(r.status, 500, path);
        assert.deepEqual(r.json(), { error: 'misconfigured' });
        assert.equal(r.header('access-control-allow-origin'), SITE);
      }
      assert.equal(calls.length, 0, 'nothing may leave the gate while misconfigured');
    });
  }

  test('an empty-string secret counts as missing', async () => {
    const r = await call('/search?q=x', { env: { ...ENV, SESSION_SECRET: '' } });
    assert.equal(r.status, 500);
  });
});

describe('routing', () => {
  test('/healthz is open: 200 OK, no auth, no upstream call', async () => {
    const r = await call('/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'OK');
    assert.equal(calls.length, 0);
  });

  test('OPTIONS preflight: 204 with credentialed CORS for the site origin', async () => {
    const r = await call('/search', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.header('access-control-allow-origin'), SITE);
    assert.equal(r.header('access-control-allow-credentials'), 'true');
    assert.equal(r.header('access-control-allow-methods'), 'GET, OPTIONS');
    assert.match(r.header('access-control-allow-headers'), /cf-turnstile-token/);
  });

  test('non-GET → 405, unknown path → 404, both without an upstream call', async () => {
    assert.equal((await call('/search?q=x', { method: 'POST' })).status, 405);
    assert.equal((await call('/admin')).status, 404);
    assert.equal((await call('/')).status, 404);
    assert.equal(calls.length, 0);
  });
});

describe('session cookie', () => {
  test('no cookie and no token → 401 turnstile_required, nothing proxied', async () => {
    const r = await call('/search?q=hello&format=json');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json(), { error: 'turnstile_required' });
    assert.equal(calls.length, 0);
  });

  test('a valid cookie is proxied to ORIGIN_HOST with the gate header', async () => {
    const r = await call('/search?q=hello&format=json', { headers: { cookie: await validCookie() } });
    assert.equal(r.status, 200);
    const [c] = originCalls();
    assert.ok(c, 'origin was called');
    assert.equal(originCalls().length, 1);
    assert.equal(c.url, `${ORIGIN}/search?q=hello&format=json`);
    assert.equal(c.init.headers.get('x-amnesia-gate'), ENV.ORIGIN_SECRET);
    assert.equal(c.init.headers.get('user-agent'), 'amnesia-api-gate/1.0');
    assert.equal(c.init.headers.get('cookie'), null, 'the client cookie is not forwarded');
    assert.equal(verifyCalls().length, 0, 'a cookie skips Turnstile');
    assert.equal(r.header('cache-control'), 'no-store');
    assert.equal(r.header('set-cookie'), null, 'a cookie-authorized request is not re-issued one');
  });

  test('the cookie is found among other cookies', async () => {
    const r = await call('/search?q=x', { headers: { cookie: `a=b; ${await validCookie()}; c=d` } });
    assert.equal(r.status, 200);
  });

  test('a cookie signed with another key → 401', async () => {
    const r = await call('/search?q=x', { headers: { cookie: await validCookie(60, 'attacker-guess') } });
    assert.equal(r.status, 401);
    assert.equal(originCalls().length, 0);
  });

  test('an expired cookie with a correct signature → 401', async () => {
    const exp = String(nowS() - 5);
    const r = await call('/search?q=x', { headers: { cookie: `${COOKIE_NAME}=${exp}.${await hmac(ENV.SESSION_SECRET, exp)}` } });
    assert.equal(r.status, 401);
  });

  test('a spliced cookie (real signature, extended expiry) → 401', async () => {
    const exp = String(nowS() + 60);
    const sig = await hmac(ENV.SESSION_SECRET, exp);
    const extended = String(nowS() + 10 * 365 * 86400);
    const r = await call('/search?q=x', { headers: { cookie: `${COOKIE_NAME}=${extended}.${sig}` } });
    assert.equal(r.status, 401);
    assert.equal(await verifySession(`${exp}.${sig}`, ENV.SESSION_SECRET), true, 'the unspliced original is valid');
  });

  test('malformed cookie values → 401', async () => {
    for (const v of ['', 'garbage', '.', '123.', '.abc', 'NaN.abc', '0.00', `${nowS() + 60}.${'0'.repeat(64)}`]) {
      const r = await call('/search?q=x', { headers: { cookie: `${COOKIE_NAME}=${v}` } });
      assert.equal(r.status, 401, JSON.stringify(v));
    }
    assert.equal(originCalls().length, 0);
  });
});

describe('Turnstile token', () => {
  test('a good token is verified server-side, proxied, and issued a session cookie', async () => {
    const r = await call('/search?q=hi&cf_turnstile_token=tok-q', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    assert.equal(r.status, 200);
    const [v] = verifyCalls();
    const form = new URLSearchParams(String(v.init.body));
    assert.equal(form.get('secret'), ENV.TURNSTILE_SECRET);
    assert.equal(form.get('response'), 'tok-q');
    assert.equal(form.get('remoteip'), '203.0.113.7');
    assert.equal(originCalls()[0].url, `${ORIGIN}/search?q=hi`, 'the token query param is stripped before proxying');
    const sc = r.header('set-cookie');
    assert.match(sc, /; Max-Age=1800; Path=\/; HttpOnly; Secure; SameSite=None$/);
    assert.equal(await verifySession(cookieValue(sc), ENV.SESSION_SECRET), true);
  });

  test('the header form of the token works too', async () => {
    const r = await call('/search?q=hi', { headers: { 'cf-turnstile-token': 'tok-h' } });
    assert.equal(r.status, 200);
    assert.equal(new URLSearchParams(String(verifyCalls()[0].init.body)).get('response'), 'tok-h');
  });

  test('a token minted for another hostname → 403 turnstile_hostname_mismatch, nothing proxied', async () => {
    siteverify = { success: true, hostname: 'evil.example' };
    const r = await call('/search?q=hi', { headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, 'turnstile_hostname_mismatch');
    assert.equal(r.header('set-cookie'), null);
    assert.equal(originCalls().length, 0);
  });

  test('a rejected token → 403 turnstile_failed with the error codes', async () => {
    siteverify = { success: false, 'error-codes': ['invalid-input-response'] };
    const r = await call('/search?q=hi', { headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json(), { error: 'turnstile_failed', codes: ['invalid-input-response'] });
    assert.equal(originCalls().length, 0);
  });

  test('siteverify unreachable → 502, never an open door', async () => {
    siteverify = new Error('network down');
    const r = await call('/search?q=hi', { headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 502);
    assert.equal(r.json().error, 'verify_unreachable');
    assert.equal(originCalls().length, 0);
  });

  test('/session warms the cookie without proxying a search', async () => {
    const r = await call('/session', { headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, ttl: 1800 });
    assert.ok(r.header('set-cookie'));
    assert.equal(originCalls().length, 0);
    assert.equal((await call('/session')).status, 401, 'no token, no session');
  });

  test('SESSION_TTL sets the cookie lifetime', async () => {
    const r = await call('/session', { headers: { 'cf-turnstile-token': 't' }, env: { ...ENV, SESSION_TTL: '21600' } });
    assert.equal(r.json().ttl, 21600);
    assert.match(r.header('set-cookie'), /Max-Age=21600;/);
  });
});

describe('trusted-bridge bypass (BRIDGE_IPS)', () => {
  test('a listed client IP is authorized without cookie or token', async () => {
    const env = { ...ENV, BRIDGE_IPS: '198.51.100.1, 198.51.100.2' };
    const r = await call('/search?q=x', { env, headers: { 'cf-connecting-ip': '198.51.100.2' } });
    assert.equal(r.status, 200);
    assert.equal(verifyCalls().length, 0);
    assert.equal(r.header('set-cookie'), null);
  });

  test('an unlisted IP, or an empty list, gets no bypass', async () => {
    const env = { ...ENV, BRIDGE_IPS: '198.51.100.1' };
    assert.equal((await call('/search?q=x', { env, headers: { 'cf-connecting-ip': '198.51.100.9' } })).status, 401);
    const empty = { ...ENV, BRIDGE_IPS: '' };
    assert.equal((await call('/search?q=x', { env: empty, headers: { 'cf-connecting-ip': '' } })).status, 401);
  });
});

describe('CORS', () => {
  test('every answer names the configured origin, never *', async () => {
    const cookie = await validCookie();
    const answers = [
      await call('/healthz'),
      await call('/search', { method: 'OPTIONS' }),
      await call('/search', { method: 'POST' }),
      await call('/nope'),
      await call('/search?q=x'),
      await call('/search?q=x', { headers: { cookie } }),
      await call('/search?q=x', { env: { ...ENV, SESSION_SECRET: undefined } }),
    ];
    siteverify = { success: false };
    answers.push(await call('/search?q=x', { headers: { 'cf-turnstile-token': 't' } }));
    for (const a of answers) {
      assert.equal(a.header('access-control-allow-origin'), SITE, `status ${a.status}`);
      assert.equal(a.header('vary'), 'Origin', `status ${a.status}`);
    }
  });

  test('a foreign Origin header is not reflected', async () => {
    const r = await call('/search?q=x', { headers: { origin: 'https://evil.example', cookie: await validCookie() } });
    assert.equal(r.header('access-control-allow-origin'), SITE);
  });

  test('ALLOWED_ORIGIN is honored for a self-hosted gate', async () => {
    const r = await call('/healthz', { env: { ...ENV, ALLOWED_ORIGIN: 'https://search.example.org' } });
    assert.equal(r.header('access-control-allow-origin'), 'https://search.example.org');
  });
});

describe('edge cache', () => {
  test('the key is the normalized query and sorted params — no cookie, token or IP', async () => {
    const cookie = await validCookie();
    await call('/search?q=%20%20LiNuX%20&format=json&pageno=1', {
      headers: { cookie, 'cf-connecting-ip': '203.0.113.50', 'cf-turnstile-token': 'tok-secret' },
    });
    assert.equal(cache.size, 1);
    const [[key, entry]] = [...cache];
    assert.equal(key, `${ORIGIN}/search?format=json&pageno=1&q=linux`);
    for (const secret of [cookieValue(cookie), '203.0.113.50', 'tok-secret', COOKIE_NAME]) {
      assert.ok(!key.includes(secret), `key must not contain ${secret}`);
    }
    assert.equal(entry.key.headers.get('cookie'), null);
    assert.equal(entry.headers['cache-control'], 'public, max-age=180');
  });

  test('a case/whitespace/order variant is served from the edge without an origin trip', async () => {
    const cookie = await validCookie();
    const first = await call('/search?q=%20%20LiNuX%20&format=json&pageno=1', { headers: { cookie } });
    const second = await call('/search?pageno=1&q=linux&format=json', { headers: { cookie } });
    assert.equal(originCalls().length, 1);
    assert.equal(second.header('x-amnesia-cache'), 'hit');
    assert.equal(second.header('cache-control'), 'no-store', 'the client copy stays no-store');
    assert.equal(second.body, first.body);
  });

  test('the token query param never reaches the key', async () => {
    const r = await call('/search?q=x&cf_turnstile_token=tok-in-url');
    assert.equal(r.status, 200);
    assert.equal(cache.size, 1);
    for (const key of cache.keys()) assert.ok(!key.includes('tok-in-url'), key);
  });

  test('autocomplete is cached for 6h under its own key', async () => {
    await call('/autocompleter?q=Lin', { headers: { cookie: await validCookie() } });
    const [[key, entry]] = [...cache];
    assert.equal(key, `${ORIGIN}/autocompleter?q=lin`);
    assert.equal(entry.headers['cache-control'], 'public, max-age=21600');
  });

  test('only 200s are stored; other statuses pass through', async () => {
    origin = () => new Response('busy', { status: 429 });
    const r = await call('/search?q=x', { headers: { cookie: await validCookie() } });
    assert.equal(r.status, 429);
    assert.equal(cache.size, 0);
  });

  test('a cached answer is never served before auth', async () => {
    await call('/search?q=linux', { headers: { cookie: await validCookie() } });
    assert.equal(cache.size, 1);
    const r = await call('/search?q=linux');
    assert.equal(r.status, 401);
    assert.equal(r.header('x-amnesia-cache'), null);
  });

  test('origin unreachable → 502 origin_unreachable', async () => {
    origin = () => { throw new Error('tunnel down'); };
    const r = await call('/search?q=x', { headers: { cookie: await validCookie() } });
    assert.equal(r.status, 502);
    assert.equal(r.json().error, 'origin_unreachable');
  });
});

describe('origin secret', () => {
  test('without ORIGIN_SECRET the gate header is simply absent (the origin WAF rule is what refuses)', async () => {
    const env = { ...ENV, ORIGIN_SECRET: undefined };
    const r = await call('/search?q=x', { env, headers: { cookie: await validCookie() } });
    assert.equal(r.status, 200);
    assert.equal(originCalls()[0].init.headers.get('x-amnesia-gate'), null);
  });
});
