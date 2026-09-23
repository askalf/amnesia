# Self-hosting Amnesia

Back to the [README](../README.md).

## One container

```bash
docker run -d --name amnesia -p 8080:8080 ghcr.io/askalf/amnesia
```

Open <http://localhost:8080>. That is the amnesia.tax page and SearXNG in one image, served from one origin:

- **The same page as amnesia.tax.** The container serves [`src/amnesia-search.html`](../src/amnesia-search.html) at `/` and hands `/search`, `/autocompleter` and the image proxy to SearXNG on the same origin, so there is no API host, no CORS and no bot gate. The page picks this up by itself: `API_BASE` is the hosted Worker only on `amnesia.tax` and same-origin everywhere else.
- **No request to Cloudflare.** The Turnstile loader is removed from the page the container serves, and its Content-Security-Policy is `connect-src 'self'` with no third-party origin, so the page cannot send your query anywhere but your own container. The CSP allows the page's one script and one style by SHA-256 hash, computed from the bytes served.
- **amnesia's SearXNG tuning**, from [`image/settings.yml`](../image/settings.yml): JSON output on, image proxy on, metrics off, the outgoing timeouts that keep a slow engine from holding a search, and the engines that are broken for everyone switched off. The engines amnesia.tax disables only because they refuse VPN and datacenter IPs (Google, Mojeek, Qwant, Startpage and others) are **on** here: from an IP they accept they answer, and from one they refuse SearXNG suspends them and moves on.
- **Its own secret.** Each container generates a random `secret_key` on first start and keeps it in `/var/cache/searxng`, unless you pass `SEARXNG_SECRET`. The baked settings carry SearXNG's refuse-to-start placeholder, so a run that skips the entrypoint fails closed rather than using a key published in this repo.
- **Unprivileged.** The container runs as SearXNG's `searxng` user, not root.

**The hardened run line.** Read-only root filesystem, no Linux capabilities, no privilege escalation, a named volume for the key, and bound to loopback. [`image.yml`](../.github/workflows/image.yml) runs the full smoke test against exactly this line on every change:

```bash
docker run -d --name amnesia --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -v amnesia-cache:/var/cache/searxng \
  -p 127.0.0.1:8080:8080 ghcr.io/askalf/amnesia
```

**What it does not do for you.** Engines see the IP your container leaves from, which at home is your home address. The hosted instance puts a VPN under SearXNG for that reason; to do the same, run the image inside a Gluetun network namespace as [`infra/docker-compose.vpn.yml`](../infra/docker-compose.vpn.yml) does. The image is built for one person or a household: SearXNG's limiter is off, as it is on amnesia.tax (where Cloudflare and the Turnstile Worker do abuse control). If you expose it to the internet, put a rate limit or a gate in front of it.

**Options.**

| Want | Do |
|---|---|
| Your own SearXNG settings | Mount a file at `/etc/searxng/settings.yml`; it wins over the baked tuning, and its `secret_key` is then yours to set |
| A fixed secret | `-e SEARXNG_SECRET=…` |
| A public hostname behind a reverse proxy | `-e SEARXNG_BASE_URL=https://search.example.org/`; `/opensearch.xml` then names that origin (otherwise it uses the request's `Host`) |
| Add it as your browser's search engine | Visit the page; the browser offers it through `/opensearch.xml`, suggestions included |
| Check what you pulled | `gh attestation verify oci://ghcr.io/askalf/amnesia:latest --owner askalf` verifies the SLSA build provenance: this repository's `image.yml`, on `main` |
| Check a running instance | `python3 image/smoke.py http://127.0.0.1:8080` runs the same checks CI does |

Images are multi-arch (`linux/amd64`, `linux/arm64`) and tagged `:latest` and `:sha-<commit>`. Pin a `sha-` tag or the digest if you want updates only when you choose them.

## Full production shape

This is how amnesia.tax itself runs: VPN egress by network namespace, a hardened container, a Cloudflare Tunnel, and the gated Worker in front.

```bash
cp infra/.env.example infra/.env        # set AMNESIA_SEARXNG_SECRET, the WireGuard key, your network name
docker compose -f infra/docker-compose.vpn.yml up -d
```

[`infra/docker-compose.vpn.yml`](../infra/docker-compose.vpn.yml) runs its own Gluetun (ProtonVPN over WireGuard) and puts SearXNG inside Gluetun's network namespace, so the tunnel is the only way out and Gluetun's firewall drops everything while it is down. [`infra/docker-compose.yml`](../infra/docker-compose.yml) is the older shape, which reaches an existing Gluetun by proxy setting. [`infra/DEPLOY.md`](../infra/DEPLOY.md) covers the tunnel ingress, the WAF origin-lock rule, and the egress check. The Worker lives in [`worker/`](../worker/) with its own [`DEPLOY.md`](../worker/DEPLOY.md) and deploys with `wrangler`. The site deploys to any static host; here it is Cloudflare Pages, assembled by [`scripts/build-site.sh`](../scripts/build-site.sh).

## Layout

```
src/                 the SPA (~45 KB, self-contained) + _headers (CSP) + fonts + opensearch + og + robots + sitemap
worker/              API-gate Worker: Turnstile → HMAC session, /search /autocompleter /session /healthz
image/               the self-host image: Dockerfile, SearXNG settings, entrypoint, the same-origin app, smoke test
infra/               production mirror: compose (VPN namespace), SearXNG settings, tunnel ingress, DEPLOY.md
test/                node:test suites for the Worker and the SPA's guards (npm test, zero dependencies)
fuzz/                ClusterFuzzLite target for the session-cookie auth boundary
scripts/             csp-hashes (CSP from the HTML), build-site, README link guard, README asset generators
.github/workflows/   ci · image · codeql · cflite · scorecard · canary (daily live smoke + score floor) · deploy + deploy-worker
```

## Stack

`HTML` · `CSS` · `JavaScript` · `SearXNG` · `Docker` · `Cloudflare Pages + Workers + Tunnel + WAF` · `Turnstile` · `Gluetun (WireGuard)` · `ProtonVPN`
