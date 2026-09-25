import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sectionFor } from '../scripts/release-notes.mjs';

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
