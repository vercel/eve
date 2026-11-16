---
title: Sanity Getting Started Guide
description: Use these rules when users ask to 'Get started with Sanity' or need help setting up a new Sanity project.
---

# Sanity Getting Started Guide

## Overview

Getting started with Sanity follows three phases:
1. **Studio & Schema** — Set up Sanity Studio and define your content model
2. **Content** — Import existing content or generate placeholder content via MCP
3. **Frontend** — Integrate with your application (framework-specific)

## Communication Style

**Keep responses succinct:**

- Tell the user what you did: "Created post schema with title, body, and slug"
- Ask direct questions: "What kind of content are you building?"
- Avoid verbose explanations of what you're about to do
- Don't explain every step unless the user asks

**Examples:**

- **Good**: "Schema deployed. Ready to add some content?"
- **Bad**: "I'm going to deploy your schema to the Content Lake so that the MCP server can recognize your new document types. This will allow..."

---

## Get Started with Sanity (Interactive Guide)

**TRIGGER PHRASE:** When the user says "Get started with Sanity" or similar, follow these steps.

**Before starting:** Let the user know they can pause and resume anytime by saying "Continue Sanity setup".

**RESUME TRIGGER:** If the user says "Continue Sanity setup", check what's already configured:
- Does `sanity.config.ts` exist (typically in a `studio/` folder)? → Studio is set up
- Are there files in `schemaTypes/`? → Schema exists
- Is there a frontend framework in `package.json`? → May need integration

Resume from where they left off.

---

## Phase 1: Studio & Schema

### Step 1: Check for Existing Studio

**Look for `sanity.config.ts` or `sanity.cli.ts` across the workspace** — in the recommended side-by-side layout the Studio lives in its own folder (`studio/`, or `studio-*` when created by the Sanity onboarding flow) next to the app folder:

**If NO Studio found:**
- Ask: "Want to create a new Sanity Studio?"
- If yes, run from the repo root — **not inside a Next.js app folder**, where the CLI would switch to its embedded flow (not recommended):
  ```bash
  npm create sanity@latest -- --template clean --typescript --output-path studio
  ```
- This creates a standalone Studio in `studio/`, alongside your app folder (see `project-structure.md`)

**If Studio exists:**
- Read the config to get `projectId` and `dataset`
- Proceed to Step 2

### Step 2: Check for Existing Schema

**Look in `schemaTypes/`, `schemas/`, or `src/sanity/schemaTypes/`:**

**If NO schema found:**
- Ask: "What kind of content are you building? (e.g., Blog, E-commerce, Portfolio)"
- Create appropriate schema types based on their answer
- See `schema.md` for patterns

**If schema exists:**
- Show them what you found
- Ask: "Want to add more content types or modify existing ones?"

**If they want a quick example:**
Create a basic blog schema:
```typescript
// schemaTypes/post.ts
import { defineType, defineField } from 'sanity'

export const post = defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string' }),
    defineField({ name: 'slug', type: 'slug', options: { source: 'title' } }),
    defineField({ name: 'body', type: 'array', of: [{ type: 'block' }] }),
  ],
})
```

### Step 3: Deploy Schema

**Required before Phase 2:**

```bash
npx sanity schema deploy
```

This uploads your schema to the Content Lake so MCP tools can work with it.

---

## Phase 2: Content

### Step 1: Check for Existing Content

**Use MCP `query_documents` to check:**
```
*[_type == "post"][0...5]
```

**If content exists:**
- Show them a summary
- Ask: "Want to add more content or move to frontend integration?"

**If NO content:**
- Ask: "Do you want to:
  1. Import existing content (from another CMS, markdown, etc.)
  2. Generate sample content with AI
  3. Skip this and add content manually in the Studio"

### Step 2a: Import Existing Content

If migrating from another CMS or files:
- See `migration.md` and the `sanity-migration` skill for guidance
- Use MCP content tools such as `create_documents` and `patch_documents` after converting content to structured Sanity documents

### Step 2b: Generate Sample Content (MCP)

Ask the agent to draft structured sample content, then create it with the Sanity MCP Server:
```
Tool: create_documents
Documents: [{ type: "post", content: { title: "Getting started with Sanity", body: [] } }]
```

**If MCP content tools cannot see new types or fields:** Remind them to run `npx sanity schema deploy` first.

### MCP Setup (If Not Configured)

**Quick start via Sanity CLI:**
```bash
npx sanity@latest mcp configure
```

**Cursor:** [One-click install →](cursor://anysphere.cursor-deeplink/mcp/install?name=Sanity&config=eyJ1cmwiOiJodHRwczovL21jcC5zYW5pdHkuaW8iLCJ0eXBlIjoiaHR0cCJ9Cg==)

Or add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "Sanity": {
      "type": "http",
      "url": "https://mcp.sanity.io"
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add Sanity -t http https://mcp.sanity.io --scope user
```

**VS Code:** Command Palette → `MCP: Open User Configuration` → add:
```json
{
  "servers": {
    "Sanity": {
      "type": "http",
      "url": "https://mcp.sanity.io"
    }
  }
}
```

---

## Phase 3: Frontend Integration

### Client Bundle Warning (Vite-based frameworks)

React Router, SvelteKit, Astro, and Nuxt all run on Vite. **Any module imported by a client component will be bundled to the browser.** `process.env` doesn't exist there.

For publishable values (`projectId`, `dataset`, `apiVersion`, public studio URL), use the framework's client-safe env mechanism:

- React Router / Remix: `import.meta.env.VITE_*`
- SvelteKit: `$env/static/public`
- Astro: `import.meta.env.PUBLIC_*`
- Nuxt: `useRuntimeConfig().public`

For secrets (read tokens, webhook secrets), read `process.env.*` (or the server equivalent) **only from server-only modules** — `.server.ts`, route handlers, API endpoints. Don't centralize them in a shared `env.ts` that anything else imports.

This trap is invisible at SSR — the page renders fine on first load. It surfaces on client-side route transitions, when a lazy-loaded route chunk pulls a shared client/image module into the browser.

### Step 1: Find the App and Detect Framework

The working directory is often a parent folder with the Studio and the app side by side. Identify the app folder first: a sibling of the Studio folder with its own `package.json` (commonly `web/`). If several candidates exist, ask the user which app to integrate — never assume.

**Check the app's `package.json` dependencies:**

| Dependency | Framework | Rule File |
|------------|-----------|-----------|
| `next` | Next.js | `nextjs.md` |
| `@remix-run/react` or `react-router` | React Router / Remix | `remix.md` |
| `svelte` or `@sveltejs/kit` | SvelteKit | `svelte.md` |
| `nuxt` | Nuxt | `nuxt.md` |
| `astro` | Astro | `astro.md` |

**If NO framework found:**
- Ask: "Which framework are you using, or would you like to create a new app?"
- Guide them to create one or specify their choice

### Step 2: Next.js Integration (Inline)

If Next.js is detected, follow these essential steps:

**Scaffold a new app (if you don't have one yet):**

Run from the repo root so the app sits alongside your `studio/` folder:

```bash
npx create-next-app@latest web --tailwind --ts --app --src-dir --eslint --import-alias "@/*" --turbopack
cd web
```

**Install dependencies:**
```bash
npm install next-sanity @sanity/image-url
```

`next-sanity` is the official Sanity toolkit for Next.js. It bundles `@sanity/client`, `groq` (with `defineQuery`), and `@portabletext/react`, plus dedicated subpath exports for Next.js-specific features:
- `next-sanity` — `createClient`, `defineQuery`, `PortableText`, `SanityDocument`, `stegaClean`
- `next-sanity/live` — `defineLive` for live content with Next.js cache integration
- `next-sanity/draft-mode` — Draft Mode endpoint helpers
- `next-sanity/visual-editing` — `<VisualEditing />` component for click-to-edit overlays
- `next-sanity/image` — Sanity-aware `<Image />` wrapping `next/image`
- `next-sanity/studio` — embed the Sanity Studio at a route (legacy setups only — keep the Studio standalone, see `nextjs.md`)
- `next-sanity/webhook` — webhook signature verification

Don't also install `@sanity/client`, `@portabletext/react`, or `groq` directly — import them from `next-sanity`. `@sanity/image-url` is not bundled (yet), so add it separately.

**Create the client (`src/sanity/client.ts`):**
```typescript
import { createClient } from "next-sanity";

export const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  apiVersion: "2026-05-15", // Use current date for new projects
  useCdn: false, // Use API directly for server-side rendering; set true for client-side reads
});
```

**Fetch content in a Server Component:**
```typescript
// src/app/page.tsx
import { client } from "@/sanity/client";
import { defineQuery, type SanityDocument } from "next-sanity";

const POSTS_QUERY = defineQuery(
  `*[_type == "post" && defined(slug.current)] | order(_createdAt desc){ _id, title, slug }`
);

const options = { next: { revalidate: 30 } };

export default async function PostsPage() {
  const posts = await client.fetch<SanityDocument[]>(POSTS_QUERY, {}, options);

  return (
    <ul>
      {posts.map((post) => (
        <li key={post._id}>
          <a href={`/${(post.slug as { current?: string })?.current}`}>{post.title as string}</a>
        </li>
      ))}
    </ul>
  );
}
```

`{ next: { revalidate: 30 } }` opts the fetch into Next.js' ISR cache with a 30-second revalidation window. Tune to taste; omit `options` to use defaults.

**Render an individual post (`src/app/[slug]/page.tsx`):**
```typescript
import { PortableText, defineQuery, type SanityDocument } from "next-sanity";
import { notFound } from "next/navigation";
import { client } from "@/sanity/client";

const POST_QUERY = defineQuery(
  `*[_type == "post" && slug.current == $slug][0]{ _id, title, body }`
);

const options = { next: { revalidate: 30 } };

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await client.fetch<SanityDocument | null>(POST_QUERY, { slug }, options);

  if (!post) return notFound();

  return (
    <article>
      <h1>{post.title as string}</h1>
      {Array.isArray(post.body) && <PortableText value={post.body} />}
    </article>
  );
}
```

**Add environment variables (`.env.local`):**
```
NEXT_PUBLIC_SANITY_PROJECT_ID=your-project-id
NEXT_PUBLIC_SANITY_DATASET=production
```

For advanced patterns (TypeGen, Visual Editing with `next-sanity/visual-editing`, live content with `defineLive` from `next-sanity/live`, standalone Studio architecture), see `nextjs.md`.

### Step 3: Other Frameworks

For non-Next.js frameworks, read the corresponding rule file and follow its integration guide:

- **React Router / Remix:** `remix.md`
- **SvelteKit:** `svelte.md`
- **Nuxt:** `nuxt.md`
- **Astro:** `astro.md`

Each rule file contains framework-specific patterns for data fetching, Portable Text rendering, and Visual Editing.

### Step 4: Smoke Test

Before declaring integration done, exercise both render paths:

1. `npm run dev` (in the app folder)
2. Load the home page (lists posts).
3. **Click through to a detail page** via an in-app `<Link>` / `<a>` — do not paste the URL.
4. Open the browser console. It should be clean. No `ReferenceError: process is not defined`, no hard reload to `/`.
5. For good measure, reload the detail page directly (URL bar) — that exercises SSR.

Server-side rendering passing isn't enough. Client-side route transitions pull lazy chunks that exercise different code paths, and that's where env/bundling traps surface.

---

## What's Next

Once setup is complete, let the user know:

"You're all set! Here are some things I can help with:

- **Visual Editing** — Click-to-edit in the Presentation tool (`visual-editing.md`)
- **TypeGen** — Type-safe queries with generated types (`typegen.md`)
- **Studio Structure** — Customize the Studio sidebar (`studio-structure.md`)
- **SEO** — Metadata, sitemaps, and Open Graph (`seo.md`)
- **i18n** — Multi-language content (`localization.md`)

Just ask about any of these!"

---

## Environment Variables

### Framework-Specific Prefixes

| Framework | Client-Side Prefix | Example |
|-----------|-------------------|---------|
| Next.js | `NEXT_PUBLIC_` | `NEXT_PUBLIC_SANITY_PROJECT_ID` |
| React Router / Remix | `VITE_` | `VITE_SANITY_PROJECT_ID` |
| SvelteKit | `PUBLIC_` | `PUBLIC_SANITY_PROJECT_ID` |
| Nuxt | `NUXT_PUBLIC_` | `NUXT_PUBLIC_SANITY_PROJECT_ID` |
| Astro | `PUBLIC_` | `PUBLIC_SANITY_PROJECT_ID` |

**Secrets** (read tokens, webhook secrets) stay **unprefixed** and are read via `process.env` (or the framework's server-only equivalent) from server-only modules — `*.server.ts`, route handlers, API routes. Never re-export a secret from a module that a route component can import.

---

## Common Commands

```bash
npx sanity@latest mcp configure  # Configure MCP for your editor
npx sanity dev                   # Start Studio locally
npx sanity schema deploy         # Deploy schema for MCP/editor access
npx sanity deploy                # Deploy Studio to Sanity hosting
npx sanity manage                # Open project settings
npm run typegen                  # Generate TypeScript types
```

---

## Important Notes

- **Be succinct** — Guide step-by-step without over-explaining
- **Check context first** — Read existing files before suggesting changes
- **Don't give up** — If something fails, give the user a way to complete manually
- **Deploy schema early** — MCP content tools need deployed schemas to see new types and fields
- **One phase at a time** — Complete each phase before moving to the next
