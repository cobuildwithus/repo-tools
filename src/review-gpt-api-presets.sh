#!/usr/bin/env bash
set -euo pipefail

list_presets() {
  cat <<'EOC'
Available presets:
  all                 - Include all major API audit preset sections.
  security            - Node/API security review (headers, auth, secrets, trust boundaries).
  security-audit      - Deep auth + grant + endpoint security pass.
  simplify            - Complexity and behavior-preserving simplification opportunities.
  bad-code            - Combined code quality and anti-pattern pass.
  grief-vectors       - Abuse, liveness, and denial-of-service vectors.
  incentives          - Abuse economics and resource-extraction incentives.
  reliability         - Timeouts, retries, streaming lifecycle, and failure safety.
  test-gaps           - Highest-impact missing test coverage for changed behavior.
  api-contracts       - Request/response schema + runtime compatibility audit.
  auth-grants         - JWT, ownership, and grant lifecycle enforcement review.
  tool-safety         - Tool invocation + external integration safety review.
EOC
}

expand_preset_token() {
  local token="$1"
  case "$token" in
    all)
      add_preset security
      add_preset security-audit
      add_preset simplify
      add_preset bad-code
      add_preset grief-vectors
      add_preset incentives
      add_preset reliability
      add_preset test-gaps
      add_preset api-contracts
      add_preset auth-grants
      add_preset tool-safety
      ;;
    security)
      add_preset security
      ;;
    security-audit|audit-security)
      add_preset security-audit
      ;;
    simplify|complexity|complexity-simplification)
      add_preset simplify
      ;;
    anti-patterns|antipatterns|bad-practices|anti-patterns-and-bad-practices)
      add_preset bad-code
      ;;
    bad-code|code-quality|bad-code-quality)
      add_preset bad-code
      ;;
    grief-vectors|grief|dos|liveness)
      add_preset grief-vectors
      ;;
    incentives|economic-security|economics|economic-security-and-incentives)
      add_preset incentives
      ;;
    reliability|reliability-audit)
      add_preset reliability
      ;;
    test-gaps|coverage-gaps|coverage)
      add_preset test-gaps
      ;;
    api-contracts|contracts|api)
      add_preset api-contracts
      ;;
    auth-grants|auth|grants|authorization)
      add_preset auth-grants
      ;;
    tool-safety|tools|integrations)
      add_preset tool-safety
      ;;
    *)
      echo "Error: unknown preset '$token'." >&2
      echo "Run --list-presets to see valid names." >&2
      exit 1
      ;;
  esac
}

preset_file() {
  local preset="$1"
  case "$preset" in
    security)
      printf '%s\n' "$preset_dir/security.md"
      ;;
    security-audit)
      printf '%s\n' "$preset_dir/security-audit.md"
      ;;
    simplify)
      printf '%s\n' "$preset_dir/complexity-simplification.md"
      ;;
    anti-patterns|bad-code)
      printf '%s\n' "$preset_dir/bad-code-quality.md"
      ;;
    grief-vectors)
      printf '%s\n' "$preset_dir/grief-vectors.md"
      ;;
    incentives|economic-security)
      printf '%s\n' "$preset_dir/incentives.md"
      ;;
    reliability)
      printf '%s\n' "$preset_dir/reliability.md"
      ;;
    test-gaps)
      printf '%s\n' "$preset_dir/test-gaps.md"
      ;;
    api-contracts)
      printf '%s\n' "$preset_dir/api-contracts.md"
      ;;
    auth-grants)
      printf '%s\n' "$preset_dir/auth-grants.md"
      ;;
    tool-safety)
      printf '%s\n' "$preset_dir/tool-safety.md"
      ;;
    *)
      echo "Error: no prompt file mapping for preset '$preset'." >&2
      exit 1
      ;;
  esac
}
