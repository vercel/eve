---
title: Serialize Portable Text to HTML
description: Convert Portable Text to HTML strings server-side using @portabletext/to-html
tags: [portable-text, html, server-side, serialization, email]
---

# Serialize Portable Text to HTML

Use `@portabletext/to-html` for server-side HTML string generation — useful for RSS feeds, emails, static rendering, or any non-framework context.

```bash
npm install @portabletext/to-html
```

## Basic Usage

```ts
import {toHTML} from '@portabletext/to-html'

const html = toHTML(portableTextBlocks, {components})
```

## ⚠️ Security: Escape HTML

Unlike framework renderers, `toHTML` returns raw strings. **You must sanitize output.**

Use `htm` + `vhtml` for safe templating, or the built-in `escapeHTML` utility:

```ts
import {toHTML, escapeHTML, uriLooksSafe} from '@portabletext/to-html'
import htm from 'htm'
import vhtml from 'vhtml'

const h = htm.bind(vhtml)
```

## Custom Components

Components are functions returning HTML strings:

```ts
const components = {
  types: {
    image: ({value}) => {
      return `<figure>
        <img src="${escapeHTML(value.url)}" alt="${escapeHTML(value.alt || '')}" />
        ${value.caption ? `<figcaption>${escapeHTML(value.caption)}</figcaption>` : ''}
      </figure>`
    },
    code: ({value}) => {
      return `<pre data-language="${escapeHTML(value.language)}"><code>${escapeHTML(value.code)}</code></pre>`
    },
  },

  marks: {
    link: ({children, value}) => {
      const href = value?.href || ''
      if (!uriLooksSafe(href)) return children
      const rel = href.startsWith('/') ? '' : ' rel="noreferrer noopener"'
      return `<a href="${escapeHTML(href)}"${rel}>${children}</a>`
    },
    strong: ({children}) => `<strong>${children}</strong>`,
    em: ({children}) => `<em>${children}</em>`,
    highlight: ({children}) => `<mark>${children}</mark>`,
  },

  block: {
    h1: ({children}) => `<h1>${children}</h1>`,
    h2: ({children}) => `<h2>${children}</h2>`,
    blockquote: ({children}) => `<blockquote>${children}</blockquote>`,
    normal: ({children}) => `<p>${children}</p>`,
  },

  list: {
    bullet: ({children}) => `<ul>${children}</ul>`,
    number: ({children}) => `<ol>${children}</ol>`,
  },

  listItem: {
    bullet: ({children}) => `<li>${children}</li>`,
  },
}
```

## With htm/vhtml (Auto-Escaped)

Using `htm` + `vhtml` auto-escapes attribute values, preventing XSS from user content that could break out of attributes in raw template literals:

```ts
const components = {
  types: {
    image: ({value}) => h`<img src=${value.url} alt=${value.alt || ''} />`,
  },
  marks: {
    link: ({children, value}) => {
      if (!uriLooksSafe(value?.href || '')) return children
      return h`<a href=${value.href}>${children}</a>`
    },
  },
}
```

## Use Cases

| Use Case | Why toHTML |
|----------|-----------|
| RSS/Atom feeds | Need raw HTML string |
| Email templates | No framework runtime |
| Static site generation | Pre-render at build time |
| API responses | Return HTML from endpoints |
| PDF generation | Feed HTML to PDF libraries |

## Reference

- [@portabletext/to-html](https://github.com/portabletext/to-html)
