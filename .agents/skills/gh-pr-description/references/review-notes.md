# PR description review notes

These guidelines were derived from the five most recent pull request
descriptions by Casey Gowrie and Andrew Barba, together with the repository's
contributing guidelines and pull request template.

## What made the descriptions useful

- **They led with outcomes.** Short summaries made the problem and resulting
  behavior clear before implementation details.
- **They emphasized review-significant details.** Bullets covered public
  behavior, contracts, design decisions, and regression coverage rather than
  listing changed files.
- **They named boundaries.** Larger changes identified preserved behavior,
  deliberate non-goals, compatibility implications, and where work belonged in
  a stack of changes.
- **They provided context.** Descriptions identified the related issue or
  proposal and distinguished closing, related, superseded, and dependent work.
- **They gave concrete validation.** Test sections named exact commands,
  focused suites, pass counts, and manual checks where useful.
- **They were candid about limitations.** When local validation was blocked,
  the description said why and what CI would cover instead.
- **They scaled with risk.** Small fixes used a few bullets; broad or breaking
  changes included enough structure to explain scope and migration impact.
- **They accounted for repository obligations.** Tests, documentation,
  changesets, and cases where those were not applicable were made explicit.

The resulting standard is reviewer-oriented: explain the problem, meaningful
change, validation, and anything that deserves special attention. Avoid file
inventories, commit narration, unsupported claims, and boilerplate that does
not help review.
