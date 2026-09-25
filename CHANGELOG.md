# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Latency benchmarks, `scripts/bench/`.** `live.mjs` times a cold page load,
  a warm reload, a search and a repeat search (edge-cache hit) in a real
  browser against amnesia.tax or a self-host. `engines.mjs` runs the pinned
  SearXNG with `infra/searxng/settings.yml` in Docker and reports per-engine
  p50/p95 from SearXNG's `Server-Timing` header, failures, and how often each
  engine was the one a search waited on. Both zero-dependency Node; the browser
  one needs Playwright installed.
- **Self-host image `ghcr.io/askalf/amnesia`.** `docker run -d -p 8080:8080
  ghcr.io/askalf/amnesia` runs the amnesia page and SearXNG in one container on
  one origin: no API host, no CORS, no bot gate, and no request to Cloudflare
  (the Turnstile loader is stripped and the CSP is `connect-src 'self'`).
  Unprivileged, multi-arch, a per-container secret, and SLSA build provenance
  attested to the registry. `image.yml` builds it and runs `image/smoke.py`
  against the container, plain and with the hardened run line, before main
  publishes it. The README's previous one-liner ran stock SearXNG, not amnesia.
- **Tests.** `npm test` (node:test, zero dependencies): 50 tests driving the
  Worker's real default export (fail-closed, cookie forgery/expiry/splice,
  the Turnstile hostname check, CORS, the edge-cache key) and the SPA's URL
  guards run from the page's own bytes.
- **Score guards.** A PR job scores the PR's own tree with OpenSSF Scorecard
  in `--local` mode and fails if Pinned-Dependencies, Token-Permissions,
  Dangerous-Workflow or Binary-Artifacts drop below 10; the daily canary fails
  if the published score falls under 9.5 or a 10 slips.
- README rebuilt: art, a terminal generated from a live run of the checks
  (`scripts/readme/verify.mjs` writes nothing if a claim fails), the query
  path with what each party sees and keeps, and a README/docs link guard in CI.

### Fixed
- `/opensearch.xml` never existed, so "add amnesia to your browser" received
  the HTML page. The file ships now, and `deploy.yml` builds the site with
  `scripts/build-site.sh` instead of its own copy of the file list.
- Image search kept broken thumbnail tiles: the hash CSP refuses the inline
  `onerror` that hid them. A capture-phase listener does it now.
- The canary checked site 200 and gate 401 but never the origin lock's 403
  the README credited it with. It checks the 403 and the OpenSearch file now.
- Faster first search. The page-load warm-up tries the session cookie on
  `/session` first and solves Turnstile only on a 401, so a returning visitor
  with a valid cookie no longer pays a challenge solve before their first
  search. The Turnstile loader is now `defer` (was `async`) and the page waits
  for it before solving: before, a warm-up that ran ahead of the script gave
  up silently, and a first visit that searched straight from `?q=` could fail
  with "Verification failed". A `<link rel=preconnect>` opens the connection to
  `api.amnesia.tax` during parse; the self-host image strips it.
- Docs said the session cookie lasts 30 minutes; the Worker issues 6 hours.

### Changed
- **The session cookie renews while in use.** A valid cookie with less than
  half of `SESSION_TTL` left is re-issued on the same response, so someone
  searching across the 6-hour mark no longer hits a Turnstile solve there.
  The cookie now signs the solve's time with its expiry (`start.exp.sig`), and
  renewal never passes `SESSION_MAX_AGE` (24 h) from that solve, so one solve
  still buys a bounded session. Cookies issued before this (`exp.sig`) keep
  working until they expire and are not renewed.

### Security
- The gate's Turnstile bypass for the operator's verification bridge listed a
  dynamic residential IP from a relay retired on 2026-09-12. Only the box's
  own IP remains, and the privacy model now discloses the bypass.
- The privacy model states two things it used to leave out: image search
  loads each thumbnail from its own host (which sees your IP, but no
  referrer), and the zone's Cloudflare managed transform currently overrides
  some of `src/_headers` at the edge.

### Security
- VPN by topology, as an alternative stack shape: `infra/docker-compose.vpn.yml`
  runs its own gluetun and puts SearXNG inside its network namespace
  (`network_mode: "service:gluetun"`), so the only route out is the tunnel and
  gluetun's firewall drops everything while the tunnel is down. Verified on the
  host with the tunnel deliberately down: from inside the namespace DNS fails
  and a direct-IP request times out, while the same image on the default
  bridge leaves by the host IP. `hostname: gluetun` keeps
  `searxng/settings.yml`'s proxy line working unchanged (it now names the
  co-located proxy). Same container names, cache volume and loopback port as
  the proxy shape, so cloudflared and the canary are untouched; cutover and
  rollback are two `docker compose` lines each (DEPLOY.md 1b). **Live since
  2026-09-13** on its own ProtonVPN session: egress leaves by the VPN exit with
  no proxy flag (163.5.171.6, US, versus the host's own address), site 200,
  gate 401, a real browser search returns results, and the README's VPN caveat
  is retired.
- CSP no longer carries `'unsafe-inline'`. The page's one `<script>` and one
  `<style>` are allowed by SHA-256 hash; the four inline `onclick` handlers
  became `data-action` attributes behind one delegated listener, and the two
  inline `style` attributes became a CSS rule. `scripts/csp-hashes.mjs`
  generates the header from the HTML (`--write`) and CI refuses a commit where
  the two disagree (`--check`), because a stale hash would ship a page whose
  script the browser silently refuses to run. Verified in a real browser under
  the new header: zero `securitypolicyviolation` events across page load, a
  full results render, and every button path. Cloudflare's Bot Fight Mode
  injects its own inline script, which this CSP refuses; nothing here depends
  on it, and the README says so.

### Changed
- **Faster searches, bounded by 3 s instead of 6 s.** A search waits for its
  slowest engine, and the main engines carried a 6 s timeout above the 4 s
  default; every enabled engine now shares a 3 s timeout (`max_request_timeout`
  5 s), and `retries` is 0, since a retry runs inside the same deadline. The
  global `retry_on_http_error: true` is gone: SearXNG only reads it per engine,
  so it never did anything.
- **No proxy hop on the live stack.** SearXNG already runs inside gluetun's
  network namespace, so `outgoing.proxies` (gluetun:8888) only put an HTTP
  CONNECT relay in front of every engine connection. The live settings drop it
  and gluetun's HTTP proxy is off. The rollback shape still needs it (SearXNG
  ignores `HTTP_PROXY` from the environment), so `docker-compose.yml` mounts
  `infra/searxng-proxy/settings.yml`, generated from the live file by
  `scripts/searxng-proxy-settings.mjs`, and CI refuses a commit where they drift.
- **Blocked providers' other verticals off.** `use_default_settings` keeps every
  upstream engine that is on by default, so Google, Qwant, Startpage and Mojeek
  image, news and video engines still ran although those providers' web
  engines were disabled for refusing VPN IPs. They are disabled by name now.
- **SearXNG metrics on.** `/stats` and `/stats/errors` show per-engine timing,
  timeouts and errors, reachable only on the host's loopback port: the Worker
  forwards nothing but `/search` and `/autocompleter`.
- README rewritten as the project's trust document. Corrects drift (Presearch
  is no longer a live engine, the canary is daily, the SPA is 44 KB), documents
  the 3-minute `/search` edge cache that shipped in #50, and replaces the
  competitor comparison with a "who sees what" threat model plus a
  guarantee / enforced-by / verify-it table whose every command was run against
  the live endpoints. States two limits plainly: the CSP carries
  `'unsafe-inline'` for the single-file SPA, and VPN egress is enforced by
  `HTTP_PROXY` configuration rather than a network namespace. Drops an
  unverifiable "real-browser injection tests" claim (no such test is in the
  tree). Adds a hero capture of the live UI (`.github/readme-hero.webp`, 14 KB) and
  a working self-host path that names the `API_BASE` line to change.

### Added
- Continuous fuzzing of the API gate's auth boundary (ClusterFuzzLite +
  Jazzer.js). `fuzz/session.fuzz.js` pins the Worker's signed-session-cookie
  contract — the one input an anonymous internet client fully controls: it
  never throws on a hostile cookie value, never verifies a value the operator's
  `SESSION_SECRET` didn't sign (forgery = free, un-gated search past Turnstile),
  and a `buildCookie` result always round-trips under its own secret and never
  under another. The cookie helpers are now named exports beside the Worker's
  default export (no runtime change). `cflite.yml` runs weekly; `npm run fuzz`
  is the local loop. The target is async (WebCrypto HMAC), so it runs in
  Jazzer's async mode — not `--sync`, which fires the promises without awaiting
  and OOMs instead of fuzzing. Closes the OpenSSF Scorecard Fuzzing check.
- Live search suggestions: debounced autocomplete dropdown backed by the API
  gate's `/autocompleter` endpoint (keyboard navigation, click/tap select).
  Best-effort — rides the session cookie and never triggers Turnstile solves.

### Changed
- `deploy.yml` workflow token drops to read-only at the top level; the
  `deployments: write` scope moves to the single deploy job. Closes the
  Scorecard Token-Permissions finding. No behavior change.

### Security
- Validate result/image URLs against an http(s) scheme allowlist before rendering
  links, blocking `javascript:`/`data:` injection from poisoned upstream results.
- Escape engine names in the results footer (the one unescaped interpolation).
- API-gate Worker now fails closed (HTTP 500) when `SESSION_SECRET` or
  `TURNSTILE_SECRET` is unset, instead of signing cookies with an empty key.
- Worker rejects Turnstile tokens whose `hostname` doesn't match the site origin.
- CI (pull_request, fork-reachable) moved off the self-hosted production runner to
  GitHub-hosted runners; only push-to-main deploys use the self-hosted runner.
- Pinned GitHub Actions to commit SHAs.

## [1.0.0] - 2024

### Added
- Static HTML search interface for privacy-first web search
- Support for 150+ search engines
- Integration with SearXNG backend
- Cloudflare Pages deployment workflow
- Professional GitHub community files (CODE_OF_CONDUCT, CONTRIBUTING)
- Static assets: OG image, robots.txt, sitemap.xml
- Architecture documentation and privacy comparison
- Self-hosting guide in README
- GitHub workflow automation for deployment
- CODEOWNERS configuration
- Dependabot configuration for dependency updates

### Changed
- Search API calls now route through api.amnesia.tax (Cloudflare Pages frontend)
- Updated HTML with improved UI/UX

### Fixed
- Deploy workflow now includes OG, robots, and sitemap files

## Initial Release

- Multi-source search aggregator
- Privacy-focused implementation
