// The single-file SPA: its URL/attribute guards, and the markup contract the
// hash-based CSP depends on.
//
// The guards live inside the page's one inline <script> (not modules, so
// nothing to import). They are lifted out by name and evaluated in a bare
// node:vm context, which runs the exact bytes the browser runs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const HTML = readFileSync(resolve(root, 'src/amnesia-search.html'), 'utf8');

/** Source of `function <name>(…) { … }`, found by brace matching (strings, regex literals and comments skipped). */
function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in the SPA`);
  let i = src.indexOf('{', start);
  let depth = 0;
  let prev = ''; // last significant character, to tell a regex literal from division
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
    } else if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
    } else if (ch === '/' && /[(,=:[!&|?{};]/.test(prev)) {
      for (let cls = false, j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) { i = j; break; }
      }
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const sandbox = vm.createContext({ URL, location: { origin: 'https://amnesia.tax' } });
const { safeUrl, escapeAttr } = vm.runInContext(
  `${functionSource(HTML, 'safeUrl')}\n${functionSource(HTML, 'escapeAttr')}\n({ safeUrl, escapeAttr })`,
  sandbox,
);

describe('safeUrl', () => {
  test('keeps absolute http(s) URLs, normalized', () => {
    assert.equal(safeUrl('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
    assert.equal(safeUrl('http://example.com'), 'http://example.com/');
    assert.equal(safeUrl('HTTPS://EXAMPLE.COM/x'), 'https://example.com/x');
    assert.equal(safeUrl('//cdn.example.net/i.png'), 'https://cdn.example.net/i.png');
  });

  test('drops every script-capable or non-web scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'blob:https://example.com/uuid',
    ]) {
      assert.equal(safeUrl(bad), '', JSON.stringify(bad));
    }
  });

  test('drops what the URL parser rejects', () => {
    for (const bad of ['http://[::1', 'https://exa mple.com:99999/', 'http://']) {
      assert.equal(safeUrl(bad), '', JSON.stringify(bad));
    }
  });

  test('relative and empty inputs resolve against the page origin (same-site, never script)', () => {
    // Real behavior, pinned here so a change to it is deliberate: the base
    // argument makes relative input land on https://amnesia.tax.
    assert.equal(safeUrl('/path'), 'https://amnesia.tax/path');
    assert.equal(safeUrl(''), 'https://amnesia.tax/');
    assert.equal(safeUrl(undefined), 'https://amnesia.tax/undefined');
  });
});

describe('escapeAttr', () => {
  test('neutralizes attribute breakout in double-quoted attributes', () => {
    assert.equal(escapeAttr('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeAttr('a&b'), 'a&amp;b');
    assert.equal(escapeAttr('&quot;'), '&amp;quot;', 'escapes & first, so entities are not double-decoded');
    assert.equal(escapeAttr(null), '');
    assert.equal(escapeAttr(undefined), '');
  });

  test('every escapeAttr() use in the page sits inside a double-quoted attribute', () => {
    // escapeAttr does not touch single quotes, so it is only safe in "…".
    const uses = [...HTML.matchAll(/(.)\s*\+\s*escapeAttr\(/g)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const q of uses) assert.equal(q, "'", 'escapeAttr output must follow a string ending in ="');
    const contexts = [...HTML.matchAll(/'([^']*)'\s*\+\s*escapeAttr\(/g)].map((m) => m[1]);
    for (const c of contexts) assert.match(c, /="$/, `unexpected context: ${c}`);
  });
});

/**
 * Split the page into its inline <tag> blocks and everything else, by string
 * index rather than a tag regex: case-insensitive, and an end tag may carry
 * whitespace before its '>' (</script >). This reads our own page in a test;
 * it sanitizes nothing.
 */
function splitBlocks(src, tag) {
  const lower = src.toLowerCase();
  const inner = [];
  let outside = '';
  let at = 0;
  for (;;) {
    let open = lower.indexOf(`<${tag}`, at);
    while (open >= 0 && !/[\s>]/.test(lower[open + tag.length + 1] ?? '')) open = lower.indexOf(`<${tag}`, open + 1);
    if (open < 0) break;
    const openEnd = lower.indexOf('>', open);
    const close = lower.indexOf(`</${tag}`, openEnd);
    const closeEnd = lower.indexOf('>', close);
    assert.ok(openEnd > 0 && close > 0 && closeEnd > 0, `unterminated <${tag}> block`);
    outside += src.slice(at, open);
    inner.push(src.slice(openEnd + 1, close));
    at = closeEnd + 1;
  }
  return { inner, outside: outside + src.slice(at) };
}

describe('page contract', () => {
  const scripts = splitBlocks(HTML, 'script');
  const markup = splitBlocks(scripts.outside, 'style').outside;

  test('is a complete HTML document', () => {
    assert.match(HTML, /^<!DOCTYPE html>/i);
    assert.match(HTML, /<html\b[^>]*\blang="en"/);
    assert.match(HTML, /<\/html>\s*$/);
  });

  test('static markup has no inline event handlers (the hash CSP would refuse them silently)', () => {
    const handlers = [...markup.matchAll(/<[^>]*\s(on[a-z]+)\s*=/gi)].map((m) => m[1]);
    assert.deepEqual(handlers, []);
  });

  test('no javascript: URL in any href/src', () => {
    assert.doesNotMatch(HTML, /\b(?:href|src)\s*=\s*["']?\s*javascript:/i);
  });

  test('markup generated by the script carries no inline event handlers', () => {
    // Results are built as strings and set via innerHTML; a handler attribute
    // in one of them is refused by the hash CSP with no visible error (the
    // image grid's hide-on-error once died exactly this way).
    const script = scripts.inner.join('\n');
    assert.ok(script.includes('function safeUrl('), 'found the page script');
    const generated = [...script.matchAll(/['"`][^'"`]*<[a-z][^'"`]*\son[a-z]+=/gi)].map((m) => m[0]);
    assert.deepEqual(generated, []);
  });

  // Pages answers a missing path with index.html (200, text/html), so a
  // missing asset never shows up as a 404 anywhere — only here.
  const refs = new Set(
    [
      ...[...HTML.matchAll(/url\(\s*['"]?(\/[^'")]+)['"]?\s*\)/g)].map((m) => m[1]),
      ...[...markup.matchAll(/\b(?:href|src)="(\/[^"#?]+)"/g)].map((m) => m[1]),
    ].filter((r) => r !== '/' && !r.startsWith('//')),
  );
  const missing = (r) => !existsSync(resolve(root, 'src', r.slice(1)));

  test('every root-relative asset the page references exists in src/', () => {
    assert.ok(refs.size > 0);
    for (const r of refs) assert.ok(!missing(r), `src${r} is referenced but missing`);
  });

  test('the OpenSearch description exists, is copied into the build, and its template is a query the page runs on load', () => {
    assert.ok(refs.has('/opensearch.xml'), 'the page links /opensearch.xml');
    const xml = readFileSync(resolve(root, 'src/opensearch.xml'), 'utf8');
    assert.match(xml, /<Url type="text\/html" method="get" template="https:\/\/amnesia\.tax\/\?q=\{searchTerms\}"\/>/);
    assert.match(HTML, /new URLSearchParams\(location\.search\)[\s\S]*params\.get\('q'\)/, 'the page reads ?q= on load');
    const build = readFileSync(resolve(root, 'scripts/build-site.sh'), 'utf8');
    assert.match(build, /^cp src\/opensearch\.xml deploy\/opensearch\.xml$/m, 'build-site.sh ships it (and not best-effort)');
  });

  test('robots.txt, sitemap.xml and the social card ship with the page', () => {
    for (const f of ['robots.txt', 'sitemap.xml', 'og.png', '_headers']) {
      assert.ok(existsSync(resolve(root, 'src', f)), `src/${f} missing`);
    }
  });
});
