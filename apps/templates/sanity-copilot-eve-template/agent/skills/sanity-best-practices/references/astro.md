---
title: Astro & Sanity Integration Rules
description: Integration guide for Astro, including @sanity/astro, visual editing, and data fetching.
---

# Astro & Sanity Integration Rules

## 1. Setup & Configuration

### Scaffold a new Astro app

```bash
npm create astro@latest my-app -- --template with-tailwindcss --install --git --yes
cd my-app
```

`--yes` accepts defaults non-interactively. `--install` runs `npm install` for you, `--git` initializes a repo.

### Installation

Add the `@sanity/astro` integration and the renderer/helper packages used by the examples below.

```bash
npx astro add @sanity/astro
npm install astro-portabletext @sanity/image-url groq
```

`@sanity/astro` provides the `sanity:client` virtual module. `astro-portabletext` renders Portable Text. `@sanity/image-url` builds image URLs. `groq` exports `defineQuery` for typed queries.

### Configuration (`astro.config.mjs`)

Use the official `@sanity/astro` integration. `astro.config.mjs` runs at config time before Astro's env loading, so `import.meta.env.PUBLIC_*` is not available there — use Vite's `loadEnv` to read the same `PUBLIC_` variables your pages will use.

```javascript
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import sanity from "@sanity/astro";

const { PUBLIC_SANITY_PROJECT_ID, PUBLIC_SANITY_DATASET } = loadEnv(
  process.env.NODE_ENV ?? "development",
  process.cwd(),
  ""
);

export default defineConfig({
  integrations: [
    sanity({
      projectId: PUBLIC_SANITY_PROJECT_ID,
      dataset: PUBLIC_SANITY_DATASET,
      useCdn: false, // False for static builds
      studioBasePath: "/admin", // Optional — only if embedding the Studio
    }),
  ],
});
```

Inside `.astro` files and components you can keep using `import.meta.env.PUBLIC_SANITY_*` directly; the `loadEnv` shim above is config-only.

### Client Type Safety
Enable types in `tsconfig.json`.

```json
{
  "compilerOptions": {
    "types": ["@sanity/astro/module"]
  }
}
```

## 2. Data Fetching

### Basic Fetching
Use `sanityClient` from `sanity:client` in the frontmatter of your `.astro` files.

```astro
---
import { sanityClient } from "sanity:client";
import { defineQuery } from "groq";

const POSTS_QUERY = defineQuery(`*[_type == "post"]{title, slug}`);
const posts = await sanityClient.fetch(POSTS_QUERY);
---
<ul>
  {posts.map(post => <li>{post.title}</li>)}
</ul>
```

### Helper Functions
It's best practice to abstract queries into a utility file (e.g., `src/utils/sanity.ts`).

```typescript
import { sanityClient } from "sanity:client";
import { defineQuery } from "groq";

const POSTS_QUERY = defineQuery(`*[_type == "post" && defined(slug.current)]`);

export async function getPosts() {
  return await sanityClient.fetch(POSTS_QUERY);
}
```

### Dynamic Routes (`[slug].astro`)

Astro hoists `getStaticPaths()` into a separate module context. Module-scope `const` declarations in the frontmatter are NOT accessible inside it — referencing them throws `ReferenceError: <NAME> is not defined` at request time. Define queries used by `getStaticPaths` inside the function, or import them from a utility module.

```astro
---
import { sanityClient } from "sanity:client";
import { defineQuery } from "groq";
import { PortableText } from "astro-portabletext";

// Module-scope queries are fine for module-scope code…
const POST_QUERY = defineQuery(`*[_type == "post" && slug.current == $slug][0]{ title, body }`);

// …but anything used inside getStaticPaths must live inside it.
export async function getStaticPaths() {
  const SLUGS_QUERY = defineQuery(
    `*[_type == "post" && defined(slug.current)]{ "params": { "slug": slug.current } }`
  );
  return await sanityClient.fetch(SLUGS_QUERY);
}

const { slug } = Astro.params;
const post = await sanityClient.fetch(POST_QUERY, { slug });
---
<article>
  <h1>{post?.title}</h1>
  {post?.body && <PortableText value={post.body} />}
</article>
```

## 3. Portable Text
Use `astro-portabletext` for rendering rich text.

```astro
---
import { PortableText } from "astro-portabletext";
const { body } = Astro.props;
---
<div class="prose">
  <PortableText value={body} />
</div>
```

## 4. Image Handling
Use `@sanity/image-url` to generate optimized image URLs.

```typescript
import imageUrlBuilder from "@sanity/image-url";
import { sanityClient } from "sanity:client";

const builder = imageUrlBuilder(sanityClient);

export function urlFor(source) {
  return builder.image(source);
}
```

## 5. Visual Editing (Live Preview)
Astro handles visual editing slightly differently depending on if you are using Hybrid or Static mode.

### Setup
Ensure `stega` is enabled in your client configuration if you want clickable overlays.

For real-time updates in the presentation tool, you typically need a React component wrapper (since Astro components don't re-render on the client) or use the View Transitions API with a loader.

*Note: The `@sanity/astro` integration is evolving. Check the latest docs for "Visual Editing" support.*
