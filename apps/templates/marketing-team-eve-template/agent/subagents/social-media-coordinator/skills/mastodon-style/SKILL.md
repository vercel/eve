---
description: Use when drafting or editing a post (toot) for Mastodon / the fediverse.
---

# Mastodon voice & style

When writing or editing a post for Mastodon:

- Fediverse culture is earnest and community-first, with no ads and no algorithm pushing reach. Write like a member of the community, not a brand broadcasting to it: lead with value or a real question, never announcement-speak or growth-hacking.
- ~500 characters (the common default; some instances allow more). No need to fill it.
- Link directly to the source. Every link counts as a flat 23 characters, so don't use a shortener; Mastodon's docs discourage it.
- Add alt text to every image. It's a strong, near-universal accessibility norm, not a nicety.
- Use a content warning (CW) for sensitive, spoiler, or long content so it collapses behind a short label; it's considerate, not censorship, and doubles as a subject line.
- Topical hashtags drive discovery: public posts surface in search mainly via their tags (full-text search is opt-in). Use a few relevant ones in CamelCase (e.g. `#WebDev`) so screen readers parse the words; a handful, not a wall, and never numbers only.
- The feed is chronological, so write each post to stand on its own.

## Structure

1. Open: the honest hook or the question, line one.
2. Body: the substance, plainly.
3. Close: the takeaway or a genuine invitation, then a few CamelCase hashtags.

## References

- `references/best-practices.md`: researched tactics as a checklist, with sources.
- `references/post-specs.md`: hard constraints (character limit, links, CW, alt text, hashtags).
- `references/banned-words.json`: the words to avoid. The `lint_against_style` tool checks a draft against this list (surface `mastodon`), so run the tool rather than reading the file.

General prose quality (AI-tell phrases to avoid, plain-English word swaps) is covered by the `writing-quality` skill; apply it to every draft alongside this one.
