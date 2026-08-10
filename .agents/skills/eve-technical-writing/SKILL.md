---
name: eve-technical-writing
description: Write, edit, review, or audit user-facing documentation for the eve repository. Use for changes under docs/, documentation tied to eve APIs or CLI behavior, docs work based on Slack or support feedback, and docs reviews that must verify claims against current eve source, tests, CLI help, and repository conventions.
---

# eve technical writing

Write accurate, task-focused documentation for eve. Treat developers and AI agents as readers: make each section easy to scan, retrieve, and act on without relying on unstated context.

## Choose a workflow

- For a new page or full rewrite, read [references/writing-workflow.md](references/writing-workflow.md).
- For targeted or structural changes to existing pages, read [references/editing-workflow.md](references/editing-workflow.md).
- Before finalizing any change, read [references/review-framework.md](references/review-framework.md).
- For formatting and terminology, read [references/style-rules.md](references/style-rules.md).
- For page structure, read [references/content-types.md](references/content-types.md) when the content type is unclear or changing.

## Verify before writing

Do not rely on training data for eve behavior. Use this source hierarchy:

1. Current source, public types, and tests in `packages/eve`
2. Current CLI help and setup implementation
3. Existing pages under `docs/`
4. Merged pull requests, changelogs, and release notes
5. Research plans under `research/` as proposed intent, not shipped behavior
6. Support evidence such as Slack threads or issues

Use support evidence to identify the reader's problem, not to establish product behavior. Verify commands, flags, API names, defaults, limitations, and examples against the current repository. For a docs-only change, also compare the implementation with the latest public release so the docs do not announce branch-only behavior. When docs accompany product code in the same change, state that dependency during review. If a claim cannot be verified, omit it or report the missing owner or source. Never leave `[VERIFY]` markers in a completed docs change.

## Follow eve conventions

- Write `eve` lowercase, including headings and sentence starts when practical.
- Use exact public names such as `defineAgent`, `eve dev`, and `eve add channel/slack`.
- Distinguish the root agent, the built-in `agent` tool, declared subagents, and remote agents. They have different inheritance and execution semantics.
- Distinguish eve connections from Vercel Connect, the model-facing `Workflow` tool from authored Vercel Workflows, and durable session state from sandbox filesystem or attachment storage.
- Name diagnostic surfaces precisely: Vercel runtime logs, **Agent Runs**, OpenTelemetry, `eve logs`, and `eve traces` are not interchangeable.
- Treat `docs/**` as published documentation. Update `docs/meta.json` when navigation changes.
- Keep `.md` files framework-agnostic. Use MDX components only in `.mdx` files and only when nearby pages establish the convention.
- Preserve published routes and heading anchors when possible. When moving a page, update authored links and add permanent redirects for old HTML and Markdown URLs.
- Prefer TypeScript examples. Include imports and language labels, and verify examples against current exports.
- Show only supported commands and flags. Check CLI help or the command implementation before documenting them.
- Link to related pages with descriptive text. Include the critical fact locally because retrieved sections may be read without their links.
- Do not document proposed behavior as shipped. Describe unsupported boundaries directly when they affect a user task.

## Write for the task

- Lead each page and section with the answer or outcome.
- Address the reader as `you`; use imperative verbs for steps.
- Prefer active voice, present tense, concrete nouns, and consistent terms.
- Keep one page focused on one primary job. Add a section to an existing page when it already owns the task.
- Put the happy path before alternatives and failure modes.
- Add troubleshooting where observed failures cluster around a workflow. Use symptoms, verified causes, and concrete next checks.
- Write self-contained sections. Repeat the full noun in key statements instead of relying on ambiguous pronouns.
- Use specific limits and behavior only when the repository or an authoritative platform source supports them.

## Avoid common failures

- Do not invent flags, registry entries, connectors, workarounds, or platform guarantees.
- Do not turn one product request into a new page. First decide whether the gap belongs to docs, product, or both.
- Do not duplicate broad guides when a focused section or cross-link resolves the problem.
- Do not rewrite clear prose merely to match a personal preference.
- Do not use promotional language, rhetorical questions, filler, or claims that a task is easy, simple, or quick.
- Do not use `we` unless describing a deliberate Vercel or eve team action.

## Finish the change

1. Re-read every changed page in full.
2. Verify each new technical claim against its source.
3. Search for contradictory statements and affected cross-links.
4. Run the review workflow.
5. Run `pnpm docs:check` when preparing to push, unless the user requests earlier validation.
