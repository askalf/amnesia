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

  test('relative input resolves against the page origin (same-site, never script)', () => {
    // Pinned so a change to it is deliberate: the base argument makes
    // relative input land on https://amnesia.tax.
    assert.equal(safeUrl('/path'), 'https://amnesia.tax/path');
  });

  test('a missing value is dropped, not turned into a link to this site', () => {
    // A result without img_src or url used to render src="/undefined".
    for (const missing of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(safeUrl(missing), '', JSON.stringify(missing));
    }
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

function warmHarness({ sessionStatus, turnstileLoaded = true }) {
  const fetches = [];
  let solves = 0;
  const listeners = {};
  const ctx = vm.createContext({
    setTimeout,
    fetch: async (url, opts = {}) => {
      const token = opts.headers?.['cf-turnstile-token'] || '';
      fetches.push({ url, token, credentials: opts.credentials });
      return { status: token ? 200 : sessionStatus, ok: token ? true : sessionStatus === 200 };
    },
    document: {
      getElementById: (id) => (id === 'ts-loader' ? { addEventListener: (ev, fn) => { listeners[ev] = fn; } } : null),
    },
  });
  vm.runInContext(
    `const API_BASE = 'https://api.amnesia.tax';
     let _warmPromise = null;
     let _tsReady = null;
     ${turnstileLoaded ? 'var turnstile = {};' : ''}
     ${functionSource(HTML, 'turnstileReady')}
     function getTurnstileToken() { return turnstileReady().then(() => (typeof turnstile === 'undefined' ? '' : (__solve(), 'tok'))); }
     ${functionSource(HTML, 'warmSession')}`,
    Object.assign(ctx, { __solve: () => { solves++; } }),
  );
  return {
    warm: () => vm.runInContext('warmSession()', ctx),
    loadTurnstile: () => { vm.runInContext('var turnstile = {};', ctx); listeners.load(); },
    fetches,
    solves: () => solves,
    loaderListens: () => typeof listeners.load === 'function',
  };
}

describe('warmSession', () => {
  test('a valid session cookie warms with one /session request and no Turnstile solve', async () => {
    const h = warmHarness({ sessionStatus: 200 });
    assert.equal(await h.warm(), true);
    assert.equal(h.fetches.length, 1);
    assert.equal(h.fetches[0].url, 'https://api.amnesia.tax/session');
    assert.equal(h.fetches[0].token, '', 'the cookie is tried without a token');
    assert.equal(h.fetches[0].credentials, 'include', 'the cookie is sent');
    assert.equal(h.solves(), 0);
  });

  test('no cookie (401) solves Turnstile once and retries /session with the token', async () => {
    const h = warmHarness({ sessionStatus: 401 });
    assert.equal(await h.warm(), true);
    assert.deepEqual(h.fetches.map((f) => f.token), ['', 'tok']);
    assert.equal(h.solves(), 1);
  });

  test('waits for the deferred Turnstile loader after a 401', async () => {
    const h = warmHarness({ sessionStatus: 401, turnstileLoaded: false });
    const warmed = h.warm();
    await new Promise((r) => setImmediate(r));
    assert.ok(h.loaderListens(), 'waits on the loader script');
    assert.equal(h.fetches.length, 1, 'no token request yet');
    h.loadTurnstile();
    assert.equal(await warmed, true);
    assert.deepEqual(h.fetches.map((f) => f.token), ['', 'tok']);
  });
});

test('the page preconnects to the API gate (credentialed, so no crossorigin) and loads Turnstile with the id turnstileReady waits on', () => {
  assert.match(HTML, /<link rel="preconnect" href="https:\/\/api\.amnesia\.tax">/);
  assert.match(HTML, /<script id="ts-loader" src="https:\/\/challenges\.cloudflare\.com\/turnstile\//);
});

/**
 * The page's whole inline script, run in a vm context with just enough DOM
 * for it to boot. History is a real entry stack (push truncates the forward
 * entries, back/forward fire popstate), fetches stay pending until the test
 * answers them, and timers only run when the test says so.
 */
function pageHarness({ url = '/', storageThrows = false } = {}) {
  class FakeElement {
    constructor() {
      this.listeners = {};
      this.style = {};
      this.dataset = {};
      this.attrs = {};
      this.innerHTML = '';
      this.value = '';
      this.className = '';
      const classes = new Set();
      this.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c)),
      };
    }
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
    dispatch(ev, e = {}) { for (const fn of this.listeners[ev] || []) fn(e); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    querySelectorAll() { return []; }
    appendChild(c) { return c; }
    focus() { document.activeElement = this; }
    set textContent(s) { this.innerHTML = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  }

  const ids = ['q', 'shell', 'subtitle', 'content', 'categoryTabs', 'themeToggle', 'toggleIcon', 'themeColor', 'logo', 'acDropdown'];
  const el = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  el.shell.className = 'shell landing';
  const document = {
    getElementById: (id) => el[id] ?? null,
    createElement: () => new FakeElement(),
    addEventListener: () => {},
    documentElement: new FakeElement(),
    body: new FakeElement(),
    activeElement: el.q,
  };

  const win = new FakeElement();
  const location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
  const entries = [url];
  let at = 0;
  const sync = () => { location.search = new URL(entries[at], location.origin).search; };
  sync();
  const history = {
    pushState(_s, _t, u) { entries.splice(at + 1); entries.push(u); at++; sync(); },
    replaceState(_s, _t, u) { entries[at] = u; sync(); },
    back() { if (at > 0) { at--; sync(); win.dispatch('popstate'); } },
    forward() { if (at < entries.length - 1) { at++; sync(); win.dispatch('popstate'); } },
  };
  Object.assign(win, { location, scrollTo: () => {} });

  const timers = new Map();
  let timerId = 0;
  const fetches = [];
  const storage = () => { if (storageThrows) throw new Error('SecurityError'); return null; };

  const ctx = vm.createContext({
    window: win, document, location, history, URL, URLSearchParams, AbortController, performance,
    localStorage: { getItem: storage, setItem: storage },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: (u, opts = {}) => new Promise((resolve, reject) => {
      const f = { url: u, signal: opts.signal };
      f.respond = (data) => resolve({ ok: true, status: 200, json: async () => data });
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      fetches.push(f);
    }),
  });
  const script = splitBlocks(HTML, 'script').inner.find((s) => s.includes('function doSearch('));
  vm.runInContext(script, ctx);

  const searches = () => fetches.filter((f) => f.url.startsWith('/search?'));
  return {
    el,
    fetches,
    searches,
    history,
    entries: () => [...entries],
    index: () => at,
    /** Answer the pending /search for `query` with one result titled `<query>-result`. */
    respond: (query) => {
      const f = searches().find((s) => new URL(s.url, location.origin).searchParams.get('q') === query && !s.done);
      assert.ok(f, `no pending search for ${query}`);
      f.done = true;
      f.respond({ results: [{ url: `https://example.com/${query}`, title: `${query}-result` }] });
    },
    type: (text) => { el.q.value = text; el.q.dispatch('input'); },
    enter: (text) => {
      if (text !== undefined) el.q.value = text;
      el.q.dispatch('keydown', { key: 'Enter', keyCode: 13, isComposing: false, preventDefault() {} });
    },
    runTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('search history and rendering order', () => {
  test('a ?q= link searches on load and replaces its entry instead of pushing one', async () => {
    const h = pageHarness({ url: '/?q=cats' });
    assert.deepEqual(h.entries(), ['/?q=cats']);
    assert.equal(h.searches().length, 1);
    h.respond('cats');
    await settle();
    assert.equal(h.el.shell.className, 'shell results-mode');
    assert.match(h.el.content.innerHTML, /cats-result/);
  });

  test('a new search pushes one entry', async () => {
    const h = pageHarness();
    h.enter('cats');
    assert.deepEqual(h.entries(), ['/', '/?q=cats']);
    h.enter('dogs');
    assert.deepEqual(h.entries(), ['/', '/?q=cats', '/?q=dogs']);
  });

  test('Back and Forward re-run the search without pushing or losing the forward entry', async () => {
    const h = pageHarness();
    h.enter('cats'); h.respond('cats');
    h.enter('dogs'); h.respond('dogs');
    await settle();
    const stack = ['/', '/?q=cats', '/?q=dogs'];

    h.history.back();
    assert.deepEqual(h.entries(), stack, 'Back pushed an entry or cleared the forward stack');
    assert.equal(h.index(), 1);
    assert.equal(h.el.q.value, 'cats');
    h.respond('cats');
    await settle();
    assert.match(h.el.content.innerHTML, /cats-result/);

    h.history.forward();
    assert.deepEqual(h.entries(), stack, 'Forward pushed an entry');
    assert.equal(h.index(), 2);
    h.respond('dogs');
    await settle();
    assert.match(h.el.content.innerHTML, /dogs-result/);
    assert.doesNotMatch(h.el.content.innerHTML, /cats-result/);
  });

  test('an older search answering after a newer one does not replace it', async () => {
    const h = pageHarness();
    h.enter('old');
    h.enter('new');
    h.respond('new');
    await settle();
    assert.match(h.el.content.innerHTML, /new-result/);
    h.respond('old');
    await settle();
    assert.match(h.el.content.innerHTML, /new-result/);
    assert.doesNotMatch(h.el.content.innerHTML, /old-result/);
  });

  test('Back to the landing page while a search is pending keeps the landing page', async () => {
    const h = pageHarness();
    h.enter('cats');
    h.history.back();
    assert.equal(h.el.shell.className, 'shell landing');
    h.respond('cats');
    await settle();
    assert.equal(h.el.shell.className, 'shell landing');
    assert.equal(h.el.content.innerHTML, '');
  });

  test('the logo returns to the landing page even with a search pending', async () => {
    const h = pageHarness();
    h.enter('cats');
    h.el.logo.dispatch('click');
    assert.deepEqual(h.entries(), ['/', '/?q=cats', '/']);
    h.respond('cats');
    await settle();
    assert.equal(h.el.shell.className, 'shell landing');
    assert.equal(h.el.content.innerHTML, '');
  });

  test('Enter cancels a debounced autocomplete before it fetches', async () => {
    const h = pageHarness();
    h.type('cats');
    h.enter();
    h.runTimers();
    await settle();
    assert.ok(!h.fetches.some((f) => f.url.startsWith('/autocompleter')), 'autocomplete fetched after Enter');
    assert.ok(!h.el.acDropdown.classList.contains('open'));
  });

  test('Enter aborts an in-flight autocomplete so it cannot reopen over the results', async () => {
    const h = pageHarness();
    h.type('cats');
    h.runTimers();
    const ac = h.fetches.find((f) => f.url.startsWith('/autocompleter'));
    assert.ok(ac, 'autocomplete fetched after the debounce');
    h.enter();
    assert.equal(ac.signal.aborted, true);
    ac.respond(['cats', ['cats and dogs']]);
    await settle();
    assert.ok(!h.el.acDropdown.classList.contains('open'));
  });

  test('search still works when storage access throws', async () => {
    const h = pageHarness({ url: '/?q=cats', storageThrows: true });
    h.respond('cats');
    await settle();
    assert.match(h.el.content.innerHTML, /cats-result/);
  });
});

describe('result rendering', () => {
  /** Load `/?q=<q>[&cat=<cat>]`, answer its search with `results`, return the rendered #content. */
  async function render(results, cat) {
    const h = pageHarness({ url: '/?q=cats' + (cat ? '&cat=' + cat : '') });
    const [f] = h.searches();
    assert.ok(f, 'the page searched on load');
    f.respond({ results });
    await settle();
    return h.el.content.innerHTML;
  }
  const imgSrcs = (html) => [...html.matchAll(/<img src="([^"]*)"/g)].map((m) => m[1]);
  const shownCount = (html) => Number(/<span>(\d+) results in /.exec(html)?.[1]);

  test('image tiles use thumbnail_src, then thumbnail, then img_src, and count only the tiles drawn', async () => {
    const html = await render([
      { url: 'https://a.example/', title: 'a', thumbnail_src: 'https://t.example/a-src.jpg', thumbnail: 'https://t.example/a-thumb.jpg', img_src: 'https://o.example/a.jpg' },
      { url: 'https://b.example/', title: 'b', thumbnail: 'https://t.example/b-thumb.jpg', img_src: 'https://o.example/b.jpg' },
      { url: 'https://c.example/', title: 'c', img_src: 'https://o.example/c.jpg' },
      { url: 'https://d.example/', title: 'duplicate of a', thumbnail_src: 'https://t.example/a-src.jpg' },
      { url: 'https://e.example/', title: 'rejected', thumbnail_src: 'javascript:alert(1)', img_src: 'https://o.example/e.jpg' },
      { url: 'https://f.example/', title: 'no image' },
    ], 'images');
    assert.deepEqual(imgSrcs(html), [
      'https://t.example/a-src.jpg',
      'https://t.example/b-thumb.jpg',
      'https://o.example/c.jpg',
    ]);
    assert.equal(shownCount(html), 3);
    assert.doesNotMatch(html, /javascript:|o\.example\/(a|b|e)\.jpg|duplicate of a|no image/);
  });

  test('standard results drop duplicate and rejected URLs and count only what is shown', async () => {
    const html = await render([
      { url: 'https://example.com/one', title: 'one' },
      { url: 'https://example.com/one', title: 'one again' },
      { url: 'javascript:alert(1)', title: 'script' },
      { url: 'ftp://example.com/file', title: 'ftp' },
      { title: 'no url' },
      { url: 'https://example.com/two', title: 'two' },
    ]);
    assert.equal((html.match(/class="result-item"/g) || []).length, 2);
    assert.equal(shownCount(html), 2);
    assert.match(html, /href="https:\/\/example\.com\/one"/);
    assert.match(html, /href="https:\/\/example\.com\/two"/);
    assert.doesNotMatch(html, /one again|javascript:|ftp:|no url/);
    assert.doesNotMatch(html, /no-results/);
  });

  test('standard results that are all rejected show zero and the empty state', async () => {
    const html = await render([
      { url: 'javascript:alert(1)', title: 'script' },
      { title: 'no url' },
    ]);
    assert.equal(shownCount(html), 0);
    assert.match(html, /class="no-results"/);
  });
});
