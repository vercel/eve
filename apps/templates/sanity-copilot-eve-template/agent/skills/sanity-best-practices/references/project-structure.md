---
title: Sanity Project Structure
description: Project structure patterns for Sanity projects including standalone Studio and monorepo setups.
---

# Sanity Project Structure

## Standalone Studio

Best for content-only projects, API-first architectures, or when frontend is managed separately.

```
your-project/
├── schemaTypes/
│   ├── index.ts
│   ├── documents/
│   ├── objects/
│   └── blocks/
├── sanity.config.ts
├── sanity.cli.ts
└── package.json
```

**Use cases:**

- Content modeling with MCP/AI tools (no frontend needed)
- Headless CMS with external consumers
- Prototyping and content design

## Monorepo (Recommended with a frontend)

Best for most projects pairing Sanity with a Next.js (or other framework) app. The Studio stays standalone — Vite-based dev/builds, auto-updates, TypeGen watch mode — while living in the same repo as the frontend.

```
your-project/
├── studio/                     # Sanity Studio (standalone)
│   ├── schemaTypes/
│   │   ├── index.ts
│   │   ├── documents/
│   │   ├── objects/
│   │   └── blocks/
│   ├── sanity.config.ts
│   ├── sanity.cli.ts           # CLI + TypeGen configuration
│   └── package.json
└── web/                        # Next.js (or other framework)
    ├── src/
    │   ├── app/
    │   └── sanity/
    │       ├── client.ts
    │       ├── live.ts         # defineLive setup
    │       └── queries.ts
    ├── sanity.types.ts         # Generated types (from TypeGen)
    └── package.json
```

No workspace tooling is required — each app manages its own dependencies. For larger repos, the same shape works under `apps/` with npm or pnpm workspaces.

**Setup:**

1. Add the web app URL to CORS origins: `npx sanity cors add http://localhost:3000 --credentials` (or via [Sanity Manage](https://www.sanity.io/manage))
2. Configure `typegen` in `studio/sanity.cli.ts` to read queries from `../web` and output types to `../web/sanity.types.ts` (see `typegen.md`)
3. Optionally add a root `package.json` with scripts that run both dev servers

## Embedded Studio (Legacy — Not Recommended)

Older Next.js projects may mount the Studio inside the app at `src/app/studio/[[...tool]]/page.tsx`, with `sanity.config.ts` in the app root. This still works but is no longer recommended: it slows builds, ties Studio updates to app deploys, and rules out auto-updates and TypeGen watch mode. See `nextjs.md` for the rationale and migration steps.

## File Naming Conventions

- **kebab-case** for all files: `user-profile.ts`, `hero-block.ts`
- `.ts` for schemas/utilities, `.tsx` for React components
- Each schema exports a named const matching filename

## Schema Directory Structure

```
schemaTypes/
├── index.ts              # Exports all types
├── documents/            # Standalone content types
│   ├── post.ts
│   └── author.ts
├── objects/              # Embeddable/reusable types
│   ├── seo.ts
│   └── link.ts
├── blocks/               # Portable Text blocks
│   ├── hero.ts
│   └── callout.ts
└── shared/               # Shared field definitions
    └── seoFields.ts
```

## Key Files

| File               | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `sanity.config.ts` | Studio configuration (plugins, schema, structure)       |
| `sanity.cli.ts`    | CLI configuration (project ID, dataset, TypeGen config) |
| `structure.ts`     | Custom desk structure                                   |
