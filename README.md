# Amnesia — Multi-Source Search Aggregator

A clean, fast search engine that aggregates results from multiple sources into a single, distraction-free interface. No tracking, no ads, no search history.

**Live at [amnesia.tax](https://amnesia.tax)**

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
- **Self-contained** — single HTML file, inline CSS/JS, no external dependencies

## Architecture

- Single static HTML file (~31KB) served by Nginx
- SearXNG backend for multi-engine search aggregation (no API keys needed)
- Cloudflare Tunnel for zero-trust access
- Response caching for performance (60s TTL)
- Rate limiting to prevent abuse

## Stack

`HTML` · `CSS` · `JavaScript` · `Nginx` · `SearXNG` · `Cloudflare`

## About

Built by **Sprayberry Labs**. Live in production at [amnesia.tax](https://amnesia.tax).
