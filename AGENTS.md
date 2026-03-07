# AGENTS.md

## Purpose

Shared tooling package for repo operation scripts used across Cobuild repositories.

## Rules

- Keep runtime tooling generic. No sibling-repo paths or environment-specific assumptions.
- Prefer configuration over per-repo forks.
- Use `pnpm` for installs, script execution, and lockfile management in this repo. Do not introduce `package-lock.json`.
- Treat the published `@cobuild/repo-tools` package as the consumer source of truth. Do not reintroduce sibling `file:` / `link:` dependencies unless the user explicitly asks for a local-only workflow.
- `repo-tools` releases can sync direct workspace consumers automatically after push by waiting for npm publish visibility and then running `scripts/sync-dependent-repos.sh`. Use `--no-sync-upstreams` or `REPO_TOOLS_SKIP_UPSTREAM_SYNC=1` when that follow-up should be skipped intentionally.
- If a change affects shared bins, release helpers, or config env contracts, document which sibling repos need a follow-up bump or note why no consumer update is required.
- Run `pnpm typecheck` and `pnpm test` before handoff.
- Use `scripts/committer` for commits.
