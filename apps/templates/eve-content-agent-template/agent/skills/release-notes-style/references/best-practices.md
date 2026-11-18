# Release notes best practices

A sourced checklist of current conventions for writing release notes and changelogs. Use it as a
pre-flight check, not a recipe — the house voice (plain, concrete, honest) wins over any single
rule.

## Write for the reader, not the team

- [ ] Lead with what the reader can now do, not the internal feature name. "You can now log in
      with your company's SSO" beats "We added SSO support." Use "you", not "we".
- [ ] Say why it matters when it isn't obvious. "Reports load faster" beats "Optimized SQL query
      execution plan for the reporting module."
- [ ] Translate implementation detail into an outcome. "Data imports are now faster and more
      reliable" beats "Refactored the middleware layer for improved throughput."
- [ ] Remember the audience: a changelog is for the people who use the software, not the people
      who wrote it. Keep it human, not a machine-readable diff.

## Entry anatomy

- [ ] Answer three questions in each entry: what changed, why it matters, and what the reader
      should do next.
- [ ] Front-load the benefit — explain the change in the first sentence so it survives a skim.
- [ ] Keep each entry to one or two sentences. Quick context, not a technical breakdown.
- [ ] End an entry with a concrete next step when there is one: "Go to Settings → Import to try
      it", or a link to learn more.

## Grouping & categories

- [ ] Group changes by type so readers can scan to what matters to them — don't mix fixes, new
      features, and deprecations in one undifferentiated list.
- [ ] Use the same section names every release. Consistency builds a scanning habit; familiarity
      is the point.
- [ ] Use the standard categories rather than inventing your own. "Improvements", "Tweaks", and
      "Misc" mean nothing to someone scanning for a change that affects them.
- [ ] Be specific instead of leaning on "improvement" as a catch-all. "Search results now appear
      up to 40% faster" lands; "Improved backend processes" doesn't.

## Breaking changes

- [ ] Put breaking changes at the top, not buried under minor fixes. Name what breaks and who is
      affected.
- [ ] Include the migration path — the steps to take — and a timeline when there is one.
- [ ] Deprecate before you remove. Give a feature at least one full release cycle of warning
      (ideally two or three) in the Deprecated section before it moves to Removed.

## Voice & tense

- [ ] Plain present tense: "You can now…", "Fixed an issue where…". Describe a fix from the
      symptom the reader saw, not the code path.
- [ ] No marketing language. A changelog is a record, not a pitch — clarity beats cleverness, and
      don't let a cute line get in the way of comprehension.
- [ ] Avoid jargon a non-technical reader wouldn't know (`CRUD`, `staging`, `middleware`,
      `major/minor version`) unless the audience genuinely expects it.

## Linking & depth

- [ ] Link out instead of explaining everything inline — point to a docs page, help-center
      article, or deeper post when a reader wants more. Keep the entry itself scannable.
- [ ] Layer the depth for mixed audiences: a plain-language line first, user-facing detail next,
      and the technical detail behind a link rather than in the entry.

## Cadence & coverage

- [ ] Every shipped version deserves an entry, even a small one. Gaps make readers wonder what you
      changed quietly, and a partial changelog can erode trust as much as none at all.
- [ ] Don't paste the commit log. It's full of noise — merge commits, obscure titles, doc-only
      changes — and reads as a dump, not a record.
- [ ] Newest first. Readers open a changelog to see what changed recently, not to read history
      from the top.

## Sources

- Keep a Changelog 1.1.0: https://keepachangelog.com/en/1.1.0/
- LaunchNotes — How to Write Great Product Release Notes: https://www.launchnotes.com/blog/how-to-write-great-product-release-notes-the-ultimate-guide
- AnnounceKit — Release Notes Best Practices (2026): https://announcekit.app/guides/release-notes-best-practices
- Appcues — 13 Release Notes Examples (+ template and writing tips): https://www.appcues.com/blog/release-notes-examples
- Userpilot — What are Release Notes? Definition, Best Practices & Examples: https://userpilot.com/blog/release-notes/
