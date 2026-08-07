---
name: gh-pr-description
description: Drafts and reviews GitHub pull request descriptions for the eve repository. Use when opening, updating, or reviewing a PR, or when summarizing a branch for reviewers.
---

# GitHub PR description

See [review notes](references/review-notes.md) for the maintainer patterns behind
this workflow; they describe what to cover, not how much to write.

Read `CONTRIBUTING.md` and `.github/pull_request_template.md`, then inspect the
branch diff, commits, related issue, tests, docs, and changesets. If updating a
PR, read its current body too.

Fill in the repository template. Write for a reviewer:

- explain the concrete problem and solution near the top
- summarize meaningful behavior and decisions, not files or commits
- mention breaking changes, preserved behavior, scope boundaries, or stacked
  PRs only when relevant
- link the prior issue with `Closes #N`, `Related to #N`, or equivalent
- scale length with risk, not diff size

Default to the shortest body that answers the four questions below. Keep the
Summary under 5 sentences for most PRs; exceed 10 lines only for breaking or
cross-cutting changes. Prefer plain language. Include implementation detail or
jargon only when the reviewer cannot assess behavior or risk without it. Do not
restate the issue, template guidance, or checklist. Use bullets only when they
improve clarity.

A typical small PR body:

```markdown
### Summary

Closes #412. `eve dev` crashed when an agent had no `connections/` directory;
the compiler now treats missing optional directories as empty.

### Validation

- Reproduced the crash with the weather fixture, then confirmed a clean boot
- `pnpm test:unit`, `pnpm typecheck`

### Checklist

(preserved from the template; only verified items checked)
```

Under validation, list exact checks actually run and useful manual coverage. State
limitations honestly. Do not infer results or claim checks that only CI will
run.

Preserve the checklist and check only verified items. If tests, docs, or a
changeset are not applicable, say so in one short line at most.

Before returning or publishing the description, confirm that it answers:

1. What problem does this solve?
2. What meaningfully changes?
3. How was it validated?
4. What should the reviewer pay special attention to?

Then prune: delete any sentence that restates the diff, the issue, or the
template, and any detail the reviewer does not need. If the answer to question
4 is "nothing," leave it out.

When asked only to draft, return the body for review. When asked to create or
update the PR, pass a body file to `gh pr create` or `gh pr edit`.
