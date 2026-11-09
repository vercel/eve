# eve documentation content types

Use these categories as structural heuristics, not mandatory frontmatter.

## Tutorial

Teach through a complete, guided build. Include prerequisites, sequential steps, observable results, and next steps. Use a tutorial when learning is the goal.

## How-to

Help an experienced reader complete one task. Lead with the supported path, keep explanation proportional, and add focused troubleshooting for common failures.

## Reference

Document APIs, CLI commands, configuration, limits, or schemas for lookup. Use exact names, consistent tables, types, defaults, constraints, and verified examples.

## Feature page shape

A feature page documents one thing an author adds to an agent, such as subagents, tools, skills, or a channel. Order it from the common case to the rare one:

1. **Opening.** In two or three sentences, say what the feature is, where it lives on disk, and when to use it.
2. **Minimal example.** Show a file tree and the smallest working code, with comments that name required and optional fields.
3. **How it behaves.** Give the few rules a reader needs for the common case.
4. **Options.** Put fields, defaults, and limits in a table.
5. **Variants and advanced use.** Give each its own section after the common case.
6. **Troubleshooting.** Use `What you see | What to do` rows.
7. **Neighbor.** Say when to use the related feature instead, and link to it.

The shape orders the content a page already has. It is not a checklist of sections to add:

- Add a section only when the page has verified content for it. Write troubleshooting rows only for failures that are known to happen, never inferred ones.
- When a table lists options or outcomes, delete the prose that described them.
- State each fact once on the page. Show an input shape or example once, and refer back to it.
- Leave rare combinations to the page that owns them, such as what happens when two optional features interact. Link to that page.
- When a sentence explains how eve reaches a result, keep only the result.
- Keep existing diagrams. A compact diagram of a flow or relationship is not prose to cut.

For each section, ask whether a reader building the common case needs it. If not, move it to the advanced sections, a table, a troubleshooting row, or the page that owns it. Moving detail is an edit. Removing documented behavior from the docs entirely is a product decision, so flag it for maintainer review.

## Conceptual

Explain how or why a system works. Define the mental model, boundaries, tradeoffs, and related tasks without turning the page into a procedural guide.

## Information architecture

Organize navigation for progressive disclosure: a reader should meet the smallest useful surface first and find depth by descending, not by scanning.

- Keep the top-level sidebar lean. `docs/meta.json` sections move from orientation (Introduction) through authoring (Build), connecting (Integrate), and running (Operate) to lookup (Reference).
- Nest a page under the capability that owns it when the page only matters after the reader knows the parent (for example, Workflow Tool under Subagents, State under Core Concepts).
- Promote a page to the top level only when readers need it before or independently of any parent capability.
- Lead every page and section with the common case; push advanced options, edge cases, and internals further down or into a nested page.
- When moving a published route, update authored links and add permanent redirects for every old HTML and Markdown URL, and keep `llms-index.ts` in step with the sidebar.

## Decide whether to create a page

Create a page only when all are true:

- The reader has a distinct goal or question.
- The behavior is shipped and stable enough to document.
- The content cannot fit cleanly in an existing owner page.
- The page has enough substance to stand alone.

Otherwise, add a focused section, example, limitation, or cross-link to the existing page.
