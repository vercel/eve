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

- Follow these ASD-STE100 rules where they apply:
  - Use approved words from the ASD-STE100 dictionary, with one meaning per
    word.
  - Use active voice and keep one topic in each sentence.
  - Limit descriptive sentences to 25 words and procedural sentences to 20
    words.
  - Keep necessary technical terms, proper nouns, and code identifiers.
- Keep the Summary to one short paragraph: usually 2–4 sentences and about
  100 words or fewer.
- Lead with the concrete problem, user need, or decision behind the change;
  follow with the solution and meaningful behavior. Split independent points
  into separate sentences.
- Do not list files or narrate commits. Include implementation detail only when
  it is necessary to assess behavior or risk.
- Mention breaking changes, preserved behavior, tradeoffs, scope boundaries,
  follow-ups, or stacked PRs only when they matter to review.
- Link an existing issue or discussion with `Closes #N`, `Related to #N`, or an
  equivalent when one exists. Do not create an issue solely for a PR.
- State only validation that actually ran, including limitations or failures.

Preserve the checklist and check only verified items.

## Publish

Before publishing, confirm the Summary leads with why the change is needed.
Write the body to a file, then pass it to `gh pr create` or `gh pr edit` with
`--body-file`.
