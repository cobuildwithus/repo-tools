---
name: work-with-pro
description: Use when the user says "work with pro" or wants a repo task delegated to ChatGPT Pro through review-gpt, or when they want Codex to wait on a provided ChatGPT conversation URL, download returned patch, diff, or zip attachments, and resume the current session to implement them.
---

# Work With Pro

Use this skill when the user wants ChatGPT Pro to do a meaningful chunk of repo work and then wants Codex to pull down the returned artifacts and finish the implementation locally.

There are two modes:

- `send-and-wake`: send a new or updated prompt into ChatGPT, then schedule the delayed wake flow.
- `watch-only`: do not post anything new; just revisit an already-running thread later, download returned artifacts, and resume Codex.

When the user provides only an existing ChatGPT conversation URL plus instructions like "wait on this thread", "check back later", or "implement the patch when it returns", default to `watch-only`. Do not send an extra prompt unless the user explicitly asks for that, or also provides new task details that need to be posted.

## Size To Delay

- `small` -> `30m`
- `medium` -> `60m`
- `huge` -> `100m`
- If the user gives an explicit delay, use it.
- If the task size is unclear, default to `medium`.

Use these heuristics:

- `small`: narrow bugfix, one-file tweak, or very small refactor
- `medium`: a normal feature, moderate refactor, or a few touched files
- `huge`: broad feature, multi-area refactor, architecture-heavy task, or likely long-running work

## Preconditions

Before scheduling anything, confirm all of these are true:

- The repo has `@cobuild/review-gpt` installed.
- The repo exposes either:
  - a wrapper like `pnpm review:gpt`, or
  - direct access via `pnpm exec cobuild-review-gpt`.
- The managed ChatGPT browser session is already signed in.
- `CODEX_THREAD_ID` is available for the current Codex session.
- The user provided the ChatGPT conversation URL to revisit later.

If any of those are missing, say so plainly instead of guessing.

## Command Selection

Prefer the repo's existing wrapper when it exists:

```bash
pnpm review:gpt ...
```

If the wrapper does not exist, use the package CLI directly:

```bash
pnpm exec cobuild-review-gpt ...
```

For `watch-only`, the direct CLI is enough.

For `send-and-wake`, only use the direct CLI if the repo already documents the needed `review-gpt` config path and prompt wiring. Otherwise stop and say the repo is missing a usable `review:gpt` entrypoint.

## Workflow

### Watch-only

Use this when the existing thread already contains the task and the user only wants Codex to wait for the result.

1. Confirm the user supplied the ChatGPT conversation URL.
2. Do not send a new review prompt.
3. Schedule the delayed follow-up directly:

```bash
pnpm exec cobuild-review-gpt thread wake \
  --delay <delay> \
  --chat-url <url> \
  --session-id "$CODEX_THREAD_ID"
```

4. When the wake command resumes the session, read the exported thread, inspect the downloaded patch, diff, or zip files, implement the returned changes, and run the repo-required checks.

### Send-and-wake

Use this when the user wants you to delegate new work or explicitly wants a follow-up prompt sent into the ChatGPT thread.

1. Estimate task size and select the delay.
2. Build a prompt for Pro that asks for:
   - the requested implementation
   - a `.patch`, `.diff`, or `.zip` attachment, not just prose
   - scoped, compilable changes
   - explicit assumptions when needed
3. Launch the review with the repo-local wrapper or documented direct CLI.
4. Use the ChatGPT conversation URL provided by the user.
   - do not guess the URL
   - if the user has not provided it yet, ask for it before scheduling the wake step
5. Schedule the delayed follow-up:

```bash
pnpm exec cobuild-review-gpt thread wake \
  --delay <delay> \
  --chat-url <url> \
  --session-id "$CODEX_THREAD_ID"
```

6. When the wake command resumes the session, read the exported thread, inspect the downloaded artifacts, implement the returned changes, and run the repo-required checks.

## Prompt Requirements

Ask Pro to return an attachment-based result. Use wording close to this:

```text
Implement this task and return the result as a .patch, .diff, or .zip attachment that can be applied locally.
Keep the result scoped to the requested work, include any needed tests, and note assumptions briefly in the response.
```

Add the repo-specific task details after that.

Skip this prompt-construction step entirely in `watch-only` mode.

## Notes

- Always go through the main incur CLI: `cobuild-review-gpt thread ...`
- Do not use removed standalone binaries like `cobuild-review-gpt-thread-wake`.
- A provided ChatGPT thread URL by itself is not permission to post a follow-up message. Treat it as `watch-only` unless the user clearly asks you to send or update the prompt.
- If the user asks for a different model or tighter instructions, keep the same wake flow and only change the review prompt or normal `review:gpt` options.
