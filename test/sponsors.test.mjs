// scripts/sponsors.mjs: the README sponsors block. Pure functions only; the
// GraphQL read needs a token and is exercised by the daily workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeSponsors, renderReadmeBlock, replaceReadmeBlock, fetchSponsors, escapeMarkdownText, README_START, README_END,
} from '../scripts/sponsors.mjs';

const node = (login, monthly, extra = {}) => ({
  isOneTimePayment: false,
  tier: { monthlyPriceInDollars: monthly, isOneTime: false },
  sponsorEntity: { __typename: 'User', login, name: null },
  ...extra,
});

test('normalizeSponsors drops nodes without a login and sorts by tier, then login', () => {
  const out = normalizeSponsors([
    node('bea', 5), node('ada', 25), node('cal', 25), { sponsorEntity: null }, { sponsorEntity: { login: '' } }, null,
  ]);
  assert.deepEqual(out.map((s) => s.login), ['ada', 'cal', 'bea']);
  assert.deepEqual(normalizeSponsors(undefined), []);
});

test('only recurring sponsors at $25/month and up are named', () => {
  const block = renderReadmeBlock(normalizeSponsors([
    node('big', 100, { sponsorEntity: { login: 'big', name: ' Big Co ' } }),
    node('edge', 25),
    node('under', 24),
    node('small', 5),
    node('once', 500, { isOneTimePayment: true }),
    node('tieronce', 500, { tier: { monthlyPriceInDollars: 500, isOneTime: true } }),
  ]));
  assert.match(block, /- \[@big\]\(https:\/\/github\.com\/big\) \(Big Co\)/);
  assert.match(block, /\[@edge\]/);
  assert.doesNotMatch(block, /under|small|once|tieronce/);
});

test('with nobody to name, the block is one sentence pointing at Sponsors', () => {
  const block = renderReadmeBlock([]);
  assert.ok(block.startsWith(README_START) && block.endsWith(README_END));
  assert.match(block, /github\.com\/sponsors\/askalf/);
  assert.equal(block.split('\n').length, 3);
});

test('the README carries one marked block that replaceReadmeBlock can find', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(readme.split(README_START).length, 2);
  const current = readme.slice(readme.indexOf(README_START), readme.indexOf(README_END) + README_END.length);
  assert.equal(replaceReadmeBlock(readme, current), readme);
  assert.match(replaceReadmeBlock(readme, renderReadmeBlock([])), /github\.com\/sponsors\/askalf/);
  assert.throws(() => replaceReadmeBlock('no markers', renderReadmeBlock([])), /missing/);
});

const page = (nodes, hasNextPage, endCursor) => ({
  ok: true,
  json: async () => ({ data: { user: { sponsorshipsAsMaintainer: { nodes, pageInfo: { hasNextPage, endCursor } } } } }),
});

test('fetchSponsors follows every page before normalizing', async () => {
  process.env.GH_TOKEN = 'test-token';
  const cursors = [];
  const pages = [page([node('first', 25)], true, 'c1'), page([node('second', 100)], false, null)];
  const out = await fetchSponsors('askalf', async (_url, init) => {
    cursors.push(JSON.parse(init.body).variables.cursor);
    return pages.shift();
  });
  assert.deepEqual(cursors, [null, 'c1']);
  assert.deepEqual(out.map((s) => s.login), ['second', 'first']);
});

test('fetchSponsors fails rather than loop on a cursor that does not advance', async () => {
  process.env.GH_TOKEN = 'test-token';
  await assert.rejects(fetchSponsors('askalf', async () => page([], true, null)), /did not advance/);
  const repeat = [page([], true, 'c1'), page([], true, 'c1')];
  await assert.rejects(fetchSponsors('askalf', async () => repeat.shift()), /did not advance/);
  const lost = [page([], true, 'c1'), page([], true, null)];
  await assert.rejects(fetchSponsors('askalf', async () => lost.shift()), /did not advance/);
});

test('a sponsor display name renders as text, never as Markdown or HTML', () => {
  const hostile = '![beacon](https://attacker.example/pixel) <img src=x> [link](https://x.example)\n# heading';
  const block = renderReadmeBlock(normalizeSponsors([
    node('evil', 25, { sponsorEntity: { login: 'evil', name: hostile } }),
  ]));
  const line = block.split('\n').find((l) => l.startsWith('- [@evil]'));
  assert.ok(line, 'the sponsor is still listed');
  const name = line.slice('- [@evil](https://github.com/evil) '.length);
  assert.doesNotMatch(name, /(^|[^\\])(!\[|<img|\]\()/, 'no live image, tag or link survives');
  assert.equal(block.split('\n').length, 5, 'a newline in the name cannot start a new README line');
  assert.equal(escapeMarkdownText('Big Co'), 'Big Co');
});
