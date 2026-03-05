#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release.sh check
  bash scripts/release.sh <patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z[-channel.n]> [--preid <alpha|beta|rc>] [--dry-run] [--no-push] [--allow-non-main]

Examples:
  bash scripts/release.sh patch
  bash scripts/release.sh preminor --preid alpha
  bash scripts/release.sh 1.2.3-rc.1 --dry-run
  bash scripts/release.sh check
EOF
}

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  usage >&2
  exit 1
fi
shift || true

PREID=""
DRY_RUN=false
PUSH_TAGS=true
ALLOW_NON_MAIN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preid)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --preid" >&2
        usage >&2
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
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

EXPECTED_PACKAGE_NAME="@cobuild/repo-tools"
EXPECTED_REPOSITORY_URL="https://github.com/cobuildwithus/repo-tools"

assert_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: git working tree must be clean before release." >&2
    exit 1
  fi
}

assert_main_branch() {
  if [[ "$ALLOW_NON_MAIN" == true ]]; then
    return
  fi

  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current_branch" != "main" ]]; then
    echo "Error: releases must run from main (current: $current_branch)." >&2
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
  local package_name
  package_name="$(node -p "require('./package.json').name")"
  if [[ "$package_name" != "$EXPECTED_PACKAGE_NAME" ]]; then
    echo "Error: unexpected package name '$package_name' (expected $EXPECTED_PACKAGE_NAME)." >&2
    exit 1
  fi
}

assert_repository_url() {
  local package_repository_url
  package_repository_url="$(
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
'
  )"
  if [[ "$package_repository_url" != "$EXPECTED_REPOSITORY_URL" ]]; then
    echo "Error: unexpected package repository '$package_repository_url' (expected $EXPECTED_REPOSITORY_URL)." >&2
    exit 1
  fi
}

run_release_checks() {
  npm run release:check
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

  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta|rc)\.[0-9]+$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi

  echo "Unsupported release version format: $version" >&2
  exit 1
}

restore_file_from_snapshot() {
  local target="$1"
  local snapshot="$2"
  if [[ -f "$snapshot" ]]; then
    cat "$snapshot" > "$target"
  fi
}

if [[ "$ACTION" == "check" ]]; then
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

if [[ -n "$PREID" ]]; then
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
    if [[ -z "$PREID" ]]; then
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

package_snapshot="$(mktemp)"
changelog_snapshot="$(mktemp)"
cat package.json > "$package_snapshot"
cat CHANGELOG.md > "$changelog_snapshot"
trap 'restore_file_from_snapshot package.json "$package_snapshot"; restore_file_from_snapshot CHANGELOG.md "$changelog_snapshot"; rm -f "$package_snapshot" "$changelog_snapshot"' EXIT

npm_version_args=("$ACTION" "--no-git-tag-version")
if [[ -n "$PREID" ]]; then
  npm_version_args+=("--preid" "$PREID")
fi

new_tag="$(npm version "${npm_version_args[@]}" | tail -n1 | tr -d '\r')"
new_version="${new_tag#v}"
npm_dist_tag="$(resolve_npm_tag "$new_version")"

if [[ -n "$npm_dist_tag" ]]; then
  echo "Release channel: $npm_dist_tag"
else
  echo "Release channel: latest"
fi

"$SCRIPT_DIR/update-changelog.sh" "$new_version"

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run only."
  echo "Would prepare release: @cobuild/repo-tools@$new_version"
  echo "Would create tag: v$new_version"
  if [[ "$PUSH_TAGS" == true ]]; then
    echo "Would push main and v$new_version"
  fi
  restore_file_from_snapshot package.json "$package_snapshot"
  restore_file_from_snapshot CHANGELOG.md "$changelog_snapshot"
  rm -f "$package_snapshot" "$changelog_snapshot"
  trap - EXIT
  exit 0
fi

scripts/committer "chore(release): v${new_version}" package.json CHANGELOG.md
git tag -a "v${new_version}" -m "v${new_version}"

if [[ "$PUSH_TAGS" == true ]]; then
  git push origin HEAD
  git push origin "v${new_version}"
else
  echo "Skipping push (--no-push)."
fi

rm -f "$package_snapshot" "$changelog_snapshot"
trap - EXIT

echo "Release prepared: @cobuild/repo-tools@$new_version"
