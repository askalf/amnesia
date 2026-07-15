# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:12908b1c3349c765b2eca27203adab9c0a4946fc5468a96d3517c01aa95594e0
COPY . $SRC/amnesia
WORKDIR $SRC/amnesia
COPY .clusterfuzzlite/build.sh $SRC/build.sh
