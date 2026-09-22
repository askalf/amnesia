# Self-hosting Amnesia

Back to the [README](../README.md).

## Self-host

**Minimal** — your own machine, your own IP, every engine available, no gate needed:

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng
```

Then serve `src/amnesia-search.html` from any static host and point it at your instance. The API origin is one line near the top of the script:

```js
const API_BASE = window.location.hostname === 'localhost' ? '' : 'https://api.amnesia.tax';
```

The empty-string branch is same-origin and skips Turnstile entirely, so the simplest setup is to serve the page from the same origin as SearXNG (a reverse proxy in front of both). Otherwise set the string to your SearXNG URL and allow your page origin in SearXNG's CORS settings; the Turnstile warm-up resolves empty and searches proceed. The SPA calls `/search?q=…&format=json` and `/autocompleter?q=…`, both served natively by SearXNG.

**Full production shape** — VPN egress, hardened container, tunnel, gated Worker:

```bash
cp infra/.env.example infra/.env        # set AMNESIA_SEARXNG_SECRET and your network name
docker compose -f infra/docker-compose.yml up -d
```

[`infra/docker-compose.yml`](../infra/docker-compose.yml) ships the hardened SearXNG service and expects a Gluetun container named `gluetun` on the shared network to exist already; it does not bundle the VPN. [`infra/DEPLOY.md`](../infra/DEPLOY.md) covers the tunnel ingress, the WAF origin-lock rule, and the egress check. The Worker lives in [`worker/`](../worker/) with its own [`DEPLOY.md`](../worker/DEPLOY.md) and deploys with `wrangler`. The site deploys to any static host; here it is Cloudflare Pages via [`deploy.yml`](../.github/workflows/deploy.yml).

## Layout

```
src/                 the SPA (44 KB, self-contained) + _headers (CSP) + fonts + og + robots + sitemap
worker/              API-gate Worker: Turnstile → HMAC session, /search /autocompleter /session /healthz
infra/               production mirror: compose, SearXNG settings, tunnel ingress, DEPLOY.md
fuzz/                ClusterFuzzLite target for the session-cookie auth boundary
.github/workflows/   ci · codeql · cflite · scorecard · canary (daily live smoke) · deploy + deploy-worker
```

## Stack

`HTML` · `CSS` · `JavaScript` · `SearXNG` · `Cloudflare Pages + Workers + Tunnel + WAF` · `Turnstile` · `Gluetun (WireGuard)` · `ProtonVPN`
