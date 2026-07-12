#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
# The target exports an ASYNC `fuzz(data)` (the Worker's cookie signing is
# WebCrypto); the invariant is the fail-safe contract at amnesia's auth
# boundary — the signed session cookie never throws on a hostile value and
# never verifies under a secret that didn't sign it (a forged cookie = free,
# un-gated search access past Turnstile). No --sync: that mode fires the
# promises without awaiting them and OOMs instead of fuzzing.
cd "$SRC/amnesia"
npm ci --no-audit --no-fund

for target in session; do
  compile_javascript_fuzzer amnesia "fuzz/${target}.fuzz.js"
done
