# eve dev TUI parity tranche 1

This tranche establishes three narrow ownership surfaces. It is not full TUI parity.

## Model configuration

- Keep featured model options as the leading picker run; sort non-featured models by valid `released` descending, then label and id. Undated entries sort last.
- Reuse the authored top-level `reasoning` field. Absence means provider default and remains distinct from authored `"none"`.
- Present Fast mode as the UI name for `modelOptions.providerOptions.gateway.serviceTier = "priority"`. Standard removes only that leaf. Existing custom tiers are displayed, never silently overwritten.
- Draft model, reasoning, and Fast mode changes in `/model`, then apply one atomic source patch on Done.
- The source patch uses `keep | set | remove` per field, preserves sibling provider options, and bails without writing on unsafe AST shapes.

## Tool activity

- Keep execution state independently keyed by call id.
- Represent lifecycle as a discriminated outcome: running, approval, completed, failed, or rejected.
- Translate all protocol statuses exhaustively; rejected must never render as success.
- Derive presentation through a pure registry. The first semantic presenter renders `web_fetch` as `Fetch <url>` and falls back safely for malformed input.
- Use the shared square pulse for running activity.
- Keep parallel calls independently keyed, but hold the active cohort mutable
  until every call terminates. Coalesce only adjacent, same-status semantic
  presentations; never merge execution state or calls with unique result copy.

## Markdown

- Parse GFM through a vendored build-time dependency; eve keeps `nitro` as its
  only runtime dependency.
- Render headings, emphasis, links, fenced code, blockquotes, nested/task lists,
  strikethrough, rules, and tables from tokens rather than regex replacement.
- Bound table columns to the terminal width before the transcript wrapper runs.

## Diagnostics

- Own a per-process sink at the `eve dev` composition root, above the terminal renderer and worker lifecycle.
- Store readable records under `.eve/logs/dev-<timestamp>-<pid>.log`; create the directory as `0700` and file as `0600` with exclusive creation.
- Serialize writes and await close. Sink failures fall back to the current capped inline detail and never recurse through intercepted stderr.
- Persist full captured stderr and already-formatted workflow diagnostic detail. Keep the transcript concise and point to the local file.

## Verification contract

- Add focused unit/integration coverage for ordering, atomic source edits,
  model-flow drafts, rejected tools, semantic fetch labels and groups, pulse
  behavior, Markdown tokens and width, permissions, serialized writes, concise
  error fallback, and shutdown flushing.
- Pass the full eve unit and integration tiers, typecheck, vendored build,
  mechanical invariant guard, formatting, and lint.
- Exercise the packed-install TUI path so the published artifact imports the
  vendored Markdown parser and opens `/model` without repository devDependencies.

## Explicitly deferred

- Remaining semantic tool presenters beyond `web_fetch`.
- Active-turn composer, steering, attachments, and remaining session controls.
- Sandbox access to host diagnostic files.
