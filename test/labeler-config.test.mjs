// Every label this repo applies on its own is declared in .github/labels.json.
// labels.yml proves declared == live; this proves applied ⊆ declared, so a new
// labeler.yml entry (or size label, or issue-template label) can't auto-create
// an undeclared label and turn labels.yml red on main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const declared = new Set(JSON.parse(read('.github/labels.json')).map((l) => l.name));

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

test('labeler.yml applies only declared labels', () => {
  // Top-level keys of the path → label map are the label names.
  const applied = read('.github/labeler.yml').split('\n')
    .map((line) => line.match(/^([^\s#-][^:]*):\s*$/))
    .filter(Boolean)
    .map((m) => unquote(m[1]));
  assert.ok(applied.length > 0, 'parsed no labels out of labeler.yml');
  assert.deepEqual(applied.filter((l) => !declared.has(l)), []);
});

test('pr-triage.yml size labels are declared', () => {
  const sizes = [...read('.github/workflows/pr-triage.yml').matchAll(/'(size\/[A-Z]+)'/g)].map((m) => m[1]);
  assert.ok(sizes.length > 0, 'parsed no size labels out of pr-triage.yml');
  assert.deepEqual(sizes.filter((l) => !declared.has(l)), []);
});

test('dependabot.yml labels are declared', () => {
  // The list items under each `labels:` key (not `patterns:` and the like).
  const applied = [];
  let inLabels = false;
  for (const line of read('.github/dependabot.yml').split('\n')) {
    if (/^\s+labels:\s*$/.test(line)) { inLabels = true; continue; }
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (inLabels && item) applied.push(unquote(item[1]));
    else inLabels = false;
  }
  assert.ok(applied.length > 0, 'parsed no labels out of dependabot.yml');
  assert.deepEqual(applied.filter((l) => !declared.has(l)), []);
});

test('issue templates apply only declared labels', () => {
  const dir = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const m = readFileSync(new URL(f, dir), 'utf8').match(/^labels:\s*\[(.*)\]\s*$/m);
    if (!m) continue;
    const applied = m[1].split(',').map(unquote).filter(Boolean);
    assert.deepEqual(applied.filter((l) => !declared.has(l)), [], f);
  }
});
