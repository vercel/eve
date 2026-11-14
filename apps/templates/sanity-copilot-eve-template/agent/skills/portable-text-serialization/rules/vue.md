---
title: Serialize Portable Text to Vue
description: Render Portable Text in Vue 3 and Nuxt using @portabletext/vue
tags: [portable-text, vue, nuxt, serialization, rendering]
---

# Serialize Portable Text to Vue

Use `@portabletext/vue` to render PT in Vue 3 / Nuxt applications.

```bash
npm install @portabletext/vue
```

## Basic Usage

```vue
<script setup lang="ts">
import {PortableText} from '@portabletext/vue'
import type {PortableTextBlock} from '@portabletext/types'

const props = defineProps<{value: PortableTextBlock[]}>()
</script>

<template>
  <PortableText :value="value" :components="components" />
</template>
```

## Custom Components

Vue components can be defined as render functions, SFCs, or JSX.

### Render Function Style (Concise)

```ts
import {h} from 'vue'
import type {PortableTextVueComponents} from '@portabletext/vue'

const components: PortableTextVueComponents = {
  types: {
    image: ({value}) => h('img', {src: urlFor(value).width(800).url(), alt: value.alt || ''}),
    code: ({value}) => h('pre', {'data-language': value.language}, h('code', value.code)),
  },

  marks: {
    link: ({value}, {slots}) => {
      const rel = !value?.href?.startsWith('/') ? 'noreferrer noopener' : undefined
      return h('a', {href: value?.href, rel}, slots.default?.())
    },
    highlight: (_, {slots}) => h('span', {class: 'bg-yellow-200'}, slots.default?.()),
  },

  block: {
    h1: (_, {slots}) => h('h1', {class: 'text-4xl font-bold'}, slots.default?.()),
    h2: (_, {slots}) => h('h2', {class: 'text-3xl font-semibold'}, slots.default?.()),
    blockquote: (_, {slots}) => h('blockquote', {class: 'border-l-4 pl-4 italic'}, slots.default?.()),
  },

  list: {
    bullet: (_, {slots}) => h('ul', {class: 'list-disc ml-6'}, slots.default?.()),
    number: (_, {slots}) => h('ol', {class: 'list-decimal ml-6'}, slots.default?.()),
  },
}
```

### SFC Style (For Complex Components)

```vue
<!-- ImageBlock.vue -->
<script setup lang="ts">
import type {PortableTextComponentProps} from '@portabletext/vue'

const props = defineProps<PortableTextComponentProps<{
  asset: {_ref: string}
  alt?: string
  caption?: string
}>>()
</script>

<template>
  <figure>
    <img :src="urlFor(value).width(800).url()" :alt="value.alt || ''" />
    <figcaption v-if="value.caption">{{ value.caption }}</figcaption>
  </figure>
</template>
```

Then register:

```ts
import ImageBlock from './ImageBlock.vue'

const components = {
  types: {
    image: ImageBlock,
  },
}
```

## Props Pattern

Custom components receive:

| Prop | Description |
|------|-------------|
| `value` | The block/mark data |
| `index` | Position in parent array |
| `isInline` | Whether this is an inline element |
| `renderNode` | Internal renderer (rarely needed) |

Children are passed via **slots** (`slots.default?.()`), not props.

## Plain Text Extraction

```ts
import {toPlainText} from '@portabletext/vue'

const text = toPlainText(blocks)
```

## Reference

- [@portabletext/vue](https://github.com/portabletext/vue-portabletext)
- [Sanity + Nuxt guide](https://www.sanity.io/guides/sanity-nuxt)
