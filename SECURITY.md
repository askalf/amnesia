# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in amnesia, please report it responsibly to:

**Email:** security@askalf.org

We will:
- Acknowledge your report within **48 hours**
- Work on a fix and release a patch
- Credit you in the security advisory (unless you request anonymity)

Critical vulnerabilities will be patched within **7 days** of confirmation.

## Scope

Amnesia is a privacy-first, static HTML search interface with the following security considerations:

### In Scope
- Search query privacy and logging
- Proxy bypass vulnerabilities
- XSS in search results
- Credential exposure (API keys, tokens)
- SearXNG configuration leaks
- Authentication/authorization issues
- Data exposure or leakage

### Out of Scope
- Third-party dependencies (report directly to the maintainer)
- Infrastructure vulnerabilities (report to hosting provider)
- DoS attacks without evidence of a specific vulnerability
- Speculative or theoretical attacks without proof of concept

## Security Best Practices

When self-hosting amnesia:
- Keep your SearXNG instance updated
- Use HTTPS for all connections
- Secure your reverse proxy (Nginx, Cloudflare Tunnel)
- Restrict network access appropriately
- Monitor logs for suspicious activity
- Use strong VPN/tunnel configurations if applicable

## Contact

For security matters: security@askalf.org
For other inquiries: support@askalf.org
