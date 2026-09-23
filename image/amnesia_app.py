"""amnesia self-host: the SPA at /, SearXNG for everything else, one origin.

granian serves this module (amnesia_app:app) instead of searx.webapp:app. It is
a WSGI wrapper around SearXNG's own app: GET/HEAD for the page and its fonts
are answered from /usr/local/amnesia/site; every other request, including
/search, /autocompleter, /image_proxy and /healthz, goes to SearXNG untouched.
Same origin means the page needs no API host, no CORS and no bot gate.

Two differences from the hosted page, both so a self-host never contacts
Cloudflare:
  - the Turnstile loader <script src=https://challenges.cloudflare.com/...> is
    removed from the served HTML (the page skips Turnstile on same-origin
    anyway, see API_BASE in src/amnesia-search.html), and so is the
    <link rel=preconnect> to the hosted API gate, which would otherwise open
    a connection to api.amnesia.tax on every page load;
  - the Content-Security-Policy names no third-party origin, so even an
    unstripped loader could not run.

The CSP allows the page's inline <script>/<style> by SHA-256 hash, computed
here from the served bytes the same way scripts/csp-hashes.mjs does it for
src/_headers; the image's CI smoke test checks the two agree.

Standard library only: nothing is installed into the image.
"""

import base64
import hashlib
import os
import re

from searx.webapp import app as searxng

SITE = os.environ.get("AMNESIA_SITE_DIR", "/usr/local/amnesia/site")

TURNSTILE_LOADER = re.compile(
    r'[ \t]*<script\b[^>]*\bsrc="https://challenges\.cloudflare\.com/[^"]*"[^>]*>\s*</script>[ \t]*\n?',
    re.IGNORECASE,
)

API_PRECONNECT = re.compile(
    r'[ \t]*<link\b[^>]*\brel="preconnect"[^>]*\bhref="https://api\.amnesia\.tax"[^>]*>[ \t]*\n?',
    re.IGNORECASE,
)


def _read(*parts):
    with open(os.path.join(SITE, *parts), "rb") as f:
        return f.read()


def _inline_blocks(html, tag):
    """Inline blocks of one kind, in document order: the text between the tags, untouched."""
    out = []
    for m in re.finditer(r"<%s\b([^>]*)>([\s\S]*?)</%s>" % (tag, tag), html, re.IGNORECASE):
        if tag == "script" and re.search(r"\bsrc\s*=", m.group(1), re.IGNORECASE):
            continue
        out.append(m.group(2))
    return out


def _sha256(text):
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "'sha256-%s'" % base64.b64encode(digest).decode("ascii")


def _page():
    html = _read("index.html").decode("utf-8")
    html, removed = TURNSTILE_LOADER.subn("", html)
    if removed != 1:
        print("amnesia: expected one Turnstile loader in index.html, removed %d" % removed, flush=True)
    html, removed = API_PRECONNECT.subn("", html)
    if removed != 1:
        print("amnesia: expected one api.amnesia.tax preconnect in index.html, removed %d" % removed, flush=True)
    scripts = " ".join(_sha256(b) for b in _inline_blocks(html, "script"))
    styles = " ".join(_sha256(b) for b in _inline_blocks(html, "style"))
    csp = "; ".join([
        "default-src 'self'",
        "script-src 'self' " + scripts,
        "style-src 'self' " + styles,
        "font-src 'self'",
        # Thumbnails: image_proxy rewrites them to this origin; https: is kept
        # for parity with the hosted CSP (src/_headers) for any result field
        # SearXNG does not proxy.
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
    ])
    headers = [
        ("Content-Type", "text/html; charset=utf-8"),
        ("Content-Security-Policy", csp),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
        ("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()"),
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Cache-Control", "no-cache"),
    ]
    return html.encode("utf-8"), headers


def _asset(content_type, *parts):
    return _read(*parts), [
        ("Content-Type", content_type),
        ("X-Content-Type-Options", "nosniff"),
        ("Cache-Control", "public, max-age=31536000, immutable"),
    ]


ROUTES = {"/": _page(), "/og.png": _asset("image/png", "og.png")}
for _name in sorted(os.listdir(os.path.join(SITE, "fonts"))):
    ROUTES["/fonts/" + _name] = _asset("font/woff2", "fonts", _name)

# /opensearch.xml ("add amnesia as a search engine") must name this instance's
# own origin, which only the request knows: SEARXNG_BASE_URL when set (the same
# variable SearXNG reads behind a reverse proxy), else X-Forwarded-Proto plus
# the Host header. A Host that is not a plain host[:port] falls through to
# SearXNG's own /opensearch.xml rather than being echoed into XML.
HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(:[0-9]{1,5})?$|^\[[0-9A-Fa-f:.]+\](:[0-9]{1,5})?$")
OPENSEARCH = """<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>amnesia</ShortName>
  <Description>Search the web. Remember nothing.</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="{origin}/?q={{searchTerms}}"/>
  <Url type="application/x-suggestions+json" method="get" template="{origin}/autocompleter?q={{searchTerms}}"/>
</OpenSearchDescription>
"""


def _origin(environ):
    base = os.environ.get("SEARXNG_BASE_URL", "").strip().rstrip("/")
    if re.match(r"^https?://[A-Za-z0-9.:\[\]-]+(/[A-Za-z0-9._~/-]*)?$", base):
        return base
    host = environ.get("HTTP_HOST", "")
    if not HOST_RE.match(host):
        return None
    proto = environ.get("HTTP_X_FORWARDED_PROTO", "").split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = environ.get("wsgi.url_scheme", "http")
    return "%s://%s" % (proto, host)


def _opensearch(environ):
    origin = _origin(environ)
    if origin is None:
        return None
    return OPENSEARCH.format(origin=origin).encode("utf-8"), [
        ("Content-Type", "application/opensearchdescription+xml; charset=utf-8"),
        ("X-Content-Type-Options", "nosniff"),
        ("Cache-Control", "no-store"),
    ]


def app(environ, start_response):
    path = environ.get("PATH_INFO") or "/"
    method = environ.get("REQUEST_METHOD", "GET")
    route = None
    if method in ("GET", "HEAD"):
        route = _opensearch(environ) if path == "/opensearch.xml" else ROUTES.get(path)
    if route is None:
        return searxng(environ, start_response)
    body, headers = route
    start_response("200 OK", headers + [("Content-Length", str(len(body)))])
    return [b""] if method == "HEAD" else [body]
