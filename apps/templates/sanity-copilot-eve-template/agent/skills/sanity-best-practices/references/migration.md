---
title: Sanity Content Migration Rules
description: Best practices for migrating content (HTML, Markdown) into Sanity Portable Text.
---

# Sanity Content Migration Rules

## Document Identity During Import (Critical)

Let Sanity generate `_id` values for imported documents unless you are intentionally creating a singleton. Do not derive deterministic UUIDs or document IDs from slugs, file paths, legacy IDs, or related document IDs.

- Store legacy identifiers in fields such as `legacyId`, `externalId`, or `slug`.
- Make imports idempotent by looking up existing documents with GROQ before creating or patching them.
- Create relationships by querying the target document and using its real `_id` in a `reference`; do not predict `_ref` values from naming conventions.
- Reserve explicit `_id` values for singleton documents such as `settings`, `homePage`, or localized singleton IDs like `homePage-en`.

## 1. HTML Import (Legacy CMS)

Use `@portabletext/block-tools` with `JSDOM` to convert HTML to Portable Text. This covers setup, custom deserializers, pre-processing, image uploads, and wrapping in `defineMigration`.

**See `migration-html-import.md` for the full guide with working examples.**

## 2. Markdown Import (Static Sites)

Use `@portabletext/markdown` for direct, schema-aware Markdown ↔ Portable Text conversion.

**Recommended: Direct Conversion with `@portabletext/markdown`**

```typescript
import { markdownToPortableText } from "@portabletext/markdown";

const blocks = markdownToPortableText(markdownString);
```

This handles headings, lists, bold, italic, code, links, images, and tables. Use `@portabletext/sanity-bridge` to pass your Sanity schema so only valid types are produced.

**Alternative: Markdown → HTML → Portable Text**
For complex Markdown with non-standard extensions, convert to HTML first, then use `htmlToBlocks` (see above).

1.  **Parse:** `marked` or `remark` to convert MD to HTML.
2.  **Convert:** Use `htmlToBlocks` from `@portabletext/block-tools`.

> **Note:** `@sanity/block-content-to-markdown` and `@sanity/block-tools` are deprecated. Use `@portabletext/markdown` and `@portabletext/block-tools` instead.

## 3. Image Handling (Universal)

Don't just link to external images. Download them and upload to Sanity Asset Pipeline.

1.  **Extract:** Find `<img>` tags or Markdown image syntax.
2.  **Download:** Fetch the image buffer.
3.  **Upload:** `client.assets.upload('image', buffer)`
4.  **Replace:** Return a Sanity Image block with the new asset reference.

## 4. Schema Validation

Ensure your destination schema allows the structures you are importing.

- **Tables:** Need a `table` type (HTML `<table>` or GFM tables).
- **Code:** Need a `code` type (HTML `<pre><code>` or MD code fences).
