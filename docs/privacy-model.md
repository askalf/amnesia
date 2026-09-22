# Amnesia privacy model

Back to the [README](../README.md).

What each party on a query's path can see, and a check you can run for every guarantee.

## Who sees what

A privacy claim is only as good as its threat model. This is the full path a query takes and what each party can observe. **"Stores" means retained after the response is sent.**

| Party | Sees | Stores |
|---|---|---|
| **You (browser)** | Everything. Theme preference lives in `localStorage`. | Nothing is sent to us. No history, no account. |
| **Cloudflare edge** (Pages, Worker, Tunnel) | Your IP and the query in plaintext. Cloudflare terminates TLS, so the Worker reads `?q=` to proxy it. | An **edge cache entry** keyed on the normalized query text, for **3 minutes** (`/search`) or **6 hours** (`/autocompleter`). The key never includes a cookie, token, or IP. Cloudflare's own edge logging is governed by [Cloudflare's policies](https://www.cloudflare.com/privacypolicy/), not by this repo. |
| **The session cookie** | Nothing. It is an HMAC over a timestamp under the operator's secret — it identifies a *session*, not a person. | 30 minutes, in your browser. The server keeps no session table. |
| **SearXNG backend** | The query, arriving with the gate's user agent and no client IP. | Nothing. No result cache, no Redis, no access log. |
| **VPN provider** (ProtonVPN) | Encrypted traffic leaving the backend for the engines. | Per ProtonVPN's policy; the tunnel carries no query in plaintext. |
| **Search engines** (Brave, Bing, DuckDuckGo, …) | The query and the VPN exit IP. | Whatever each engine retains for a datacenter IP with no cookies. They never see your IP. |
| **Amnesia's operator** | Nothing per-user. | Nothing. No analytics, no server-side query log. |

What this does **not** protect against: a global adversary correlating traffic at both ends, a compromised Cloudflare account, or an engine fingerprinting queries by content. If you need that, run the [self-host](self-host.md#self-host) shape on hardware you control, or use Tor.

## Guarantees, and how to check them

Every row is enforced by code or configuration in this repo, and every row has a check you can run yourself without trusting the README.

| Guarantee | Enforced by | Verify it |
|---|---|---|
| No search without the gate | WAF rule: 403 unless the gate's secret header is present; the Worker sets it, nothing else can | `curl -s -o /dev/null -w '%{http_code}' 'https://search-origin.amnesia.tax/search?q=test'` → `403` |
| No search without a session | Worker: cookie → allow; valid Turnstile token → allow and issue cookie; else 401 ([`worker/src/index.js`](../worker/src/index.js)) | `curl -s -o /dev/null -w '%{http_code}' 'https://api.amnesia.tax/search?q=test&format=json'` → `401` |
| Gate fails closed | Worker returns `500 misconfigured` if `SESSION_SECRET` or `TURNSTILE_SECRET` is unset, before any auth path runs | Read the env check at the top of `fetch()` in the Worker |
| Session cookie cannot be forged | HMAC-SHA-256 over a timestamp under `SESSION_SECRET`, verified with a constant-time compare (`timingSafeEqual`) | `npm run fuzz` runs the forgery, splice, and cross-secret targets locally; ClusterFuzzLite runs them weekly |
| Responses are never cached in your browser | Every proxied `/search` and `/autocompleter` response, edge hit or miss, is sent with `cache-control: no-store` | The two response-header sites in the Worker's proxy section; or inspect any search in DevTools |
| Only this file's own script and style run, plus Turnstile | CSP allows the page's one `<script>` and one `<style>` **by SHA-256 hash** — no `'unsafe-inline'` — plus `https://challenges.cloudflare.com`; HSTS preload, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` ([`src/_headers`](../src/_headers)). The hashes are generated from the HTML by [`scripts/csp-hashes.mjs`](../scripts/csp-hashes.mjs) and CI fails when they drift | `curl -sI https://amnesia.tax/ \| grep -i content-security-policy` shows two `'sha256-…'` sources and no `'unsafe-inline'`; `node scripts/csp-hashes.mjs --check` |
| Result links cannot execute script | `safeUrl()` in the SPA allows only `http:` and `https:`; a `javascript:` or `data:` URL from a poisoned engine renders with no link | Read `safeUrl()` in [`src/amnesia-search.html`](../src/amnesia-search.html) |
| Backend cannot escalate | `cap_drop: ALL`, `read_only: true`, `no-new-privileges`, tmpfs for the only writable paths, 512 MB memory cap, digest-pinned image ([`infra/docker-compose.yml`](../infra/docker-compose.yml)) | `docker inspect amnesia-searxng` on a self-host |
| Engine traffic cannot leave except by VPN | SearXNG has no network of its own: it runs inside its Gluetun container's namespace (`network_mode: "service:gluetun"`, [`infra/docker-compose.vpn.yml`](../infra/docker-compose.vpn.yml)), and Gluetun drops all egress while the tunnel is down | `docker exec amnesia-searxng sh -c 'wget -qO- https://ifconfig.me/ip'` — no proxy flag — returns the VPN exit, not the host IP |
| Nothing in git history | History scrubbed before the repo went public; secrets exist only as Worker bindings and CI secrets | `git log -p \| grep -iE 'secret\|token'` finds names, never values |
| It is still up and still gated | Daily canary at 14:17 UTC: token-expiry check + live smoke (site 200 / gate 401 / origin 403) | [canary runs](https://github.com/askalf/amnesia/actions/workflows/canary.yml) |

One honest caveat. Cloudflare's Bot Fight Mode injects an inline script of its own into every response, and this CSP refuses it — the page is unaffected, the console shows a violation, and the zone's JavaScript bot detection does not run on this site (the API is gated by Turnstile and a rate limit, not by bot scores, so nothing depends on it; turning Bot Fight Mode off for the zone removes the noise).

The VPN row used to carry a second caveat — egress was enforced by a proxy setting SearXNG was asked to honour, so an engine that ignored it would have left by the host IP. Since 2026-09-13 the live instance runs [`infra/docker-compose.vpn.yml`](../infra/docker-compose.vpn.yml): SearXNG sits inside its Gluetun container's network namespace with no interface of its own, and Gluetun's firewall drops everything while the tunnel is down. Both halves were checked on the host — traffic leaves by the VPN exit with no proxy flag, and with the tunnel deliberately down nothing leaves at all (DNS fails, a request by address times out).
