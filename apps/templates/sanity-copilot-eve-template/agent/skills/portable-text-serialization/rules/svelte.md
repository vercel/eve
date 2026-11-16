---
title: Serialize Portable Text to Svelte
description: Render Portable Text in Svelte 5 and SvelteKit using @portabletext/svelte
tags: [portable-text, svelte, sveltekit, serialization, rendering]
---

# Serialize Portable Text to Svelte

Use `@portabletext/svelte` (requires Svelte 5+) to render PT in Svelte/SvelteKit.

```bash
npm install @portabletext/svelte
```

## Basic Usage

```svelte
<script>
  import {PortableText} from '@portabletext/svelte'

  let {value} = $props()
</script>

<PortableText {value} components={components} />
```

## Custom Components

Svelte components receive a `portableText` prop with `value`, `global`, and `indexInParent`. Child content is passed via Svelte snippets.

### Block Styles

```svelte
<!-- Heading.svelte -->
<script>
  let {portableText, children} = $props()
  const {value} = portableText
</script>

{#if value.style === 'h1'}
  <h1 class="text-4xl font-bold">{@render children()}</h1>
{:else if value.style === 'h2'}
  <h2 class="text-3xl font-semibold">{@render children()}</h2>
{:else}
  <p>{@render children()}</p>
{/if}
```

### Custom Types

```svelte
<!-- ImageBlock.svelte -->
<script>
  let {portableText} = $props()
  const {value} = portableText
</script>

<figure>
  <img src={urlFor(value).width(800).url()} alt={value.alt || ''} />
  {#if value.caption}
    <figcaption>{value.caption}</figcaption>
  {/if}
</figure>
```

### Mark Components (Annotations)

```svelte
<!-- Link.svelte -->
<script>
  let {portableText, children} = $props()
  const {value} = portableText
  const href = value?.href || ''
</script>

<a {href} rel={href.startsWith('/') ? undefined : 'noreferrer noopener'}>
  {@render children()}
</a>
```

## Assembling Components

```svelte
<script>
  import {PortableText} from '@portabletext/svelte'
  import ImageBlock from './ImageBlock.svelte'
  import CodeBlock from './CodeBlock.svelte'
  import Link from './Link.svelte'

  let {value} = $props()

  const components = {
    types: {
      image: ImageBlock,
      code: CodeBlock,
    },
    marks: {
      link: Link,
    },
    block: {
      h1: ({children}) => `<h1>${children}</h1>`, // or use a component
    },
  }
</script>

<PortableText {value} {components} />
```

## Passing Context

Pass external data to all components via `context`:

```svelte
<PortableText
  {value}
  {components}
  context={{dataset: 'production', footnotes}}
/>
```

Access in components via `portableText.global.context`.

## Plain Text Extraction

```js
import {toPlainText} from '@portabletext/svelte'

const text = toPlainText(blocks)
```

## Reference

- [@portabletext/svelte](https://github.com/portabletext/svelte-portabletext)
- [Sanity + SvelteKit guide](https://www.sanity.io/guides/sanity-sveltekit)
