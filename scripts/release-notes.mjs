#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, for the GitHub release notes.
//
//   node scripts/release-notes.mjs 1.1.0
//
// Exits 1 when the version has no section, so a tag pushed without a
// CHANGELOG entry fails the release job instead of publishing empty notes.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when this file is the script node was asked to run. Compared as
// resolved filesystem paths, not as strings glued onto `file://`: a URL
// percent-encodes spaces, `%` and non-ASCII, and a Windows path has a drive
// letter and backslashes, so the string form never matches there and the
// script would exit 0 with no output.
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

export function sectionFor(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body || null;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const version = (process.argv[2] || '').replace(/^v/, '');
  const notes = version && sectionFor(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  if (!notes) {
    console.error(`release-notes: CHANGELOG.md has no section for ${version || '(no version given)'}`);
    process.exit(1);
  }
  process.stdout.write(`Live at [amnesia.tax](https://amnesia.tax). Self-host: \`docker run -d -p 8080:8080 ghcr.io/askalf/amnesia\`.\n\n${notes}\n`);
}
