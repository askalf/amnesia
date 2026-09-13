# amnesia — deployment runbook

Two moving parts:

| Piece | Where | Serves |
|-------|-------|--------|
| **Front-end** | Cloudflare Pages project `amnesia-site` (deployed from `src/` by `.github/workflows/deploy.yml`) | `https://amnesia.tax` |
| **Backend** | This `infra/` stack on the Hetzner host at `/root/amnesia/` | `https://api.amnesia.tax` |

The front-end (`src/amnesia-search.html`, line ~945) calls
`GET https://api.amnesia.tax/search?q=…&format=json`. Because that is a
**cross-origin** request, `api.amnesia.tax` must return a CORS
`Access-Control-Allow-Origin` header (added at the Cloudflare edge — step 4).

---

## 1. Backend — deploy on Hetzner

```sh
ssh -i ~/.ssh/askalf_platform_ed25519 root@178.104.181.103

# Find the platform network's real name
docker network ls | grep askalf-net      # e.g. askalf_askalf-net

mkdir -p /root/amnesia
# copy infra/ contents here: docker-compose.yml, searxng/, .env.example
cp .env.example .env
# fill .env:
#   AMNESIA_SEARXNG_SECRET   = openssl rand -hex 32
#   ASKALF_NET_NAME          = <name from `docker network ls`>

docker compose -f /root/amnesia/docker-compose.yml --env-file /root/amnesia/.env up -d
docker compose -f /root/amnesia/docker-compose.yml ps
docker exec amnesia-searxng wget -qO- http://127.0.0.1:8080/healthz   # -> OK

# Confirm engine egress is via ProtonVPN (not the host IP):
docker exec amnesia-searxng sh -c 'curl -s -x http://gluetun:8888 https://ifconfig.me'
```

This is the proxy shape, kept as the rollback path. The live stack runs 1b,
where SearXNG cannot leave except by the tunnel.

## 1b. Backend, the live shape — VPN by topology (`docker-compose.vpn.yml`)

> **This is what runs in production since 2026-09-13.** Section 1 above is the
> older proxy shape, kept as the rollback path.


`docker-compose.yml` puts SearXNG on the platform's network and *tells* it to
use the platform gluetun's proxy; an engine that ignored the proxy setting
would leave by the host IP. `docker-compose.vpn.yml` is the other shape: its
own gluetun, and SearXNG inside that container's network namespace
(`network_mode: "service:gluetun"`). There is then exactly one way out, the
tunnel, and gluetun's firewall drops everything while the tunnel is down — a
VPN outage is a search outage, never a leak. The stack is self-contained and
touches nothing in the platform stack.

Verified on the host with the tunnel deliberately down (a bogus key): from
inside the namespace a lookup of ifconfig.me cannot resolve and a request to
1.1.1.1 by address times out; the same image on the default bridge answers
with the host IP.

```sh
# One-time: generate a WireGuard configuration for THIS stack in the Proton
# account (Downloads → WireGuard configuration). One config = one device; do
# not reuse the platform's key, the two sessions would fight.
# The env file gains:
#   AMNESIA_WIREGUARD_PRIVATE_KEY = <private key from that config>
#   AMNESIA_VPN_COUNTRIES         = United States   (optional; default)

cd /root/amnesia
docker compose -f docker-compose.yml down            # the proxy shape; keeps the cache volume
docker compose -f docker-compose.vpn.yml up -d
docker compose -f docker-compose.vpn.yml ps          # gluetun healthy, then searxng healthy

# Both halves of the guarantee, on the live stack:
docker exec amnesia-searxng sh -c 'wget -qO- https://ifconfig.me'          # the VPN exit — no proxy flag
docker stop amnesia-gluetun
docker exec amnesia-searxng sh -c 'wget -qO- -T 5 https://ifconfig.me'     # nothing: no route while the tunnel is down
docker start amnesia-gluetun && docker compose -f docker-compose.vpn.yml restart searxng
```

Same container names, same `amnesia_searxng_cache` volume, same `127.0.0.1:8081`
(now published by gluetun), so cloudflared and the canary need no change.
Roll back with the two `docker compose` lines in the other order. Known
behaviour: recreating the gluetun container empties searxng's namespace —
`docker compose -f docker-compose.vpn.yml up -d` restarts searxng too.

## 2. DNS — point api.amnesia.tax at the tunnel

```sh
# Uses the cloudflared cert, not the scoped API token.
cloudflared tunnel route dns askalf-platform api.amnesia.tax
```

## 3. cloudflared ingress

Add the block from `cloudflared-ingress.snippet.yml` to
`/etc/cloudflared/config.yml` (above the `http_status:404` catch-all), then:

```sh
cloudflared tunnel ingress validate
systemctl restart cloudflared
curl -s https://api.amnesia.tax/healthz      # -> OK
```

## 4. Cloudflare edge — CORS + hardening (scoped API token)

On zone **amnesia.tax**:

- **CORS (required).** Transform Rule → *Modify Response Header* on
  `http.host eq "api.amnesia.tax"`: set
  `Access-Control-Allow-Origin: https://amnesia.tax`.
- **Rate limit.** WAF → Rate limiting rule on `api.amnesia.tax/search`,
  e.g. 30 req / 10s per IP → Block (this is the primary per-IP throttle;
  it sees the true client IP).
- **Bot Fight Mode** ON for the zone.
- Proxy (orange cloud) the `api` record — it is, via the tunnel CNAME.

## 5. Front-end — Pages domain + deploy

- Bind custom domain `amnesia.tax` (and `www`) to Pages project `amnesia-site`
  (account `dfdf9f7ec6fe9f816bd9cdc6f2469eca`). Root uses CNAME flattening.
- Deploy: push to `main` → `deploy.yml` runs `wrangler pages deploy` with the
  repo's `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets. Confirm those
  secrets are still valid (`gh run watch` the deploy).

## 6. Verify end-to-end

```sh
curl -sI https://amnesia.tax                      # 200, HTML
curl -s 'https://api.amnesia.tax/search?q=test&format=json' \
  -H 'Origin: https://amnesia.tax' -i | grep -i access-control-allow-origin
# then load https://amnesia.tax in a browser and run a query
```

### why there is no SearXNG limiter

Behind cloudflared every request reaches SearXNG from the tunnel's IP, so the
built-in limiter (and `public_instance: true`) collectively throttles everyone
— in practice it silently returns **zero results**. Live therefore runs
`limiter: false` / `public_instance: false` with no valkey container, and all
rate/bot defense happens at the Cloudflare edge (Turnstile gate Worker + the
WAF rate-limit rule from step 4, which sees true client IPs). Do not re-enable
the limiter or re-add valkey without re-testing search through the tunnel.

---

## ⚠️ Durability

The host copies under `/root/amnesia/` and the `/etc/cloudflared/config.yml`
edit are **not** regenerated from any repo — this `infra/` directory is the
source of truth. Any change made on the host MUST be mirrored back here in the
same session, or it is lost on the next manual redeploy.

This stack is deliberately **separate from the askalf platform repo** (the
platform `CLAUDE.md` forbids the `amnesia` brand name anywhere in it). It only
*borrows* the platform's `gluetun` for VPN egress via the shared `askalf-net`
network.
