# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:ca1d2a7f50cc4c37dd7b535d1adeae631843ce8a3ba35bfb7b8ad176e0b07038
COPY . $SRC/amnesia
WORKDIR $SRC/amnesia
COPY .clusterfuzzlite/build.sh $SRC/build.sh
