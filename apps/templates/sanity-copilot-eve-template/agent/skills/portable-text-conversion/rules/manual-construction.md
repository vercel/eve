---
title: Manually Construct Portable Text Blocks
description: Build Portable Text blocks programmatically from any data source
tags: [portable-text, construction, api, programmatic, migration]
---

# Manually Construct Portable Text Blocks

Build PT blocks directly when converting from non-HTML sources (APIs, databases, custom formats) or when you need precise control over the output.

## Key Generation

Every block, span, and markDef needs a unique `_key`:

```ts
import {randomKey} from '@sanity/util/content'

const key = randomKey(12) // e.g., "a1b2c3d4e5f6"
```

Or use a simple helper:

```ts
const randomKey = () => Math.random().toString(36).slice(2, 14)
```

## Building Blocks

### Simple Paragraph

```ts
{
  _type: 'block',
  _key: randomKey(),
  style: 'normal',
  children: [
    {_type: 'span', _key: randomKey(), text: 'Hello world', marks: []}
  ],
  markDefs: []
}
```

### Heading

```ts
{
  _type: 'block',
  _key: randomKey(),
  style: 'h2', // h1, h2, h3, h4, h5, h6
  children: [
    {_type: 'span', _key: randomKey(), text: 'Section Title', marks: []}
  ],
  markDefs: []
}
```

### Text with Decorators (Bold, Italic, Code)

```ts
{
  _type: 'block',
  _key: randomKey(),
  style: 'normal',
  children: [
    {_type: 'span', _key: randomKey(), text: 'This is ', marks: []},
    {_type: 'span', _key: randomKey(), text: 'bold', marks: ['strong']},
    {_type: 'span', _key: randomKey(), text: ' and ', marks: []},
    {_type: 'span', _key: randomKey(), text: 'italic', marks: ['em']},
    {_type: 'span', _key: randomKey(), text: ' text.', marks: []},
  ],
  markDefs: []
}
```

### Text with Annotations (Links)

Annotations require a `markDef` entry and a matching key in `marks`:

```ts
const linkKey = randomKey()

{
  _type: 'block',
  _key: randomKey(),
  style: 'normal',
  children: [
    {_type: 'span', _key: randomKey(), text: 'Visit ', marks: []},
    {_type: 'span', _key: randomKey(), text: 'Sanity', marks: [linkKey]},
    {_type: 'span', _key: randomKey(), text: ' for more.', marks: []},
  ],
  markDefs: [
    {_type: 'link', _key: linkKey, href: 'https://www.sanity.io'}
  ]
}
```

### Overlapping Marks

A span can have multiple marks (both decorators and annotations):

```ts
const linkKey = randomKey()

// "bold link" — both strong and linked
{_type: 'span', _key: randomKey(), text: 'bold link', marks: ['strong', linkKey]}
```

### Lists

Lists are regular blocks with `listItem` and `level`:

```ts
// Bullet list
[
  {
    _type: 'block', _key: randomKey(), style: 'normal',
    listItem: 'bullet', level: 1,
    children: [{_type: 'span', _key: randomKey(), text: 'First item', marks: []}],
    markDefs: []
  },
  {
    _type: 'block', _key: randomKey(), style: 'normal',
    listItem: 'bullet', level: 1,
    children: [{_type: 'span', _key: randomKey(), text: 'Second item', marks: []}],
    markDefs: []
  },
  {
    _type: 'block', _key: randomKey(), style: 'normal',
    listItem: 'bullet', level: 2, // nested
    children: [{_type: 'span', _key: randomKey(), text: 'Nested item', marks: []}],
    markDefs: []
  },
]
```

### Custom Block Types

Any object with `_type` and `_key` can be a block:

```ts
// Image block
{
  _type: 'image',
  _key: randomKey(),
  asset: {_type: 'reference', _ref: 'image-abc123-800x600-png'},
  alt: 'A description',
}

// Code block
{
  _type: 'code',
  _key: randomKey(),
  language: 'typescript',
  code: 'const x = 42',
}

// YouTube embed
{
  _type: 'youtube',
  _key: randomKey(),
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
}
```

## Helper Function

A utility for building common blocks:

```ts
function createBlock(
  text: string,
  style: string = 'normal',
  options?: {listItem?: string; level?: number}
) {
  return {
    _type: 'block',
    _key: randomKey(),
    style,
    ...(options?.listItem ? {listItem: options.listItem, level: options.level || 1} : {}),
    children: [{_type: 'span', _key: randomKey(), text, marks: []}],
    markDefs: [],
  }
}

// Usage
const blocks = [
  createBlock('Introduction', 'h2'),
  createBlock('This is a paragraph.'),
  createBlock('First point', 'normal', {listItem: 'bullet', level: 1}),
  createBlock('Second point', 'normal', {listItem: 'bullet', level: 1}),
]
```

## Validation Checklist

Before writing PT blocks to Sanity, verify:

- [ ] Every block has `_type` and `_key`
- [ ] Every span has `_type: "span"`, `_key`, `text`, and `marks`
- [ ] Every annotation key in `marks[]` has a matching entry in `markDefs[]`
- [ ] `markDefs` entries have `_type` and `_key`
- [ ] `_key` values are unique within the array
- [ ] `style` values match your schema's allowed styles
- [ ] `listItem` values match your schema's allowed list types
- [ ] Custom block `_type` values match registered schema types

## Reference

- [Portable Text Specification](https://github.com/portabletext/portabletext)
- [@sanity/util](https://github.com/sanity-io/sanity/tree/next/packages/%40sanity/util) — provides `randomKey()` for generating `_key` values
