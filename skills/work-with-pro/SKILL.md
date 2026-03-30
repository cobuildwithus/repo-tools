---
name: work-with-pro
description: Use when the user says "work with pro" or wants a repo task delegated to ChatGPT Pro through review-gpt. Prefer `watch-only` when the user already has a ChatGPT thread URL with repo context attached. Use `send-and-wake` through `review-gpt`, which should own repo-context packaging, then download returned patch, diff, or zip attachments and resume the current session to implement them.
---

# Work With Pro

Use this skill when the user wants ChatGPT Pro to do a meaningful chunk of repo work and then wants Codex to pull down the returned artifacts and finish the implementation locally.

## Repo Context Contract

ChatGPT Pro does not have access to the local repo unless Codex explicitly sends repo context.

- In `watch-only`, the user may have already prepared the ChatGPT thread correctly by sending repo context themselves. In that case, do not send anything new. Just wake the thread later, download the returned artifacts, and continue locally.
- In `send-and-wake`, `review-gpt` is the runtime tool and should own repo-context packaging. Codex should not depend on unrelated repo tools to make this workflow work.
- The skill does not install `review-gpt`, browser automation, or a managed ChatGPT session. It only describes how to use them when they already exist.
- If `review-gpt` is missing, fail fast and tell the user to install or expose it instead of inventing alternate packaging flows.
- In any existing thread, if there is no repo artifact or other clear repo context in the conversation, Pro is operating blind and may invent file-specific claims.
- Do not let Pro claim file edits "in this file" unless the thread already has a repo artifact or you just sent one.

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

If the repo does not expose `review-gpt`, stop and say so plainly. The skill should not auto-install packages.

For `watch-only`, the direct CLI is enough to schedule the wake step, but it does not provide repo context by itself.

For `send-and-wake`, use whichever `review-gpt` entrypoint the repo documents. `review-gpt` should package and send repo context itself. If the available entrypoint cannot do that, stop and tell the user to prepare the Pro thread manually, then use `watch-only`.

## Workflow

### Watch-only

Use this when the existing thread already contains the task and the user only wants Codex to wait for the result.

1. Confirm the user supplied the ChatGPT conversation URL.
2. Confirm whether the thread already has repo context.
   - If it came from `review:gpt` or already contains a repo artifact, continue.
   - If the user says they already attached repo context manually, continue.
   - If it was a plain manual ChatGPT thread without repo context, call out that Pro is blind to the repo and should not be trusted for file-specific implementation claims.
3. Do not send a new review prompt.
4. Schedule the delayed follow-up directly:

```bash
pnpm exec cobuild-review-gpt thread wake \
  --delay <delay> \
  --chat-url <url> \
  --session-id "$CODEX_THREAD_ID"
```

5. When the wake command resumes the session, read the exported thread, inspect the downloaded patch, diff, or zip files, implement the returned changes, and run the repo-required checks.

### Send-and-wake

Use this when the user wants you to delegate new work or explicitly wants a follow-up prompt sent into the ChatGPT thread.

1. Estimate task size and select the delay.
2. Confirm `review-gpt` is available and that the repo's documented send path includes repo context.
   - Prefer the repo's `pnpm review:gpt` wrapper when it exists.
   - Otherwise use `pnpm exec cobuild-review-gpt` if the repo documents that path.
   - If `review-gpt` is missing or the send path does not include repo context, stop and tell the user to prepare the thread manually, then switch to `watch-only`.
3. Build a prompt for Pro that asks for:
   - the requested implementation
   - using the provided repo context as the source of truth
   - a `.patch`, `.diff`, or `.zip` attachment, not just prose
   - scoped, compilable changes
   - explicit assumptions when needed
4. Launch the review with the repo-local wrapper or documented direct CLI.
5. Use the ChatGPT conversation URL provided by the user.
   - do not guess the URL
   - if the user has not provided it yet, ask for it before scheduling the wake step
6. Schedule the delayed follow-up:

```bash
pnpm exec cobuild-review-gpt thread wake \
  --delay <delay> \
  --chat-url <url> \
  --session-id "$CODEX_THREAD_ID"
```

7. When the wake command resumes the session, read the exported thread, inspect the downloaded artifacts, implement the returned changes, and run the repo-required checks.

## Prompt Requirements

Ask Pro to return an attachment-based result. Use wording close to this:

```text
Use the provided repo context as the source of truth. Implement this task and return the result as a .patch, .diff, or .zip attachment that can be applied locally.
Keep the result scoped to the requested work, include any needed tests, and note assumptions briefly in the response.
```

Add the repo-specific task details after that.

Skip this prompt-construction step entirely in `watch-only` mode.

## Notes

- Always go through the main incur CLI: `cobuild-review-gpt thread ...`
- Do not use removed standalone binaries like `cobuild-review-gpt-thread-wake`.
- A provided ChatGPT thread URL by itself is not permission to post a follow-up message. Treat it as `watch-only` unless the user clearly asks you to send or update the prompt.
- If the user asks for a different model or tighter instructions, keep the same wake flow and only change the review prompt or normal `review:gpt` options.
- If the thread does not already contain a repo artifact, say so explicitly. Do not imply that Pro can see local files.
- Do not auto-install `review-gpt` from inside the skill. If the runtime tool is missing, stop with a clear install or setup instruction.
