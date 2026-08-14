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

repo_root="$(git rev-parse --show-toplevel)"
operation_markers=(MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer)
for operation_marker in "${operation_markers[@]}"; do
  operation_path="$(git rev-parse --git-path "$operation_marker")"
  if [ -e "$operation_path" ]; then
    printf 'Error: active Git operation is not supported (%s); finish or abort it before using this committer\n' "$operation_marker" >&2
    exit 1
  fi
done

has_base_commit=true
if git rev-parse --verify "$branch_ref" >/dev/null 2>&1; then
  base_head="$(git rev-parse "$branch_ref")"
else
  has_base_commit=false
  base_head=''
fi

object_id_probe="$(git hash-object --stdin </dev/null)"
zero_oid="$(printf '%*s' "${#object_id_probe}" '' | tr ' ' '0')"
expected_old_oid="${base_head:-$zero_oid}"

if [ "$#" -eq 0 ]; then
  usage
fi

canonical_files=()
contains_path() {
  local needle="$1"
  shift
  local candidate=''

  for candidate in "$@"; do
    if [ "$candidate" = "$needle" ]; then
      return 0
    fi
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

  if [ -d "$file" ]; then
    printf 'Error: directories are not allowed (%s); list exact file paths instead\n' "$file" >&2
    exit 1
  fi

  matched_files=()
  while IFS= read -r -d '' matched_file; do
    matched_files+=("$matched_file")
  done < <(git --literal-pathspecs ls-files --full-name --cached --others --exclude-standard -z -- "$file")

  if [ "${#matched_files[@]}" -eq 0 ] && [ "$has_base_commit" = true ]; then
    while IFS= read -r -d '' matched_file; do
      matched_files+=("$matched_file")
    done < <(git --literal-pathspecs ls-tree --full-name -r --name-only -z "$base_head" -- "$file")
  fi

  if [ "${#matched_files[@]}" -eq 0 ]; then
    printf 'Error: file not found: %s\n' "$file" >&2
    exit 1
  fi

  if [ "${#matched_files[@]}" -ne 1 ]; then
    printf 'Error: path must identify exactly one file: %s\n' "$file" >&2
    exit 1
  fi

  canonical_file="${matched_files[0]}"
  if [ "${#canonical_files[@]}" -eq 0 ] || ! contains_path "$canonical_file" "${canonical_files[@]}"; then
    if ((${#disallow_globs[@]} > 0)); then
      for pattern in "${disallow_globs[@]}"; do
        case "$canonical_file" in
          $pattern)
            printf 'Error: committing files matching %s is disallowed in this repository (%s)\n' "$pattern" "$canonical_file" >&2
            exit 1
            ;;
        esac
      done
    fi

    canonical_files+=("$canonical_file")
  fi
done

lock_dir="$(git rev-parse --git-path agent-commit-locks)"
mkdir -p "$lock_dir"

acquired_locks=()
tmp_index=''
tmp_commit_msg=''
original_index_snapshot=''
prepared_index=''
real_index_path=''
real_index_lock=''
real_index_lock_acquired=false
ref_updated=false

finalize_reserved_index() {
  if [ "$real_index_lock_acquired" != true ]; then
    return 0
  fi

  if mv -f "$real_index_lock" "$real_index_path"; then
    real_index_lock_acquired=false
    return 0
  fi

  if [ ! -e "$real_index_lock" ] && [ -f "$real_index_path" ] && cmp -s "$real_index_path" "$prepared_index"; then
    real_index_lock_acquired=false
    return 0
  fi

  return 1
}

cleanup() {
  local status=$?
  local reconciliation_failed=false
  trap - EXIT
  trap '' HUP INT QUIT TERM

  if [ "$real_index_lock_acquired" = true ]; then
    if [ "$ref_updated" = true ]; then
      if ! finalize_reserved_index; then
        if ! finalize_reserved_index; then
          reconciliation_failed=true
        fi
      fi
    else
      rm -f "$real_index_lock"
      real_index_lock_acquired=false
    fi
  fi

  if [ -n "$tmp_index" ]; then
    rm -f "$tmp_index" "${tmp_index}.lock"
  fi

  if [ -n "$tmp_commit_msg" ] && [ -f "$tmp_commit_msg" ]; then
    rm -f "$tmp_commit_msg"
  fi

  if [ -n "$original_index_snapshot" ]; then
    rm -f "$original_index_snapshot" "${original_index_snapshot}.lock"
  fi

  if [ -n "$prepared_index" ]; then
    rm -f "$prepared_index" "${prepared_index}.lock"
  fi

  for lock_path in "${acquired_locks[@]}"; do
    [ -f "$lock_path" ] && rm -f "$lock_path"
  done

  if [ "$ref_updated" = true ]; then
    if [ "$reconciliation_failed" = true ]; then
      if [ -e "$real_index_lock" ]; then
        printf 'Error: commit %s succeeded but the prepared repository index could not be installed; inspect the Git index lock before retrying\n' "${new_commit:0:12}" >&2
      else
        printf 'Error: commit %s succeeded but repository index reconciliation could not be confirmed; verify the index before retrying\n' "${new_commit:0:12}" >&2
      fi
      status=1
    else
      printf 'Committed "%s" as %s on %s with %d file(s)\n' "$commit_message" "${new_commit:0:12}" "$branch_ref" "${#committed_files[@]}"
      status=0
    fi
  fi

  exit "$status"
}
trap cleanup EXIT

handle_signal() {
  local signal_name="$1"
  local signal_status="$2"
  printf 'Interrupted by %s\n' "$signal_name" >&2
  exit "$signal_status"
}
install_signal_traps() {
  trap 'handle_signal HUP 129' HUP
  trap 'handle_signal INT 130' INT
  trap 'handle_signal QUIT 131' QUIT
  trap 'handle_signal TERM 143' TERM
}
install_signal_traps

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

for file in "${canonical_files[@]}"; do
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

if git -C "$repo_root" --literal-pathspecs diff --name-only --diff-filter=U -- "${canonical_files[@]}" | grep -q '.'; then
  printf 'Error: unresolved merge conflicts in selected files\n' >&2
  exit 1
fi

tmp_index="$(mktemp "${TMPDIR:-/tmp}/committer-index.XXXXXX")"
if [ "$has_base_commit" = true ]; then
  GIT_INDEX_FILE="$tmp_index" git read-tree "$base_head"
  comparison_tree="$base_head"
else
  GIT_INDEX_FILE="$tmp_index" git read-tree --empty
  comparison_tree="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
fi
GIT_INDEX_FILE="$tmp_index" git -C "$repo_root" --literal-pathspecs add -A -- "${canonical_files[@]}"

initial_changed_files=()
while IFS= read -r -d '' changed_path; do
  initial_changed_files+=("$changed_path")
done < <(GIT_INDEX_FILE="$tmp_index" git -C "$repo_root" diff --cached --name-only --no-renames -z "$comparison_tree" --)

if [ "${#initial_changed_files[@]}" -eq 0 ]; then
  printf 'Warning: no changes detected for selected file paths\n' >&2
  exit 1
fi

real_index_path="$(git rev-parse --git-path index)"
if [[ "$real_index_path" != /* ]]; then
  real_index_path="$PWD/$real_index_path"
fi
real_index_existed=false
original_index_snapshot="$(mktemp "${TMPDIR:-/tmp}/committer-real-index.XXXXXX")"
if [ -f "$real_index_path" ]; then
  cp "$real_index_path" "$original_index_snapshot"
  real_index_existed=true
else
  GIT_INDEX_FILE="$original_index_snapshot" git read-tree --empty
fi

preexisting_staged_files=()
for canonical_file in "${canonical_files[@]}"; do
  if GIT_INDEX_FILE="$original_index_snapshot" git -C "$repo_root" --literal-pathspecs diff --cached --quiet "$comparison_tree" -- "$canonical_file"; then
    continue
  else
    diff_status=$?
    if [ "$diff_status" -ne 1 ]; then
      printf 'Error: could not inspect the existing staged snapshot for %s\n' "$canonical_file" >&2
      exit 1
    fi
  fi
  preexisting_staged_files+=("$canonical_file")
done

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

committed_files=()
while IFS= read -r -d '' changed_path; do
  committed_files+=("$changed_path")
done < <(GIT_INDEX_FILE="$tmp_index" git -C "$repo_root" diff --cached --name-only --no-renames -z "$comparison_tree" --)

if [ "${#committed_files[@]}" -eq 0 ]; then
  printf 'Error: hooks removed every selected change; refusing to create an empty commit\n' >&2
  exit 1
fi

hook_added_paths=()
for changed_path in "${committed_files[@]}"; do
  if ! contains_path "$changed_path" "${canonical_files[@]}"; then
    hook_added_paths+=("$changed_path")
  fi
done

if [ "${#hook_added_paths[@]}" -gt 0 ]; then
  for hook_added_path in "${hook_added_paths[@]}"; do
    printf 'Error: hook staged a path outside the selected exact file list: %s\n' "$hook_added_path" >&2
  done
  printf 'List every hook-generated path explicitly and retry\n' >&2
  exit 1
fi

hook_removed_paths=()
for changed_path in "${initial_changed_files[@]}"; do
  if ! contains_path "$changed_path" "${committed_files[@]}"; then
    hook_removed_paths+=("$changed_path")
  fi
done

if [ "${#hook_removed_paths[@]}" -gt 0 ]; then
  for hook_removed_path in "${hook_removed_paths[@]}"; do
    printf 'Error: hook removed an initially selected change: %s\n' "$hook_removed_path" >&2
  done
  exit 1
fi

if [ "$has_base_commit" = true ]; then
  new_commit="$(GIT_INDEX_FILE="$tmp_index" git commit-tree -p "$base_head" -F <(printf '%s\n' "$commit_message") "$(GIT_INDEX_FILE="$tmp_index" git write-tree)")"
else
  new_commit="$(GIT_INDEX_FILE="$tmp_index" git commit-tree -F <(printf '%s\n' "$commit_message") "$(GIT_INDEX_FILE="$tmp_index" git write-tree)")"
fi

reconcile_files=()
for committed_file in "${committed_files[@]}"; do
  if [ "${#preexisting_staged_files[@]}" -eq 0 ] || ! contains_path "$committed_file" "${preexisting_staged_files[@]}"; then
    reconcile_files+=("$committed_file")
  fi
done

if [ "${#reconcile_files[@]}" -gt 0 ]; then
  prepared_index="$(mktemp "${TMPDIR:-/tmp}/committer-prepared-index.XXXXXX")"
  cp "$original_index_snapshot" "$prepared_index"
  GIT_INDEX_FILE="$prepared_index" git -C "$repo_root" --literal-pathspecs reset -q "$new_commit" -- "${reconcile_files[@]}"

  real_index_lock="${real_index_path}.lock"
  if ! (set -o noclobber; : >"$real_index_lock") 2>/dev/null; then
    printf 'Error: repository index is locked; no commit was created\n' >&2
    exit 1
  fi
  real_index_lock_acquired=true

  index_changed=false
  if [ "$real_index_existed" = true ]; then
    if [ ! -f "$real_index_path" ] || ! cmp -s "$real_index_path" "$original_index_snapshot"; then
      index_changed=true
    fi
  elif [ -e "$real_index_path" ]; then
    index_changed=true
  fi

  if [ "$index_changed" = true ]; then
    printf 'Error: repository index changed during commit preparation; no commit was created\n' >&2
    exit 1
  fi

  if ! cp "$prepared_index" "$real_index_lock"; then
    printf 'Error: could not prepare repository index reconciliation; no commit was created\n' >&2
    exit 1
  fi
fi

trap '' HUP INT QUIT TERM
if ! git update-ref "$branch_ref" "$new_commit" "$expected_old_oid"; then
  install_signal_traps
  exit 1
fi
ref_updated=true
exit 0
