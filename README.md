# @cobuild/repo-tools

Shared repository operations tooling for Cobuild repos.

## Tools

- `cobuild-open-exec-plan`
- `cobuild-close-exec-plan`
- `cobuild-doc-gardening`
- `cobuild-check-agent-docs-drift`
- `cobuild-committer`
- `cobuild-package-audit-context`
- `cobuild-sync-dependent-repos`
- `cobuild-switch-package-source`
- `cobuild-update-changelog`
- `cobuild-generate-release-notes`
- `cobuild-release-package`

## Config

`cobuild-check-agent-docs-drift`, `cobuild-doc-gardening`, `cobuild-committer`, and `cobuild-package-audit-context` read configuration from environment variables so each consuming repo can keep only thin wrappers.

Supported env vars:

- `COBUILD_DRIFT_REQUIRED_FILES`: newline-delimited required doc artifact paths.
- `COBUILD_DRIFT_CODE_CHANGE_PATTERN`: extended regex for code/process-sensitive files.
- `COBUILD_DRIFT_CODE_CHANGE_LABEL`: message prefix for code/doc coupling failures.
- `COBUILD_DRIFT_LARGE_CHANGE_THRESHOLD`: file-count threshold that requires an active plan.
- `COBUILD_DRIFT_CHANGED_COUNT_EXCLUDE_PATTERN`: extended regex of files excluded from large-change counting.
- `COBUILD_DRIFT_ALLOW_RELEASE_ARTIFACTS_ONLY`: set to `1` to allow release-artifact-only commits without docs updates.
- `COBUILD_DOC_GARDENING_EXTRA_TRACKED_PATHS`: newline-delimited extra tracked doc paths outside `agent-docs/**`.
- `COBUILD_COMMITTER_EXAMPLE`: example Conventional Commit shown on validation failure.
- `COBUILD_COMMITTER_ALLOWED_TYPES`: optional comma- or newline-delimited Conventional Commit types accepted by `cobuild-committer`. Defaults to `feat,fix,refactor,build,ci,chore,docs,style,perf,test,release`.
- `COBUILD_COMMITTER_DISALLOW_GLOBS`: newline-delimited shell globs that must not be committed.
- `COBUILD_AUDIT_CONTEXT_PREFIX`: default output filename prefix for audit packages.
- `COBUILD_AUDIT_CONTEXT_TITLE`: heading used in merged text bundles.
- `COBUILD_AUDIT_CONTEXT_REPO_LABEL`: repo label used in the help text.
- `COBUILD_AUDIT_CONTEXT_SENSITIVE_NOTE`: optional extra sentence appended to the help text.
- `COBUILD_AUDIT_CONTEXT_INCLUDE_TESTS_DEFAULT`, `COBUILD_AUDIT_CONTEXT_INCLUDE_DOCS_DEFAULT`, `COBUILD_AUDIT_CONTEXT_INCLUDE_CI_DEFAULT`: default include toggles (`0` or `1`).
- `COBUILD_AUDIT_CONTEXT_ALWAYS_PATHS`: newline-delimited always-included file paths.
- `COBUILD_AUDIT_CONTEXT_SCAN_SPECS`, `COBUILD_AUDIT_CONTEXT_TEST_SCAN_SPECS`, `COBUILD_AUDIT_CONTEXT_DOC_SCAN_SPECS`, `COBUILD_AUDIT_CONTEXT_CI_SCAN_SPECS`: newline-delimited scan specs in `dir` or `dir:glob` form.
- `COBUILD_AUDIT_CONTEXT_PRUNE_DIR_NAMES`: newline-delimited directory names pruned while scanning.
- `COBUILD_AUDIT_CONTEXT_EXCLUDE_GLOBS`: newline-delimited shell globs excluded from the manifest.
- `COBUILD_AUDIT_CONTEXT_EXCLUDE_SENSITIVE`: set to `1` to drop common secret/archive paths from the manifest.
- `COBUILD_AUDIT_CONTEXT_VALIDATE_SOLIDITY_IMPORT_CLOSURE`: set to `1` to require packaged Solidity imports to stay closed within the manifest.
- `COBUILD_RELEASE_PACKAGE_NAME`: expected package name for shared release flow.
- `COBUILD_RELEASE_REPOSITORY_URL`: optional expected repository URL for shared release flow.
- `COBUILD_RELEASE_CHECK_CMD`: optional release-check command; defaults to `npm run release:check`.
- `COBUILD_RELEASE_COMMIT_CMD`: optional commit helper path; defaults to `scripts/committer`.
- `COBUILD_RELEASE_COMMIT_TEMPLATE`: optional `printf` template; defaults to `chore(release): v%s`.
- `COBUILD_RELEASE_TAG_MESSAGE_TEMPLATE`: optional tag annotation template; defaults to `v%s`.
- `COBUILD_RELEASE_NOTES_ENABLED`: set to `1` to generate release notes.
- `COBUILD_RELEASE_NOTES_DIR`: optional release notes output directory; defaults to `release-notes`.
- `COBUILD_RELEASE_POST_PUSH_CMD`: optional shell command run after a pushed release.
- `COBUILD_RELEASE_POST_PUSH_SKIP_ENV`: optional env var name; if that env var is `1`, skip the post-push hook.

## Release

- `pnpm run release:check`
- `pnpm run release:patch`
- `pnpm run release:minor`
- `pnpm run release:major`
- `pnpm run sync:repos -- --version <semver>`

The shared release flow uses `pnpm` for versioning and release checks, so PNPM-managed repos keep `pnpm-lock.yaml` authoritative instead of recreating `package-lock.json`.

## Consumer update policy

`@cobuild/repo-tools` is intended to be consumed as a published package from `node_modules`, not as a sibling checkout.

- Current direct workspace consumers: `v1-core`, `wire`, `interface`, `chat-api`, `cli`, `indexer`, and `review-gpt-cli`.
- Consumer wrapper scripts resolve repo-tools bins from the installed dev dependency first, so a sibling `repo-tools` clone is not required for normal repo operation.
- After a published release that changes shared bins, release wrappers, or config env contracts, bump the affected sibling repos intentionally instead of assuming agents will infer the rollout.

Typical consumer bump command from a consumer repo root:

```bash
pnpm up @cobuild/repo-tools@<version>
```

This repo now has the same one-command publish-and-bump shape:

- `scripts/release.sh` can call `scripts/sync-dependent-repos.sh` after push and after npm publish visibility.
- Skip the automatic downstream bump with `--no-sync-upstreams` or `REPO_TOOLS_SKIP_UPSTREAM_SYNC=1`.
- Run the same flow manually with `pnpm run sync:repos -- --version <semver> --wait-for-publish`.

## Examples

Switch a dependency to a published release:

```bash
pnpm exec cobuild-switch-package-source --package @cobuild/wire --field dependencies --published
```

Switch a dependency to a local link:

```bash
pnpm exec cobuild-switch-package-source --package @cobuild/wire --field dependencies --local ../wire
```

Build a text-only audit bundle using repo-local config:

```bash
source scripts/repo-tools.config.sh
pnpm exec cobuild-package-audit-context --txt
```
