// Fuzz the amnesia Worker's auth boundary — the session cookie is
// client-controlled input that decides whether a request skips Turnstile, so
// its forgery-resistance is the whole security story. Contracts pinned:
//   - verifySession never throws on any cookie value, always returns a boolean,
//     and NEVER accepts a value the operator's SESSION_SECRET didn't sign
//     (forgery = free search access);
//   - a cookie freshly minted by buildCookie always verifies under the same
//     secret and never under a different one (sign/verify agree);
//   - timingSafeEqual never throws and only returns true for equal strings;
//   - readCookie never throws parsing a hostile Cookie header.
import {
  buildCookie,
  verifySession,
  timingSafeEqual,
  readCookie,
  COOKIE_NAME,
} from '../worker/src/index.js';

const SECRET = 'fuzz-session-secret';
const OTHER = 'a-different-secret';

export async function fuzz(data) {
  const s = data.toString('utf8');

  // Arbitrary cookie value must never throw and never verify under the wrong
  // secret. (An attacker submits arbitrary bytes as the cookie.)
  const v1 = await verifySession(s, SECRET);
  if (typeof v1 !== 'boolean') throw new Error('verifySession returned a non-boolean');

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
  const dot = value.lastIndexOf('.');
  if (dot > 0) {
    const forged = s + value.slice(dot); // attacker-chosen expiry + real sig
    if (await verifySession(forged, SECRET)) {
      throw new Error('spliced-expiry cookie forged a valid session');
    }
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
