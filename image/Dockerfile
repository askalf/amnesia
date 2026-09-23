# amnesia, self-hosted: the amnesia.tax front end and SearXNG with amnesia's
# tuning, one container, one origin.
#
#   docker run -d --name amnesia -p 8080:8080 ghcr.io/askalf/amnesia
#
# Build from the repository root:  docker build -f image/Dockerfile .
#
# The base is the SearXNG digest the hosted instance runs (infra/docker-compose*.yml);
# Dependabot keeps it current. There is no RUN step: nothing is installed or
# downloaded at build time, so the image is the base plus the files below, and
# a multi-arch build needs no emulation. See docs/self-host.md.
FROM searxng/searxng@sha256:1a143665b6445079d1cd5b6facdf599d22ac9c29698dd2e7d15eb9b5f5a854cc

LABEL org.opencontainers.image.title="amnesia" \
      org.opencontainers.image.description="Privacy meta-search: the amnesia.tax front end and SearXNG in one container. Search the web. Remember nothing." \
      org.opencontainers.image.source="https://github.com/askalf/amnesia" \
      org.opencontainers.image.url="https://amnesia.tax" \
      org.opencontainers.image.documentation="https://github.com/askalf/amnesia/blob/main/docs/self-host.md" \
      org.opencontainers.image.licenses="MIT AND AGPL-3.0-or-later"

# Only the entrypoint takes --chmod, and it goes first: BuildKit gives a
# directory that a --chmod COPY creates the same mode as the file, so a 0644
# COPY here would leave /usr/local/amnesia untraversable for the searxng user
# (the container then dies with "can't open entrypoint.sh: Permission denied").
# The plain COPYs below create their directories 0755 and keep the files'
# mode from the checkout (0644).
COPY --chmod=0755 image/entrypoint.sh /usr/local/amnesia/entrypoint.sh
COPY image/settings.yml /usr/local/amnesia/settings.yml
COPY image/amnesia_app.py /usr/local/searxng/amnesia_app.py
COPY src/amnesia-search.html /usr/local/amnesia/site/index.html
COPY src/og.png /usr/local/amnesia/site/og.png
COPY src/fonts/space-mono-400.woff2 src/fonts/space-mono-700.woff2 /usr/local/amnesia/site/fonts/

# The base image runs as root; nothing here needs to.
USER searxng
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/amnesia/entrypoint.sh"]
