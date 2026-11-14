---
title: Serialize Portable Text to Astro
description: Render Portable Text in Astro using astro-portabletext
tags: [portable-text, astro, serialization, rendering]
---

# Serialize Portable Text to Astro

Use `astro-portabletext` to render PT in Astro projects. This is the officially recommended library for Sanity + Astro.

```bash
npm install astro-portabletext
```

## Basic Usage

```astro
---
import {PortableText} from 'astro-portabletext'
const {value} = Astro.props
---

<PortableText value={value} />
```

## Custom Components

Pass custom components to override default rendering:

```astro
---
import {PortableText} from 'astro-portabletext'
import ImageBlock from './ImageBlock.astro'
import CodeBlock from './CodeBlock.astro'
import Link from './Link.astro'

const {value} = Astro.props

const components = {
  type: {
    image: ImageBlock,
    code: CodeBlock,
  },
  mark: {
    link: Link,
  },
  block: {
    h1: 'h1',
    h2: 'h2',
    blockquote: 'blockquote',
  },
}
---

<PortableText {value} {components} />
```

### Custom Type Component

```astro
---
// ImageBlock.astro
const {node} = Astro.props
---

<figure>
  <img src={urlFor(node).width(800).url()} alt={node.alt || ''} />
  {node.caption && <figcaption>{node.caption}</figcaption>}
</figure>
```

### Custom Mark Component

```astro
---
// Link.astro
const {node} = Astro.props
const href = node?.href || ''
const rel = href.startsWith('/') ? undefined : 'noreferrer noopener'
---

<a {href} {rel}><slot /></a>
```

## Using Slots for Customization

`astro-portabletext` supports Astro's slot system for simpler customization:

```astro
---
import {PortableText} from 'astro-portabletext'
---

<PortableText value={value}>
  <fragment slot="block:h1">
    <h1 class="text-4xl font-bold"><slot /></h1>
  </fragment>
  <fragment slot="mark:strong">
    <strong class="font-black"><slot /></strong>
  </fragment>
</PortableText>
```

## usePortableText Helper

For more control, use the `usePortableText` render function:

```astro
---
import {usePortableText} from 'astro-portabletext'

const {value} = Astro.props
const {render} = usePortableText(value)
---

<div class="prose">
  {render()}
</div>
```

## Reference

- [astro-portabletext](https://github.com/theisel/astro-portabletext)
- [Sanity + Astro guide](https://www.sanity.io/guides/sanity-astro)
