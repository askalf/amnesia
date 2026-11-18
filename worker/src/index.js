/**
 * amnesia API gate — Cloudflare Worker in front of api.amnesia.tax
 *
 * Keeps the zone's bot/challenge protection ON while letting the static SPA's
 * cross-origin fetch() reach the SearXNG JSON API. A browser can't solve a CF
 * interstitial inside fetch(), so the SPA solves a Turnstile widget; this Worker
 * verifies the token server-side, then issues a short-lived signed SESSION
 * COOKIE so subsequent searches + pagination skip Turnstile (which otherwise
 * adds ~9s per request). Requests are authorized by EITHER a valid cookie OR a
 * fresh Turnstile token.
 *
 * Endpoints:
 *   GET /healthz       — liveness, no auth.
 *   GET /session       — pre-warm: verify a Turnstile token, set the cookie,
 *                        return {ok:true}. Lets the SPA warm the session on load.
 *   GET /search        — proxied to SearXNG; cookie OR token required.
 *   GET /autocompleter — same. Both carry an edge cache (below).
 *   GET /img           — image proxy for result thumbnails (below). Cookie (or
 *                        bridge IP) required, and the URL must carry the
 *                        gate's own signature.
 *
 * Image proxy: SearXNG's JSON carries each thumbnail's own URL (gstatic,
 * Flickr, Pinterest, Wikimedia, ...), so a page loading them directly shows
 * every one of those hosts the visitor's IP. Before a /search answer leaves
 * the gate, each img_src / thumbnail_src / thumbnail is rewritten to
 * /img?u=<url>&s=<HMAC(SESSION_SECRET, "img:" + url)>, and /img fetches only
 * a URL it signed itself. The signature is what keeps /img from being an open
 * proxy: it serves the images real searches returned, nothing a caller makes
 * up. The host sees a Cloudflare address and the CF-Worker header naming this
 * zone, never the visitor. Anything that isn't an http(s) URL, that points
 * back into amnesia.tax, or that names a loopback, private or otherwise
 * non-public host, is blanked rather than passed through, so the page
 * never loads a thumbnail straight from its host. Before each fetch, and
 * each redirect hop, the host is resolved over DoH and refused unless every
 * address is public. Only raster types are
 * served (no SVG), under IMG_MAX_BYTES, with a sandbox CSP and nosniff;
 * accepted images sit in the colo's edge cache for IMG_CACHE_TTL, keyed on
 * the signed URL alone. Like the search cache, that is shared per colo.
 *
 * Edge caches: the upstream ride (tunnel -> SearXNG -> engines via the VPN
 * proxy) costs ~1.5s for autocomplete and ~1-4s for a search. Both are
 * repetitive, so 200s are cached in the colo's Cache API — autocomplete for
 * AC_CACHE_TTL (prefix queries age well), search results for SEARCH_CACHE_TTL
 * (short: results should stay fresh, but a repeated/popular query inside the
 * window is served at edge speed). Keys are the normalized (trim+lowercase)
 * query plus the other SEARCH_PARAMS (category, page, format, ...) in a fixed
 * order, so the key carries the QUERY only: never a cookie, token, or IP.
 * Any other parameter is dropped from both the key and the origin URL. Lookup
 * happens AFTER auth — the cache saves the origin trip, not the gate.
 * Clients still get no-store; the edge copy is ours alone. Only answers with
 * something in them are stored (an origin 200 with no results or no
 * suggestions is usually an upstream blip, not an answer worth 6 hours), and
 * the stored copy carries the normalized query, not the first asker's spelling.
 *
 * What the cache does expose: it is shared by everyone in a colo, so a hit is
 * faster than a miss, and a session holder who times a query learns whether
 * someone there asked it inside the TTL. docs/privacy-model.md says so. The
 * x-amnesia-cache header, which would say it outright, goes to BRIDGE_IPS only.
 *
 * Auth precedence: valid session cookie → allow (no Turnstile). Else a valid
 * `cf-turnstile-token` → allow AND (re)issue the cookie. Else 401.
 *
 * Renewal: a valid cookie with less than half of SESSION_TTL left is re-issued
 * on the same response, so a visitor who keeps searching doesn't meet the
 * Turnstile solve when the cookie would have run out. The cookie carries the
 * time of the solve that started it, and renewal never extends it past
 * SESSION_MAX_AGE from then: one solve buys at most that long.
 *
 * Cross-site cookie: page origin is amnesia.tax, cookie host is api.amnesia.tax,
 * so the cookie is SameSite=None; Secure and the SPA fetches with
 * credentials:'include'. CORS therefore echoes the specific origin (never '*')
 * and sets Access-Control-Allow-Credentials: true.
 *
 * Bindings:
 *   TURNSTILE_SECRET (secret) — Turnstile secret key for siteverify
 *   SESSION_SECRET   (secret) — HMAC key signing the session cookie
 *   ORIGIN_SECRET    (secret) — shared header proving requests come from this Worker
 *   ORIGIN_HOST      (var)    — base URL of the SearXNG origin behind the tunnel
 *   ALLOWED_ORIGIN   (var)    — SPA origin allowed for CORS (https://amnesia.tax)
 *   SESSION_TTL      (var)    — cookie lifetime in seconds (default 1800)
 *   SESSION_MAX_AGE  (var)    — cap on a renewed session, from its solve (default 86400)
 *   BRIDGE_IPS       (var):     comma-separated IPs let through without a session (default none)
 *
 * Any of these that is set but unusable (a non-numeric TTL, an ALLOWED_ORIGIN
 * that isn't a URL) is a 500 "misconfigured", same as a missing secret.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const COOKIE_NAME = "amns";
const AC_CACHE_TTL = 21600; // 6h — autocomplete suggestions age well
const SEARCH_CACHE_TTL = 180; // 3m — repeat searches at edge speed, results stay fresh
// The only query parameters passed to the origin or used in the cache key.
// A parameter SearXNG ignores would still make a new key, so forwarding
// arbitrary ones lets any session holder append `&x=<random>` and miss the
// edge cache on every request. The SPA sends q, format, categories and
// pageno; the rest are SearXNG search options a direct API caller may set.
// Kept sorted: the cache key is built in this order.
const SEARCH_PARAMS = ["categories", "format", "language", "pageno", "q", "safesearch", "time_range"];
// Image proxy (see header).
export const IMG_FIELDS = ["img_src", "thumbnail_src", "thumbnail"];
export const IMG_MAX_BYTES = 8 * 1024 * 1024; // thumbnails are KBs; an original fallback can be MBs
const IMG_CACHE_TTL = 86400; // 1d: an image at a given URL rarely changes
const IMG_TIMEOUT_MS = 8000;
const IMG_MAX_REDIRECTS = 5;
const IMG_UA = "Mozilla/5.0 (compatible; amnesia-image-proxy/1.0; +https://amnesia.tax)";
// Raster only: an SVG is a document that can carry script.
const IMG_TYPES = /^image\/(avif|webp|png|apng|jpeg|jpg|pjpeg|gif|bmp|x-icon|vnd\.microsoft\.icon)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://amnesia.tax";
    const ttl = seconds(env.SESSION_TTL, 1800);
    const maxAge = seconds(env.SESSION_MAX_AGE, 86400);
    // The hostname a Turnstile token must have been solved on.
    let expectedHost = "";
    try { expectedHost = new URL(allowedOrigin).hostname; } catch (e) {}

    // Fail closed if signing/verification secrets are missing. Without
    // SESSION_SECRET, hmac() would sign cookies with an empty key — forgeable by
    // anyone who can read this (public) source. Never silently degrade auth.
    // A garbled TTL ("6h" read as 6 s) or an origin with no hostname to bind
    // tokens to is the same mistake: refuse rather than half-work.
    if (!env.SESSION_SECRET || !env.TURNSTILE_SECRET || !ttl || !maxAge || !expectedHost) {
      return json({ error: "misconfigured" }, 500, {
        "access-control-allow-origin": allowedOrigin,
        vary: "Origin",
      });
    }

    const cors = (extra = {}) => ({
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "cf-turnstile-token, content-type",
      "access-control-allow-credentials": "true",
      "access-control-max-age": "86400",
      vary: "Origin",
      ...extra,
    });

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    // Liveness — no auth.
    if (url.pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: cors({ "content-type": "text/plain" }) });
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, cors());
    }

    const isSession = url.pathname === "/session";
    const isSearch = url.pathname === "/search" || url.pathname === "/autocompleter";
    const isImage = url.pathname === "/img";
    if (!isSession && !isSearch && !isImage) {
      return json({ error: "not_found" }, 404, cors());
    }

    // --- Authorize: trusted-bridge bypass, else session cookie, else token --
    let authorized = false;
    let issueCookie = false;
    let sessionStart; // a renewal keeps the solve time it started from

    // Trusted bridge bypass. The headless front-end-verification bridge runs on
    // the operator's server and can't solve Turnstile from that datacenter IP. Allow
    // requests from the server's egress IP(s) to reach /search without a token so
    // internal front-end verification works. BRIDGE_IPS is a public var (an IP is
    // not a secret), scoped to the operator's own infra; empty = bypass disabled.
    const clientIp = request.headers.get("cf-connecting-ip");
    const bridgeIps = (env.BRIDGE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const isBridge = Boolean(clientIp && bridgeIps.includes(clientIp));
    if (isBridge) {
      authorized = true;
    }

    const cookie = readCookie(request, COOKIE_NAME);

    // Images ride the session a search already set up: no Turnstile here (an
    // <img> can't send the header) and no renewal (searches renew it).
    if (isImage) {
      const ok = authorized || Boolean(cookie && (await verifySession(cookie, env.SESSION_SECRET)));
      return proxyImage(url, env, ctx, ok, cors);
    }

    if (!authorized && cookie && (await verifySession(cookie, env.SESSION_SECRET))) {
      authorized = true; // valid, unexpired session — skip Turnstile
      const { start, exp } = sessionTimes(cookie);
      if (needsRenewal(start, exp, ttl, maxAge)) {
        issueCookie = true;
        sessionStart = start;
      }
    } else if (!authorized) {
      const token =
        request.headers.get("cf-turnstile-token") ||
        url.searchParams.get("cf_turnstile_token");
      if (!token) {
        return json({ error: "turnstile_required" }, 401, cors());
      }
      const outcome = await siteverify(token, env.TURNSTILE_SECRET, request.headers.get("cf-connecting-ip"));
      if (outcome === "unreachable") {
        return json({ error: "verify_unreachable" }, 502, cors());
      }
      if (!outcome.success) {
        return json({ error: "turnstile_failed", codes: outcome["error-codes"] || [] }, 403, cors());
      }
      // Bind the token to our own site: reject tokens minted for any other
      // hostname (a stolen sitekey solved on an attacker's page won't match),
      // and a success that doesn't say where it was solved.
      if (outcome.hostname !== expectedHost) {
        return json({ error: "turnstile_hostname_mismatch" }, 403, cors());
      }
      authorized = true;
      issueCookie = true;
    }

    if (!authorized) {
      return json({ error: "turnstile_required" }, 401, cors());
    }

    const setCookie = issueCookie
      ? { "set-cookie": await buildCookie(env.SESSION_SECRET, ttl, sessionStart, maxAge) }
      : {};

    // Pre-warm endpoint: just establish the session, no search.
    if (isSession) {
      return json({ ok: true, ttl }, 200, cors(setCookie));
    }

    // --- Proxy to the SearXNG origin --------------------------------------
    const originBase = env.ORIGIN_HOST || "https://search-origin.amnesia.tax";
    // cf_turnstile_token is not in SEARCH_PARAMS, so it never reaches the origin.
    const params = searchParams(url.searchParams);
    const originUrl =
      originBase.replace(/\/$/, "") + url.pathname + "?" + params.toString();

    // Edge cache (see header). Keyed on the normalized query + SEARCH_PARAMS
    // so "Linux " and "linux" (and reordered or padded param spellings) share
    // an entry. The key never contains a cookie, token, or client IP.
    const isAc = url.pathname === "/autocompleter";
    const cacheTtl = isAc ? AC_CACHE_TTL : SEARCH_CACHE_TTL;
    let edgeCacheKey = null;
    const normalizedQ = (params.get("q") || "").trim().toLowerCase();
    if (isAc || url.pathname === "/search") {
      const keyParams = new URLSearchParams(params);
      keyParams.set("q", normalizedQ);
      edgeCacheKey = new Request(
        originBase.replace(/\/$/, "") + url.pathname + "?" + keyParams.toString()
      );
      const hit = await caches.default.match(edgeCacheKey);
      if (hit) {
        return new Response(hit.body, {
          status: 200,
          headers: cors({
            "content-type": hit.headers.get("content-type") || "application/json",
            "cache-control": "no-store",
            ...(isBridge ? { "x-amnesia-cache": "hit" } : {}),
            ...setCookie,
          }),
        });
      }
    }

    const originHeaders = new Headers();
    originHeaders.set("accept", request.headers.get("accept") || "application/json");
    originHeaders.set("user-agent", "amnesia-api-gate/1.0");
    if (env.ORIGIN_SECRET) originHeaders.set("x-amnesia-gate", env.ORIGIN_SECRET);

    let originResp;
    try {
      originResp = await fetch(originUrl, { method: "GET", headers: originHeaders });
    } catch (e) {
      return json({ error: "origin_unreachable" }, 502, cors());
    }

    const respHeaders = cors({
      "content-type": originResp.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      ...setCookie,
    });

    // Store good answers at the edge; the client copy stays no-store. The
    // stored copy's cache-control is what governs edge retention (per-path TTL).
    if (edgeCacheKey && originResp.status === 200) {
      // fetch() resolves once the headers arrive, so a body that breaks after
      // them fails here, past the catch above.
      let text;
      try {
        text = await originResp.text();
      } catch (e) {
        return json({ error: "origin_unreachable" }, 502, cors());
      }
      // Before the edge copy, so a cache hit carries the signed URLs too.
      if (!isAc) text = await proxifyImages(text, url.origin, env.SESSION_SECRET);
      const stored = cacheable(text, isAc, normalizedQ);
      if (stored !== null) {
        ctx.waitUntil(
          caches.default.put(
            edgeCacheKey,
            new Response(stored, {
              status: 200,
              headers: {
                "content-type": originResp.headers.get("content-type") || "application/json",
                "cache-control": "public, max-age=" + cacheTtl,
              },
            })
          )
        );
      }
      return new Response(text, { status: 200, headers: respHeaders });
    }

    return new Response(originResp.body, { status: originResp.status, headers: respHeaders });
  },
};

// A positive whole number of seconds from a var, the fallback when unset, or
// 0 (→ misconfigured) for anything else: parseInt("6h") is 6, not 21600.
function seconds(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^\d+$/.test(String(value).trim()) ? parseInt(value, 10) : 0;
}

// The SEARCH_PARAMS present in `from`, in SEARCH_PARAMS order, first value
// of each. A repeated name counts once so `q=a&q=<random>` can't vary the key.
export function searchParams(from) {
  const out = new URLSearchParams();
  for (const name of SEARCH_PARAMS) {
    const value = from.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

// The body to keep at the edge for an origin 200, or null to keep nothing.
// Empty answers aren't kept: SearXNG answers 200 with [] when its
// autocomplete backend fails and with no results when every engine timed
// out, and either would otherwise be served to everyone for the whole TTL.
// The kept copy echoes the normalized query, so a hit never hands one user
// another's exact spelling of it.
export function cacheable(text, isAc, normalizedQ) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  if (isAc) {
    // OpenSearch form [query, [suggestions]], or a bare list.
    if (!Array.isArray(data)) return null;
    if (Array.isArray(data[1])) {
      if (!data[1].length) return null;
      data[0] = normalizedQ;
    } else if (!data.length) {
      return null;
    }
  } else {
    if (!data || !Array.isArray(data.results) || !data.results.length) return null;
    if ("query" in data) data.query = normalizedQ;
  }
  return JSON.stringify(data);
}

// ---- Image proxy ----------------------------------------------------------

// The absolute http(s) URL the proxy may fetch for a result's image value, or
// null. Protocol-relative values ("//host/x.jpg") count as https; relative
// paths, other schemes, credentials in the URL, anything on amnesia.tax
// itself, and any host isPublicHost refuses do not.
export function imageTarget(value) {
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (isOwnHost(u.hostname) || !isPublicHost(u.hostname)) return null;
  return u.href;
}

// False for a host the proxy must never be pointed at: every IPv6 literal,
// IPv4 literals outside public unicast space (URL parsing has already turned
// forms like 0x7f.1 or 2130706433 into dotted IPv4), single-label names, and
// the suffixes that only resolve inside a network. A Worker has no resolver to
// check where a public name points, so names are judged by their spelling and
// every redirect hop is judged again in proxyImage.
function isPublicHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[")) return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return isPublicIPv4(v4.slice(1).map(Number));
  if (!h.includes(".")) return false;
  return !/(^|\.)(localhost|localdomain|local|internal|intranet|lan|home\.arpa)$/.test(h);
}

function isPublicIPv4([a, b, c]) {
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

// imageTarget judges a host by its spelling; this judges where it points. A
// Worker's fetch resolves names itself and never says where they landed, so
// before each hop proxyImage resolves the name over DNS-over-HTTPS and refuses
// it unless every A and AAAA answer is public unicast. The fetch resolves the
// name again, so an answer that changes in between isn't caught here; the
// check stops a name that plainly points inward, which is the case that
// matters.
const DOH = "https://cloudflare-dns.com/dns-query";

export async function resolvesPublic(hostname, signal) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPublicHost(h);
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const r = await fetch(`${DOH}?name=${encodeURIComponent(h)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal,
    });
    if (!r.ok) throw new Error(`dns ${r.status}`);
    const data = await r.json();
    // 0 = an answer, 3 = no such name (no addresses, refused below).
    if (data.Status !== 0 && data.Status !== 3) throw new Error(`dns status ${data.Status}`);
    return Array.isArray(data.Answer) ? data.Answer : [];
  }));
  let addresses = 0;
  for (const a of answers.flat()) {
    if (a.type === 1) {
      addresses++;
      const p = String(a.data).split(".").map(Number);
      if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
      if (!isPublicIPv4(p)) return false;
    } else if (a.type === 28) {
      addresses++;
      if (!isPublicIPv6(String(a.data))) return false;
    }
  }
  return addresses > 0;
}

// Global unicast (2000::/3) only, minus documentation and Teredo; a 6to4
// address is judged by the IPv4 address it carries.
export function isPublicIPv6(text) {
  const g = expandIPv6(text.toLowerCase());
  if (!g) return false;
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false;
  if (g[0] === 0x2002) return isPublicIPv4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]);
  return true;
}

// Eight 16-bit groups, or null. Dotted (IPv4-embedding) forms are never
// global unicast, so they don't parse.
function expandIPv6(s) {
  if (s.includes(".")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parts = (x) => (x ? x.split(":") : []);
  const head = parts(halves[0]);
  const tail = halves.length === 2 ? parts(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
}

function isOwnHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "amnesia.tax" || h.endsWith(".amnesia.tax");
}

export function imageSignature(secret, target) {
  return hmac(secret, "img:" + target);
}

// A /search JSON body with every image field pointing at this gate's /img
// route. A body that isn't JSON with a results list, or has no image fields,
// comes back byte for byte.
export async function proxifyImages(text, base, secret) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return text; }
  if (!data || !Array.isArray(data.results)) return text;
  let changed = false;
  for (const r of data.results) {
    if (!r || typeof r !== "object") continue;
    for (const field of IMG_FIELDS) {
      const value = r[field];
      if (value === undefined || value === null || value === "") continue;
      const target = imageTarget(value);
      r[field] = target
        ? base + "/img?" + new URLSearchParams({ u: target, s: await imageSignature(secret, target) }).toString()
        : "";
      changed = true;
    }
  }
  return changed ? JSON.stringify(data) : text;
}

async function proxyImage(url, env, ctx, authorized, cors) {
  const u = url.searchParams.get("u");
  const s = url.searchParams.get("s");
  // Only a URL this gate signed, exactly as signed. A bad signature is a
  // 404 like any other unknown resource, and checked before the session so a
  // probe learns nothing about either.
  const target = imageTarget(u);
  if (!target || target !== u || !s || !timingSafeEqual(s, await imageSignature(env.SESSION_SECRET, target))) {
    return json({ error: "not_found" }, 404, cors());
  }
  if (!authorized) {
    return json({ error: "session_required" }, 401, cors());
  }

  const cacheKey = new Request(url.origin + "/img?" + new URLSearchParams({ u: target, s }).toString());
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    return new Response(hit.body, { status: 200, headers: imageHeaders(hit.headers.get("content-type")) });
  }

  // Nothing of the visitor's goes upstream: no cookie, no client IP, no
  // referrer. Just the URL and a user agent that says what is asking.
  // Redirects are followed here, at most IMG_MAX_REDIRECTS of them, and each
  // Location must pass imageTarget before it is fetched, so a signed public
  // URL can't bounce the fetch to a private address or into amnesia.tax.
  const signal = AbortSignal.timeout(IMG_TIMEOUT_MS);
  let up;
  let next = target;
  for (let hop = 0; ; hop++) {
    let publicHost;
    try {
      publicHost = await resolvesPublic(new URL(next).hostname, signal);
    } catch (e) {
      return json({ error: "image_unreachable" }, 502, cors());
    }
    if (!publicHost) return json({ error: "image_refused" }, 502, cors());
    try {
      up = await fetch(next, {
        method: "GET",
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
          "user-agent": IMG_UA,
        },
        redirect: "manual",
        signal,
      });
    } catch (e) {
      return json({ error: "image_unreachable" }, 502, cors());
    }
    if (up.status < 300 || up.status > 399) break;
    const location = up.headers.get("location");
    cancelBody(up);
    let to = null;
    if (location) {
      try { to = imageTarget(new URL(location, next).href); } catch (e) {}
    }
    if (!to || hop >= IMG_MAX_REDIRECTS) {
      return json({ error: "image_refused" }, 502, cors());
    }
    next = to;
  }
  const type = (up.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!up.ok || !IMG_TYPES.test(type)) {
    cancelBody(up);
    return json({ error: "not_an_image" }, 502, cors());
  }
  const declared = up.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= IMG_MAX_BYTES)) {
    cancelBody(up);
    return json({ error: "image_too_large" }, 502, cors());
  }
  let bytes;
  try {
    bytes = await readCapped(up.body, IMG_MAX_BYTES);
  } catch (e) {
    return json({ error: "image_unreachable" }, 502, cors());
  }
  if (bytes === null) {
    return json({ error: "image_too_large" }, 502, cors());
  }

  ctx.waitUntil(
    caches.default.put(
      cacheKey,
      new Response(bytes, {
        status: 200,
        headers: { "content-type": type, "cache-control": "public, max-age=" + IMG_CACHE_TTL },
      })
    )
  );
  return new Response(bytes, { status: 200, headers: imageHeaders(type) });
}

function imageHeaders(type) {
  return {
    "content-type": type || "application/octet-stream",
    "cache-control": "private, max-age=" + IMG_CACHE_TTL,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-site",
    "referrer-policy": "no-referrer",
  };
}

function cancelBody(res) {
  try { if (res.body) res.body.cancel(); } catch (e) {}
}

// The whole body, or null once it passes `max` bytes (the rest is never read).
export async function readCapped(body, max) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch (e) {}
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---- Turnstile siteverify -----------------------------------------------
async function siteverify(token, secret, ip) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  try {
    const vr = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    return await vr.json();
  } catch (e) {
    return "unreachable";
  }
}

// ---- Signed session cookie (HMAC-SHA256 over start and expiry) ----------
// Value: `start.exp.sig`, sig = HMAC(`start.exp`); start is the Turnstile
// solve's time.
// The cookie helpers below are exported for the fuzz targets in /fuzz — the
// cookie value is client-controlled input guarding auth, so its
// forgery-resistance contract is machine-checked there. Named exports beside
// the default export don't affect the Worker runtime.
export async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildCookie(secret, ttl, start, maxAge = Infinity) {
  const now = Math.floor(Date.now() / 1000);
  if (start === undefined) start = now;
  const exp = Math.min(now + ttl, start + maxAge);
  const payload = `${start}.${exp}`;
  const sig = await hmac(secret, payload);
  return `${COOKIE_NAME}=${payload}.${sig}; Max-Age=${exp - now}; Path=/; HttpOnly; Secure; SameSite=None`;
}

export async function verifySession(value, secret) {
  const dot = value.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+\.\d+$/.test(payload)) return false;
  const expNum = parseInt(payload.slice(payload.lastIndexOf(".") + 1), 10);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return false; // expired
  const expected = await hmac(secret, payload);
  return timingSafeEqual(sig, expected);
}

// Only called on a value verifySession accepted.
export function sessionTimes(value) {
  const parts = value.split(".");
  return { start: parseInt(parts[0], 10), exp: parseInt(parts[1], 10) };
}

export function needsRenewal(start, exp, ttl, maxAge) {
  const now = Math.floor(Date.now() / 1000);
  return exp - now < ttl / 2 && exp < start + maxAge;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(request, name) {
  const h = request.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
