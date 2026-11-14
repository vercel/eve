---
title: Convert HTML to Portable Text
description: Use @portabletext/block-tools with htmlToBlocks to convert HTML content into Portable Text blocks
tags: [portable-text, html, conversion, migration, import]
---

# Convert HTML to Portable Text

Use `@portabletext/block-tools` to parse HTML into Portable Text blocks. This is the primary tool for migrating HTML content from legacy CMSs. It has built-in support for content from Google Docs, Microsoft Word, and Notion.

> **Note:** For Markdown sources, use `@portabletext/markdown` instead — it's simpler and more direct. See `rules/markdown-to-pt.md`.

> **Note:** `@sanity/block-tools` is the legacy package name. Use `@portabletext/block-tools` for new projects. The API is identical.

## Setup

```bash
npm install @portabletext/block-tools jsdom @sanity/schema
```

In Node.js, you must provide a `parseHtml` function that returns a DOM `Document`. Use JSDOM for this:

```ts
import {htmlToBlocks} from '@portabletext/block-tools'
import {JSDOM} from 'jsdom'
import Schema from '@sanity/schema'

// JSDOM is passed to htmlToBlocks via the parseHtml option:
// htmlToBlocks(html, blockContentType, {
//   parseHtml: (html) => new JSDOM(html).window.document,
// })
```

## Define Your Schema

`htmlToBlocks` needs a compiled Sanity block content type to know which marks, styles, and custom types are valid. Use `@sanity/schema` to compile it:

```ts
const defaultSchema = Schema.compile({
  name: 'mySchema',
  types: [
    {
      name: 'post',
      type: 'document',
      fields: [
        {
          name: 'body',
          type: 'array',
          of: [
            {
              type: 'block',
              marks: {
                decorators: [
                  {title: 'Strong', value: 'strong'},
                  {title: 'Emphasis', value: 'em'},
                  {title: 'Code', value: 'code'},
                ],
                annotations: [
                  {
                    name: 'link',
                    type: 'object',
                    fields: [{name: 'href', type: 'url'}],
                  },
                ],
              },
              styles: [
                {title: 'Normal', value: 'normal'},
                {title: 'H2', value: 'h2'},
                {title: 'H3', value: 'h3'},
                {title: 'Quote', value: 'blockquote'},
              ],
              lists: [
                {title: 'Bullet', value: 'bullet'},
                {title: 'Number', value: 'number'},
              ],
            },
            {
              name: 'image',
              type: 'image',
              fields: [{name: 'alt', type: 'string'}],
            },
          ],
        },
      ],
    },
  ],
})

const blockContentType = defaultSchema
  .get('post')
  .fields.find((f) => f.name === 'body').type
```

## Basic Conversion

```ts
const html = '<p>Hello <strong>world</strong></p><h2>Heading</h2>'

const blocks = htmlToBlocks(html, blockContentType, {
  parseHtml: (html) => new JSDOM(html).window.document,
})
```

## Custom Deserializers

Handle HTML elements that don't map directly to standard PT:

```ts
const blocks = htmlToBlocks(html, blockContentType, {
  parseHtml: (html) => new JSDOM(html).window.document,
  rules: [
    // Convert <img> to image blocks
    {
      deserialize(el, next, block) {
        if (el.tagName?.toLowerCase() !== 'img') return undefined

        return block({
          _type: 'image',
          asset: {
            _type: 'reference',
            _ref: '', // Upload image separately, set ref after
          },
          alt: el.getAttribute('alt') || '',
          _sanityAsset: `image@${el.getAttribute('src')}`, // for migration tooling
        })
      },
    },
    // Convert <a> with custom attributes
    {
      deserialize(el, next, block) {
        if (el.tagName?.toLowerCase() !== 'a') return undefined

        const href = el.getAttribute('href') || ''
        const target = el.getAttribute('target') || ''

        return {
          _type: '__annotation',
          markDef: {
            _type: 'link',
            href,
            ...(target ? {target} : {}),
          },
          children: next(el.childNodes),
        }
      },
    },
    // Convert <iframe> to embed blocks
    {
      deserialize(el, next, block) {
        if (el.tagName?.toLowerCase() !== 'iframe') return undefined

        return block({
          _type: 'embed',
          url: el.getAttribute('src') || '',
        })
      },
    },
  ],
})
```

## Pre-Process HTML Before Conversion

Strip layout elements and extract metadata:

```ts
function preprocessHtml(rawHtml: string) {
  const dom = new JSDOM(rawHtml)
  const doc = dom.window.document

  // Remove layout elements
  const removeSelectors = ['header', 'footer', 'nav', '.sidebar', '.menu', 'script', 'style']
  removeSelectors.forEach((sel) => {
    doc.querySelectorAll(sel).forEach((el) => el.remove())
  })

  // Extract metadata
  const title = doc.querySelector('h1')?.textContent || doc.title || ''
  const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') || ''

  // Get cleaned body
  const body = doc.querySelector('article')?.innerHTML || doc.body.innerHTML

  return {title, description, body}
}
```

## Upload Images During Migration

Don't just link external images — upload them to Sanity:

```ts
import type {SanityClient} from '@sanity/client'

async function uploadImage(client: SanityClient, url: string) {
  const response = await fetch(url)
  const buffer = await response.arrayBuffer()
  const asset = await client.assets.upload('image', Buffer.from(buffer), {
    filename: url.split('/').pop(),
  })
  return {
    _type: 'image',
    asset: {_type: 'reference', _ref: asset._id},
  }
}
```

## Full Migration Example

```ts
import {defineMigration, createOrReplace} from 'sanity/migrate'

export default defineMigration({
  title: 'Import WordPress posts',
  async *migrate(documents, context) {
    const posts = await fetchWordPressPosts()

    for (const post of posts) {
      const {title, description, body} = preprocessHtml(post.content)
      const blocks = htmlToBlocks(body, blockContentType, {
        parseHtml: (html) => new JSDOM(html).window.document,
        rules: [/* custom rules */],
      })

      yield createOrReplace({
        _id: `post-${post.slug}`,
        _type: 'post',
        title: title || post.title,
        body: blocks,
      })
    }
  },
})
```

Run with: `sanity migration run import-wordpress-posts --no-dry-run`

## Reference

- [@portabletext/block-tools](https://github.com/portabletext/editor/tree/main/packages/block-tools) — part of the `portabletext/editor` monorepo
- [Sanity Migration docs](https://www.sanity.io/docs/schema-and-content-migrations)
- [portabletext.org](https://www.portabletext.org) — Editor docs and serializer list
