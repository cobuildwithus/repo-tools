# AGENTS.md

## Purpose

Shared tooling package for repo operation scripts used across Cobuild repositories.

## Rules

- Keep runtime tooling generic. No sibling-repo paths or environment-specific assumptions.
- Prefer configuration over per-repo forks.
- Run `npm run typecheck` and `npm test` before handoff.
- Use `scripts/committer` for commits.
