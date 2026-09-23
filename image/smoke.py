#!/usr/bin/env python3
"""Smoke test for a running amnesia image.

    python3 image/smoke.py http://127.0.0.1:8080

Run by .github/workflows/image.yml against the freshly built image before it
is pushed, and usable against any self-hosted instance. Standard library only.
Every check prints one line; any failure exits 1.
"""

import base64
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080").rstrip("/")
failures = 0


def check(ok, what):
    global failures
    print(("ok    " if ok else "FAIL  ") + what)
    if not ok:
        failures += 1


def get(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


# Wait for the container to answer (granian + SearXNG start in a few seconds).
for _ in range(60):
    try:
        if get("/healthz")[0] == 200:
            break
    except OSError:
        pass
    time.sleep(1)

status, _, _ = get("/healthz")
check(status == 200, "/healthz answers 200")

status, headers, body = get("/")
html = body.decode("utf-8", "replace")
headers = {k.lower(): v for k, v in headers.items()}
check(status == 200 and headers.get("content-type", "").startswith("text/html"), "/ serves HTML")
check("<title>amnesia" in html, "/ is the amnesia page, not SearXNG's own UI")
check("challenges.cloudflare.com" not in html, "the page loads nothing from Cloudflare (Turnstile loader stripped)")
check(re.search(r"const API_BASE = window\.location\.hostname === 'amnesia\.tax' \? 'https://api\.amnesia\.tax' : '';", html) is not None,
      "API_BASE is same-origin off the hosted apex")

csp = headers.get("content-security-policy", "")
check(bool(csp) and "unsafe-inline" not in csp, "CSP present, no 'unsafe-inline'")
check("cloudflare" not in csp, "CSP names no third-party origin")
check(re.search(r"(^|;)\s*connect-src 'self'\s*(;|$)", csp) is not None,
      "connect-src 'self' only: the page cannot send a query to any other origin")


def sha(block):
    return "'sha256-%s'" % base64.b64encode(hashlib.sha256(block.encode("utf-8")).digest()).decode()


inline_scripts = [m.group(2) for m in re.finditer(r"<script\b([^>]*)>([\s\S]*?)</script>", html)
                  if not re.search(r"\bsrc\s*=", m.group(1))]
inline_styles = [m.group(1) for m in re.finditer(r"<style\b[^>]*>([\s\S]*?)</style>", html)]
check(bool(inline_scripts) and all(sha(s) in csp for s in inline_scripts),
      "CSP hash matches the served inline <script> (the page's JS will run)")
check(all(sha(s) in csp for s in inline_styles), "CSP hash matches the served inline <style>")

status, headers, _ = get("/fonts/space-mono-400.woff2")
check(status == 200 and "font/woff2" in {k.lower(): v for k, v in headers.items()}.get("content-type", ""),
      "self-hosted font served")

status, _, body = get("/opensearch.xml", {"Host": "search.example.org"})
check(status == 200 and b'template="http://search.example.org/?q={searchTerms}"' in body,
      "/opensearch.xml names the instance's own origin")

status, headers, body = get("/search?q=amnesia&format=json")
try:
    data = json.loads(body)
except ValueError:
    data = None
check(status == 200 and isinstance(data, dict) and data.get("query") == "amnesia",
      "/search?format=json answers JSON on the same origin (no gate, no CORS)")
if isinstance(data, dict):
    # Not asserted: engines may refuse a CI runner's datacenter IP.
    print("info  %d results; unresponsive engines: %s" % (
        len(data.get("results", [])), ", ".join(e[0] for e in data.get("unresponsive_engines", [])) or "none"))

status, _, body = get("/autocompleter?q=amne")
check(status == 200, "/autocompleter answers")

sys.exit(1 if failures else 0)
