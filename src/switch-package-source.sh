#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  cobuild-switch-package-source --package <name> [--field <dependencies|devDependencies|peerDependencies|optionalDependencies>] --local <path> [--no-install]
  cobuild-switch-package-source --package <name> [--field <dependencies|devDependencies|peerDependencies|optionalDependencies>] --published [<range>] [--no-install]

Examples:
  cobuild-switch-package-source --package @cobuild/wire --field dependencies --local ../wire
  cobuild-switch-package-source --package @cobuild/wire --field dependencies --published
  cobuild-switch-package-source --package @cobuild/repo-tools --field devDependencies --published ^0.1.4
USAGE
  exit 2
}

if [[ $# -eq 0 ]]; then
  usage
fi

package_name=""
dep_field="dependencies"
mode=""
local_target=""
published_target=""
should_install=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      [[ $# -ge 2 ]] || usage
      package_name="$2"
      shift 2
      ;;
    --field)
      [[ $# -ge 2 ]] || usage
      dep_field="$2"
      shift 2
      ;;
    --local)
      [[ $# -ge 2 ]] || usage
      mode="local"
      local_target="$2"
      shift 2
      ;;
    --published)
      mode="published"
      if [[ $# -ge 2 && "$2" != --* ]]; then
        published_target="$2"
        shift 2
      else
        shift
      fi
      ;;
    --no-install)
      should_install=0
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      printf 'Error: unknown argument: %s\n' "$1" >&2
      usage
      ;;
  esac
done

if [[ -z "$package_name" || -z "$mode" ]]; then
  usage
fi

case "$dep_field" in
  dependencies|devDependencies|peerDependencies|optionalDependencies) ;;
  *)
    printf 'Error: unsupported dependency field: %s\n' "$dep_field" >&2
    exit 1
    ;;
esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'Error: not inside a git repository\n' >&2
  exit 1
fi

have_pnpm=0
if command -v pnpm >/dev/null 2>&1; then
  have_pnpm=1
fi

resolve_latest_published_version() {
  local value=""
  if [[ "$have_pnpm" == "1" ]]; then
    value="$(pnpm view "$package_name" version --json 2>/dev/null | tr -d '"[:space:]')"
  elif command -v npm >/dev/null 2>&1; then
    value="$(npm view "$package_name" version --json 2>/dev/null | tr -d '"[:space:]')"
  fi
  if [[ -z "$value" || "$value" == "null" ]]; then
    printf 'Error: failed to resolve latest published version for %s\n' "$package_name" >&2
    exit 1
  fi
  printf '%s' "$value"
}

set_package_dependency() {
  local field="$1"
  local name="$2"
  local value="$3"
  node - "$field" "$name" "$value" <<'EOF'
const fs = require('node:fs');

const [, , depField, packageName, resolvedValue] = process.argv;
const packageJsonPath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const current = pkg[depField];
const nextField =
  current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : {};
nextField[packageName] = resolvedValue;
pkg[depField] = nextField;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
EOF
}

resolved_value=""
case "$mode" in
  local)
    if [[ -z "$local_target" ]]; then
      printf 'Error: --local requires a path\n' >&2
      exit 1
    fi
    resolved_value="link:${local_target}"
    ;;
  published)
    if [[ -n "$published_target" ]]; then
      resolved_value="$published_target"
    else
      latest_version="$(resolve_latest_published_version)"
      resolved_value="^${latest_version}"
    fi
    ;;
  *)
    printf 'Error: unsupported mode: %s\n' "$mode" >&2
    exit 1
    ;;
esac

set_package_dependency "$dep_field" "$package_name" "$resolved_value"

if [[ "$should_install" == "1" ]]; then
  if [[ "$have_pnpm" != "1" ]]; then
    printf 'Error: pnpm is required when install is enabled\n' >&2
    exit 1
  fi
  pnpm install --force
fi

printf 'Switched %s in %s to %s\n' "$package_name" "$dep_field" "$resolved_value"
