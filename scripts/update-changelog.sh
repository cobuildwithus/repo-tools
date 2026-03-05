#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "Usage: scripts/update-changelog.sh <version>" >&2
  exit 1
fi

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]]; then
  echo "Unsupported version format: $version" >&2
  exit 1
fi

date_stamp="$(date +%Y-%m-%d)"
header="## ${version} - ${date_stamp}"

if grep -Fq "$header" CHANGELOG.md; then
  echo "Changelog already contains $header"
  exit 0
fi

tmp_file="$(mktemp)"
{
  echo "# Changelog"
  echo
  echo "$header"
  echo
  echo "- Release ${version}."
  echo
  tail -n +3 CHANGELOG.md
} > "$tmp_file"

mv "$tmp_file" CHANGELOG.md
echo "Updated CHANGELOG.md for ${version}"
