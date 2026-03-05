#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export COBUILD_RELEASE_PACKAGE_NAME='@cobuild/repo-tools'
export COBUILD_RELEASE_REPOSITORY_URL='https://github.com/cobuildwithus/repo-tools'
exec "$ROOT_DIR/src/release-package.sh" "$@"
