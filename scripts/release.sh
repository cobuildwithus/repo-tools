#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: scripts/release.sh <check|patch|minor|major> [--dry-run]
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

mode="$1"
shift || true

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
fi

case "$mode" in
  check)
    npm run release:check
    exit 0
    ;;
  patch|minor|major) ;;
  *)
    usage
    exit 1
    ;;
esac

npm run typecheck
npm test

current_version="$(node -p "require('./package.json').version")"
next_version="$(npm version "$mode" --no-git-tag-version)"
next_version="${next_version#v}"

if [[ "$dry_run" == "1" ]]; then
  node -e "const fs=require('node:fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));pkg.version=process.argv[1];fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');" "$current_version"
  echo "Dry run complete: $current_version -> $next_version"
  exit 0
fi

echo "Version bumped: $current_version -> $next_version"
echo "Run 'npm publish' when ready."
