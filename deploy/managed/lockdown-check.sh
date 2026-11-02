#!/bin/sh
# Run the lock-down proof in a disposable podman container.
#
# The repository is mounted read-only at /src. No host directory, no host
# /etc and no host home is written, and the script is not allowed to use sudo.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
IMAGE=${TAA_LOCKDOWN_IMAGE:-docker.io/library/node:24-alpine}

if ! command -v podman >/dev/null 2>&1; then
  echo "lockdown-check: podman is required" >&2
  exit 2
fi

exec podman run --rm \
  --volume "$ROOT:/src:ro" \
  --workdir /src \
  --env SRC=/src \
  "$IMAGE" \
  sh /src/deploy/managed/container-check.sh
