---
description: "Writing-quality guardrails for any prose the agent drafts or edits: blog posts, page copy, Notion drafts, release notes, marketing text. Use this skill whenever writing or revising content meant for humans to read, to keep the prose natural, plain, and free of AI-sounding phrasing. Not needed for code, queries, or structural CMS work."
---
# Writing Quality

House-neutral rules for making drafted content read like a person wrote it. They apply to any prose surface. Layer project- or brand-specific voice guidance on top of them.

## When to Apply

Load this skill before:
- Drafting new content (a blog post, landing-page copy, a Notion draft, release notes)
- Editing or rewriting existing content
- Reviewing a draft before proposing it to the user

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in `references/ai-phrases-to-avoid.md`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. `references/plain-english-alternatives.md` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When editing existing content, keep its register and conventions. These rules trim the noise; they don't impose a personality.

## References

Load the reference that matches the task rather than all of them at once:

- `references/ai-phrases-to-avoid.md`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements. Load when drafting or editing any prose.
- `references/plain-english-alternatives.md`: plain-English swaps for corporate, padded, or vague wording. Load when drafting or editing any prose.
- `references/web-writing-best-practices.md`: a sourced checklist for long-form web content, covering scanning behavior, hooks, structure, readability, length by intent, SEO basics, and closes. Load when writing or restructuring articles, blog posts, or guides.
- `references/web-content-specs.md`: the concrete numbers behind that checklist (slug rules, heading cadence, readability thresholds, word count by intent, alt text, internal links). Load for a final spec check on a piece. Title, meta, and Open Graph specs live in the `seo-aeo-best-practices` skill.
