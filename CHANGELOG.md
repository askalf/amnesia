# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
