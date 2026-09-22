# Amnesia architecture and security

Back to the [README](../README.md).

## Architecture

```mermaid
flowchart LR
    B["browser"] --> P["Cloudflare Pages<br/>static SPA · CSP + HSTS"]
    B --> W["API-gate Worker<br/>Turnstile once → HMAC session cookie<br/>edge cache: search 3 m · autocomplete 6 h"]
    W -->|"secret header,<br/>WAF-locked origin"| T["Cloudflare Tunnel"]
    T --> S["SearXNG<br/>hardened container"]
    S -->|"HTTP(S)_PROXY"| V["Gluetun<br/>WireGuard / ProtonVPN"]
    V --> E["search engines"]
```

- **Front end** — [`src/amnesia-search.html`](../src/amnesia-search.html), 44 KB, self-contained. Pre-warms the session cookie on page load so the first search never waits on Turnstile; on a 401 it solves once and retries. Autocomplete is best-effort and never triggers a challenge.
- **API gate** — [`worker/src/index.js`](../worker/src/index.js). Authorizes (cookie, else token, else 401), proxies `/search` and `/autocompleter` to the origin with the secret header, and stores successful answers at the edge under a key built from the normalized query and sorted params. Clients always receive `no-store`; the edge copy's own `cache-control` governs its lifetime.
- **Origin lock** — the backend hostname answers only to the Worker. WAF returns 403 without the secret header; zone rate limits cover `/search` on both hosts.
- **Backend** — one SearXNG container, no result cache, no Redis or Valkey, no nginx. Fewer components holding a query is the design goal, not a shortcut. Outgoing request timeout is 4 s with an 8 s ceiling: healthy engines answer well under 1.5 s, and a flaky one is bounded rather than waited on.

## Security

- **Fuzzing** — [`fuzz/session.fuzz.js`](../fuzz/session.fuzz.js) pins the cookie contract: never throws on a hostile value, never verifies a value the operator's secret did not sign, always round-trips under its own secret and never under another. Runs weekly in ClusterFuzzLite and locally via `npm run fuzz`. The target is async (WebCrypto HMAC), so it runs in Jazzer's async mode.
- **Static analysis** — CodeQL on every push and PR; OpenSSF Scorecard weekly. All actions are SHA-pinned.
- **Runner isolation** — CI for fork-reachable workflows runs on GitHub-hosted runners. Only the deploy jobs, which run from `main` after review, touch the self-hosted deploy host.
- **Deploys are serialised** — Pages and Worker deploys queue rather than cancel, so two pushes to `main` never land out of order or half-applied.
- **Disclosure** — see [`SECURITY.md`](../SECURITY.md). Please do not open a public issue for a vulnerability.
