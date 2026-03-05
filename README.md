# @cobuild/repo-tools

Shared repository operations tooling for Cobuild repos.

## Tools

- `cobuild-open-exec-plan`
- `cobuild-close-exec-plan`
- `cobuild-doc-gardening`
- `cobuild-check-agent-docs-drift`
- `cobuild-committer`

## Config

`cobuild-check-agent-docs-drift`, `cobuild-doc-gardening`, and `cobuild-committer` read configuration from environment variables so each consuming repo can keep only thin wrappers.

Supported env vars:

- `COBUILD_DRIFT_REQUIRED_FILES`: newline-delimited required doc artifact paths.
- `COBUILD_DRIFT_CODE_CHANGE_PATTERN`: extended regex for code/process-sensitive files.
- `COBUILD_DRIFT_CODE_CHANGE_LABEL`: message prefix for code/doc coupling failures.
- `COBUILD_DRIFT_LARGE_CHANGE_THRESHOLD`: file-count threshold that requires an active plan.
- `COBUILD_DRIFT_CHANGED_COUNT_EXCLUDE_PATTERN`: extended regex of files excluded from large-change counting.
- `COBUILD_DRIFT_ALLOW_RELEASE_ARTIFACTS_ONLY`: set to `1` to allow release-artifact-only commits without docs updates.
- `COBUILD_DOC_GARDENING_EXTRA_TRACKED_PATHS`: newline-delimited extra tracked doc paths outside `agent-docs/**`.
- `COBUILD_COMMITTER_EXAMPLE`: example Conventional Commit shown on validation failure.
- `COBUILD_COMMITTER_DISALLOW_GLOBS`: newline-delimited shell globs that must not be committed.

## Release

- `npm run release:check`
- `npm run release:patch`
- `npm run release:minor`
- `npm run release:major`
