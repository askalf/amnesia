<div align="center">

# Amnesia

**Search the web. Remember nothing.**

Privacy-first search aggregator. No tracking, no ads, no cookies, no search history. 155+ search engines via SearXNG + encrypted VPN tunnel. Self-hosted.

[![Live](https://img.shields.io/badge/Live-amnesia.tax-10b981?style=for-the-badge)](https://amnesia.tax)
[![License](https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge)](LICENSE)

</div>

---

## Features

- **155+ search engines** — Google, Brave, DuckDuckGo, Bing, Yahoo, Startpage, Mojeek, Qwant, and many more
- **Multi-source aggregation** — pulls and merges results from multiple engines simultaneously
- **Category tabs** — All, Images, News, Videos, Music, Science, Social, Files
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
│  ▸ Result Title — other.com       [Brave]    │
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

## Search Engines

155+ engines across all categories:

| Category | Engines |
|----------|---------|
| **Web** | Google, Brave, DuckDuckGo, Bing, Startpage, Mojeek, Qwant, Yahoo, Yandex, Yep, Ask |
| **News** | Google News, Brave News, Bing News, DDG News, Yahoo News, Wikinews |
| **Images** | Google, Brave, Bing, DDG, Unsplash, Pexels, Pixabay, Flickr, Pinterest |
| **Videos** | Google, YouTube, Brave, Bing, DDG, Dailymotion, Vimeo, Rumble, Odysee |
| **Science** | Google Scholar, arXiv, PubMed, Semantic Scholar, OpenAlex |
| **Social** | Reddit, Lemmy, Mastodon, 9gag |
| **Music** | Genius, Bandcamp, Soundcloud, Deezer |
| **Dev** | GitHub, GitLab, StackOverflow, npm, PyPI, Docker Hub, HuggingFace |
| **Files** | 1337x, Piratebay, Library Genesis, Anna's Archive |
| **Maps** | Apple Maps, OpenStreetMap |

All engines routed through VPN — search providers see the VPN exit IP, not yours.

## Architecture

```
Browser → Cloudflare Tunnel → Nginx (cache + rate limit)
                                  ↓
                              amnesia-search.html (static, 31KB)
                                  ↓ (API calls)
                              SearXNG (155+ engines) → Gluetun VPN → Search Engines
                                  ↑
                              Redis (result cache)
```

- **Single HTML file** — no build step, no framework, no dependencies
- **SearXNG backend** — meta-search aggregator, no API keys needed
- **Cloudflare Tunnel** — zero-trust access, DDoS protection
- **Gluetun VPN** — all outbound search queries encrypted through WireGuard (ProtonVPN)
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

`HTML` · `CSS` · `JavaScript` · `SearXNG` · `Nginx` · `Redis` · `Gluetun VPN` · `Cloudflare Tunnel` · `ProtonVPN`

## Related

- [AskAlf](https://askalf.org) — self-hosted AI workforce platform (includes Amnesia)
- [SearXNG](https://github.com/searxng/searxng) — the meta-search engine that powers Amnesia
- [Gluetun](https://github.com/qdm12/gluetun) — VPN tunnel for containerized services

## License

MIT — [askalf.org](https://askalf.org) · Live at [amnesia.tax](https://amnesia.tax)

---
amnesia is by the maker of **[Own Your Stack](https://github.com/askalf)** — own your AI infrastructure instead of renting it.
