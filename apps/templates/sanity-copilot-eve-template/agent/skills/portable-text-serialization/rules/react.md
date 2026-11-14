---
title: Serialize Portable Text to React
description: Render Portable Text in React and Next.js using @portabletext/react
tags: [portable-text, react, nextjs, serialization, rendering]
---

# Serialize Portable Text to React

Use `@portabletext/react` (or re-exported from `next-sanity`) to render PT in React/Next.js.

```bash
npm install @portabletext/react
```

## Basic Usage

```tsx
import {PortableText} from '@portabletext/react'
// or: import {PortableText} from 'next-sanity'

export function Body({value}: {value: PortableTextBlock[]}) {
  return <PortableText value={value} components={components} />
}
```

## Typed Components Object

```tsx
import type {PortableTextComponents} from '@portabletext/react'

const components: PortableTextComponents = {
  // Block styles
  block: {
    h1: ({children}) => <h1 className="text-4xl font-bold">{children}</h1>,
    h2: ({children}) => <h2 className="text-3xl font-semibold">{children}</h2>,
    blockquote: ({children}) => (
      <blockquote className="border-l-4 pl-4 italic">{children}</blockquote>
    ),
    // 'normal' is the default paragraph style
  },

  // Custom block types
  types: {
    image: ({value}) => (
      <img
        src={urlFor(value).width(800).url()}
        alt={value.alt || ''}
        loading="lazy"
      />
    ),
    code: ({value}) => (
      <pre data-language={value.language}>
        <code>{value.code}</code>
      </pre>
    ),
  },

  // Marks (decorators + annotations)
  marks: {
    // Decorator
    highlight: ({children}) => (
      <span className="bg-yellow-200">{children}</span>
    ),
    // Annotation
    link: ({children, value}) => {
      const rel = !value?.href?.startsWith('/') ? 'noreferrer noopener' : undefined
      return (
        <a href={value?.href} rel={rel}>
          {children}
        </a>
      )
    },
    internalLink: ({children, value}) => (
      <a href={`/${value?.slug}`}>{children}</a>
    ),
  },

  // Lists
  list: {
    bullet: ({children}) => <ul className="list-disc ml-6">{children}</ul>,
    number: ({children}) => <ol className="list-decimal ml-6">{children}</ol>,
  },
  listItem: {
    bullet: ({children}) => <li>{children}</li>,
  },
}
```

## Props Reference

| Component type | Props received |
|---------------|----------------|
| `block.*` | `{children, value}` — `value` is the full block |
| `types.*` | `{value, isInline}` — `value` is the custom block data |
| `marks.*` | `{children, value, markType, markKey}` — `value` is the markDef data |
| `list.*` | `{children, value}` |
| `listItem.*` | `{children, value}` |

## Performance: Stabilize the Components Object

❌ **Bad** — recreated every render:
```tsx
function Body({value}) {
  return <PortableText value={value} components={{
    types: {image: ({value}) => <img src={value.url} />}
  }} />
}
```

✅ **Good** — defined outside or memoized:
```tsx
const components: PortableTextComponents = {
  types: {image: ({value}) => <img src={value.url} />}
}

function Body({value}) {
  return <PortableText value={value} components={components} />
}
```

## Plain Text Extraction

```tsx
import {toPlainText} from '@portabletext/react'

const text = toPlainText(blocks) // for meta descriptions, search indexing
```

## Tailwind Typography Shortcut

For simple blogs without custom blocks, wrap in `prose`:

```tsx
<article className="prose lg:prose-xl">
  <PortableText value={value} />
</article>
```

## Reference

- [@portabletext/react](https://github.com/portabletext/react-portabletext)
- [Sanity docs: Presenting Portable Text](https://www.sanity.io/docs/presenting-block-text)
