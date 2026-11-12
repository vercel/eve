---
name: gh-pr-description
description: Drafts and reviews GitHub pull request descriptions for the eve repository. Use when opening, updating, or reviewing a PR, or when summarizing a branch for reviewers.
metadata:
  internal: true
---

# GitHub PR description

Inspect the branch diff, commits, related issue or discussion, tests, docs, and
changesets. When updating a PR, read its current body first.

## Write

Fill in the sections of `.github/pull_request_template.md`: the Summary, and
the Public API section when the PR adds, changes, deprecates, or removes a
public API. Delete the Public API section when it has nothing to list. Never add
a Validation, Test plan, or Checklist section, and delete them from an existing
body when you update it.

### Summary

Write the Summary for a reviewer, not a changelog:

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
- Do not list checks you ran or suggest checks for reviewers to run. CI runs
  them on every PR.
- Leave the list of API additions and changes to the Public API section.

### Public API

List every public API change, one bullet each:

- A public API is anything an author imports, calls, configures, or handles
  from eve's entry points: exports and their types, definition fields, `ctx`
  members, CLI commands and flags, stream events, and error reasons. The
  [stability policy](../../../docs/reference/typescript-api.md#stability-policy)
  defines which surfaces are stable.
- Name each item as an author writes it, with its entry point, such as
  `steered()` from `eve/tools/approval`. Follow it with one short sentence
  about what it does.
- Cover additions, changed behavior or types, deprecations, and removals.
  Prefix a breaking item with "Breaking:", and mark an `experimental` field or
  `eve/experimental/*` API as experimental.
- Check the list against the diff. Export changes show in
  `packages/eve/public-api/`; new fields, options, and error reasons show in
  the changed type definitions.

## Publish

Before publishing, confirm the Summary leads with why the change is needed.
Write the body to a file, then pass it to `gh pr create` or `gh pr edit` with
`--body-file`.
