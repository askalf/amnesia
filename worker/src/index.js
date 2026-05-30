/**
 * amnesia API gate — Cloudflare Worker in front of api.amnesia.tax
 *
 * Purpose: keep the zone's bot/challenge protection ON while still letting the
 * static SPA's cross-origin fetch() reach the SearXNG JSON API. A browser can't
 * solve an interstitial challenge inside fetch(), so instead the SPA solves a
 * Cloudflare Turnstile widget and sends the token; this Worker verifies the
 * token server-side (siteverify) and only then proxies to SearXNG.
 *
 * Routes (wrangler.toml): api.amnesia.tax/*  →  this Worker.
 * Upstream: the SearXNG container, reached over the cloudflared tunnel at
 * ORIGIN_HOST (default https://search-origin.amnesia.tax). That origin host is a
 * SEPARATE tunnel hostname that is NOT public-challenge-gated and NOT the one the
 * SPA calls — it exists only so the Worker can reach SearXNG. Lock it down with a
 * shared secret header (ORIGIN_SECRET) checked by a Cloudflare rule, or by only
 * accepting the Worker's requests.
 *
 * Bindings (set via wrangler secret / vars):
 *   TURNSTILE_SECRET  (secret)  — Turnstile secret key for siteverify
 *   ORIGIN_HOST       (var)     — base URL of the SearXNG origin behind the tunnel
 *   ORIGIN_SECRET     (secret)  — shared header value proving requests come from this Worker
 *   ALLOWED_ORIGIN    (var)     — the SPA origin allowed for CORS (https://amnesia.tax)
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://amnesia.tax";

    const cors = (extra = {}) => ({
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "cf-turnstile-token, content-type",
      "access-control-max-age": "86400",
      vary: "Origin",
      ...extra,
    });

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    // Health check — no token required, so uptime monitors work.
    if (url.pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: cors({ "content-type": "text/plain" }) });
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, cors());
    }

    // Only the search + autocompleter endpoints are exposed.
    if (url.pathname !== "/search" && url.pathname !== "/autocompleter") {
      return json({ error: "not_found" }, 404, cors());
    }

    // --- Turnstile verification -------------------------------------------
    const token =
      request.headers.get("cf-turnstile-token") ||
      url.searchParams.get("cf_turnstile_token");

    if (!token) {
      return json({ error: "turnstile_required" }, 401, cors());
    }

    const verifyBody = new URLSearchParams();
    verifyBody.set("secret", env.TURNSTILE_SECRET);
    verifyBody.set("response", token);
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) verifyBody.set("remoteip", ip);

    let outcome;
    try {
      const vr = await fetch(SITEVERIFY, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: verifyBody,
      });
      outcome = await vr.json();
    } catch (e) {
      return json({ error: "verify_unreachable" }, 502, cors());
    }

    if (!outcome.success) {
      return json(
        { error: "turnstile_failed", codes: outcome["error-codes"] || [] },
        403,
        cors()
      );
    }

    // --- Proxy to the SearXNG origin --------------------------------------
    const originBase = env.ORIGIN_HOST || "https://search-origin.amnesia.tax";
    // Strip the turnstile token from the query before forwarding.
    url.searchParams.delete("cf_turnstile_token");
    const originUrl = originBase.replace(/\/$/, "") + url.pathname + "?" + url.searchParams.toString();

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

    // Re-emit with our CORS headers; preserve content-type + body.
    const respHeaders = cors({
      "content-type": originResp.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    });
    return new Response(originResp.body, { status: originResp.status, headers: respHeaders });
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
