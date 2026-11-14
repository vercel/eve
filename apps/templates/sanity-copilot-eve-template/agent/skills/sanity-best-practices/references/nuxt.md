---
title: Nuxt & Sanity Integration Rules
description: Integration guide for Nuxt, including @nuxtjs/sanity, visual editing, and data fetching.
---

# Nuxt & Sanity Integration Rules

## 1. Setup & Configuration

### Scaffold a new Nuxt app

```bash
npm create nuxt@latest my-app -- -t ui -M "" --packageManager npm --no-gitInit
cd my-app
```

`-t ui` selects the Nuxt UI starter. `-M ""` skips the interactive module-selection prompt (empty string = no extra modules). `--packageManager npm` and `--no-gitInit` suppress the other two prompts so the scaffold runs end-to-end without input.

### Installation

```bash
npx nuxi@latest module add sanity
```

`nuxi module add sanity` resolves to the official `@nuxtjs/sanity` module and registers it in `nuxt.config.ts` automatically. The module bundles `@sanity/client`, `@sanity/visual-editing`, `@portabletext/vue`, and `groq` as direct dependencies — no separate installs needed.

`groq` and `defineQuery` are also **auto-imported** by the module, so you can use them in `.vue` files without an `import` statement.

For manual image-URL building (an alternative to the auto-registered `<SanityImage>` component), add `@sanity/image-url`:

```bash
npm install @sanity/image-url
```

### What the module auto-imports

**Composables** (use directly in `<script setup>`, no imports needed):
- `useSanity()` — get the client and its config
- `useSanityQuery()` / `useLazySanityQuery()` — reactive query helpers
- `useSanityConfig()` — read the resolved module config
- `useSanityPerspective()`, `useSanityPreviewPerspective()`, `useSanityPreviewEnvironment()` — perspective helpers for drafts/preview
- `useSanityVisualEditingState()`, `useIsSanityLivePreview()`, `useIsSanityPresentationTool()` — visual-editing state helpers

**GROQ helpers** (template tags): `groq`, `defineQuery`

**Components** (use directly in `<template>`):
- `<SanityContent>` — Portable Text renderer (uses `@portabletext/vue` internally; prop is `:value`)
- `<SanityImage>` — image renderer; takes an `assetId` (the image asset's `_ref`); upgrades to `<NuxtImg>` automatically when `@nuxt/image` is installed
- `<SanityFile>` — file renderer

### Configuration (`nuxt.config.ts`)

```typescript
export default defineNuxtConfig({
  modules: ['@nuxtjs/sanity'],
  sanity: {
    projectId: process.env.NUXT_SANITY_PROJECT_ID,
    dataset: process.env.NUXT_SANITY_DATASET,
    apiVersion: '2026-05-15',
    // Live Visual Editing Configuration
    visualEditing: {
      studioUrl: process.env.NUXT_SANITY_STUDIO_URL,
      token: process.env.NUXT_SANITY_API_READ_TOKEN, // Required for fetching drafts
      stega: true, // Enable stega for visual editing
      mode: 'live-visual-editing', // Default: enables live updates
    },
  },
});
```

**Important:** Don't enable the `minimal` client if you want the full feature set (composables, components, visual editing).

## 2. Data Fetching

### `useSanityQuery`
Use the composable for reactive fetching. It handles preview state automatically when `visualEditing` is configured. `groq` and `defineQuery` are auto-imported — use either.

```vue
<!-- app/pages/posts.vue -->
<script setup lang="ts">
const query = groq`*[_type == "post" && defined(slug.current)]{ _id, title, slug }`
const { data: posts } = await useSanityQuery<Array<{ _id: string; title?: string; slug?: { current?: string } }>>(query)
</script>

<template>
  <ul>
    <li v-for="post in posts || []" :key="post._id">
      <NuxtLink :to="`/${post.slug?.current}`">{{ post.title }}</NuxtLink>
    </li>
  </ul>
</template>
```

### Dynamic Routes (`[slug].vue`)

Pull the slug off `useRoute()` and pass it as a query parameter. The `<SanityContent>` component renders Portable Text — note the prop is `value`, not `blocks` (renamed in v2).

```vue
<!-- app/pages/[slug].vue -->
<script setup lang="ts">
const route = useRoute()
const query = groq`*[_type == "post" && slug.current == $slug][0]{ _id, title, body }`
const { data: post } = await useSanityQuery<{ _id: string; title?: string; body?: unknown[] }>(
  query,
  { slug: route.params.slug }
)
</script>

<template>
  <article v-if="post">
    <h1>{{ post.title }}</h1>
    <SanityContent v-if="post.body" :value="post.body" />
  </article>
</template>
```

## 3. Visual Editing (Live Preview)

### Automatic Setup
When `visualEditing` is configured in `nuxt.config.ts`, the module handles:
1. Injecting the Visual Editing overlays.
2. Refreshing data when content changes in the Studio.
3. Enabling Stega encoding.

### Handling Stega in Logic
If you use stega-encoded strings in logic (e.g. `v-if="post.layout === 'full'"`), you must clean them. `stegaClean` is exported from `@sanity/client/stega` (a transitive of `@nuxtjs/sanity`, so no separate install).

```typescript
import { stegaClean } from '@sanity/client/stega'

const layout = computed(() => stegaClean(props.layout))
```

## 4. Components

### Portable Text — `<SanityContent>`

The module auto-registers `<SanityContent>`. Don't install `@portabletext/vue` separately; it's a direct dep of the module.

```vue
<SanityContent :value="post.body" />
```

For custom blocks/marks, pass `:components`:

```vue
<SanityContent :value="post.body" :components="{ block: { h2: MyH2 } }" />
```

### Images — two options

**Option A — `<SanityImage>` (recommended).** Auto-registered. Takes the asset's `_ref` (the `assetId`) and builds the URL via the module's resolved projectId/dataset. If `@nuxt/image` is installed, it transparently upgrades to `<NuxtImg>` for responsive sizing.

```vue
<SanityImage :asset-id="post.mainImage.asset._ref" width="800" />
```

**Option B — `@sanity/image-url` builder.** Install `@sanity/image-url` separately and build URLs manually. Useful when you need fine-grained control (hotspot/crop, format negotiation, srcset).

```typescript
import imageUrlBuilder from '@sanity/image-url'
const builder = imageUrlBuilder(useSanity().client)
// builder.image(source).width(800).url()
```
