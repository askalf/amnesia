#!/bin/sh
# amnesia self-host entrypoint.
#
# Replaces the stock SearXNG entrypoint, which ends by exec'ing
# searx.webapp:app; this one execs amnesia_app:app, the wrapper that serves the
# SPA at / and hands every other path to that same SearXNG app. The image runs
# as the unprivileged searxng user, so the stock script's chown and
# update-ca-certificates steps (root-only) are not carried over.
set -eu

# Settings: a settings.yml mounted at /etc/searxng wins, the stock SearXNG
# convention; otherwise the amnesia tuning baked into the image.
if [ -f /etc/searxng/settings.yml ]; then
  SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
  export SEARXNG_SETTINGS_PATH
  echo "amnesia: using the mounted /etc/searxng/settings.yml"
else
  SEARXNG_SETTINGS_PATH=/usr/local/amnesia/settings.yml
  export SEARXNG_SETTINGS_PATH

  # secret_key signs image-proxy URLs. The baked settings carry SearXNG's
  # refuse-to-start placeholder, so it always comes from SEARXNG_SECRET: yours
  # if you pass one, otherwise a random key generated on first start and kept
  # in the cache volume, so each container has its own and keeps it across
  # restarts. With a mounted settings.yml the key is left to that file.
  if [ -z "${SEARXNG_SECRET:-}" ]; then
    keyfile=/var/cache/searxng/.amnesia-secret
    if [ ! -s "$keyfile" ]; then
      (umask 077 && head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$keyfile") 2>/dev/null || rm -f "$keyfile" 2>/dev/null || true
    fi
    if [ -s "$keyfile" ]; then
      SEARXNG_SECRET=$(cat "$keyfile")
    else
      echo "amnesia: /var/cache/searxng is not writable; using a key for this start only" >&2
      SEARXNG_SECRET=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
    fi
    export SEARXNG_SECRET
  fi
fi

echo "amnesia: SearXNG $SEARXNG_VERSION, SPA at / (amnesia_app:app)"
exec /usr/local/searxng/.venv/bin/granian amnesia_app:app
