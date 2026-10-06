import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/check-readme-links.mjs', import.meta.url));

// The checker is a CLI with no exports, so drive it the way CI does: one
// markdown file whose headings are under test and a link to the anchor.
function check(heading, anchor) {
  const dir = mkdtempSync(join(tmpdir(), 'amnesia links-'));
  try {
    const file = join(dir, 'doc.md');
    writeFileSync(file, `## ${heading}\n\n[link](#${anchor})\n`);
    return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const resolves = (heading, anchor) => assert.equal(check(heading, anchor).status, 0, `${heading} → #${anchor} should resolve`);
const rejects = (heading, anchor) => assert.equal(check(heading, anchor).status, 1, `${heading} → #${anchor} should fail`);

test('underscore emphasis delimiters are not part of the slug', () => {
  resolves('_Setup_', 'setup');
  resolves('__Setup__', 'setup');
  resolves('a _b __c__ d_', 'a-b-c-d');
  rejects('_Setup_', '_setup_');
  rejects('__Setup__', '__setup__');
});

test('literal underscores in identifiers stay in the slug', () => {
  resolves('SESSION_TTL', 'session_ttl');
  resolves('snake_case _and_ more', 'snake_case-and-more');
  resolves('`_raw_`', '_raw_');
  rejects('SESSION_TTL', 'sessionttl');
});

test('asterisk emphasis and punctuation still drop out', () => {
  resolves('**Bold** *it*: done!', 'bold-it-done');
});
