#!/usr/bin/env bash
set -euo pipefail

prefix_default="${COBUILD_AUDIT_CONTEXT_PREFIX:-cobuild-audit}"
title_default="${COBUILD_AUDIT_CONTEXT_TITLE:-Cobuild Audit Bundle}"
repo_label="${COBUILD_AUDIT_CONTEXT_REPO_LABEL:-repo}"
sensitive_note="${COBUILD_AUDIT_CONTEXT_SENSITIVE_NOTE:-}"
include_tests_default="${COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT:-1}"
include_docs_default="${COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT:-1}"
include_ci_default="${COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT:-1}"
prune_dir_names="${COBUILD_AUDIT_CONTEXT_PRUNE_DIR_NAMES:-node_modules
.git
dist
out
cache
coverage
audit-packages}"
always_paths_config="${COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS:-AGENTS.md
ARCHITECTURE.md
README.md
package.json
pnpm-lock.yaml
tsconfig.json
tsconfig.build.json
vitest.config.ts}"
scan_specs_default="${COBUILD_AUDIT_CONTEXT_SCAN_SPECS:-src
scripts}"
test_scan_specs_default="${COBUILD_AUDIT_CONTEXT_TEST_SCAN_SPECS:-tests
test}"
doc_scan_specs_default="${COBUILD_AUDIT_CONTEXT_DOC_SCAN_SPECS:-agent-docs:*.md}"
ci_scan_specs_default="${COBUILD_AUDIT_CONTEXT_CI_SCAN_SPECS:-.github/workflows}"
exclude_globs="${COBUILD_AUDIT_CONTEXT_EXCLUDE_GLOBS:-}"
exclude_sensitive="${COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE:-0}"
validate_solidity_closure="${COBUILD_AUDIT_CONTEXT_VALIDATE_SOLIDITY_IMPORT_CLOSURE:-0}"

format="both"
out_dir=""
prefix="$prefix_default"
include_tests="$include_tests_default"
include_docs="$include_docs_default"
include_ci="$include_ci_default"

usage() {
  local exit_code="${1:-0}"
  cat >&2 <<USAGE
Usage: cobuild-package-audit-context [options]

Packages audit-relevant ${repo_label} files into upload-friendly artifacts.${sensitive_note:+
${sensitive_note}}

Options:
  --zip              Create only a .zip archive
  --txt              Create only a merged .txt file
  --both             Create both .zip and .txt (default)
  --out-dir <dir>    Output directory (default: <repo>/audit-packages)
  --name <prefix>    Output filename prefix (default: ${prefix_default})
  --with-tests       Include configured test scan paths
  --no-tests         Exclude configured test scan paths
  --with-docs        Include configured docs scan paths
  --no-docs          Exclude configured docs scan paths
  --with-ci          Include configured CI scan paths
  --no-ci            Exclude configured CI scan paths
  -h, --help         Show this help message
USAGE
  exit "$exit_code"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip)
      format="zip"
      shift
      ;;
    --txt)
      format="txt"
      shift
      ;;
    --both)
      format="both"
      shift
      ;;
    --out-dir)
      [[ $# -ge 2 ]] || { echo "Error: --out-dir requires a value." >&2; exit 1; }
      out_dir="$2"
      shift 2
      ;;
    --name)
      [[ $# -ge 2 ]] || { echo "Error: --name requires a value." >&2; exit 1; }
      prefix="$2"
      shift 2
      ;;
    --with-tests)
      include_tests=1
      shift
      ;;
    --no-tests)
      include_tests=0
      shift
      ;;
    --with-docs)
      include_docs=1
      shift
      ;;
    --no-docs)
      include_docs=0
      shift
      ;;
    --with-ci)
      include_ci=1
      shift
      ;;
    --no-ci)
      include_ci=0
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "Error: unknown option '$1'." >&2
      usage 2
      ;;
  esac
done

if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

if [[ -z "$out_dir" ]]; then
  out_dir="$ROOT/audit-packages"
fi
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

if [[ "$format" == "zip" || "$format" == "both" ]]; then
  if ! command -v zip >/dev/null 2>&1; then
    echo "Error: zip is required for --zip/--both modes." >&2
    exit 1
  fi
fi

timestamp="$(date -u '+%Y%m%d-%H%M%SZ')"
base_name="${prefix}-${timestamp}"
manifest="$(mktemp)"
missing_imports="$(mktemp)"
cleanup() {
  rm -f "$manifest" "$missing_imports"
}
trap cleanup EXIT

trim_cr() {
  local line="$1"
  printf '%s' "${line%$'\r'}"
}

is_excluded_path() {
  local relpath="$1"
  local base_name="${relpath##*/}"
  while IFS= read -r raw; do
    local pattern
    pattern="$(trim_cr "$raw")"
    [[ -z "$pattern" ]] && continue
    case "$relpath" in
      $pattern)
        return 0
        ;;
    esac
  done <<< "$exclude_globs"

  if [[ "$exclude_sensitive" != "1" ]]; then
    return 1
  fi

  case "$relpath" in
    .env|.env.*|*/.env|*/.env.*|*/.aws/*|*/.ssh/*|*/.gnupg/*|*/audit-packages/*)
      return 0
      ;;
  esac

  case "$base_name" in
    .env|.env.*|.npmrc|.netrc|.pypirc|.dockercfg|docker-config.json)
      return 0
      ;;
    id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|known_hosts)
      return 0
      ;;
    *.pem|*.key|*.p8|*.p12|*.pfx|*.crt|*.cer|*.der|*.jks|*.kdb|*.pkcs12|*.ovpn|*.kubeconfig)
      return 0
      ;;
    *.zip|*.tar|*.tgz|*.gz|*.bz2|*.xz|*.7z)
      return 0
      ;;
  esac

  return 1
}

list_tree_files() {
  local rel_dir="$1"
  local file_glob="${2:-*}"
  [[ -d "$ROOT/$rel_dir" ]] || return 0

  while IFS= read -r -d '' file_path; do
    printf '%s\n' "${file_path#"$ROOT/"}"
  done < <(
    find "$ROOT/$rel_dir" \
      \( -type d \( $(
        first=1
        while IFS= read -r raw; do
          item="$(trim_cr "$raw")"
          [[ -z "$item" ]] && continue
          if [[ "$first" == "1" ]]; then
            printf -- '-name %q ' "$item"
            first=0
          else
            printf -- '-o -name %q ' "$item"
          fi
        done <<< "$prune_dir_names"
      ) \) -prune \) -o \
      -type f -name "$file_glob" -print0
  )
}

collect_scan_specs() {
  local specs="$1"
  while IFS= read -r raw; do
    local spec rel_dir file_glob
    spec="$(trim_cr "$raw")"
    [[ -z "$spec" ]] && continue
    if [[ "$spec" == *:* ]]; then
      rel_dir="${spec%%:*}"
      file_glob="${spec#*:}"
    else
      rel_dir="$spec"
      file_glob='*'
    fi
    list_tree_files "$rel_dir" "$file_glob"
  done <<< "$specs"
}

{
  while IFS= read -r raw; do
    relpath="$(trim_cr "$raw")"
    [[ -z "$relpath" ]] && continue
    [[ -f "$ROOT/$relpath" ]] && printf '%s\n' "$relpath"
  done <<< "$always_paths_config"

  collect_scan_specs "$scan_specs_default"

  if [[ "$include_tests" == "1" ]]; then
    collect_scan_specs "$test_scan_specs_default"
  fi
  if [[ "$include_docs" == "1" ]]; then
    collect_scan_specs "$doc_scan_specs_default"
  fi
  if [[ "$include_ci" == "1" ]]; then
    collect_scan_specs "$ci_scan_specs_default"
  fi
} | awk 'NF' | sort -u | while IFS= read -r relpath; do
  if is_excluded_path "$relpath"; then
    printf 'Warning: excluding path from audit package: %s\n' "$relpath" >&2
    continue
  fi
  if [[ -f "$ROOT/$relpath" ]]; then
    printf '%s\n' "$relpath"
  else
    printf 'Warning: skipping missing selected file: %s\n' "$relpath" >&2
  fi
done > "$manifest"

file_count="$(wc -l < "$manifest" | tr -d ' ')"
if [[ "$file_count" == "0" ]]; then
  echo "Error: no files matched packaging filters." >&2
  exit 1
fi

resolve_import_path() {
  local from_file="$1"
  local import_path="$2"
  local combined base_dir='.'

  if [[ "$import_path" == src/* ]]; then
    combined="$import_path"
  else
    [[ "$from_file" == */* ]] && base_dir="${from_file%/*}"
    combined="$base_dir/$import_path"
  fi

  local IFS='/'
  local -a parts out_parts
  read -r -a parts <<< "$combined"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|.) continue ;;
      ..)
        if [[ ${#out_parts[@]} -eq 0 ]]; then
          return 1
        fi
        unset "out_parts[${#out_parts[@]}-1]"
        ;;
      *) out_parts+=("$part") ;;
    esac
  done
  [[ ${#out_parts[@]} -gt 0 ]] || return 1
  (IFS='/'; printf '%s\n' "${out_parts[*]}")
}

validate_solidity_import_closure_fn() {
  local has_errors=0
  extract_solidity_imports() {
    local relpath="$1"
    perl -0777 -ne 's{/\*.*?\*/}{}gs; s{//[^\n]*}{}g; while (/\bimport\s+(?:[^"\x27;]+?\s+from\s+)?["\x27]([^"\x27]+)["\x27]\s*;/g) { print "$1\n"; }' "$ROOT/$relpath"
  }

  while IFS= read -r relpath; do
    [[ "$relpath" == *.sol ]] || continue
    while IFS= read -r import_path; do
      case "$import_path" in
        ./*|../*|src/*) ;;
        *) continue ;;
      esac
      local resolved_path
      if ! resolved_path="$(resolve_import_path "$relpath" "$import_path")"; then
        printf '%s -> %s (resolved outside repo)\n' "$relpath" "$import_path" >> "$missing_imports"
        has_errors=1
        continue
      fi
      if [[ ! -f "$ROOT/$resolved_path" ]]; then
        printf '%s -> %s (file not found: %s)\n' "$relpath" "$import_path" "$resolved_path" >> "$missing_imports"
        has_errors=1
        continue
      fi
      if ! grep -Fxq "$resolved_path" "$manifest"; then
        printf '%s -> %s (not packaged: %s)\n' "$relpath" "$import_path" "$resolved_path" >> "$missing_imports"
        has_errors=1
      fi
    done < <(extract_solidity_imports "$relpath")
  done < "$manifest"

  if [[ "$has_errors" -ne 0 ]]; then
    echo "Error: package manifest failed Solidity import closure check." >&2
    sort -u "$missing_imports" >&2
    exit 1
  fi
}

if [[ "$validate_solidity_closure" == "1" ]]; then
  validate_solidity_import_closure_fn
fi

zip_path=""
txt_path=""
if [[ "$format" == "zip" || "$format" == "both" ]]; then
  zip_path="$out_dir/$base_name.zip"
  (
    cd "$ROOT"
    zip -q "$zip_path" -@ < "$manifest"
  )
fi

if [[ "$format" == "txt" || "$format" == "both" ]]; then
  txt_path="$out_dir/$base_name.txt"
  {
    printf '# %s\n' "$title_default"
    printf '# Generated (UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '# Repository: %s\n' "$ROOT"
    printf '# Files: %s\n' "$file_count"

    while IFS= read -r relpath; do
      printf '\n===== FILE: %s =====\n' "$relpath"
      cat -- "$ROOT/$relpath"
      printf '\n'
    done < "$manifest"
  } > "$txt_path"
fi

echo "Audit package created."
echo "Included files: $file_count"
[[ -n "$zip_path" ]] && echo "ZIP: $zip_path ($(du -h "$zip_path" | awk '{print $1}'))"
[[ -n "$txt_path" ]] && echo "TXT: $txt_path ($(du -h "$txt_path" | awk '{print $1}'))"
