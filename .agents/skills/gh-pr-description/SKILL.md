---
name: gh-pr-description
description: Drafts and reviews GitHub pull request descriptions for the eve repository. Use when opening, updating, or reviewing a PR, or when summarizing a branch for reviewers.
---

# GitHub PR description

Inspect the branch diff, commits, related issue or discussion, tests, docs, and
changesets. When updating a PR, read its current body first.

## Write

Fill in `.github/pull_request_template.md`. Write for a reviewer, not a
changelog:

- Keep the Summary short—under five sentences for most PRs.
- Lead with the concrete problem, user need, or decision behind the change;
  follow with the solution and meaningful behavior.
- Do not list files or narrate commits. Include implementation detail only when
  it is necessary to assess behavior or risk.
- Mention breaking changes, preserved behavior, tradeoffs, scope boundaries,
  follow-ups, or stacked PRs only when they matter to review.
- Link an existing issue or discussion with `Closes #N`, `Related to #N`, or an
  equivalent when one exists. Do not create an issue solely for a PR.
- State only validation that actually ran, including limitations or failures.

Preserve the checklist and check only verified items.

## Diff size

Append `### Diff size` after the checklist. It must be the final section and
account for every changed file exactly once in this order: Docs,
Implementation, then Tests. Include every category, even when it has no files.
Each category heading must show its file count, additions, and deletions.

```markdown
### Diff size

**Docs** — 0 files · `+0 / -0`

Not applicable.

**Implementation** — 1 file · `+6 / -2`

Keeps the missing-directory handling local to the compiler.

**Tests** — 1 file · `+14 / -0`

Covers the regression without broad fixture changes.
```

Classify files by primary purpose. Reconcile the category totals with the full
branch diff, and note binary files separately. Explain why each category is
that size, not only its line count. Call out individual paths or add a concise
category-local `<details>` block only when a generated, mechanical, fixture, or
otherwise disproportionate portion needs reviewer context.

## Publish

Before publishing, confirm the Summary leads with why the change is needed and
the Diff size totals reconcile with the complete branch diff. Write the body to
a file, then pass it to `gh pr create` or `gh pr edit` with `--body-file`.
