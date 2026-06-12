# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Live search suggestions: debounced autocomplete dropdown backed by the API
  gate's `/autocompleter` endpoint (keyboard navigation, click/tap select).
  Best-effort — rides the session cookie and never triggers Turnstile solves.

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
