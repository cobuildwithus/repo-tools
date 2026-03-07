#!/usr/bin/env bash
set -euo pipefail

repo_tools_join_lines() {
  local out_var="$1"
  shift
  local joined=""
  local item
  for item in "$@"; do
    joined+="${item}"$'\n'
  done
  printf -v "$out_var" '%s' "$joined"
  export "$out_var"
}

cobuild_repo_tool_path() {
  local relative_path="$1"
  local local_path="$COBUILD_REPO_ROOT/node_modules/@cobuild/repo-tools/$relative_path"
  local sibling_path="$COBUILD_REPO_ROOT/../repo-tools/$relative_path"

  if [ -f "$local_path" ]; then
    printf '%s\n' "$local_path"
    return 0
  fi

  # Allow local workspace testing of unreleased repo-tools files before the next package publish.
  if [ -f "$sibling_path" ]; then
    printf '%s\n' "$sibling_path"
    return 0
  fi

  echo "Error: missing repo-tools file '$relative_path'. Install dependencies first." >&2
  return 1
}

cobuild_repo_tool_bin() {
  local bin_name="$1"
  local local_bin="$COBUILD_REPO_ROOT/node_modules/.bin/$bin_name"
  local sibling_bin="$COBUILD_REPO_ROOT/../repo-tools/bin/$bin_name"

  if [ -x "$local_bin" ]; then
    printf '%s\n' "$local_bin"
    return 0
  fi

  # Allow local workspace testing of unreleased repo-tools bins before the next package publish.
  if [ -x "$sibling_bin" ]; then
    printf '%s\n' "$sibling_bin"
    return 0
  fi

  if command -v "$bin_name" >/dev/null 2>&1; then
    command -v "$bin_name"
    return 0
  fi

  echo "Error: missing repo-tools executable '$bin_name'. Install dependencies first." >&2
  return 1
}
