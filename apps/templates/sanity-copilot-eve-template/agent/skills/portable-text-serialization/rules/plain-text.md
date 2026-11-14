---
title: Extract Plain Text from Portable Text
description: Convert Portable Text to plain text strings for search, meta descriptions, and summaries
tags: [portable-text, plain-text, search, seo, extraction]
---

# Extract Plain Text from Portable Text

Every `@portabletext/*` library exports a `toPlainText()` utility. Use it for meta descriptions, search indexing, summaries, and anywhere you need raw text without markup.

## Usage

```ts
// From any framework library:
import {toPlainText} from '@portabletext/react'
// or: import {toPlainText} from '@portabletext/svelte'
// or: import {toPlainText} from '@portabletext/vue'
// or: import {toPlainText} from '@portabletext/to-html'

const plainText = toPlainText(portableTextBlocks)
```

## Common Patterns

### Meta Description

```ts
function getMetaDescription(body: PortableTextBlock[]): string {
  const text = toPlainText(body)
  return text.length > 160 ? text.slice(0, 157) + '...' : text
}
```

### Search Indexing

```ts
// Index document content for search
const searchableText = toPlainText(document.body)
```

### Slug Generation

```ts
import slugify from 'slugify'

const slug = slugify(toPlainText(blocks), {lower: true, strict: true})
```

### Character/Word Count

```ts
const text = toPlainText(blocks)
const wordCount = text.split(/\s+/).filter(Boolean).length
const charCount = text.length
```

## Behavior

- Extracts text from all `span` children in `block` type nodes
- Joins blocks with double newlines (`\n\n`)
- Ignores custom block types (images, code blocks, etc.)
- Strips all marks (bold, links, etc.) — returns raw text only

## Reference

- [`toPlainText` source](https://github.com/portabletext/toolkit)
