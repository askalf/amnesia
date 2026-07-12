// `npm run fuzz` — run every Jazzer.js target in ./fuzz for a short burst.
// Continuous fuzzing is done in CI by ClusterFuzzLite (.github/workflows/
// cflite.yml); this is the fast local repro loop. Targets import the Worker
// source directly (no build step). Override the per-target budget with
// FUZZ_SECONDS (default 30).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const targets = readdirSync(dir).filter((f) => f.endsWith('.fuzz.js')).sort();
const secs = process.env.FUZZ_SECONDS || '30';
// Run Jazzer's JS CLI directly under `node` — no .cmd wrapper, no shell, so a
// space in the repo path can't break the invocation. The targets export an
// ASYNC fuzz(data) (the Worker's cookie signing is WebCrypto), so we run in
// Jazzer's async mode — NOT --sync, which fires the promises without awaiting
// them and floods pending crypto ops into an OOM rather than fuzzing.
const jazzerCli = createRequire(import.meta.url).resolve('@jazzer.js/core/dist/cli.js');

for (const t of targets) {
  console.log(`\n=== fuzzing ${t} (${secs}s) ===`);
  const r = spawnSync(
    process.execPath,
    [jazzerCli, `fuzz/${t.replace(/\.js$/, '')}`, '--', `-max_total_time=${secs}`],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status || 1);
}
