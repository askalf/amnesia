<div align="center">

# Amnesia

**Search the web. Remember nothing.**

Privacy-first search aggregator. No tracking, no ads, no cookies, no search history. Self-hosted via SearXNG + VPN tunnel.

[![Live](https://img.shields.io/badge/Live-amnesia.tax-10b981?style=for-the-badge)](https://amnesia.tax)
[![License](https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge)](LICENSE)

</div>

---

## Features

- **Multi-source aggregation** — pulls and merges results from multiple search engines simultaneously via SearXNG
- **Category tabs** — All, Images, News, Videos
- **Engine tags** — see which sources contributed each result
- **Autocomplete** — search suggestions as you type
- **Pagination** — full result navigation
- **Search timing** — see how fast your query resolved
- **OpenSearch integration** — add Amnesia as your browser's default search engine
- **Dark/Light mode** — respects system preference, toggleable
- **Zero tracking** — no cookies, no analytics, no search history stored
- **Self-contained** — single HTML file (~31KB), inline CSS/JS, no external dependencies

## Screenshot

```
┌──────────────────────────────────────────────┐
│  amnesia                          ☀ / ☾      │
│                                              │
│  ┌──────────────────────────────────┐        │
│  │  Search the web...               │  🔍    │
│  └──────────────────────────────────┘        │
│                                              │
│  All    Images    News    Videos              │
│                                              │
│  ▸ Result Title — source.com      [Google]   │
│    Description of the search result...       │
│                                              │
│  ▸ Result Title — other.com       [Bing]     │
│    Description of the search result...       │
│                                              │
│  ◂ 1  2  3  4  5 ▸        0.34s · 47 results│
└──────────────────────────────────────────────┘
```

## Self-Host

### With Docker (standalone)

```bash
docker run -d --name amnesia \
  -p 8080:8080 \
  searxng/searxng

# Serve amnesia-search.html via any static file server
# pointing to your SearXNG instance
```

### With AskAlf (recommended)

Amnesia is included in the AskAlf webhost stack with VPN tunneling, rate limiting, and Cloudflare tunnel:

```bash
curl -fsSL https://get.askalf.org | bash
```

The AskAlf deployment routes all SearXNG search traffic through an encrypted WireGuard VPN tunnel via Gluetun — search providers never see your real IP.

## Architecture

```
Browser → Cloudflare Tunnel → Nginx (cache + rate limit)
                                  ↓
                              amnesia-search.html (static, 31KB)
                                  ↓ (API calls)
                              SearXNG → Gluetun VPN → Search Engines
                                  ↑
                              Redis (result cache)
```

- **Single HTML file** — no build step, no framework, no dependencies
- **SearXNG backend** — meta-search aggregator, no API keys needed
- **Cloudflare Tunnel** — zero-trust access, DDoS protection
- **Gluetun VPN** — all outbound search queries encrypted through WireGuard
- **Nginx** — response caching (60s TTL), rate limiting, security headers
- **Redis** — SearXNG result caching for faster repeated queries

## Privacy

| | Amnesia | Google | Bing | DuckDuckGo |
|---|:---:|:---:|:---:|:---:|
| Cookies | None | Yes | Yes | Yes |
| Search history | None | Stored | Stored | None* |
| IP logging | None | Yes | Yes | Partial |
| Ads | None | Yes | Yes | Yes |
| Tracking pixels | None | Yes | Yes | None |
| JavaScript required | Yes | Yes | Yes | No |

*DuckDuckGo doesn't store searches but does log metadata.

Amnesia stores nothing. No accounts. No cookies. No server-side logs. The SearXNG backend proxies queries to search engines — they see the VPN exit IP, not yours.

## Stack

`HTML` · `CSS` · `JavaScript` · `Nginx` · `SearXNG` · `Redis` · `Gluetun VPN` · `Cloudflare Tunnel`

## Related

- [AskAlf](https://github.com/SprayberryLabs/askalf) — autonomous AI agent fleet (includes Amnesia in the webhost stack)
- [SearXNG](https://github.com/searxng/searxng) — the meta-search engine that powers Amnesia
- [Gluetun](https://github.com/qdm12/gluetun) — VPN tunnel for containerized services

## License

MIT — Built by [Sprayberry Labs](https://github.com/SprayberryLabs) · Live at [amnesia.tax](https://amnesia.tax)
