// The API gate, driven through its real default export.
//
// Nothing here edits worker/src: the Worker runs as deployed, with the
// Workers-runtime globals it touches (fetch, caches.default, ctx.waitUntil)
// replaced by in-memory stubs. Every upstream call the gate makes is
// recorded, so each test can assert both the answer the client got and
// what did (or did not) leave the gate.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildCookie, hmac, verifySession, sessionTimes, COOKIE_NAME, imageTarget, imageSignature, proxifyImages, readCapped, IMG_MAX_BYTES } from '../worker/src/index.js';

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
    if (new URL(url).origin === 'https://challenges.cloudflare.com') {
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

const originOf = (url) => new URL(url).origin;
const originCalls = () => calls.filter((c) => originOf(c.url) === ORIGIN);
const verifyCalls = () => calls.filter((c) => originOf(c.url) === 'https://challenges.cloudflare.com');

/** The cookie VALUE (start.exp.sig) from a Set-Cookie line. */
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

  test('a garbled TTL or max age → 500, not a silently wrong lifetime', async () => {
    for (const bad of [{ SESSION_TTL: '6h' }, { SESSION_TTL: '0' }, { SESSION_TTL: 'abc' }, { SESSION_MAX_AGE: '24h' }, { SESSION_MAX_AGE: '-1' }]) {
      const r = await call('/session', { env: { ...ENV, ...bad }, headers: { 'cf-turnstile-token': 't' } });
      assert.equal(r.status, 500, JSON.stringify(bad));
      assert.deepEqual(r.json(), { error: 'misconfigured' });
    }
    assert.equal(calls.length, 0);
  });

  test('an ALLOWED_ORIGIN with no hostname to bind tokens to → 500', async () => {
    const r = await call('/search?q=x', { env: { ...ENV, ALLOWED_ORIGIN: 'amnesia.tax' }, headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 500);
    assert.equal(calls.length, 0);
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
    const r = await call('/search?q=hello&format=json', { headers: { cookie: await validCookie(1800) } });
    assert.equal(r.status, 200);
    const [c] = originCalls();
    assert.ok(c, 'origin was called');
    assert.equal(originCalls().length, 1);
    assert.equal(c.url, `${ORIGIN}/search?format=json&q=hello`, 'params go out in SEARCH_PARAMS order');
    assert.equal(c.init.headers.get('x-amnesia-gate'), ENV.ORIGIN_SECRET);
    assert.equal(c.init.headers.get('user-agent'), 'amnesia-api-gate/1.0');
    assert.equal(c.init.headers.get('cookie'), null, 'the client cookie is not forwarded');
    assert.equal(verifyCalls().length, 0, 'a cookie skips Turnstile');
    assert.equal(r.header('cache-control'), 'no-store');
    assert.equal(r.header('set-cookie'), null, 'a cookie with more than half its lifetime left is not re-issued');
  });

  test('a cookie with less than half its lifetime left is renewed for a full SESSION_TTL', async () => {
    for (const path of ['/search?q=x', '/autocompleter?q=x', '/session']) {
      const r = await call(path, { headers: { cookie: await validCookie(899) } });
      assert.equal(r.status, 200, path);
      const sc = r.header('set-cookie');
      assert.ok(sc, `${path} renews the cookie`);
      assert.match(sc, /Max-Age=1800;/);
      const { exp } = sessionTimes(cookieValue(sc));
      assert.ok(Math.abs(exp - (nowS() + 1800)) <= 2, 'the new expiry is a full SESSION_TTL out');
      assert.equal(await verifySession(cookieValue(sc), ENV.SESSION_SECRET), true);
    }
    assert.equal(verifyCalls().length, 0, 'renewal needs no Turnstile solve');
  });

  test('an edge-cache hit also renews an ageing cookie', async () => {
    await call('/search?q=cached', { headers: { cookie: await validCookie(1800) } });
    const r = await call('/search?q=cached', { headers: { cookie: await validCookie(60) } });
    assert.equal(r.status, 200);
    assert.ok(r.header('set-cookie'));
    assert.equal(originCalls().length, 1, 'served from the edge');
  });

  const agedCookie = async (age, left) => {
    const start = String(nowS() - age);
    const exp = String(nowS() + left);
    return `${COOKIE_NAME}=${start}.${exp}.${await hmac(ENV.SESSION_SECRET, `${start}.${exp}`)}`;
  };

  test('renewal keeps the solve time, so a session never outlives SESSION_MAX_AGE', async () => {
    const env = { ...ENV, SESSION_MAX_AGE: '86400' };
    // 23.9 h in: renewed, but only up to the 24 h mark.
    const r = await call('/search?q=x', { env, headers: { cookie: await agedCookie(86040, 60) } });
    const sc = r.header('set-cookie');
    assert.ok(sc);
    const { start, exp } = sessionTimes(cookieValue(sc));
    assert.ok(Math.abs(start - (nowS() - 86040)) <= 2, 'the solve time carries over');
    assert.ok(Math.abs(exp - (start + 86400)) <= 2, 'capped at start + SESSION_MAX_AGE');
    assert.match(sc, /Max-Age=3[0-9]{2};/);
    // At the cap: still valid, not renewed again.
    const capped = await call('/search?q=y', { env, headers: { cookie: `${COOKIE_NAME}=${cookieValue(sc)}` } });
    assert.equal(capped.status, 200);
    assert.equal(capped.header('set-cookie'), null);
  });

  test('the pre-1.1.0 format (exp.sig), even correctly signed, is no longer accepted', async () => {
    const exp = String(nowS() + 60);
    const legacy = `${COOKIE_NAME}=${exp}.${await hmac(ENV.SESSION_SECRET, exp)}`;
    const r = await call('/search?q=x', { headers: { cookie: legacy } });
    assert.equal(r.status, 401);
  });

  test('a legacy signature spliced onto a start time → 401', async () => {
    const exp = String(nowS() + 60);
    const sig = await hmac(ENV.SESSION_SECRET, exp);
    const r = await call('/search?q=x', { headers: { cookie: `${COOKIE_NAME}=${nowS()}.${exp}.${sig}` } });
    assert.equal(r.status, 401);
  });

  test('renewal follows SESSION_TTL, not a fixed half hour', async () => {
    const env = { ...ENV, SESSION_TTL: '21600' };
    const fresh = await call('/search?q=x', { env, headers: { cookie: await validCookie(10801) } });
    assert.equal(fresh.header('set-cookie'), null);
    const ageing = await call('/search?q=y', { env, headers: { cookie: await validCookie(10799) } });
    assert.match(ageing.header('set-cookie'), /Max-Age=21600;/);
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
    const payload = `${nowS() - 65}.${nowS() - 5}`;
    const r = await call('/search?q=x', { headers: { cookie: `${COOKIE_NAME}=${payload}.${await hmac(ENV.SESSION_SECRET, payload)}` } });
    assert.equal(r.status, 401);
  });

  test('a spliced cookie (real signature, extended expiry) → 401', async () => {
    const start = String(nowS());
    const payload = `${start}.${nowS() + 60}`;
    const sig = await hmac(ENV.SESSION_SECRET, payload);
    const extended = `${start}.${nowS() + 10 * 365 * 86400}`;
    const r = await call('/search?q=x', { headers: { cookie: `${COOKIE_NAME}=${extended}.${sig}` } });
    assert.equal(r.status, 401);
    assert.equal(await verifySession(`${payload}.${sig}`, ENV.SESSION_SECRET), true, 'the unspliced original is valid');
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

  test('a success that names no hostname → 403, the binding is not skipped', async () => {
    siteverify = { success: true };
    const r = await call('/search?q=hi', { headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 403);
    assert.equal(r.json().error, 'turnstile_hostname_mismatch');
    assert.equal(originCalls().length, 0);
  });

  test('siteverify answering non-JSON → 502', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      new URL(typeof input === 'string' ? input : input.url).origin === 'https://challenges.cloudflare.com'
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : real(input, init);
    const r = await call('/search?q=hi', { headers: { 'cf-turnstile-token': 't' } });
    assert.equal(r.status, 502);
    assert.equal(r.json().error, 'verify_unreachable');
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
    assert.equal(first.status, 200);
    assert.equal(originCalls().length, 1);
    assert.equal(second.header('cache-control'), 'no-store', 'the client copy stays no-store');
    assert.deepEqual(JSON.parse(second.body).results, JSON.parse(first.body).results);
  });

  test('a hit is not announced to clients (x-amnesia-cache goes to BRIDGE_IPS only)', async () => {
    const env = { ...ENV, BRIDGE_IPS: '198.51.100.1' };
    const cookie = await validCookie();
    await call('/search?q=probe', { env, headers: { cookie } });
    const visitor = await call('/search?q=probe', { env, headers: { cookie, 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(visitor.status, 200);
    assert.equal(visitor.header('x-amnesia-cache'), null);
    const bridge = await call('/search?q=probe', { env, headers: { 'cf-connecting-ip': '198.51.100.1' } });
    assert.equal(bridge.header('x-amnesia-cache'), 'hit');
    assert.equal(originCalls().length, 1);
  });

  test('the stored copy carries the normalized query, not the first asker\'s spelling', async () => {
    origin = () => Response.json({ query: '  Victim Name ', results: [{ url: 'https://example.com/' }] });
    const cookie = await validCookie();
    const first = await call('/search?q=%20%20Victim%20Name%20', { headers: { cookie } });
    assert.equal(first.json().query, '  Victim Name ', 'the asker gets the origin\'s answer as is');
    const second = await call('/search?q=victim%20name', { headers: { cookie } });
    assert.equal(second.json().query, 'victim name');
    assert.equal(originCalls().length, 1);
  });

  test('empty answers (an upstream blip) are not stored', async () => {
    const cookie = await validCookie();
    for (const [path, body] of [
      ['/search?q=a', { query: 'a', results: [], unresponsive_engines: [['bing', 'timeout']] }],
      ['/autocompleter?q=b', ['b', []]],
      ['/autocompleter?q=c', []],
    ]) {
      origin = () => Response.json(body);
      const r = await call(path, { headers: { cookie } });
      assert.equal(r.status, 200, path);
      assert.deepEqual(r.json(), body, `${path}: the client still gets the answer`);
    }
    origin = () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await call('/search?q=d', { headers: { cookie } });
    assert.equal(cache.size, 0);
  });

  test('the token query param never reaches the key', async () => {
    const r = await call('/search?q=x&cf_turnstile_token=tok-in-url');
    assert.equal(r.status, 200);
    assert.equal(cache.size, 1);
    for (const key of cache.keys()) assert.ok(!key.includes('tok-in-url'), key);
  });

  test('unknown or repeated params reach neither the key nor the origin', async () => {
    const cookie = await validCookie();
    const r = await call('/search?x=r4nd0m&pageno=2&q=linux&q=junk&format=json&format=html', { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal(originCalls().length, 1, 'a miss goes to the origin');
    assert.equal(originCalls()[0].url, `${ORIGIN}/search?format=json&pageno=2&q=linux`);
    assert.deepEqual([...cache.keys()], [`${ORIGIN}/search?format=json&pageno=2&q=linux`]);
    const clean = await call('/search?q=linux&format=json&pageno=2', { headers: { cookie } });
    assert.equal(clean.status, 200);
    assert.equal(originCalls().length, 1, 'the clean spelling is served from the same entry');
    assert.equal(cache.size, 1);
  });

  test('autocomplete is cached for 6h under its own key', async () => {
    origin = () => Response.json(['Lin', ['linux', 'linear algebra']]);
    await call('/autocompleter?q=Lin', { headers: { cookie: await validCookie() } });
    const [[key, entry]] = [...cache];
    assert.equal(key, `${ORIGIN}/autocompleter?q=lin`);
    assert.equal(entry.headers['cache-control'], 'public, max-age=21600');
    assert.deepEqual(JSON.parse(entry.body), ['lin', ['linux', 'linear algebra']]);
    const hit = await call('/autocompleter?q=lin', { headers: { cookie: await validCookie() } });
    assert.deepEqual(hit.json(), ['lin', ['linux', 'linear algebra']]);
    assert.equal(originCalls().length, 1);
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

  test('origin body that breaks after the headers → 502 origin_unreachable, nothing stored', async () => {
    origin = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"query":"x","res'));
            controller.error(new Error('tunnel dropped mid-body'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const r = await call('/search?q=x', { headers: { cookie: await validCookie() } });
    assert.equal(r.status, 502);
    assert.equal(r.json().error, 'origin_unreachable');
    assert.equal(r.header('access-control-allow-origin'), SITE);
    assert.equal(r.header('access-control-allow-credentials'), 'true');
    assert.equal(cache.size, 0);
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

describe('image proxy', () => {
  const HOST = 'https://live.staticflickr.com';
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const signedPath = async (target, secret = ENV.SESSION_SECRET) =>
    '/img?' + new URLSearchParams({ u: target, s: await imageSignature(secret, target) }).toString();
  const imageCalls = () => calls.filter((c) => originOf(c.url) === HOST);
  const serveImage = (type = 'image/png', body = PNG, extra = {}) => {
    origin = (url) =>
      originOf(url) === HOST
        ? new Response(body, { status: 200, headers: { 'content-type': type, ...extra } })
        : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const jsonOrigin = (data) => () =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

  describe('imageTarget', () => {
    test('listed hosts pass as https; everything else is refused', () => {
      assert.equal(imageTarget('https://i.pinimg.com/a.jpg'), 'https://i.pinimg.com/a.jpg');
      assert.equal(imageTarget('http://i.pinimg.com/a.jpg'), 'https://i.pinimg.com/a.jpg');
      assert.equal(imageTarget('//i.pinimg.com/a.jpg'), 'https://i.pinimg.com/a.jpg');
      assert.equal(imageTarget('https://I.PINIMG.COM/a.jpg'), 'https://i.pinimg.com/a.jpg');
      assert.equal(imageTarget('  https://i.pinimg.com/a b.jpg '), 'https://i.pinimg.com/a%20b.jpg');
      const refused = [
        'javascript:alert(1)', 'data:image/png;base64,AAAA', '/image_proxy?url=x', 'a.jpg', '', '   ',
        'https://user:pw@i.pinimg.com/a.jpg', 'https://i.pinimg.com:8443/a.jpg', 'https://amnesia.tax/x.png', 'https://search-origin.amnesia.tax/search',
        'https://API.AMNESIA.TAX./img', null, undefined, 42, {},
      ];
      for (const bad of refused) assert.equal(imageTarget(bad), null, String(bad));
    });

    test('loopback, private, link-local and every other unlisted host is refused', () => {
      const refused = [
        'http://127.0.0.1:8081/stats', 'http://127.1/x.png', 'http://2130706433/x.png', 'http://0x7f.0.0.1/x.png',
        'http://0.0.0.0/x.png', 'http://10.0.0.5/x.png', 'http://172.16.0.1/x.png', 'http://172.31.255.255/x.png',
        'http://192.168.1.1/x.png', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/x.png',
        'http://198.18.0.1/x.png', 'http://224.0.0.1/x.png', 'http://255.255.255.255/x.png',
        'http://[::1]/x.png', 'http://[fd00::1]/x.png', 'http://[fe80::1]/x.png', 'http://[::ffff:127.0.0.1]/x.png',
        'http://localhost/x.png', 'http://LOCALHOST./x.png', 'http://a.localhost/x.png', 'http://intranet/x.png',
        'http://printer.local/x.png', 'http://metadata.google.internal/x.png', 'http://nas.home.arpa/x.png',
      ];
      for (const bad of refused) assert.equal(imageTarget(bad), null, bad);
      // Unlisted public hosts too, and look-alikes of listed ones: a name an
      // attacker registers is a name whose DNS the attacker controls.
      for (const bad of [
        'http://93.184.216.34/x.png', 'https://images.example/x.png', 'https://rebind.example/x.png',
        'https://i.pinimg.com.evil.example/x.png', 'https://evil-i.pinimg.com/x.png', 'https://x.i.pinimg.com/a.jpg',
        'https://encrypted-tbn0.gstatic.com.evil.example/x', 'https://tse1.mm.bing.net.evil.example/x',
      ]) assert.equal(imageTarget(bad), null, bad);
      for (const ok of [
        'https://upload.wikimedia.org/a.jpg', 'https://encrypted-tbn0.gstatic.com/images?q=tbn:x', 'https://tse2.mm.bing.net/th?id=x',
        'https://ts1.explicit.bing.net/th?id=x', 'https://live.staticflickr.com/65535/a_m.jpg', 'https://external-content.duckduckgo.com/iu/?u=x',
        'https://farm5.staticflickr.com/1/a.jpg', 'https://api.openverse.org/v1/images/x/thumb/', 'https://imgs.search.brave.com/x',
        'https://images.unsplash.com/photo-1?w=400', 'https://images.pexels.com/photos/1/a.jpeg',
        'https://www.artic.edu/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/200,/0/default.jpg',
        'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/a.jpg',
      ]) assert.equal(imageTarget(ok), ok, ok);
      for (const bad of ['https://artic.edu.evil.example/x.jpg', 'https://images-wixmp-x.wixmp.com.evil.example/a.jpg', 'https://wixmp.com/a.jpg'])
        assert.equal(imageTarget(bad), null, bad);
    });
  });

  describe('rewriting /search answers', () => {
    test('every image field becomes a signed /img URL on the gate; refused values are blanked', async () => {
      const results = [
        { url: 'https://a.example/', thumbnail_src: 'https://i.pinimg.com/a.jpg', img_src: 'https://upload.wikimedia.org/a.jpg' },
        { url: 'https://b.example/', thumbnail: '//i.pinimg.com/b.jpg' },
        { url: 'https://c.example/', thumbnail_src: 'javascript:alert(1)', img_src: 'https://upload.wikimedia.org/c.jpg' },
        { url: 'https://d.example/', img_src: 'https://api.amnesia.tax/session' },
        { url: 'https://e.example/', title: 'no image' },
      ];
      origin = jsonOrigin({ query: 'cats', results });
      const r = await call('/search?q=cats&categories=images&format=json', { headers: { cookie: await validCookie() } });
      assert.equal(r.status, 200);
      const out = r.json().results;
      assert.equal(out[0].thumbnail_src, API + (await signedPath('https://i.pinimg.com/a.jpg')));
      assert.equal(out[0].img_src, API + (await signedPath('https://upload.wikimedia.org/a.jpg')));
      assert.equal(out[1].thumbnail, API + (await signedPath('https://i.pinimg.com/b.jpg')));
      assert.equal(out[2].thumbnail_src, '');
      assert.equal(out[2].img_src, API + (await signedPath('https://upload.wikimedia.org/c.jpg')));
      assert.equal(out[3].img_src, '');
      assert.deepEqual(out[4], results[4]);
      assert.equal(out[0].url, 'https://a.example/', 'links are left alone');
      for (const res of out) {
        for (const f of ['img_src', 'thumbnail_src', 'thumbnail']) {
          if (res[f]) assert.ok(res[f].startsWith(API + '/img?'), res[f]);
        }
      }
    });

    test('each enabled image engine keeps its thumbnails (the URL shapes they return)', async () => {
      const thumbs = [
        'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ',
        'https://tse3.mm.bing.net/th/id/OIP.x?pid=Api',
        'https://live.staticflickr.com/65535/1_2_n.jpg',
        'https://i.pinimg.com/236x/aa/bb/cc.jpg',
        'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/C.jpg/200px-C.jpg',
        'https://www.artic.edu/iiif/2/2d484387-2509-5e8e-2c43-22f9981972eb/full/400,/0/default.jpg',
      ];
      const out = JSON.parse(await proxifyImages(JSON.stringify({ results: thumbs.map((t) => ({ thumbnail_src: t })) }), API, 's'));
      out.results.forEach((r, i) => {
        assert.ok(r.thumbnail_src.startsWith(API + '/img?'), thumbs[i]);
        assert.equal(new URL(r.thumbnail_src).searchParams.get('u'), thumbs[i]);
      });
    });

    test('the edge copy carries the signed URLs, so a hit needs no rewrite', async () => {
      origin = jsonOrigin({ query: 'q', results: [{ url: 'https://a.example/', thumbnail: 'https://i.pinimg.com/a.jpg' }] });
      const cookie = await validCookie();
      const first = await call('/search?q=q&categories=images', { headers: { cookie } });
      const second = await call('/search?q=q&categories=images', { headers: { cookie } });
      assert.equal(originCalls().length, 1);
      assert.equal(second.json().results[0].thumbnail, first.json().results[0].thumbnail);
      assert.ok(second.json().results[0].thumbnail.startsWith(API + '/img?'));
    });

    test('a body with no image fields (or no JSON) passes through byte for byte', async () => {
      const text = '{"query":"q",  "results":[{"url":"https://a.example/"}]}';
      assert.equal(await proxifyImages(text, API, 's'), text);
      assert.equal(await proxifyImages('not json', API, 's'), 'not json');
      assert.equal(await proxifyImages('{"results":"x"}', API, 's'), '{"results":"x"}');
    });

    test('autocomplete answers are not touched', async () => {
      origin = jsonOrigin(['q', ['https://i.pinimg.com/a.jpg']]);
      const r = await call('/autocompleter?q=q', { headers: { cookie: await validCookie() } });
      assert.deepEqual(r.json(), ['q', ['https://i.pinimg.com/a.jpg']]);
    });
  });

  describe('/img', () => {
    test('a signed URL with a session: fetched once, served with locked-down headers, then from the edge', async () => {
      serveImage();
      const path = await signedPath(HOST + '/a.png');
      const cookie = await validCookie();
      const r = await call(path, { headers: { cookie, 'cf-connecting-ip': '203.0.113.5', referer: SITE + '/?q=secret' } });
      assert.equal(r.status, 200);
      assert.equal(r.header('content-type'), 'image/png');
      assert.equal(r.header('x-content-type-options'), 'nosniff');
      assert.equal(r.header('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(r.header('cross-origin-resource-policy'), 'same-site');
      assert.equal(r.header('set-cookie'), null);
      const [up, ...rest] = imageCalls();
      assert.equal(rest.length, 0);
      assert.equal(up.url, HOST + '/a.png');
      const sent = Object.fromEntries(Object.entries(up.init.headers).map(([k, v]) => [k.toLowerCase(), v]));
      assert.deepEqual(Object.keys(sent).sort(), ['accept', 'user-agent'], 'no cookie, client IP or referrer goes upstream');
      assert.match(sent['user-agent'], /amnesia-image-proxy/);

      const again = await call(path, { headers: { cookie } });
      assert.equal(again.status, 200);
      assert.equal(again.header('content-type'), 'image/png');
      assert.equal(again.header('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(imageCalls().length, 1, 'the second load is an edge hit');
    });

    test('the bytes served are the bytes fetched', async () => {
      serveImage();
      const ctx = { waitUntil: (p) => pending.push(p) };
      const req = new Request(API + (await signedPath(HOST + '/a.png')), { headers: { cookie: await validCookie() } });
      const res = await worker.fetch(req, ENV, ctx);
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
      await Promise.all(pending.splice(0));
    });

    test('no session and no bridge → 401, nothing fetched', async () => {
      serveImage();
      const r = await call(await signedPath(HOST + '/a.png'), { headers: { 'cf-turnstile-token': 'tok' } });
      assert.equal(r.status, 401);
      assert.equal(r.json().error, 'session_required');
      assert.equal(calls.length, 0, 'not even siteverify: an image never spends a Turnstile token');
    });

    test('a cookie signed with another secret, or a malformed one → 401', async () => {
      serveImage();
      const path = await signedPath(HOST + '/a.png');
      assert.equal((await call(path, { headers: { cookie: await validCookie(60, 'another-secret') } })).status, 401);
      assert.equal((await call(path, { headers: { cookie: `${COOKIE_NAME}=1.2.deadbeef` } })).status, 401);
      assert.equal(imageCalls().length, 0);
    });

    test('a bridge IP needs no cookie', async () => {
      serveImage();
      const env = { ...ENV, BRIDGE_IPS: '198.51.100.1' };
      const r = await call(await signedPath(HOST + '/a.png'), { env, headers: { 'cf-connecting-ip': '198.51.100.1' } });
      assert.equal(r.status, 200);
    });

    test('anything the gate did not sign → 404, with or without a session', async () => {
      serveImage();
      const cookie = await validCookie();
      const good = await imageSignature(ENV.SESSION_SECRET, HOST + '/a.png');
      const flipped = (good[0] === '0' ? '1' : '0') + good.slice(1);
      const selfSigned = async (u) => '/img?u=' + encodeURIComponent(u) + '&s=' + (await imageSignature(ENV.SESSION_SECRET, u));
      const paths = [
        '/img',
        '/img?u=' + encodeURIComponent(HOST + '/a.png'),
        '/img?u=' + encodeURIComponent(HOST + '/b.png') + '&s=' + good,
        '/img?u=' + encodeURIComponent(HOST + '/a.png') + '&s=' + flipped,
        await signedPath(HOST + '/a.png', 'another-secret'),
        await selfSigned('//live.staticflickr.com/a.png'),
        await selfSigned('https://search-origin.amnesia.tax/search?q=x'),
      ];
      for (const p of paths) {
        assert.equal((await call(p, { headers: { cookie } })).status, 404, p);
        // Same answer without a session: a probe can't tell a bad signature from a missing cookie.
        assert.equal((await call(p)).status, 404, p);
      }
      assert.equal(calls.length, 0);
    });

    test('an image signature is not a session cookie signature', async () => {
      const sig = await imageSignature(ENV.SESSION_SECRET, HOST + '/a.png');
      assert.notEqual(sig, await hmac(ENV.SESSION_SECRET, HOST + '/a.png'));
      assert.equal(await verifySession(`1.${nowS() + 60}.${sig}`, ENV.SESSION_SECRET), false);
    });

    test('SVG, HTML, a missing type or an upstream error → 502, nothing cached', async () => {
      const cookie = await validCookie();
      for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', '']) {
        serveImage(type);
        const r = await call(await signedPath(HOST + '/x-' + type.replace(/\W/g, '')), { headers: { cookie } });
        assert.equal(r.status, 502, type);
        assert.equal(r.json().error, 'not_an_image');
      }
      origin = () => new Response('nope', { status: 404, headers: { 'content-type': 'image/png' } });
      assert.equal((await call(await signedPath(HOST + '/gone.png'), { headers: { cookie } })).status, 502);
      origin = () => { throw new TypeError('network'); };
      const down = await call(await signedPath(HOST + '/down.png'), { headers: { cookie } });
      assert.equal(down.status, 502);
      assert.equal(down.json().error, 'image_unreachable');
      assert.equal(cache.size, 0);
    });

    test('an image type with parameters still counts; the served type is the bare one', async () => {
      serveImage('image/JPEG; charset=binary');
      const r = await call(await signedPath(HOST + '/a.jpg'), { headers: { cookie: await validCookie() } });
      assert.equal(r.status, 200);
      assert.equal(r.header('content-type'), 'image/jpeg');
    });

    test('over IMG_MAX_BYTES → 502 image_too_large, by declared length or by what actually arrives', async () => {
      const cookie = await validCookie();
      serveImage('image/png', PNG, { 'content-length': String(IMG_MAX_BYTES + 1) });
      const declared = await call(await signedPath(HOST + '/big.png'), { headers: { cookie } });
      assert.equal(declared.status, 502);
      assert.equal(declared.json().error, 'image_too_large');

      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const stream = new ReadableStream({
        pull(c) {
          if (sent > IMG_MAX_BYTES) return c.close();
          sent += chunk.byteLength;
          c.enqueue(chunk);
        },
      });
      serveImage('image/png', stream);
      const streamed = await call(await signedPath(HOST + '/stream.png'), { headers: { cookie } });
      assert.equal(streamed.status, 502);
      assert.equal(streamed.json().error, 'image_too_large');
      assert.equal(cache.size, 0);
    });

    test('a private thumbnail in a /search answer is blanked, never signed', async () => {
      origin = jsonOrigin({ query: 'q', results: [{ url: 'https://a.example/', thumbnail_src: 'http://169.254.169.254/latest/meta-data/' }] });
      const r = await call('/search?q=q&categories=images', { headers: { cookie: await validCookie() } });
      assert.equal(r.json().results[0].thumbnail_src, '');
    });

    test('redirects are followed by hand, and each hop must pass imageTarget', async () => {
      const cookie = await validCookie();
      const redirectTo = (location) => {
        origin = (url) =>
          url === HOST + '/r.png'
            ? new Response(null, { status: 302, headers: { location } })
            : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      };
      for (const location of [
        'http://127.0.0.1/x.png', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x.png',
        'http://localhost/x.png', 'https://search-origin.amnesia.tax/search?q=x', 'javascript:alert(1)', '',
      ]) {
        calls = [];
        redirectTo(location);
        const r = await call(await signedPath(HOST + '/r.png'), { headers: { cookie } });
        assert.equal(r.status, 502, location);
        assert.equal(r.json().error, 'image_refused');
        assert.deepEqual(calls.map((c) => c.url), [HOST + '/r.png'], 'the refused hop is never fetched');
        assert.equal(calls[0].init.redirect, 'manual');
      }
      assert.equal(cache.size, 0);

      calls = [];
      redirectTo('/a.png');
      const ok = await call(await signedPath(HOST + '/r.png'), { headers: { cookie } });
      assert.equal(ok.status, 200);
      assert.deepEqual(calls.map((c) => c.url), [HOST + '/r.png', HOST + '/a.png']);
      assert.equal(calls[1].init.redirect, 'manual');

      calls = [];
      origin = (url) => new Response(null, { status: 302, headers: { location: url + 'x' } });
      const loop = await call(await signedPath(HOST + '/loop.png'), { headers: { cookie } });
      assert.equal(loop.status, 502);
      assert.equal(loop.json().error, 'image_refused');
      assert.equal(calls.length, 6, 'the first fetch plus five redirects, then it stops');
    });

    test('a redirect to an unlisted host is refused at that hop, whatever it resolves to', async () => {
      const cookie = await validCookie();
      origin = (url) =>
        url === HOST + '/r.png'
          ? new Response(null, { status: 302, headers: { location: 'https://rebind.example/x.png' } })
          : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      const r = await call(await signedPath(HOST + '/r.png'), { headers: { cookie } });
      assert.equal(r.status, 502);
      assert.equal(r.json().error, 'image_refused');
      assert.deepEqual(calls.map((c) => c.url), [HOST + '/r.png']);

      calls = [];
      origin = (url) =>
        url === HOST + '/r2.png'
          ? new Response(null, { status: 302, headers: { location: 'https://upload.wikimedia.org/x.png' } })
          : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      const ok = await call(await signedPath(HOST + '/r2.png'), { headers: { cookie } });
      assert.equal(ok.status, 200, 'a redirect to another listed CDN is followed');
      assert.deepEqual(calls.map((c) => c.url), [HOST + '/r2.png', 'https://upload.wikimedia.org/x.png']);
    });

    test('readCapped stops at the cap and joins what came before it', async () => {
      const mk = (...parts) => new Response(new Blob(parts.map((p) => new Uint8Array(p)))).body;
      assert.deepEqual(await readCapped(mk([1, 2], [3]), 3), new Uint8Array([1, 2, 3]));
      assert.equal(await readCapped(mk([1, 2], [3, 4]), 3), null);
      assert.deepEqual(await readCapped(null, 3), new Uint8Array(0));
    });
  });
});
