# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Digest-pinned (Scorecard Pinned-Dependencies); dependabot's docker ecosystem
# refreshes the pin so it tracks upstream instead of rotting.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:fc0de7579f51e66c3526d2281c0d4632acaebbdabd95da6a3bad747411d2432a
COPY . $SRC/amnesia
WORKDIR $SRC/amnesia
COPY .clusterfuzzlite/build.sh $SRC/build.sh
