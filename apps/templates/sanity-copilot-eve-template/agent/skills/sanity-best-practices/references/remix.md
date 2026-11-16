---
title: React Router (Remix) & Sanity Integration Rules
description: Integration guide for React Router v7 (and Remix v2) with Sanity, including loaders and visual editing.
---

# React Router (Remix) & Sanity Integration Rules

## Version Note

The primary examples below use **React Router v7** (the current shape — Remix v2 was renamed to React Router v7 starting with the v7 release). Import paths and the route-types file (`./+types/<route>`) come from the `react-router` package and the framework's typegen.

If you are on the older **Remix v2** stack, the integration shape is identical; only the import paths differ:

| React Router v7 | Remix v2 |
|-----------------|----------|
| `react-router` | `@remix-run/node` / `@remix-run/react` |
| `import type { Route } from "./+types/<route>"` | `import type { LoaderFunctionArgs } from "@remix-run/node"` + `useLoaderData<typeof loader>()` |
| `react-router.config.ts` | `remix.config.js` |

## 1. Setup & Client Pattern

### Scaffold a new React Router v7 app

```bash
npx create-react-router@latest my-app -y
cd my-app
npm install @sanity/client @sanity/react-loader @sanity/visual-editing @portabletext/react groq
```

`-y` accepts defaults. The Sanity packages cover server loaders (`@sanity/react-loader`, `@sanity/client`), live preview (`@sanity/visual-editing`), Portable Text rendering (`@portabletext/react`), and typed queries (`groq`).

To support both server-side fetching and client-side live previews, use the **Split Loader Pattern**.

### A. Environment Variables

React Router runs on Vite. **Any module reachable from a route component gets bundled into the client** — `process.env` doesn't exist there and will throw `ReferenceError: process is not defined` on client-side route transitions (SSR will still work, which makes this trap easy to miss).

Split publishable values from secrets:

- **Publishable** (`projectId`, `dataset`, `apiVersion`, `studioUrl`): prefix with `VITE_` and read via `import.meta.env`. Safe to import from anywhere.
- **Secrets** (read tokens, webhook secrets): keep unprefixed and read via `process.env` **only inside `*.server.ts` files**. Never re-export them from a shared module.

`.env`:

```
VITE_SANITY_PROJECT_ID=your-project-id
VITE_SANITY_DATASET=production
VITE_SANITY_API_VERSION=2026-02-01
VITE_SANITY_STUDIO_URL=http://localhost:3333
SANITY_API_READ_TOKEN=your-read-token
```

`app/sanity/env.ts` — browser-safe, publishable values only:

```typescript
export const projectId = import.meta.env.VITE_SANITY_PROJECT_ID!
export const dataset = import.meta.env.VITE_SANITY_DATASET!
export const apiVersion = import.meta.env.VITE_SANITY_API_VERSION ?? '2026-02-01'
export const studioUrl = import.meta.env.VITE_SANITY_STUDIO_URL
```

### B. Shared Loader (`app/sanity/loader.ts`)
Defines the store config (SSR enabled, client deferred).

```typescript
import { createQueryStore } from '@sanity/react-loader'

export const {
  loadQuery,
  setServerClient,
  useQuery,
  useLiveMode,
} = createQueryStore({ client: false, ssr: true })
```

### C. Server Loader (`app/sanity/loader.server.ts`)
Initializes the server client. Read the token directly from `process.env` here — do **not** import it from `env.ts`, or it will leak into the client bundle the moment any client-reachable module touches `env.ts`.

```typescript
import { createClient } from '@sanity/client'
import { loadQuery, setServerClient } from './loader'
import { projectId, dataset, apiVersion, studioUrl } from './env'

const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
  token: process.env.SANITY_API_READ_TOKEN,
  stega: {
    // Stega encodes invisible markers into string fields for click-to-edit
    // overlays in the Presentation tool. Those markers can leak into copy/paste,
    // screen readers, and some downstream renderers, so only enable when actually
    // previewing — gate on an env var that's only set in preview environments.
    enabled: Boolean(studioUrl),
    studioUrl,
  },
})

setServerClient(client)

export { loadQuery }
```

### D. Browser-safe Client + Image URL Builder (`app/sanity/client.ts`, `app/sanity/image.ts`)

Anything used by a route component runs in the browser too. Build a separate publishable-only client for things like the image URL builder:

```typescript
// app/sanity/client.ts
import { createClient } from '@sanity/client'
import { projectId, dataset, apiVersion } from './env'

export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
})
```

```typescript
// app/sanity/image.ts
import imageUrlBuilder from '@sanity/image-url'
import { client } from './client'

const builder = imageUrlBuilder(client)
export const urlFor = (source: Parameters<typeof builder.image>[0]) => builder.image(source)
```

Install `@sanity/image-url` if you'll render images:

```bash
npm install @sanity/image-url
```

### E. Queries (`app/sanity/queries.ts`)
Keep query definitions in one place so route loaders, components, and TypeGen all read the same source.

```typescript
import { defineQuery } from "groq";

export const POSTS_QUERY = defineQuery(
  `*[_type == "post" && defined(slug.current)] | order(_createdAt desc){
    _id, title, slug
  }`
);

export const POST_QUERY = defineQuery(
  `*[_type == "post" && slug.current == $slug][0]{
    _id, title, body, image
  }`
);
```

## 2. Data Fetching (Loaders)

Use `loadQuery` from your **server** file in route loaders. Import the generated `Route` type from `./+types/<route>` — React Router writes one type module per route file.

```typescript
// app/routes/home.tsx
import type { Route } from "./+types/home";
import { loadQuery } from "~/sanity/loader.server";
import { POSTS_QUERY } from "~/sanity/queries";

export async function loader() {
  const initial = await loadQuery(POSTS_QUERY, {});
  return { initial, query: POSTS_QUERY, params: {} };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { initial } = loaderData;
  // …pass to component
}
```

For Remix v2: replace `Route.ComponentProps` / `Route.LoaderArgs` with `useLoaderData<typeof loader>()` and `LoaderFunctionArgs` from `@remix-run/node`.

## 3. Dynamic Routes (`:slug`)

Register the dynamic route in `app/routes.ts`:

```typescript
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route(":slug", "routes/post.tsx"),
] satisfies RouteConfig;
```

Then in `app/routes/post.tsx`:

```typescript
import type { Route } from "./+types/post";
import { PortableText } from "@portabletext/react";
import { loadQuery } from "~/sanity/loader.server";
import { useQuery } from "~/sanity/loader";
import { urlFor } from "~/sanity/image";
import { POST_QUERY } from "~/sanity/queries";

export async function loader({ params }: Route.LoaderArgs) {
  const initial = await loadQuery(POST_QUERY, { slug: params.slug });
  return { initial, query: POST_QUERY, params: { slug: params.slug } };
}

export default function Post({ loaderData }: Route.ComponentProps) {
  const { initial, query, params } = loaderData;
  const { data: post } = useQuery(query, params, { initial });

  return (
    <article>
      <h1>{post?.title}</h1>
      {post?.image && (
        <img src={urlFor(post.image).width(1200).url()} alt={post.title ?? ""} />
      )}
      {post?.body && <PortableText value={post.body} />}
    </article>
  );
}
```

This route is the canonical shape that exposes the env trap: `urlFor` → `client.ts` → `env.ts`. If `env.ts` reads `process.env`, the route works under SSR (curl returns HTML) but the client-side `<Link>` navigation will throw `ReferenceError: process is not defined` in the browser console and React Router will hard-reload back to `/`.

## 4. Real-time Preview & Visual Editing

### A. Use `useQuery` in Components
Import `useQuery` from your **shared** loader file.

```typescript
import { useQuery } from "~/sanity/loader";

export default function Page({ loaderData }: Route.ComponentProps) {
  const { initial, query, params } = loaderData;

  const { data, encodeDataAttribute } = useQuery(query, params, { initial });

  return (
    <h1 data-sanity={encodeDataAttribute("title")}>
      {data?.title}
    </h1>
  );
}
```

### B. Enable Live Mode (`VisualEditing.tsx`)
Create a component to handle the connection.

```typescript
import { enableVisualEditing } from '@sanity/visual-editing'
import { useLiveMode } from '~/sanity/loader'
import { client } from '~/sanity/client' // Your browser-safe client
import { useEffect } from 'react'

export default function VisualEditing() {
  useEffect(() => enableVisualEditing(), [])
  useLiveMode({ client })
  return null
}
```

Render this component in `root.tsx` only when valid (e.g., check env vars or user session).

## 5. Stega Cleaning
When using data for logic (routing, classNames), use `stegaClean`.

```typescript
import { stegaClean } from "@sanity/client/stega"
// ...
if (stegaClean(slug) === 'home') { ... }
```
