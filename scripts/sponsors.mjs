#!/usr/bin/env node
/**
 * The README's sponsors block, rebuilt from the public sponsor list.
 *
 * The GitHub Sponsors tiers on github.com/sponsors/askalf promise $25+
 * sponsors a line in the README. This keeps that promise without anyone
 * remembering to (same query and rules as dario's scripts/sponsors.mjs):
 *
 *   node scripts/sponsors.mjs            print the block
 *   node scripts/sponsors.mjs --write    rewrite the README block in place
 *
 * Reads the maintainer's ACTIVE, PUBLIC sponsorships through the GraphQL
 * API (`GH_TOKEN` / `GITHUB_TOKEN`, or `gh auth token`). Private sponsors
 * are never named: the query does not ask for them. `--write` exits 1 when
 * the list could not be read, so a failed read never empties the block.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MAINTAINER = 'askalf';
export const README_START = '<!-- sponsors:start -->';
export const README_END = '<!-- sponsors:end -->';
/** Tiers at or above this monthly amount promised a README line. */
export const README_TIER_MIN_USD = 25;

const SPONSOR_URL = `https://github.com/sponsors/${MAINTAINER}`;

const QUERY = `query($login: String!) {
  user(login: $login) {
    sponsorshipsAsMaintainer(first: 100, activeOnly: true, includePrivate: false) {
      nodes {
        isOneTimePayment
        tier { monthlyPriceInDollars isOneTime }
        sponsorEntity {
          __typename
          ... on User { login name }
          ... on Organization { login name }
        }
      }
    }
  }
}`;

/** Sponsorship nodes → { login, name, monthly, oneTime }, highest tier first. Nodes without a login are dropped. */
export function normalizeSponsors(nodes) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const e = n && n.sponsorEntity;
    if (!e || typeof e.login !== 'string' || e.login.length === 0) continue;
    const monthly = n.tier && typeof n.tier.monthlyPriceInDollars === 'number' ? n.tier.monthlyPriceInDollars : 0;
    const oneTime = Boolean(n.isOneTimePayment || (n.tier && n.tier.isOneTime));
    out.push({ login: e.login, name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : null, monthly, oneTime });
  }
  return out.sort((a, b) => (b.monthly - a.monthly) || a.login.localeCompare(b.login));
}

const mention = (s) => `[@${s.login}](https://github.com/${s.login})`;

/** The block, markers included: the $25+ monthly sponsors, or one sentence when there are none yet. */
export function renderReadmeBlock(sponsors) {
  const named = sponsors.filter((s) => !s.oneTime && s.monthly >= README_TIER_MIN_USD);
  const lines = [README_START];
  if (named.length === 0) {
    lines.push(`amnesia has no ads and no tracking, so it is funded by its users through [GitHub Sponsors](${SPONSOR_URL}): the VPN exit and the server behind the hosted instance are the running costs. Sponsors at $${README_TIER_MIN_USD}/month and up are listed here.`);
  } else {
    lines.push(`amnesia has no ads and no tracking, so it is funded by its users through [GitHub Sponsors](${SPONSOR_URL}). Thank you:`);
    lines.push('');
    for (const s of named) lines.push(`- ${mention(s)}${s.name ? ` (${s.name})` : ''}`);
  }
  lines.push(README_END);
  return lines.join('\n');
}

/** Replace the marked block in README text; throws when the markers are missing. */
export function replaceReadmeBlock(readme, block) {
  const a = readme.indexOf(README_START);
  const b = readme.indexOf(README_END);
  if (a === -1 || b === -1 || b < a) throw new Error(`README is missing the ${README_START} … ${README_END} markers`);
  return readme.slice(0, a) + block + readme.slice(b + README_END.length);
}

function token() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

export async function fetchSponsors(login = MAINTAINER, fetchImpl = fetch) {
  const t = token();
  if (!t) throw new Error('no GitHub token (GH_TOKEN / GITHUB_TOKEN / gh auth)');
  const res = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${t}`, 'content-type': 'application/json', 'user-agent': 'amnesia-sponsors' },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  const nodes = json && json.data && json.data.user && json.data.user.sponsorshipsAsMaintainer && json.data.user.sponsorshipsAsMaintainer.nodes;
  if (!Array.isArray(nodes)) throw new Error(`unexpected GraphQL shape: ${JSON.stringify(json).slice(0, 200)}`);
  return normalizeSponsors(nodes);
}

async function main() {
  const write = process.argv.includes('--write');
  let sponsors;
  try {
    sponsors = await fetchSponsors();
  } catch (err) {
    console.error(`sponsors: ${err.message}`);
    process.exit(1);
  }
  const block = renderReadmeBlock(sponsors);
  if (!write) { process.stdout.write(block + '\n'); return; }
  const path = resolve(fileURLToPath(new URL('../README.md', import.meta.url)));
  const before = readFileSync(path, 'utf8');
  const after = replaceReadmeBlock(before, block);
  if (after !== before) { writeFileSync(path, after); console.error('sponsors: README block updated'); }
  else console.error('sponsors: README block unchanged');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) await main();
