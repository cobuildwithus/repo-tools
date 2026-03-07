#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
exec "$ROOT_DIR/bin/cobuild-sync-dependent-repos" \
  --package @cobuild/repo-tools \
  --root "$ROOT_DIR/.." \
  --repos "v1-core,wire,interface,chat-api,cli,indexer,review-gpt" \
  "$@"
