import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMainModule, sectionFor } from '../scripts/release-notes.mjs';

const log = '# Changelog\n\n## [Unreleased]\n\n## [2.0.0] - 2026-01-02\n\n### Added\n- two\n\n## [1.0.0] - 2025-01-01\n\n### Fixed\n- one\n';

test('sectionFor returns one version, stopping at the next heading', () => {
  assert.equal(sectionFor(log, '2.0.0'), '### Added\n- two');
  assert.equal(sectionFor(log, '1.0.0'), '### Fixed\n- one');
});

test('sectionFor returns null for a missing or empty version', () => {
  assert.equal(sectionFor(log, '3.0.0'), null);
  assert.equal(sectionFor(log, 'Unreleased'), null);
});

test('the real CHANGELOG has a 1.1.0 section', () => {
  const s = sectionFor(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), '1.1.0');
  assert.ok(s && s.startsWith('### Added'));
});

// The release job runs the script as a CLI and publishes whatever it prints.
// Run it from a directory whose path needs URL escaping (a space, `%` and
// non-ASCII) so the main-module check is exercised the way a real checkout
// can hit it, on every OS.
function runFromAwkwardPath(...args) {
  const root = mkdtempSync(join(tmpdir(), 'amnesia notes %20 é-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../scripts/release-notes.mjs', import.meta.url), join(root, 'scripts', 'release-notes.mjs'));
    writeFileSync(join(root, 'CHANGELOG.md'), log);
    return spawnSync(process.execPath, [join(root, 'scripts', 'release-notes.mjs'), ...args], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the CLI prints the notes when its path contains a space', () => {
  const r = runFromAwkwardPath('v2.0.0');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /### Added\n- two\n$/);
});

test('the CLI fails, rather than printing nothing, for a version with no section', () => {
  const r = runFromAwkwardPath('v3.0.0');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no section for 3\.0\.0/);
});

test('isMainModule matches a path with a space and rejects other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amnesia main check-'));
  try {
    const script = join(dir, 'a script.mjs');
    writeFileSync(script, '');
    writeFileSync(join(dir, 'other.mjs'), '');
    assert.equal(isMainModule(pathToFileURL(script).href, script), true);
    assert.equal(isMainModule(pathToFileURL(script).href, join(dir, 'other.mjs')), false);
    assert.equal(isMainModule(pathToFileURL(script).href, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
