# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:3fbd23348c72cf49b5342e2b85d65bd926b660a7a402be7c71aca921763fa317
COPY . $SRC/amnesia
WORKDIR $SRC/amnesia
COPY .clusterfuzzlite/build.sh $SRC/build.sh
