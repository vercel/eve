---
description: Use when drafting or editing release notes or a changelog entry in the house voice.
---

# Release notes voice & style

When writing or editing release notes:

- Lead with what changed for the user, in their words — not the internal feature name. Say "you
  can now…", not "we added…".
- Group by what the reader does, not by team or component. Keep the same section names every
  release so readers learn to scan it.
- Each entry: what changed, why it matters, and (if relevant) what to do about it. Front-load the
  benefit in the first sentence and keep the entry to a sentence or two.
- Plain present tense: "You can now…", "Fixed an issue where…". Describe a fix from the symptom
  the reader saw, not the code path. Skip jargon the reader wouldn't know.
- Link to docs or a deeper post instead of explaining everything inline. Keep the entry scannable.
- Be honest about breaking changes — call them out first, with the migration steps and a timeline
  if there is one. Deprecate a feature for a release cycle before you remove it.
- No marketing adjectives. A changelog is a record, not a pitch.
- Every shipped version gets an entry, newest first, dated `YYYY-MM-DD`. Don't paste the commit
  log — it's noise, not a record.

## Structure

Group entries under clear headings in this order:

1. **Breaking changes** — what to do, up front (covers Changed/Deprecated/Removed/Security
   that affect upgrades; name the migration path).
2. **New** — capabilities the reader didn't have before (Added).
3. **Improved** — things that already worked, now better (Changed).
4. **Fixed** — bugs resolved, described from the symptom the user saw (Fixed).

These map onto the Keep a Changelog category set (Added, Changed, Deprecated, Removed, Fixed,
Security). Use only the headings that have entries, and reach for the standard names rather than
inventing "Tweaks" or "Misc". See `references/format-specs.md`.

## References

- `references/best-practices.md` — sourced checklist of current release-notes conventions
  (user-benefit framing, entry anatomy, grouping, breaking changes, linking).
- `references/format-specs.md` — quick-lookup conventions: the Keep a Changelog category set,
  SemVer mapping, entry-anatomy template, and ordering/dating norms.
- `references/banned-words.json` — the list of words to avoid. Read it once up front for
  awareness, then run the `check_style` tool on your draft to check it against this
  file before proposing the draft to the writer.

## Shared references

Shared global references for all skills in the content agent. These apply regardless of the
content type.

- `references/ai-phrases-to-avoid.md` — AI-tell words, phrases, and punctuation to avoid.
- `references/plain-english-alternatives.md` — plain-English swaps for bloated or vague wording.
