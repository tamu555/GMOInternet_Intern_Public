#!/usr/bin/env bash
# Runs the Cloud Functions test suite inside the emulator container.
#
# Works from any directory: the container has the repository mounted at
# /workspace, so nothing here depends on where you invoke it from.
#
# Usage:
#   scripts/test-docker.sh              # every test
#   scripts/test-docker.sh unit         # unit tests only, no emulator needed
set -euo pipefail

CONTAINER="${EMULATOR_CONTAINER:-registrar-firebase-emulators}"
SCOPE="${1:-all}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  cat >&2 <<MSG
エミュレータのコンテナ ($CONTAINER) が起動していません。

  cd docs/firebase && docker compose up -d

を実行してからもう一度お試しください。
MSG
  exit 1
fi

case "$SCOPE" in
  all)
    # The emulator listens inside the same container, so 127.0.0.1 is correct.
    ENV_ARGS=(-e FIRESTORE_EMULATOR_HOST=127.0.0.1:8080)
    ;;
  unit)
    # Without the emulator variable the integration suites skip themselves.
    ENV_ARGS=()
    ;;
  *)
    echo "usage: $0 [all|unit]" >&2
    exit 2
    ;;
esac

# --test-concurrency=1: the integration files share one Firestore emulator and
# the same counter documents, so running them in parallel lets one file's
# counter restore land in the middle of another file's run.
docker exec "${ENV_ARGS[@]}" "$CONTAINER" sh -lc '
  cd /workspace/functions &&
  npm run build:test &&
  cd lib-test &&
  node --test --test-concurrency=1
'
