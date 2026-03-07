#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOT'
Usage:
  release-package.sh check
  release-package.sh <patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z[-channel.n]> [--preid <alpha|beta|rc>] [--dry-run] [--no-push] [--allow-non-main] [--no-post-push]

Environment:
  COBUILD_RELEASE_PACKAGE_NAME          required expected package name
  COBUILD_RELEASE_REPOSITORY_URL        optional expected repository URL
  COBUILD_RELEASE_CHECK_CMD             optional release check command (default: pnpm release:check for pnpm repos, otherwise npm run release:check)
  COBUILD_RELEASE_COMMIT_CMD            optional commit helper path (default: scripts/committer)
  COBUILD_RELEASE_COMMIT_TEMPLATE       optional printf template (default: chore(release): v%s)
  COBUILD_RELEASE_TAG_MESSAGE_TEMPLATE  optional printf template (default: v%s)
  COBUILD_RELEASE_NOTES_ENABLED         set to 1 to generate release notes
  COBUILD_RELEASE_NOTES_DIR             output directory for notes (default: release-notes)
  COBUILD_RELEASE_POST_PUSH_CMD         optional shell command run after push; receives COBUILD_RELEASE_* env vars
  COBUILD_RELEASE_POST_PUSH_SKIP_ENV    optional env var name; if set to 1, skip the post-push hook
EOT
}

ACTION="${1:-}"
if [ -z "$ACTION" ]; then
  usage >&2
  exit 1
fi
shift || true

PREID=""
DRY_RUN=false
PUSH_TAGS=true
ALLOW_NON_MAIN=false
RUN_POST_PUSH=true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preid)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --preid." >&2
        exit 2
      fi
      PREID="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      PUSH_TAGS=false
      shift
      ;;
    --no-push)
      PUSH_TAGS=false
      shift
      ;;
    --allow-non-main)
      ALLOW_NON_MAIN=true
      shift
      ;;
    --no-post-push|--no-sync-upstreams)
      RUN_POST_PUSH=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'." >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
# `pnpm run ...` can forward pnpm-only config keys into nested subprocesses.
# Clear them so shared release flows stay portable across nested tool invocations.
unset npm_config_store_dir NPM_CONFIG_STORE_DIR || true

PACKAGE_NAME="${COBUILD_RELEASE_PACKAGE_NAME:-}"
REPOSITORY_URL="${COBUILD_RELEASE_REPOSITORY_URL:-}"
COMMIT_CMD="${COBUILD_RELEASE_COMMIT_CMD:-scripts/committer}"
COMMIT_TEMPLATE="${COBUILD_RELEASE_COMMIT_TEMPLATE:-chore(release): v%s}"
TAG_MESSAGE_TEMPLATE="${COBUILD_RELEASE_TAG_MESSAGE_TEMPLATE:-v%s}"
NOTES_ENABLED="${COBUILD_RELEASE_NOTES_ENABLED:-0}"
NOTES_DIR="${COBUILD_RELEASE_NOTES_DIR:-release-notes}"
POST_PUSH_CMD="${COBUILD_RELEASE_POST_PUSH_CMD:-}"
POST_PUSH_SKIP_ENV="${COBUILD_RELEASE_POST_PUSH_SKIP_ENV:-}"

if [ -z "$PACKAGE_NAME" ]; then
  echo "Error: COBUILD_RELEASE_PACKAGE_NAME must be set." >&2
  exit 1
fi

assert_clean_worktree() {
  if [ -n "$(git status --porcelain)" ]; then
    echo "Error: git working tree must be clean before release." >&2
    exit 1
  fi
}

assert_main_branch() {
  if [ "$ALLOW_NON_MAIN" = true ]; then
    return
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "Error: releases must run from main (current: $branch)." >&2
    exit 1
  fi
}

assert_origin_remote() {
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "Error: git remote 'origin' is not configured." >&2
    exit 1
  fi
}

assert_package_name() {
  package_name="$(node -p "require('./package.json').name")"
  if [ "$package_name" != "$PACKAGE_NAME" ]; then
    echo "Error: unexpected package name '$package_name' (expected $PACKAGE_NAME)." >&2
    exit 1
  fi
}

assert_repository_url() {
  if [ -z "$REPOSITORY_URL" ]; then
    return
  fi

  package_repository_url="$({
    node -e '
const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
const repository = pkg.repository;
if (typeof repository === "string") {
  console.log(repository);
} else if (repository && typeof repository.url === "string") {
  console.log(repository.url);
} else {
  console.log("");
}
';
  })"

  if [ "$package_repository_url" != "$REPOSITORY_URL" ]; then
    echo "Error: unexpected package repository '$package_repository_url' (expected $REPOSITORY_URL)." >&2
    exit 1
  fi
}

repo_prefers_pnpm() {
  if [ -f "pnpm-lock.yaml" ]; then
    return 0
  fi

  local package_manager
  package_manager="$({
    node -e '
const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
process.stdout.write(packageManager);
'
  })"

  [[ "$package_manager" == pnpm@* ]]
}

default_release_check_cmd() {
  if repo_prefers_pnpm; then
    printf '%s\n' 'pnpm release:check'
    return 0
  fi

  printf '%s\n' 'npm run release:check'
}

CHECK_CMD="${COBUILD_RELEASE_CHECK_CMD:-$(default_release_check_cmd)}"

run_release_checks() {
  echo "Running release checks..."
  sh -lc "$CHECK_CMD"
}

is_exact_version() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]]
}

resolve_npm_tag() {
  local version="$1"
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo ""
    return 0
  fi
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$ ]]; then
    echo "alpha"
    return 0
  fi
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
    echo "beta"
    return 0
  fi
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]]; then
    echo "rc"
    return 0
  fi
  echo "Unsupported release version format: $version" >&2
  echo "Expected x.y.z or x.y.z-(alpha|beta|rc).n" >&2
  exit 1
}

snapshot_file() {
  local target="$1"
  local out_var="$2"
  if [ -f "$target" ]; then
    local snapshot
    snapshot="$(mktemp)"
    cat "$target" > "$snapshot"
    printf -v "$out_var" '%s' "$snapshot"
  else
    printf -v "$out_var" ''
  fi
}

restore_file() {
  local target="$1"
  local snapshot="$2"
  if [ -n "$snapshot" ] && [ -f "$snapshot" ]; then
    cat "$snapshot" > "$target"
  else
    rm -f "$target"
  fi
}

run_commit() {
  local message="$1"
  shift
  if [ ! -x "$COMMIT_CMD" ]; then
    echo "Error: release commit helper is not executable: $COMMIT_CMD" >&2
    exit 1
  fi
  "$COMMIT_CMD" "$message" "$@"
}

run_post_push_hook() {
  if [ "$RUN_POST_PUSH" != true ]; then
    echo "Skipping post-push hook (--no-post-push)."
    return
  fi
  if [ "$PUSH_TAGS" != true ]; then
    echo "Skipping post-push hook (release not pushed)."
    return
  fi
  if [ -z "$POST_PUSH_CMD" ]; then
    return
  fi
  if [ -n "$POST_PUSH_SKIP_ENV" ]; then
    skip_value="${!POST_PUSH_SKIP_ENV:-0}"
    if [ "$skip_value" = "1" ]; then
      echo "Skipping post-push hook ($POST_PUSH_SKIP_ENV=1)."
      return
    fi
  fi

  export COBUILD_RELEASE_VERSION="$next_version"
  export COBUILD_RELEASE_TAG="v$next_version"
  export COBUILD_RELEASE_DIST_TAG="${npm_dist_tag:-latest}"
  export COBUILD_RELEASE_PACKAGE_NAME="$PACKAGE_NAME"
  sh -lc "$POST_PUSH_CMD"
}

if [ "$ACTION" = "check" ]; then
  assert_package_name
  assert_repository_url
  run_release_checks
  echo "Release checks passed."
  exit 0
fi

case "$ACTION" in
  patch|minor|major|prepatch|preminor|premajor|prerelease)
    ;;
  *)
    if ! is_exact_version "$ACTION"; then
      echo "Error: unsupported release action or version '$ACTION'." >&2
      usage >&2
      exit 2
    fi
    ;;
esac

if [ -n "$PREID" ]; then
  if ! [[ "$PREID" =~ ^(alpha|beta|rc)$ ]]; then
    echo "Error: --preid must be one of alpha|beta|rc." >&2
    exit 2
  fi

  case "$ACTION" in
    prepatch|preminor|premajor|prerelease)
      ;;
    *)
      echo "Error: --preid is only valid with prepatch/preminor/premajor/prerelease." >&2
      exit 2
      ;;
  esac
fi

case "$ACTION" in
  prepatch|preminor|premajor|prerelease)
    if [ -z "$PREID" ]; then
      echo "Error: --preid is required with prepatch/preminor/premajor/prerelease." >&2
      exit 2
    fi
    ;;
esac

assert_clean_worktree
assert_main_branch
assert_origin_remote
assert_package_name
assert_repository_url
run_release_checks

current_version="$(node -p "require('./package.json').version")"
echo "Current version: $current_version"

package_snapshot=""
changelog_snapshot=""
pnpm_lock_snapshot=""
notes_snapshot=""
notes_path=""
cleanup_required=true
cleanup() {
  local status=$?
  if [ "$cleanup_required" = true ]; then
    restore_file package.json "$package_snapshot"
    restore_file CHANGELOG.md "$changelog_snapshot"
    restore_file pnpm-lock.yaml "$pnpm_lock_snapshot"
    if [ -n "$notes_path" ]; then
      restore_file "$notes_path" "$notes_snapshot"
    fi
  fi
  rm -f "$package_snapshot" "$changelog_snapshot" "$pnpm_lock_snapshot"
  if [ -n "$notes_snapshot" ]; then
    rm -f "$notes_snapshot"
  fi
  exit $status
}
trap cleanup EXIT
snapshot_file package.json package_snapshot
snapshot_file CHANGELOG.md changelog_snapshot
snapshot_file pnpm-lock.yaml pnpm_lock_snapshot

pnpm_version_args=("$ACTION" "--no-git-tag-version")
if [ -n "$PREID" ]; then
  pnpm_version_args+=("--preid" "$PREID")
fi

next_tag="$(pnpm version "${pnpm_version_args[@]}" | tail -n1 | tr -d '\r')"
next_version="${next_tag#v}"
npm_dist_tag="$(resolve_npm_tag "$next_version")"
if [ -n "$npm_dist_tag" ]; then
  echo "Release channel: $npm_dist_tag"
else
  echo "Release channel: latest"
fi

"$SCRIPT_DIR/update-changelog.sh" "$next_version"

files_to_commit=(package.json CHANGELOG.md)
if ! git diff --quiet -- pnpm-lock.yaml 2>/dev/null; then
  files_to_commit+=(pnpm-lock.yaml)
fi

if [ "$NOTES_ENABLED" = "1" ]; then
  previous_tag="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
  notes_path="$NOTES_DIR/v${next_version}.md"
  snapshot_file "$notes_path" notes_snapshot
  echo "Generating release notes at $notes_path"
  if [ -n "$previous_tag" ]; then
    "$SCRIPT_DIR/generate-release-notes.sh" "$next_version" "$notes_path" --from-tag "$previous_tag" --to-ref HEAD
  else
    "$SCRIPT_DIR/generate-release-notes.sh" "$next_version" "$notes_path" --to-ref HEAD
  fi
  files_to_commit+=("$notes_path")
fi

if [ "$DRY_RUN" = true ]; then
  echo "Dry run only."
  echo "Would prepare release: $PACKAGE_NAME@$next_version"
  echo "Would create tag: v$next_version"
  if [ "$PUSH_TAGS" = true ]; then
    echo "Would push $(git rev-parse --abbrev-ref HEAD) and v$next_version"
  fi
  exit 0
fi

commit_message="$(printf "$COMMIT_TEMPLATE" "$next_version")"
tag_message="$(printf "$TAG_MESSAGE_TEMPLATE" "$next_version")"
run_commit "$commit_message" "${files_to_commit[@]}"
git tag -a "v$next_version" -m "$tag_message"

if [ "$PUSH_TAGS" = true ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo "Pushing $branch + tags to origin..."
  git push origin "$branch" --follow-tags
else
  echo "Release prepared locally. Skipping push."
fi

run_post_push_hook

cleanup_required=false
trap - EXIT
rm -f "$package_snapshot" "$changelog_snapshot"
if [ -n "$notes_snapshot" ]; then
  rm -f "$notes_snapshot"
fi

echo "Release prepared: $PACKAGE_NAME@$next_version"
echo "GitHub Actions will publish tag v$next_version to npm."
