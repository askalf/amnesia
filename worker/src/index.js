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
 *
 * Edge caches: the upstream ride (tunnel -> SearXNG -> engines via the VPN
 * proxy) costs ~1.5s for autocomplete and ~1-4s for a search. Both are
 * repetitive, so 200s are cached in the colo's Cache API — autocomplete for
 * AC_CACHE_TTL (prefix queries age well), search results for SEARCH_CACHE_TTL
 * (short: results should stay fresh, but a repeated/popular query inside the
 * window is served at edge speed). Keys are the normalized (trim+lowercase)
 * query plus the sorted remaining params (category, page, format, ...), so
 * the key carries the QUERY only — never a cookie, token, or IP. Lookup
 * happens AFTER auth — the cache saves the origin trip, not the gate.
 * Clients still get no-store; the edge copy is ours alone. No new privacy
 * exposure: Cloudflare already terminates TLS on every request.
 *
 * Auth precedence: valid session cookie → allow (no Turnstile). Else a valid
 * `cf-turnstile-token` → allow AND (re)issue the cookie. Else 401.
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
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const COOKIE_NAME = "amns";
const AC_CACHE_TTL = 21600; // 6h — autocomplete suggestions age well
const SEARCH_CACHE_TTL = 180; // 3m — repeat searches at edge speed, results stay fresh

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://amnesia.tax";
    const ttl = parseInt(env.SESSION_TTL || "1800", 10);

    // Fail closed if signing/verification secrets are missing. Without
    // SESSION_SECRET, hmac() would sign cookies with an empty key — forgeable by
    // anyone who can read this (public) source. Never silently degrade auth.
    if (!env.SESSION_SECRET || !env.TURNSTILE_SECRET) {
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
    if (!isSession && !isSearch) {
      return json({ error: "not_found" }, 404, cors());
    }

    // --- Authorize: trusted-bridge bypass, else session cookie, else token --
    let authorized = false;
    let issueCookie = false;

    // Trusted bridge bypass. The headless front-end-verification bridge runs on
    // the platform box and can't solve Turnstile from that datacenter IP. Allow
    // requests from the box's egress IP(s) to reach /search without a token so
    // internal front-end verification works. BRIDGE_IPS is a public var (an IP is
    // not a secret), scoped to the operator's own infra; empty = bypass disabled.
    const clientIp = request.headers.get("cf-connecting-ip");
    const bridgeIps = (env.BRIDGE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (clientIp && bridgeIps.includes(clientIp)) {
      authorized = true;
    }

    const cookie = readCookie(request, COOKIE_NAME);
    if (!authorized && cookie && (await verifySession(cookie, env.SESSION_SECRET))) {
      authorized = true; // valid, unexpired session — skip Turnstile
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
      // hostname (a stolen sitekey solved on an attacker's page won't match).
      let expectedHost = "";
      try { expectedHost = new URL(allowedOrigin).hostname; } catch (e) {}
      if (expectedHost && outcome.hostname && outcome.hostname !== expectedHost) {
        return json({ error: "turnstile_hostname_mismatch" }, 403, cors());
      }
      authorized = true;
      issueCookie = true;
    }

    if (!authorized) {
      return json({ error: "turnstile_required" }, 401, cors());
    }

    const setCookie = issueCookie
      ? { "set-cookie": await buildCookie(env.SESSION_SECRET, ttl) }
      : {};

    // Pre-warm endpoint: just establish the session, no search.
    if (isSession) {
      return json({ ok: true, ttl }, 200, cors(setCookie));
    }

    // --- Proxy to the SearXNG origin --------------------------------------
    const originBase = env.ORIGIN_HOST || "https://search-origin.amnesia.tax";
    url.searchParams.delete("cf_turnstile_token");
    const originUrl =
      originBase.replace(/\/$/, "") + url.pathname + "?" + url.searchParams.toString();

    // Edge cache (see header). Keyed on the normalized query + sorted params
    // so "Linux " and "linux" (and reordered param spellings) share an entry.
    // The key never contains a cookie, token, or client IP — query text only.
    const isAc = url.pathname === "/autocompleter";
    const cacheTtl = isAc ? AC_CACHE_TTL : SEARCH_CACHE_TTL;
    let edgeCacheKey = null;
    if (isAc || url.pathname === "/search") {
      const keyParams = new URLSearchParams(url.searchParams);
      keyParams.set("q", (keyParams.get("q") || "").trim().toLowerCase());
      keyParams.sort();
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
            "x-amnesia-cache": "hit",
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
      const [clientBody, cacheBody] = originResp.body.tee();
      ctx.waitUntil(
        caches.default.put(
          edgeCacheKey,
          new Response(cacheBody, {
            status: 200,
            headers: {
              "content-type": originResp.headers.get("content-type") || "application/json",
              "cache-control": "public, max-age=" + cacheTtl,
            },
          })
        )
      );
      return new Response(clientBody, { status: 200, headers: respHeaders });
    }

    return new Response(originResp.body, { status: originResp.status, headers: respHeaders });
  },
};

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

// ---- Signed session cookie (HMAC-SHA256 over expiry) ---------------------
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

export async function buildCookie(secret, ttl) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmac(secret, String(exp));
  const value = `${exp}.${sig}`;
  return `${COOKIE_NAME}=${value}; Max-Age=${ttl}; Path=/; HttpOnly; Secure; SameSite=None`;
}

export async function verifySession(value, secret) {
  const dot = value.lastIndexOf(".");
  if (dot < 0) return false;
  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expNum = parseInt(exp, 10);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return false; // expired
  const expected = await hmac(secret, exp);
  return timingSafeEqual(sig, expected);
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
