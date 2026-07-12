# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:5d383584d22928edf02a20e8a7b8ce776aecb9e20c76c9b23d2fdbc92858a966
COPY . $SRC/amnesia
WORKDIR $SRC/amnesia
COPY .clusterfuzzlite/build.sh $SRC/build.sh
