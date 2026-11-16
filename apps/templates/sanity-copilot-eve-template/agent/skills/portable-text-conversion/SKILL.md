---
description: "Convert HTML and Markdown content into Portable Text blocks for Sanity. Use when migrating content from legacy CMSs, importing HTML or Markdown into Sanity, building content pipelines that ingest external content, converting rich text between formats, or programmatically creating Portable Text documents. Covers @portabletext/markdown (markdownToPortableText), @portabletext/block-tools (htmlToBlocks), custom deserializers, and the Portable Text specification for manual block construction."
---
# Portable Text Conversion

Convert external content (HTML, Markdown) into Portable Text for Sanity. Three main approaches:

1. **`markdownToPortableText`** — Convert Markdown directly using `@portabletext/markdown` (recommended for Markdown)
2. **`htmlToBlocks`** — Parse HTML into PT blocks using `@portabletext/block-tools` (for HTML migration)
3. **Manual construction** — Build PT blocks directly from any source (APIs, databases, etc.)

## Portable Text Specification

Understand the target format before converting. PT is an array of blocks:

```json
[
  {
    "_type": "block",
    "_key": "abc123",
    "style": "normal",
    "children": [
      {"_type": "span", "_key": "def456", "text": "Hello ", "marks": []},
      {"_type": "span", "_key": "ghi789", "text": "world", "marks": ["strong"]}
    ],
    "markDefs": []
  },
  {
    "_type": "block",
    "_key": "jkl012",
    "style": "h2",
    "children": [
      {"_type": "span", "_key": "mno345", "text": "A heading", "marks": []}
    ],
    "markDefs": []
  },
  {
    "_type": "image",
    "_key": "pqr678",
    "asset": {"_type": "reference", "_ref": "image-abc-200x200-png"}
  }
]
```

**Key rules:**
- Every block and span needs `_key` (unique within the array)
- `_type: "block"` is for text blocks; custom types use their own `_type`
- `markDefs` holds annotation data; `marks` on spans reference `markDefs[*]._key` or are decorator strings
- Lists use `listItem` ("bullet" | "number") and `level` (1, 2, 3...) on regular blocks

## Conversion Rules

Read the rule file matching your source format:

- **Markdown → Portable Text**: `rules/markdown-to-pt.md` — `@portabletext/markdown` with `markdownToPortableText` (recommended)
- **HTML → Portable Text**: `rules/html-to-pt.md` — `@portabletext/block-tools` with `htmlToBlocks`
- **Manual PT Construction**: `rules/manual-construction.md` — build blocks programmatically from any source

> **Note:** `@sanity/block-tools` is the legacy package name. Always use `@portabletext/block-tools` for new projects. The API is the same.
