# eve documentation content types

Use these categories as structural heuristics, not mandatory frontmatter.

## Tutorial

Teach through a complete, guided build. Include prerequisites, sequential steps, observable results, and next steps. Use a tutorial when learning is the goal.

## How-to

Help an experienced reader complete one task. Lead with the supported path, keep explanation proportional, and add focused troubleshooting for common failures.

## Reference

Document APIs, CLI commands, configuration, limits, or schemas for lookup. Use exact names, consistent tables, types, defaults, constraints, and verified examples.

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
