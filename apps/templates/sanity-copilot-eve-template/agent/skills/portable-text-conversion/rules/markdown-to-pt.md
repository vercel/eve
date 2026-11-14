---
title: Convert Markdown to Portable Text
description: Convert Markdown content into Portable Text blocks using @portabletext/markdown
tags: [portable-text, markdown, conversion, migration, import]
---

# Convert Markdown to Portable Text

Use `@portabletext/markdown` for direct Markdown ↔ Portable Text conversion. This is the official library, part of the `portabletext/editor` monorepo.

```bash
npm install @portabletext/markdown
```

## Basic Usage

```ts
import {markdownToPortableText} from '@portabletext/markdown'

const blocks = markdownToPortableText('# Hello **world**')
```

Output:
```json
[{
  "_type": "block",
  "_key": "f4s8k2",
  "style": "h1",
  "children": [
    {"_type": "span", "_key": "a9c3x1", "text": "Hello ", "marks": []},
    {"_type": "span", "_key": "b7d2m5", "text": "world", "marks": ["strong"]}
  ],
  "markDefs": []
}]
```

## Supported Markdown Features

Out of the box:

- Headings (h1–h6)
- Paragraphs
- Bold, italic, inline code, strikethrough
- Links
- Blockquotes
- Ordered and unordered lists (including nested)
- Code blocks (fenced with language)
- Horizontal rules
- Images
- Tables (GFM)
- HTML blocks (configurable)

## Custom Schema Mapping

Control how Markdown elements map to your PT schema. Define a schema with `@portabletext/schema`:

```ts
import {markdownToPortableText} from '@portabletext/markdown'
import {defineSchema, compileSchema} from '@portabletext/schema'

const schema = compileSchema(defineSchema({
  styles: [{name: 'normal'}, {name: 'heading 1'}, {name: 'heading 2'}],
  decorators: [{name: 'strong'}, {name: 'em'}],
  annotations: [{name: 'link'}],
  lists: [{name: 'bullet'}, {name: 'number'}],
}))

const blocks = markdownToPortableText(markdown, {
  schema,
  // Map Markdown heading levels to custom style names
  block: {
    h1: ({context}) => 'heading 1',
    h2: ({context}) => 'heading 2',
  },
})
```

### Using a Sanity Studio Schema

Use `@portabletext/sanity-bridge` to convert your Sanity block array schema:

```ts
import {markdownToPortableText} from '@portabletext/markdown'
import {sanitySchemaToPortableTextSchema} from '@portabletext/sanity-bridge'

// Convert a Sanity block array schema to a Portable Text schema
const schema = sanitySchemaToPortableTextSchema(sanityBlockArraySchema)

const blocks = markdownToPortableText(markdown, {schema})
```

## Custom Matchers

Matchers are top-level options (not nested under a `matchers` key). Each receives `{context, value}` where `context.schema` lets you validate against the schema:

```ts
const blocks = markdownToPortableText(markdown, {
  // Block matchers — map Markdown block elements to PT styles
  block: {
    h1: ({context}) => {
      const style = context.schema.styles.find((s) => s.name === 'heading 1')
      return style?.name // Return undefined to skip
    },
  },
  // Mark matchers — map Markdown inline elements to PT marks
  marks: {
    strong: ({context}) => 'strong',
  },
  // Type matchers — map Markdown elements to custom PT block types
  types: {
    table: ({context, value}) => {
      const tableType = context.schema.blockObjects.find((obj) => obj.name === 'table')
      if (!tableType) return undefined
      return {
        _type: 'table',
        _key: context.keyGenerator(),
        rows: value.rows,
        headerRows: value.headerRows,
      }
    },
  },
})
```

## Handling Inline HTML

Configure how inline HTML in Markdown is processed:

```ts
const blocks = markdownToPortableText(markdown, {
  html: {
    inline: 'text', // 'text' preserves as text, 'skip' removes
  },
})
```

## Custom Key Generation

Provide your own key generator:

```ts
import {randomKey} from '@sanity/util/content'

const blocks = markdownToPortableText(markdown, {
  keyGenerator: () => randomKey(12),
})
```

## Bidirectional: Also Converts PT → Markdown

The same package provides `portableTextToMarkdown()`:

```ts
import {portableTextToMarkdown} from '@portabletext/markdown'

const markdown = portableTextToMarkdown(blocks)
```

See the `portable-text-serialization` skill's `rules/markdown.md` for details on PT → Markdown.

## Migration Example

```ts
import {markdownToPortableText} from '@portabletext/markdown'
import {createClient} from '@sanity/client'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

const client = createClient({projectId: 'xxx', dataset: 'production', token: '...'})

// Import a directory of Markdown files
const mdFiles = fs.readdirSync('./content').filter(f => f.endsWith('.md'))

for (const file of mdFiles) {
  const raw = fs.readFileSync(path.join('./content', file), 'utf-8')
  const {data: frontmatter, content} = matter(raw)

  const body = markdownToPortableText(content)

  await client.createOrReplace({
    _id: `post-${path.basename(file, '.md')}`,
    _type: 'post',
    title: frontmatter.title,
    body,
  })
}
```

## When to Use htmlToBlocks Instead

Use `@portabletext/block-tools` (`htmlToBlocks`) when:
- Your source is HTML, not Markdown
- You need custom deserializer rules for non-standard HTML elements
- You're migrating from a CMS that exports HTML (WordPress, Contentful, etc.)
- You need to handle complex HTML structures (tables with merged cells, nested divs, etc.)

For Markdown sources, `@portabletext/markdown` is simpler and more direct.

## Reference

- [@portabletext/markdown](https://github.com/portabletext/editor/tree/main/packages/markdown)
- Part of the [portabletext/editor](https://github.com/portabletext/editor) monorepo
- Uses [markdown-it](https://github.com/markdown-it/markdown-it) internally
