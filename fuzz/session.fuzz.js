// Fuzz the amnesia Worker's auth boundary — the session cookie is
// client-controlled input that decides whether a request skips Turnstile, so
// its forgery-resistance is the whole security story. Contracts pinned:
//   - verifySession never throws on any cookie value, always returns a boolean,
//     and NEVER accepts a value the operator's SESSION_SECRET didn't sign
//     (forgery = free search access);
//   - a cookie freshly minted by buildCookie always verifies under the same
//     secret and never under a different one (sign/verify agree);
//   - a renewed cookie keeps its solve time and never expires later than
//     start + maxAge, whatever start the fuzzer picks;
//   - timingSafeEqual never throws and only returns true for equal strings;
//   - readCookie never throws parsing a hostile Cookie header.
import { createHmac } from 'node:crypto';
import {
  buildCookie,
  verifySession,
  sessionTimes,
  timingSafeEqual,
  readCookie,
  COOKIE_NAME,
} from '../worker/src/index.js';

const SECRET = 'fuzz-session-secret';
const OTHER = 'a-different-secret';

// Independent oracle (node:crypto, not the Worker's WebCrypto path): is `s`
// exactly a cookie value SECRET signed, and not yet expired? Anything the
// Worker accepts beyond this is a forgery, however the check got loosened.
function genuinelySigned(s) {
  const m = /^(\d+\.(\d+))\.([0-9a-f]{64})$/.exec(s);
  if (!m) return false;
  if (Number(m[2]) < Math.floor(Date.now() / 1000)) return false;
  return createHmac('sha256', SECRET).update(m[1]).digest('hex') === m[3];
}

export async function fuzz(data) {
  const s = data.toString('utf8');

  // Arbitrary cookie value must never throw, never verify unless SECRET
  // really signed it, and never verify under another secret. (An attacker
  // submits arbitrary bytes as the cookie.)
  const v1 = await verifySession(s, SECRET);
  if (typeof v1 !== 'boolean') throw new Error('verifySession returned a non-boolean');
  if (v1 && !genuinelySigned(s)) throw new Error('verifySession accepted a value SECRET never signed');
  if (await verifySession(s, OTHER)) throw new Error('an arbitrary value verified under an unrelated secret');

  // A genuinely-signed, unexpired cookie MUST verify under its secret and MUST
  // NOT verify under a different one. ttl derived from the input, floored to a
  // positive value so the cookie isn't born expired.
  const ttl = (data.length % 3600) + 60;
  const cookieHeader = await buildCookie(SECRET, ttl);
  const value = cookieHeader.slice(COOKIE_NAME.length + 1, cookieHeader.indexOf(';'));
  if (!(await verifySession(value, SECRET))) {
    throw new Error('a freshly-signed cookie failed to verify under its own secret');
  }
  if (await verifySession(value, OTHER)) {
    throw new Error('a cookie verified under the WRONG secret — signing is forgeable');
  }

  // Splicing the fuzz bytes onto the real signature must not forge a pass.
  // (Unless the fuzz bytes ARE the real payload: then the result is the
  // genuine cookie, and accepting it is right.)
  const dot = value.lastIndexOf('.');
  if (dot > 0 && s !== value.slice(0, dot)) {
    const forged = s + value.slice(dot); // attacker-chosen expiry + real sig
    if (await verifySession(forged, SECRET)) {
      throw new Error('spliced-expiry cookie forged a valid session');
    }
  }

  // Renewal from an older solve: the cap holds and the solve time carries over.
  const now = Math.floor(Date.now() / 1000);
  const maxAge = (data.length % 86400) + 3600;
  const start = now - (data.length > 0 ? data[0] * 300 : 0);
  if (start + maxAge > now) {
    const renewed = await buildCookie(SECRET, ttl, start, maxAge);
    const rv = renewed.slice(COOKIE_NAME.length + 1, renewed.indexOf(';'));
    const t = sessionTimes(rv);
    if (t.start !== start) throw new Error('renewal lost the solve time');
    if (t.exp > start + maxAge) throw new Error('renewal extended a session past its cap');
    if (!(await verifySession(rv, SECRET))) throw new Error('a renewed cookie failed to verify');
  }

  if (typeof timingSafeEqual(s, value) !== 'boolean') {
    throw new Error('timingSafeEqual returned a non-boolean');
  }
  if (timingSafeEqual(s, s) !== true) {
    throw new Error('timingSafeEqual said a string is unequal to itself');
  }

  // readCookie over a hostile Cookie header must never throw.
  const req = { headers: { get: (h) => (h === 'cookie' ? s : null) } };
  const got = readCookie(req, COOKIE_NAME);
  if (got !== null && typeof got !== 'string') {
    throw new Error('readCookie returned neither string nor null');
  }
}
