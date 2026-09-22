<div align="center">

# Amnesia

**Search the web. Remember nothing.**

A privacy meta-search engine with no accounts, no ads, no analytics, and no server-side query log — fronted by a bot gate that solves once per session, and egressing to the engines through a VPN. Live at **[amnesia.tax](https://amnesia.tax)**. Self-hostable from this repo.

[![Live](https://img.shields.io/badge/Live-amnesia.tax-10b981?style=for-the-badge)](https://amnesia.tax)
[![License](https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge)](LICENSE)

[![ci](https://github.com/askalf/amnesia/actions/workflows/ci.yml/badge.svg)](https://github.com/askalf/amnesia/actions/workflows/ci.yml)
[![CodeQL](https://github.com/askalf/amnesia/actions/workflows/codeql.yml/badge.svg)](https://github.com/askalf/amnesia/actions/workflows/codeql.yml)
[![canary](https://github.com/askalf/amnesia/actions/workflows/canary.yml/badge.svg)](https://github.com/askalf/amnesia/actions/workflows/canary.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/askalf/amnesia/badge)](https://scorecard.dev/viewer/?uri=github.com/askalf/amnesia)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14490/badge)](https://www.bestpractices.dev/projects/14490)

<a href="https://amnesia.tax"><img src=".github/readme-hero.webp" alt="amnesia.tax — search box with All / Images / News / Videos tabs, dark theme" width="100%"></a>

</div>

---

**Use it:** [amnesia.tax](https://amnesia.tax). **Run your own** in one line, then serve [`src/amnesia-search.html`](src/amnesia-search.html) in front of it ([self-host guide](docs/self-host.md)):

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng
```

**Check the claims yourself:** the origin refuses anything that did not come through the gate.

```bash
curl -s -o /dev/null -w '%{http_code}' 'https://search-origin.amnesia.tax/search?q=test'   # 403
```

## What sets it apart

Most privacy search front-ends are a stock [SearXNG](https://github.com/searxng/searxng) behind a reverse proxy. Amnesia is what you get when a SearXNG deployment is treated as production infrastructure:

- **A bot gate that isn't a per-query CAPTCHA.** A Cloudflare Worker sits in front of the backend. One Turnstile solve issues an HMAC-signed, 30-minute session cookie; every search after that is cookie-authenticated and never sees a challenge. The gate fails **closed** if its secrets are missing.
- **The auth boundary is fuzzed in CI.** ClusterFuzzLite drives the Worker's cookie sign/verify against forgery and splice attacks ([`fuzz/session.fuzz.js`](fuzz/session.fuzz.js)). OpenSSF Scorecard **Fuzzing** and **Token-Permissions** both score 10.
- **The origin cannot be reached around the gate.** A WAF rule on the backend hostname returns 403 to any request without the gate's secret header, plus zone rate limits on `/search` for both hosts. Try it: [`search-origin.amnesia.tax/search?q=test`](https://search-origin.amnesia.tax/search?q=test).
- **Engine traffic leaves through a VPN, from a hardened container.** SearXNG runs with `cap_drop: ALL`, a read-only root filesystem, `no-new-privileges`, a memory cap, and a digest-pinned image, and routes engine requests through a WireGuard tunnel (ProtonVPN via Gluetun).
- **A daily live canary, not just unit tests.** Every day at 14:17 UTC a GitHub-hosted job checks the deploy token's expiry and smoke-tests the live stack: site 200, gate 401, origin 403.
- **One 44 KB HTML file.** No framework, no build step, self-hosted fonts, no third-party request except the Turnstile challenge. Category tabs, per-result engine tags, debounced autocomplete, pagination, OpenSearch, dark/light.

## Reference

- **[Privacy model](docs/privacy-model.md)**: who sees what on a query's path, every guarantee with a command to check it, and the honest caveats.
- **[Architecture and security](docs/architecture.md)**: the front end, API gate, origin lock and backend, plus fuzzing, static analysis, runner isolation and deploy ordering.
- **[Engine coverage](docs/engines.md)**: what the hosted instance queries, why Google, Mojeek and Qwant are absent, and why engines get removed.
- **[Self-host](docs/self-host.md)**: the minimal and full production shapes, repository layout, and stack.

## Project

- [`CHANGELOG.md`](CHANGELOG.md) — what changed and why
- [`SECURITY.md`](SECURITY.md) — reporting a vulnerability
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to send a change
- [SearXNG](https://github.com/searxng/searxng) and [Gluetun](https://github.com/qdm12/gluetun) — the two projects this stands on
- [askalf.org](https://askalf.org) — the AI operation that runs Sprayberry Labs, including Amnesia

## License

MIT. Part of **[Own Your Stack](https://github.com/askalf)** — own your infrastructure instead of renting it by the token. Built by Thomas Sprayberry.
