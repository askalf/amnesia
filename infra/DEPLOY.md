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
#   AMNESIA_VALKEY_PASSWORD  = openssl rand -hex 24
#   ASKALF_NET_NAME          = <name from `docker network ls`>

docker compose -f /root/amnesia/docker-compose.yml --env-file /root/amnesia/.env up -d
docker compose -f /root/amnesia/docker-compose.yml ps
docker exec amnesia-searxng wget -qO- http://127.0.0.1:8080/healthz   # -> OK

# Confirm engine egress is via ProtonVPN (not the host IP):
docker exec amnesia-searxng sh -c 'curl -s -x http://gluetun:8888 https://ifconfig.me'
```

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

### real-IP check (step 1 follow-up)

After traffic flows, confirm SearXNG sees per-client IPs, not one proxy IP:

```sh
docker logs amnesia-searxng 2>&1 | grep -i limiter | tail
```

If everyone is collectively throttled, tune `real_ip.x_for` in
`searxng/limiter.toml` or set `server.limiter: false` and rely solely on the
Cloudflare rate-limit rule.

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
