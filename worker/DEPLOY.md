# amnesia API gate — Turnstile deployment

Keeps Cloudflare's bot/challenge protection ON for the whole zone while letting
the SPA's cross-origin `fetch()` reach the SearXNG JSON API. The SPA solves a
Cloudflare **Turnstile** widget; this Worker verifies the token server-side and
only then proxies to SearXNG.

```
browser (amnesia.tax SPA)
  │  solves Turnstile → token
  │  GET https://api.amnesia.tax/search?q=…&format=json   (header cf-turnstile-token)
  ▼
Cloudflare edge  ── zone challenge layer stays ON for everything else ──
  │  Worker route api.amnesia.tax/* → amnesia-api-gate Worker
  ▼
amnesia-api-gate Worker
  │  POST siteverify (TURNSTILE_SECRET)  → ok?
  │  GET https://search-origin.amnesia.tax/search?… (header x-amnesia-gate: ORIGIN_SECRET)
  ▼
cloudflared ingress search-origin.amnesia.tax → http://localhost:8081 → amnesia-searxng
```

## Why a second hostname (`search-origin.amnesia.tax`)
`api.amnesia.tax` is taken over by the Worker route, so the Worker can't proxy
back to `api.amnesia.tax` (infinite loop). The Worker reaches SearXNG via a
second proxied tunnel hostname, `search-origin.amnesia.tax`, that exists only for
the Worker. Protect it so the public can't bypass Turnstile by hitting it
directly — see step 4.

## Operator provisioning (needs dashboard / a broader-scoped token)

The scoped DNS token used elsewhere this session can't create Turnstile widgets
or deploy Workers. Do these in the Cloudflare dashboard (or with a token scoped
for Workers Scripts:Edit + Turnstile:Edit + Workers Routes:Edit + DNS:Edit).

1. **Turnstile widget.** Dashboard → Turnstile → Add site:
   - Domain: `amnesia.tax`
   - Mode: **Managed** (or Invisible for least friction)
   - Copy the **site key** (public, goes in the SPA) and **secret key**.

2. **DNS for the origin hostname.** Add a **proxied** CNAME
   `search-origin.amnesia.tax` → `a1a6fac4-5859-4e5b-a3e3-e169b532c9b3.cfargotunnel.com`
   (same tunnel as api). Then on the Hetzner host add the ingress rule to
   `/etc/cloudflared/config.yml` ABOVE the 404 catch-all and restart cloudflared:
   ```yaml
     - hostname: search-origin.amnesia.tax
       service: http://localhost:8081
       originRequest:
         connectTimeout: 30s
   ```

3. **Deploy the Worker.**
   ```sh
   cd worker
   wrangler secret put TURNSTILE_SECRET   # paste the Turnstile secret key
   wrangler secret put ORIGIN_SECRET      # any long random string (openssl rand -hex 24)
   wrangler deploy
   ```
   The route in `wrangler.toml` binds `api.amnesia.tax/*` to the Worker.

4. **Lock the origin hostname to the Worker.** So nobody bypasses Turnstile by
   calling `search-origin.amnesia.tax` directly, add a WAF custom rule:
   `(http.host eq "search-origin.amnesia.tax" and not http.request.headers["x-amnesia-gate"][0] eq "<ORIGIN_SECRET>")` → **Block**.
   (Or a mTLS/Access service-token; the shared header is the simplest.)

5. **Front-end.** `src/amnesia-search.html` already loads the Turnstile script and
   sends the token (see the patch in this PR). Set the **site key** placeholder
   `__TURNSTILE_SITE_KEY__` to your real site key, then redeploy Pages
   (`wrangler pages deploy …`, see ../infra/DEPLOY.md step 5).

## Verify
```sh
# preflight + health (no token needed)
curl -s -o /dev/null -w '%{http_code}\n' https://api.amnesia.tax/healthz       # 200
# search WITHOUT token must be refused now:
curl -s -o /dev/null -w '%{http_code}\n' 'https://api.amnesia.tax/search?q=x&format=json'  # 401 turnstile_required
# then load https://amnesia.tax, run a query in the browser → results.
```

## Note on the interim Configuration Rule
If you instead want search live immediately without the Worker, the one-liner
fallback is a Configuration Rule on `http.host eq "api.amnesia.tax"` setting
`security_level: essentially_off` + `bic: off` (abuse still covered by the
rate-limit rule). That was the rejected "weaken" path; the Turnstile gate here is
the stronger option you chose.
