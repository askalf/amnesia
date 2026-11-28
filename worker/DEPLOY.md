# amnesia API gate — Turnstile deployment

Keeps Cloudflare's bot/challenge protection ON for the whole zone while letting
the SPA's cross-origin `fetch()` reach the SearXNG JSON API. The SPA solves a
Cloudflare **Turnstile** widget; this Worker verifies the token server-side and
only then proxies to SearXNG.

```
browser (amnesia.sprayberrylabs.com SPA)
  │  solves Turnstile → token
  │  GET https://amnesia-api.sprayberrylabs.com/search?q=…&format=json   (header cf-turnstile-token)
  ▼
Cloudflare edge  ── zone challenge layer stays ON for everything else ──
  │  Worker route amnesia-api.sprayberrylabs.com/* → amnesia-api-gate Worker
  ▼
amnesia-api-gate Worker
  │  POST siteverify (TURNSTILE_SECRET)  → ok?
  │  GET https://amnesia-origin.sprayberrylabs.com/search?… (header x-amnesia-gate: ORIGIN_SECRET)
  ▼
cloudflared ingress amnesia-origin.sprayberrylabs.com → http://localhost:8081 → amnesia-searxng
```

## Why a second hostname (`amnesia-origin.sprayberrylabs.com`)
`amnesia-api.sprayberrylabs.com` is taken over by the Worker route, so the Worker can't proxy
back to `amnesia-api.sprayberrylabs.com` (infinite loop). The Worker reaches SearXNG via a
second proxied tunnel hostname, `amnesia-origin.sprayberrylabs.com`, that exists only for
the Worker. Protect it so the public can't bypass Turnstile by hitting it
directly — see step 4.

## Operator provisioning (needs dashboard / a broader-scoped token)

A token scoped to DNS only can't create Turnstile widgets
or deploy Workers. Do these in the Cloudflare dashboard (or with a token scoped
for Workers Scripts:Edit + Turnstile:Edit + Workers Routes:Edit + DNS:Edit).

1. **Turnstile widget.** Dashboard → Turnstile → Add site:
   - Domain: `amnesia.sprayberrylabs.com`
   - Mode: **Managed** (or Invisible for least friction)
   - Copy the **site key** (public, goes in the SPA) and **secret key**.

2. **DNS for the origin hostname.** Add a **proxied** CNAME
   `amnesia-origin.sprayberrylabs.com` → `<tunnel-id>.cfargotunnel.com`
   (same tunnel as api). Then on the backend host add the ingress rule to
   `/etc/cloudflared/config.yml` ABOVE the 404 catch-all and restart cloudflared:
   ```yaml
     - hostname: amnesia-origin.sprayberrylabs.com
       service: http://localhost:8081
       originRequest:
         connectTimeout: 30s
   ```

3. **Deploy the Worker.**
   ```sh
   cd worker
   wrangler secret put TURNSTILE_SECRET   # paste the Turnstile secret key
   wrangler secret put SESSION_SECRET     # HMAC key for the session cookie (openssl rand -hex 32)
   wrangler secret put ORIGIN_SECRET      # any long random string (openssl rand -hex 24)
   wrangler deploy
   ```
   The route in `wrangler.toml` binds `amnesia-api.sprayberrylabs.com/*` to the Worker. The
   Worker answers every route, `/healthz` included, with 500 `misconfigured`
   until both `TURNSTILE_SECRET` and `SESSION_SECRET` are set.

4. **Lock the origin hostname to the Worker.** So nobody bypasses Turnstile by
   calling `amnesia-origin.sprayberrylabs.com` directly, add a WAF custom rule:
   `(http.host eq "amnesia-origin.sprayberrylabs.com" and cf.worker.upstream_zone ne "sprayberrylabs.com")` → **Block**.
   `cf.worker.upstream_zone` holds the zone of the Worker a subrequest came from and is
   empty for every other request, so the rule passes only subrequests from a Worker on
   this zone: keep the zone's Workers to ones you trust. The Worker also sends
   `x-amnesia-gate: <ORIGIN_SECRET>`; a rule can test that header as well
   (`http.request.headers["x-amnesia-gate"][0]`), which puts the secret in the rule.

5. **Front-end.** `src/amnesia-search.html` loads the Turnstile script and sends
   the token. Its site key is the `TURNSTILE_SITE_KEY` constant in the page script; for
   your own widget, replace it with your site key and push to `main`; the
   Pages Git integration rebuilds the site (../infra/DEPLOY.md step 5).

## Verify
```sh
# preflight + health (no token needed)
curl -s -o /dev/null -w '%{http_code}\n' https://amnesia-api.sprayberrylabs.com/healthz       # 200
# search WITHOUT token must be refused now:
curl -s -o /dev/null -w '%{http_code}\n' 'https://amnesia-api.sprayberrylabs.com/search?q=x&format=json'  # 401 turnstile_required
# then load https://amnesia.sprayberrylabs.com, run a query in the browser → results.
```
