---
name: gh-pr-description
description: Drafts and reviews GitHub pull request descriptions for the eve repository. Use when opening, updating, or reviewing a PR, or when summarizing a branch for reviewers.
---

# GitHub PR description

See [review notes](references/review-notes.md) for the maintainer patterns behind
this workflow.

Read `CONTRIBUTING.md` and `.github/pull_request_template.md`, then inspect the
branch diff, commits, related issue, tests, docs, and changesets. If updating a
PR, read its current body too.

Fill in the repository template. Write for a reviewer:

- explain the concrete problem and solution near the top
- summarize meaningful behavior and decisions, not files or commits
- mention breaking changes, preserved behavior, scope boundaries, or stacked
  PRs only when relevant
- link the prior issue with `Closes #N`, `Related to #N`, or equivalent
- keep the detail proportional to the change

Under validation, list exact checks actually run and useful manual coverage. State
limitations honestly. Do not infer results or claim checks that only CI will
run.

Preserve the checklist and check only verified items. Explain when tests, docs,
or a changeset are not applicable.

Before returning or publishing the description, confirm that it answers:

1. What problem does this solve?
2. What meaningfully changes?
3. How was it validated?
4. What should the reviewer pay special attention to?

When asked only to draft, return the body for review. When asked to create or
update the PR, pass a body file to `gh pr create` or `gh pr edit`.
