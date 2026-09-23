#!/usr/bin/env bash
# Assemble the static site into deploy/ for Cloudflare Pages.
#
# The Pages build command runs this (output directory: deploy). It is the
# "Prepare deploy directory" step of the old GitHub Actions deploy, moved into
# the build so the Git integration publishes the same files with no Cloudflare
# credentials in this repo. The API Worker is a separate deploy
# (deploy-worker.yml) and is not touched here.
#
# src/fonts is required: the CSP no longer allows Google Fonts, so a build
# without the self-hosted Space Mono must fail rather than ship a site that
# renders in the fallback face.
set -eo pipefail
cd "$(dirname "$0")/.."
rm -rf deploy
mkdir -p deploy
cp src/amnesia-search.html deploy/index.html
cp src/og.png deploy/og.png 2>/dev/null || true
cp src/robots.txt deploy/robots.txt 2>/dev/null || true
cp src/sitemap.xml deploy/sitemap.xml 2>/dev/null || true
# Required, not best-effort: the page links /opensearch.xml, and without the
# file Pages answers that URL with the HTML page (the SPA fallback), so
# "add amnesia to your browser" fails with no visible error.
cp src/opensearch.xml deploy/opensearch.xml
cp src/_headers deploy/_headers 2>/dev/null || true
cp -r src/fonts deploy/fonts
echo "build-site: deploy/ holds $(find deploy -type f | wc -l) file(s):"
find deploy -type f | sort
