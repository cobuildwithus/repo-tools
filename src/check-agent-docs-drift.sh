#!/usr/bin/env bash
set -euo pipefail

required_files_raw="${COBUILD_DRIFT_REQUIRED_FILES:-}"
if [[ -z "$required_files_raw" ]]; then
  echo "COBUILD_DRIFT_REQUIRED_FILES must be set to newline-delimited paths."
  exit 1
fi

required_files=()
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  required_files+=("$file")
done <<< "$required_files_raw"

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "::error file=$file::Missing required agent-doc artifact."
    exit 1
  fi
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a git repository; required artifact checks passed and diff-based drift checks skipped."
  exit 0
fi

range=""
changed_files=""
compare_source=""
compare_range=""

if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  git fetch --quiet origin "${GITHUB_BASE_REF}" --depth=1 || true
  range="origin/${GITHUB_BASE_REF}...HEAD"
  changed_files="$(git diff --name-only "$range" || true)"
  compare_source="range"
  compare_range="$range"
else
  staged_changes="$(git diff --name-only --cached | sed '/^[[:space:]]*$/d' | sort -u)"
  working_tree_changes="$({
    git diff --name-only
    git diff --name-only --cached
    git ls-files --others --exclude-standard
  } | sed '/^[[:space:]]*$/d' | sort -u)"

  if [[ -n "$staged_changes" ]]; then
    range="staged"
    changed_files="$staged_changes"
    compare_source="staged"
  elif [[ -n "$working_tree_changes" ]]; then
    range="working-tree"
    changed_files="$working_tree_changes"
    compare_source="working-tree"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    range="HEAD~1...HEAD"
    changed_files="$(git diff --name-only "$range" || true)"
    compare_source="range"
    compare_range="$range"
  else
    echo "No comparison range available; skipping drift checks."
    exit 0
  fi
fi

if [[ -z "$changed_files" ]]; then
  echo "No changed files detected in $range."
  exit 0
fi

has_change() {
  local pattern="$1"
  echo "$changed_files" | grep -Eq "$pattern"
}

package_json_version_only_in_range() {
  local compare_range="$1"
  local diff_lines relevant line

  diff_lines="$(git diff --unified=0 --no-color "$compare_range" -- package.json 2>/dev/null || true)"
  relevant="$(printf '%s\n' "$diff_lines" | grep -E '^[+-]' | grep -Ev '^\+\+\+|^---' || true)"
  if [[ -z "$relevant" ]]; then
    return 1
  fi

  while IFS= read -r line; do
    line="${line:1}"
    line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')"
    if [[ ! "$line" =~ ^\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"[[:space:]]*,?[[:space:]]*$ ]]; then
      return 1
    fi
  done <<< "$relevant"

  return 0
}

package_json_metadata_only() {
  local before_file after_file status

  before_file="$(mktemp)"
  after_file="$(mktemp)"
  trap 'rm -f "$before_file" "$after_file"' RETURN

  case "$compare_source" in
    staged)
      git show HEAD:package.json >"$before_file" 2>/dev/null || printf '{}\n' >"$before_file"
      git show :package.json >"$after_file" 2>/dev/null || printf '{}\n' >"$after_file"
      ;;
    working-tree)
      git show HEAD:package.json >"$before_file" 2>/dev/null || printf '{}\n' >"$before_file"
      cat package.json >"$after_file" 2>/dev/null || printf '{}\n' >"$after_file"
      ;;
    range)
      git show "$(git merge-base "${compare_range%...HEAD}" HEAD)":package.json >"$before_file" 2>/dev/null || printf '{}\n' >"$before_file"
      git show HEAD:package.json >"$after_file" 2>/dev/null || printf '{}\n' >"$after_file"
      ;;
    *)
      rm -f "$before_file" "$after_file"
      trap - RETURN
      return 1
      ;;
  esac

  node - "$before_file" "$after_file" <<'NODE'
const fs = require("node:fs");
const [beforePath, afterPath] = process.argv.slice(2);
const allowed = new Set([
  "version",
  "packageManager",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "peerDependenciesMeta",
  "overrides",
  "resolutions",
  "engines",
  "pnpm",
]);

const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
const changed = [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));

if (changed.length === 0 || changed.some((key) => !allowed.has(key))) {
  process.exit(1);
}
NODE
  status=$?

  rm -f "$before_file" "$after_file"
  trap - RETURN
  return "$status"
}

code_change_pattern="${COBUILD_DRIFT_CODE_CHANGE_PATTERN:-^(src/|scripts/|package\.json$|README\.md$|ARCHITECTURE\.md$|AGENTS\.md$)}"
code_change_label="${COBUILD_DRIFT_CODE_CHANGE_LABEL:-Architecture-sensitive code/process}"
large_change_threshold="${COBUILD_DRIFT_LARGE_CHANGE_THRESHOLD:-10}"
changed_count_exclude_pattern="${COBUILD_DRIFT_CHANGED_COUNT_EXCLUDE_PATTERN:-^agent-docs/generated/|^agent-docs/exec-plans/(active|completed)/|^pnpm-lock\.yaml$}"
docs_requiring_index_exclude_pattern='^agent-docs/exec-plans/(active|completed)/'
exec_plan_support_pattern='^agent-docs/exec-plans/(active/COORDINATION_LEDGER\.md|(active|completed)/README\.md)$'
allow_release_artifacts_only="${COBUILD_DRIFT_ALLOW_RELEASE_ARTIFACTS_ONLY:-0}"
release_artifacts_pattern='^(package\.json|CHANGELOG\.md|release-notes/v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?\.md)$'
release_notes_file_pattern='^release-notes/v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?\.md$'

active_plan_changes="$(echo "$changed_files" | grep '^agent-docs/exec-plans/active/' | grep -Ev "$exec_plan_support_pattern" || true)"
plan_changes="$(echo "$changed_files" | grep -E '^agent-docs/exec-plans/(active|completed)/' | grep -Ev "$exec_plan_support_pattern" || true)"

code_changed=0
index_changed=0
active_plan_changed=0
plan_changed=0
release_artifacts_only=0
package_metadata_only_changed=0
package_version_only_changed=0

if has_change "$code_change_pattern"; then
  code_changed=1
fi
if has_change '^agent-docs/index\.md$'; then
  index_changed=1
fi
if [[ -n "$active_plan_changes" ]]; then
  active_plan_changed=1
fi
if [[ -n "$plan_changes" ]]; then
  plan_changed=1
fi

docs_changed_non_generated="$(echo "$changed_files" | grep '^agent-docs/' | grep -Ev '^agent-docs/generated/' || true)"
docs_changed_requiring_index="$(echo "$docs_changed_non_generated" | grep -Ev "$docs_requiring_index_exclude_pattern" || true)"

if has_change '^package\.json$' && [[ "$compare_source" == "range" ]] && package_json_version_only_in_range "$range"; then
  package_version_only_changed=1
fi

if has_change '^package\.json$'; then
  non_package_metadata_changes="$(echo "$changed_files" | grep -Ev '^(package\.json|pnpm-lock\.yaml)$' || true)"
  if [[ -z "$non_package_metadata_changes" ]] && package_json_metadata_only; then
    package_metadata_only_changed=1
  fi
fi

if [[ "$allow_release_artifacts_only" == "1" ]] \
  && has_change '^package\.json$' \
  && has_change '^CHANGELOG\.md$' \
  && has_change "$release_notes_file_pattern" \
  && (( package_version_only_changed == 1 )); then
  non_release_changes="$(echo "$changed_files" | grep -Ev "$release_artifacts_pattern" || true)"
  if [[ -z "$non_release_changes" ]]; then
    release_artifacts_only=1
  fi
fi

if (( code_changed == 1 )) && [[ -z "$docs_changed_non_generated" ]] && (( active_plan_changed == 0 )) && (( package_metadata_only_changed == 0 )) && (( release_artifacts_only == 0 )); then
  echo "::error::${code_change_label} changed without matching non-generated docs updates or an active execution plan."
  echo "Update relevant docs in agent-docs/ and/or add an active plan in agent-docs/exec-plans/active/."
  exit 1
fi

if [[ -n "$docs_changed_requiring_index" ]] && (( index_changed == 0 )); then
  echo "::error::agent-docs changed (outside generated artifacts) without updating agent-docs/index.md."
  exit 1
fi

changed_count="$(printf '%s\n' "$changed_files" | awk -v exclude="$changed_count_exclude_pattern" 'NF && $0 !~ exclude { count++ } END { print count + 0 }')"
if (( changed_count >= large_change_threshold && plan_changed == 0 )); then
  echo "::error::Large change set ($changed_count files) without an active execution plan."
  echo "Add a plan under agent-docs/exec-plans/active/."
  exit 1
fi

echo "Agent docs drift checks passed."
