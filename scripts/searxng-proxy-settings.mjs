#!/usr/bin/env node
// SearXNG settings for the rollback (proxy) shape, generated from the live one.
//
// The live stack (infra/docker-compose.vpn.yml) runs SearXNG inside gluetun's
// network namespace, so infra/searxng/settings.yml has no `outgoing.proxies`:
// the tunnel is the only route out and a proxy would only add a relay hop.
// The rollback stack (infra/docker-compose.yml) puts SearXNG on the platform
// network, where the proxy setting is the ONLY thing sending engine traffic
// through the VPN: the pinned SearXNG builds its httpx clients with an explicit
// transport, which makes httpx ignore HTTP_PROXY/HTTPS_PROXY from the
// environment, so without it every engine request would leave by the host IP.
// That shape therefore mounts infra/searxng-proxy/, whose settings.yml is the
// live file plus the proxy block, and CI refuses a commit where the two drift.
//
//   node scripts/searxng-proxy-settings.mjs            print the generated file
//   node scripts/searxng-proxy-settings.mjs --write    rewrite infra/searxng-proxy/settings.yml
//   node scripts/searxng-proxy-settings.mjs --check    exit 1 when it is stale

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
export const LIVE_PATH = resolve(here, '..', 'infra', 'searxng', 'settings.yml');
export const PROXY_PATH = resolve(here, '..', 'infra', 'searxng-proxy', 'settings.yml');

const HEADER = `# GENERATED — do not edit. Source: infra/searxng/settings.yml
# Regenerate: node scripts/searxng-proxy-settings.mjs --write
#
# The rollback (proxy) shape's settings, mounted by infra/docker-compose.yml:
# the live settings plus \`outgoing.proxies\`, because in that shape the proxy
# setting is the only thing sending engine traffic through the VPN.

`;

const PROXIES = `  # Rollback shape only: SearXNG shares the platform network here, so this is
  # what sends every engine request through the platform gluetun's ProtonVPN.
  proxies:
    all://:
      - http://gluetun:8888
`;

/** The proxy-shape settings text for the live settings text; throws on an unexpected shape. */
export function proxySettings(live) {
  const marker = '\noutgoing:\n';
  if (live.split(marker).length !== 2) throw new Error('infra/searxng/settings.yml must have exactly one top-level `outgoing:` block');
  if (/^  proxies:/m.test(live)) throw new Error('infra/searxng/settings.yml already sets `proxies:` — the live shape must not, it runs inside gluetun');
  return HEADER + live.replace(marker, marker + PROXIES);
}

function main() {
  const args = process.argv.slice(2);
  const want = proxySettings(readFileSync(LIVE_PATH, 'utf8'));
  let have = null;
  try { have = readFileSync(PROXY_PATH, 'utf8'); } catch { /* missing counts as stale */ }

  if (args.includes('--write')) {
    if (have === want) { console.log('infra/searxng-proxy/settings.yml already matches infra/searxng/settings.yml'); return; }
    mkdirSync(dirname(PROXY_PATH), { recursive: true });
    writeFileSync(PROXY_PATH, want);
    console.log('infra/searxng-proxy/settings.yml updated');
    return;
  }
  if (args.includes('--check')) {
    if (have === want) { console.log('ok  infra/searxng-proxy/settings.yml matches infra/searxng/settings.yml'); return; }
    console.error('FAIL: infra/searxng-proxy/settings.yml is stale — infra/searxng/settings.yml changed without regenerating it.');
    console.error('      Run: node scripts/searxng-proxy-settings.mjs --write');
    process.exit(1);
  }
  process.stdout.write(want);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
