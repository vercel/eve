---
title: "SvelteKit & Sanity Integration Rules"
description: Integration guide for SvelteKit with Sanity using @sanity/sveltekit, including Visual Editing and Preview Mode.
---

# SvelteKit & Sanity Integration Rules

This guide uses the official **`@sanity/sveltekit`** package (Svelte 5 + SvelteKit 2). The older `@sanity/svelte-loader` does not work with Svelte 5 — its `useQuery` store returns empty on the client. Use `@sanity/sveltekit` instead.

## 1. Setup & Configuration

### Scaffold a new SvelteKit app

```bash
npx sv@latest create my-app --template minimal --types ts --no-add-ons --install npm
cd my-app
```

`--template minimal` is the bare app. `--types ts` enables TypeScript. `--no-add-ons` skips the add-on picker. `--install <pm>` chooses the package manager (`npm`, `pnpm`, `yarn`, or `bun`).

### Installation

```bash
npm install @sanity/sveltekit @sanity/image-url @portabletext/svelte
```

`@sanity/sveltekit` is the one-stop integration: it bundles `@sanity/client`, `@sanity/visual-editing`, `@sanity/core-loader`, `groq`, and friends, and re-exports `createClient`, `defineQuery`, `groq`, and `stegaClean`. **Do not** also install `@sanity/client`, `@sanity/visual-editing`, or `groq` directly — import them from `@sanity/sveltekit`. `@sanity/image-url` and `@portabletext/svelte` are not bundled, so add them separately.

### Environment variables (`.env.local`)

```bash
PUBLIC_SANITY_PROJECT_ID=your-project-id
PUBLIC_SANITY_DATASET=production
PUBLIC_SANITY_API_VERSION=2026-05-15
PUBLIC_SANITY_STUDIO_URL=http://localhost:3333
SANITY_API_READ_TOKEN=
```

SvelteKit's `$env/static/public` requires the `PUBLIC_` prefix for any var read on the client. `SANITY_API_READ_TOKEN` must be declared (even empty) if any file imports it from `$env/static/private`, otherwise Vite throws at build time.

## 2. Files

### `src/lib/sanity/api.ts` — env var resolution

```ts
import {
  PUBLIC_SANITY_DATASET,
  PUBLIC_SANITY_PROJECT_ID,
  PUBLIC_SANITY_API_VERSION,
  PUBLIC_SANITY_STUDIO_URL,
} from '$env/static/public'

function assertEnvVar<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

export const dataset = assertEnvVar(PUBLIC_SANITY_DATASET, 'PUBLIC_SANITY_DATASET')
export const projectId = assertEnvVar(PUBLIC_SANITY_PROJECT_ID, 'PUBLIC_SANITY_PROJECT_ID')
export const apiVersion = PUBLIC_SANITY_API_VERSION || '2026-05-15'
export const studioUrl = PUBLIC_SANITY_STUDIO_URL || 'http://localhost:3333'
```

### `src/lib/sanity/client.ts` — public client

```ts
import {createClient} from '@sanity/sveltekit'
import {apiVersion, projectId, dataset, studioUrl} from '$lib/sanity/api'

export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
  stega: {studioUrl},
})
```

Import `createClient` from `@sanity/sveltekit`, not `@sanity/client`. `useCdn: true` is for production reads; the server (preview) client below overrides to `false`.

### `src/lib/sanity/client.server.ts` — server (preview) client

```ts
import {SANITY_API_READ_TOKEN} from '$env/static/private'
import {client} from '$lib/sanity/client'

export const serverClient = client.withConfig({
  token: SANITY_API_READ_TOKEN,
  useCdn: false,
  stega: true,
})
```

### `src/lib/sanity/queries.ts` — queries + types

```ts
import {groq} from '@sanity/sveltekit'

export const postsQuery = groq`*[_type == "post" && defined(slug.current)] | order(_createdAt desc){
  _id, _createdAt, title, slug, excerpt, mainImage, body
}`

export const postQuery = groq`*[_type == "post" && slug.current == $slug][0]{
  _id, _createdAt, title, slug, excerpt, mainImage, body
}`

export interface Post {
  _id: string
  _createdAt: string
  title?: string
  slug: {current: string}
  excerpt?: string
  mainImage?: unknown
  body?: unknown[]
}
```

Use `defineQuery` instead of `groq` if you want TypeGen-friendly query definitions; both are re-exported from `@sanity/sveltekit`.

### `src/lib/sanity/image.ts` — image URL builder

```ts
import {createImageUrlBuilder} from '@sanity/image-url'
import {client} from './client'

const builder = createImageUrlBuilder(client)

export function urlFor(source: unknown) {
  return builder.image(source as never)
}
```

Use the named `createImageUrlBuilder` export; the default export logs a deprecation warning at runtime.

## 3. Hooks & Locals

### `src/hooks.server.ts` — wire preview + query loader

```ts
import {handlePreviewMode, handleQueryLoader, setServerClient} from '@sanity/sveltekit'
import {redirect} from '@sveltejs/kit'
import {sequence} from '@sveltejs/kit/hooks'
import {serverClient} from '$lib/sanity/client.server'

setServerClient(serverClient)

export const handle = sequence(
  handlePreviewMode({
    client: serverClient,
    preview: {redirect},
  }),
  handleQueryLoader(),
)
```

`handlePreviewMode` installs `/preview/enable` and `/preview/disable` endpoints, reads the preview cookie, and populates `locals.sanity` with `{client, fetch, loadQuery, previewEnabled, previewPerspective, browserToken}`. `handleQueryLoader` attaches `loadQuery` to `locals.sanity` for use in `+page.server.ts` / `+layout.server.ts`.

### `src/app.d.ts` — typed locals

```ts
import type {SanityLocals} from '@sanity/sveltekit'

declare global {
  namespace App {
    interface Locals extends SanityLocals {}
  }
}

export {}
```

## 4. Layout: Preview + Visual Editing Providers

### `src/routes/+layout.server.ts` — propagate previewEnabled

```ts
import type {LayoutServerLoad} from './$types'

export const load: LayoutServerLoad = (event) => {
  const {previewEnabled} = event.locals.sanity
  return {previewEnabled}
}
```

### `src/routes/+layout.svelte` — wrap children in providers (Svelte 5)

```svelte
<script lang="ts">
  import {PreviewMode, QueryLoader, VisualEditing} from '@sanity/sveltekit'
  import type {LayoutProps} from './$types'
  import {client} from '$lib/sanity/client'
  const {children, data}: LayoutProps = $props()
  // svelte-ignore state_referenced_locally
  const {previewEnabled} = data
</script>

<PreviewMode enabled={previewEnabled}>
  <VisualEditing enabled={previewEnabled}>
    <QueryLoader enabled={previewEnabled} {client}>
      {@render children()}
    </QueryLoader>
  </VisualEditing>
</PreviewMode>
```

Svelte 5 idioms here are mandatory:
- `const {children, data} = $props()` — not `export let data`.
- `{@render children()}` — not `<slot />`.
- The `svelte-ignore state_referenced_locally` comment silences a warning about destructuring reactive props at module scope.

`<VisualEditing>` dynamically imports its component only when `enabled === true`, so a preview-off app never loads the React-Compiler-runtime chunk.

## 5. Data Fetching (Loaders + `useQuery`)

### Posts list

`src/routes/+page.server.ts`:

```ts
import {postsQuery as query, type Post} from '$lib/sanity/queries'
import type {PageServerLoad} from './$types'

export const load: PageServerLoad = async ({locals}) => {
  const {loadQuery} = locals.sanity
  const initial = await loadQuery<Post[]>(query)
  return {query, options: {initial}}
}
```

The return shape `{query, params?, options: {initial}}` is what `useQuery(data)` on the client expects — don't change the field names.

`src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import {useQuery} from '@sanity/sveltekit'
  import type {Post} from '$lib/sanity/queries'
  import type {PageProps} from './$types'

  const {data}: PageProps = $props()
  const query = $derived(useQuery<Post[]>(data))
  const posts = $derived($query.data)
</script>

<h1>Posts</h1>
{#if posts?.length}
  <ul>
    {#each posts as post (post._id)}
      <li><a href={`/post/${post.slug.current}`}>{post.title}</a></li>
    {/each}
  </ul>
{:else}
  <p>No posts yet.</p>
{/if}
```

Critical Svelte 5 pattern:
- `useQuery` returns a Svelte Readable store. Wrap in `$derived(useQuery(data))` so the store reference stays current across reactive updates.
- Subscribe via `$query` (Svelte's auto-subscription) and read `.data`.
- Works on both SSR and client.

### Post detail (`[slug]`)

`src/routes/post/[slug]/+page.server.ts`:

```ts
import {postQuery as query, type Post} from '$lib/sanity/queries'
import type {PageServerLoad} from './$types'

export const load: PageServerLoad = async ({locals, params}) => {
  const {loadQuery} = locals.sanity
  const {slug} = params
  const initial = await loadQuery<Post>(query, {slug})
  return {query, params: {slug}, options: {initial}}
}
```

`src/routes/post/[slug]/+page.svelte`:

```svelte
<script lang="ts">
  import {useQuery} from '@sanity/sveltekit'
  import {PortableText} from '@portabletext/svelte'
  import {urlFor} from '$lib/sanity/image'
  import type {Post} from '$lib/sanity/queries'
  import type {PageProps} from './$types'

  const {data}: PageProps = $props()
  const query = $derived(useQuery<Post>(data))
  const post = $derived($query.data)
</script>

{#if post}
  <article>
    <h1>{post.title}</h1>
    {#if post.mainImage}
      <img src={urlFor(post.mainImage).width(800).url()} alt={post.title ?? ''} />
    {/if}
    {#if post.body}
      <PortableText value={post.body} />
    {/if}
  </article>
{:else}
  <p>Post not found.</p>
{/if}
```

## 6. Stega Cleaning

When using fetched strings for logic (routing, classNames), strip the stega markers first.

```ts
import {stegaClean} from '@sanity/sveltekit'
// …
if (stegaClean(slug) === 'home') { /* … */ }
```

## 7. Caveats

- **Yarn classic + Visual Editing.** `@sanity/visual-editing` lazy-loads a chunk that imports `react/compiler-runtime`. Yarn classic doesn't auto-install peer deps, so users who flip preview mode on with yarn classic also need `yarn add react react-dom`. (Other package managers handle this automatically.) `<VisualEditing>` only loads this chunk when `enabled === true`, so a default preview-off app is unaffected.
- **No `<slot />`.** Svelte 5 layouts use `{@render children()}`.
- **No `export let`.** Pages and components use `const {data} = $props()`.
- **`@sanity/image-url` default export.** Use the named `createImageUrlBuilder`; the default export still works but logs a runtime deprecation warning.
