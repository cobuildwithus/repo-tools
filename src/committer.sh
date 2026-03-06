#!/usr/bin/env bash

set -euo pipefail
set -f

usage() {
  printf 'Usage: %s [--force] [--allow-non-conventional] [--skip-hooks] "commit message" "file" ["file" ...]\n' "$(basename "$0")" >&2
  exit 2
}

if [ "$#" -lt 2 ]; then
  usage
fi

force_delete_lock=false
allow_non_conventional=false
skip_hooks=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force_delete_lock=true
      shift
      ;;
    --allow-non-conventional)
      allow_non_conventional=true
      shift
      ;;
    --skip-hooks|--no-verify)
      skip_hooks=true
      shift
      ;;
    --help|-h)
      usage
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'Error: unknown option: %s\n' "$1" >&2
      usage
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -lt 2 ]; then
  usage
fi

commit_message=$1
shift

if [[ "$commit_message" != *[![:space:]]* ]]; then
  printf 'Error: commit message must not be empty\n' >&2
  exit 1
fi

if [ -e "$commit_message" ]; then
  printf 'Error: first argument looks like a file path ("%s"); provide the commit message first\n' "$commit_message" >&2
  exit 1
fi

commit_example="${COBUILD_COMMITTER_EXAMPLE:-fix(repo): concise summary}"
if [ "$allow_non_conventional" != true ] && [ "${COMMITTER_ALLOW_NON_CONVENTIONAL:-0}" != "1" ]; then
  default_allowed_types='feat,fix,refactor,build,ci,chore,docs,style,perf,test,release'
  allowed_types_raw="${COBUILD_COMMITTER_ALLOWED_TYPES:-$default_allowed_types}"
  allowed_types_regex=''
  while IFS= read -r raw_type; do
    normalized_type="${raw_type#"${raw_type%%[![:space:]]*}"}"
    normalized_type="${normalized_type%"${normalized_type##*[![:space:]]}"}"
    if [ -z "$normalized_type" ]; then
      continue
    fi
    if ! [[ "$normalized_type" =~ ^[A-Za-z0-9._/-]+$ ]]; then
      printf 'Error: invalid commit type in COBUILD_COMMITTER_ALLOWED_TYPES: %s\n' "$normalized_type" >&2
      exit 1
    fi
    if [ -n "$allowed_types_regex" ]; then
      allowed_types_regex="${allowed_types_regex}|"
    fi
    allowed_types_regex="${allowed_types_regex}${normalized_type}"
  done <<< "$(printf '%s' "$allowed_types_raw" | tr ',' '\n')"
  if [ -z "$allowed_types_regex" ]; then
    printf 'Error: COBUILD_COMMITTER_ALLOWED_TYPES resolved to an empty set\n' >&2
    exit 1
  fi
  conventional_commit_pattern="^(${allowed_types_regex})(\\([A-Za-z0-9._/-]+\\))?!?: .+"
  if ! [[ "$commit_message" =~ $conventional_commit_pattern ]]; then
    printf 'Error: commit message must follow Conventional Commits (for example: "%s")\n' "$commit_example" >&2
    printf 'Use --allow-non-conventional or COMMITTER_ALLOW_NON_CONVENTIONAL=1 to bypass this check when needed\n' >&2
    exit 1
  fi
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'Error: not inside a git repository\n' >&2
  exit 1
fi

branch_ref="$(git symbolic-ref -q HEAD || true)"
if [ -z "$branch_ref" ]; then
  printf 'Error: detached HEAD is not supported; check out a branch first\n' >&2
  exit 1
fi

has_base_commit=true
empty_tree='4b825dc642cb6eb9a060e54bf8d69288fbee4904'
if git rev-parse --verify "$branch_ref" >/dev/null 2>&1; then
  base_head="$(git rev-parse "$branch_ref")"
else
  has_base_commit=false
  base_head=''
fi

if [ "$#" -eq 0 ]; then
  usage
fi

files=()
contains_path() {
  local needle="$1"
  local idx=0
  local total=0
  total="${#files[@]}"

  while [ "$idx" -lt "$total" ]; do
    if [ "${files[$idx]}" = "$needle" ]; then
      return 0
    fi
    idx=$((idx + 1))
  done
  return 1
}

disallow_globs=()
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  disallow_globs+=("$pattern")
done <<< "${COBUILD_COMMITTER_DISALLOW_GLOBS:-}"

for file in "$@"; do
  if [ "$file" = "." ]; then
    printf 'Error: "." is not allowed; list exact file paths instead\n' >&2
    exit 1
  fi

  if ((${#disallow_globs[@]} > 0)); then
    for pattern in "${disallow_globs[@]}"; do
      case "$file" in
        $pattern)
          printf 'Error: committing files matching %s is disallowed in this repository (%s)\n' "$pattern" "$file" >&2
          exit 1
          ;;
      esac
    done
  fi

  if [ -d "$file" ]; then
    printf 'Error: directories are not allowed (%s); list exact file paths instead\n' "$file" >&2
    exit 1
  fi

  if ! contains_path "$file"; then
    files+=("$file")
  fi
done

for file in "${files[@]}"; do
  if [ ! -e "$file" ]; then
    if ! git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
      if [ "$has_base_commit" != true ] || ! git cat-file -e "$base_head:$file" >/dev/null 2>&1; then
        printf 'Error: file not found: %s\n' "$file" >&2
        exit 1
      fi
    fi
  fi
done

lock_dir="$(git rev-parse --git-path agent-commit-locks)"
mkdir -p "$lock_dir"

acquired_locks=()
tmp_index=''
tmp_commit_msg=''

cleanup() {
  if [ -n "$tmp_index" ] && [ -f "$tmp_index" ]; then
    rm -f "$tmp_index"
  fi

  if [ -n "$tmp_commit_msg" ] && [ -f "$tmp_commit_msg" ]; then
    rm -f "$tmp_commit_msg"
  fi

  for lock_path in "${acquired_locks[@]}"; do
    [ -f "$lock_path" ] && rm -f "$lock_path"
  done
}
trap cleanup EXIT

create_lock() {
  local lock_file="$1"
  local lock_content="$2"

  if (set -o noclobber; printf '%s\n' "$lock_content" >"$lock_file") 2>/dev/null; then
    acquired_locks+=("$lock_file")
    return 0
  fi

  return 1
}

run_husky_hook() {
  local hook_name="$1"
  shift || true

  local hook_path=".husky/$hook_name"
  if [ ! -f "$hook_path" ]; then
    return 0
  fi

  if ! GIT_INDEX_FILE="$tmp_index" sh "$hook_path" "$@"; then
    printf 'Error: Husky hook failed: %s\n' "$hook_name" >&2
    exit 1
  fi
}

run_local_pre_commit_hook() {
  local hook_path="$1"

  if [ ! -f "$hook_path" ]; then
    return 1
  fi

  if [ ! -x "$hook_path" ]; then
    printf 'Warning: skipping non-executable local git hook: %s\n' "$hook_path" >&2
    return 1
  fi

  if ! GIT_INDEX_FILE="$tmp_index" "$hook_path"; then
    printf 'Error: local git hook failed: %s\n' "$hook_path" >&2
    exit 1
  fi

  return 0
}

for file in "${files[@]}"; do
  lock_key="$(printf '%s' "$file" | shasum -a 256 | awk '{print $1}')"
  lock_path="$lock_dir/$lock_key.lock"
  lock_content="pid=$$ path=$file created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if create_lock "$lock_path" "$lock_content"; then
    continue
  fi

  if [ "$force_delete_lock" = true ]; then
    rm -f "$lock_path"
    if create_lock "$lock_path" "$lock_content"; then
      printf 'Removed stale lock for %s\n' "$file" >&2
      continue
    fi
  fi

  existing_lock="$(cat "$lock_path" 2>/dev/null || true)"
  printf 'Error: file appears locked by another commit session: %s\n' "$file" >&2
  if [ -n "$existing_lock" ]; then
    printf 'Lock details: %s\n' "$existing_lock" >&2
  fi
  printf 'If the lock is stale, rerun with --force\n' >&2
  exit 1
done

if git diff --name-only --diff-filter=U -- "${files[@]}" | grep -q '.'; then
  printf 'Error: unresolved merge conflicts in selected files\n' >&2
  exit 1
fi

tmp_index="$(mktemp "${TMPDIR:-/tmp}/committer-index.XXXXXX")"
if [ "$has_base_commit" = true ]; then
  GIT_INDEX_FILE="$tmp_index" git read-tree "$base_head"
else
  GIT_INDEX_FILE="$tmp_index" git read-tree "$empty_tree"
fi
GIT_INDEX_FILE="$tmp_index" git add -A -- "${files[@]}"

if GIT_INDEX_FILE="$tmp_index" git diff --cached --quiet; then
  printf 'Warning: no changes detected for selected file paths\n' >&2
  exit 1
fi

if [ "$skip_hooks" != true ] && [ "${COMMITTER_SKIP_HOOKS:-0}" != "1" ]; then
  tmp_commit_msg="$(mktemp "${TMPDIR:-/tmp}/committer-msg.XXXXXX")"
  printf '%s\n' "$commit_message" >"$tmp_commit_msg"

  local_pre_commit_hook="$(git rev-parse --git-path hooks/pre-commit)"
  local_pre_commit_runs_husky=false

  if [ "$local_pre_commit_hook" = ".husky/pre-commit" ] || [ "$local_pre_commit_hook" = "./.husky/pre-commit" ]; then
    local_pre_commit_runs_husky=true
  elif [ -f "$local_pre_commit_hook" ] && grep -Eq "\.husky/pre-commit" "$local_pre_commit_hook"; then
    local_pre_commit_runs_husky=true
  fi

  if [ "$local_pre_commit_runs_husky" = false ]; then
    run_local_pre_commit_hook "$local_pre_commit_hook" || true
  fi

  HUSKY=1 GIT_INDEX_FILE="$tmp_index" GIT_EDITOR=: HUSKY_GIT_PARAMS="" run_husky_hook pre-commit
  HUSKY=1 GIT_INDEX_FILE="$tmp_index" GIT_EDITOR=: HUSKY_GIT_PARAMS="" HUSKY_SKIP_HOOKS=1 run_husky_hook prepare-commit-msg "$tmp_commit_msg" message
  HUSKY=1 GIT_INDEX_FILE="$tmp_index" GIT_EDITOR=: HUSKY_GIT_PARAMS="" HUSKY_SKIP_HOOKS=1 run_husky_hook commit-msg "$tmp_commit_msg"
fi

if [ "$has_base_commit" = true ]; then
  new_commit="$(GIT_INDEX_FILE="$tmp_index" git commit-tree -p "$base_head" -F <(printf '%s\n' "$commit_message") "$(GIT_INDEX_FILE="$tmp_index" git write-tree)")"
  git update-ref "$branch_ref" "$new_commit" "$base_head"
else
  new_commit="$(GIT_INDEX_FILE="$tmp_index" git commit-tree -F <(printf '%s\n' "$commit_message") "$(GIT_INDEX_FILE="$tmp_index" git write-tree)")"
  git update-ref "$branch_ref" "$new_commit"
fi

git reset -q -- "${files[@]}"

printf 'Committed "%s" as %s on %s with %d file(s)\n' "$commit_message" "${new_commit:0:12}" "$branch_ref" "${#files[@]}"
