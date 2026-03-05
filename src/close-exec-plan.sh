#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: cobuild-close-exec-plan <active-plan-path>"
  exit 1
fi

src="$1"

if [[ ! -f "$src" ]]; then
  echo "Plan file not found: $src"
  exit 1
fi

case "$src" in
  agent-docs/exec-plans/active/*) ;;
  *)
    echo "Plan must be under agent-docs/exec-plans/active/"
    exit 1
    ;;
esac

completed_date="$(date +%Y-%m-%d)"
tmp_file="$(mktemp)"

awk -v date="$completed_date" '
  BEGIN { status_seen=0; updated_seen=0 }
  {
    if ($0 ~ /^Status:/) {
      print "Status: completed"
      status_seen=1
      next
    }
    if ($0 ~ /^Updated:/) {
      print "Updated: " date
      updated_seen=1
      next
    }
    print
  }
  END {
    if (status_seen == 0) print "Status: completed"
    if (updated_seen == 0) print "Updated: " date
    print "Completed: " date
  }
' "$src" > "$tmp_file"

mv "$tmp_file" "$src"

dest="agent-docs/exec-plans/completed/$(basename "$src")"
mv "$src" "$dest"

echo "Moved $src -> $dest"
