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

Append a `### Diff size` section after the template checklist. This must be the
last section of every PR description and must account for every changed file in
exactly one of these categories:

- **Docs** — documentation, research, changesets, and other prose or release
  metadata
- **Implementation** — product code, configuration, dependencies, build files,
  and generated runtime artifacts
- **Tests** — tests, evals, test-only fixtures, and snapshots

Use three full-width category blocks in the order above, including categories
with no changes. Do not use a table: the overview and any reviewer-relevant
context need the full description width to remain readable on GitHub.

```markdown
### Diff size

**Docs** — 0 files · `+0 / -0`

Not applicable.

**Implementation** — 1 file · `+12 / -4`

Focused implementation of the behavior above.

**Tests** — 1 file · `+28 / -0`

Regression coverage for success and failure paths.
```

Keep each category's file count, additions, and deletions visible on its bold
heading line. Treat the section as an overview, not a file inventory: do not
list every changed path. Mention individual files only when they are critical
to understanding or reviewing the change, under a short `Key files` list. Omit
paths entirely when no file needs special attention. The category counts must
still include every changed file. Do not collapse the category totals or the
entire Diff size section.

Report additions and deletions from the full branch diff against the PR base,
and verify that the three categories reconcile with the complete diff. Note
binary files separately instead of treating them as zero-line changes. Classify
a mixed-purpose file by its primary purpose; mention that ambiguity only when it
is useful to the reviewer.

The justification must explain why each category needs that amount of change,
not merely restate its line count. Call out a file or category only when its
size is genuinely surprising or materially disproportionate to the behavior
and review scope, especially for generated files, snapshots, fixtures, or
mechanical changes. Being the only changed file, the largest category, or a
modest one-file diff does not make something an outlier.

Keep a concise explanation visible. If supporting detail would be lengthy, use
a category-local `<details>` block with a specific, natural summary such as
`Generated output`, `Fixture expansion`, or `Mechanical migration`; do not use
a prescribed heading or force words such as `unusually`. Explain why the large
portion is necessary and could not reasonably be smaller. If the size is
surprising for the stated behavior, flag it for reviewer attention rather than
normalizing it. Do not manufacture an outlier explanation for an ordinary diff.
The rest of the description should still discuss behavior rather than enumerate
files; this section is the required exception.

```markdown
Generated output accounts for most of the implementation diff.

<details>
<summary>Generated output</summary>

Explain why the generated changes are necessary and could not reasonably be
smaller.

</details>
```

Default to the shortest body that answers the five questions below. Keep the
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

Reproduced the crash with the weather fixture and confirmed the fix with
focused regression coverage.

### Checklist

(preserved from the template; only verified items checked)

### Diff size

**Docs** — 0 files · `+0 / -0`

Not applicable.

**Implementation** — 1 file · `+6 / -2`

Keeps the missing-directory handling local to the compiler.

**Tests** — 1 file · `+14 / -0`

Covers the regression without broad fixture changes.
```

Under validation, write one short prose description, not a bullet list of
commands. For a bug fix, say what was reproduced and how the fix was
confirmed. For a feature, say how coverage demonstrates the new behavior. Do
not mention routine formatting, linting, type checking, or other baseline
checks; CI coverage is assumed. Note limitations honestly and do not claim
checks that only CI will run.

Preserve the checklist and check only verified items. If tests, docs, or a
changeset are not applicable, say so in one short line at most.

Before returning or publishing the description, confirm that it answers:

1. What problem does this solve?
2. What meaningfully changes?
3. How was it validated?
4. What should the reviewer pay special attention to?
5. How is the complete diff divided among docs, implementation, and tests, and
   why is each category that size?

Then prune: outside the required Diff size section, delete any sentence that
restates the diff, the issue, or the template, and any detail the reviewer does
not need. If the answer to question 4 is "nothing," leave it out.

When asked only to draft, return the body for review. When asked to create or
update the PR, pass a body file to `gh pr create` or `gh pr edit`.
