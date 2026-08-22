# eve docs app

## Responsive UI

All user-facing UI changes must be mobile-responsive. Before completing a UI change, verify it at a narrow mobile viewport and a desktop viewport. Check for page-level horizontal overflow, clipped content, unreadably narrow columns, overlapping controls, and whether dense navigation should wrap or scroll horizontally.

## Geistdocs

- Read `node_modules/@vercel/geistdocs/docs/agents.md` and the focused pages under `node_modules/@vercel/geistdocs/docs/pages/` before changing package-backed behavior.
- Keep `cacheComponents: true` and `partialPrefetching: true` in `next.config.ts`.
- Do not export `dynamic`, `dynamicParams`, `revalidate`, or `fetchCache` from App Router pages or route handlers.
- Generate every supported root language. Read `[lang]` through `next/root-params` only in Server Components; retain route context `params` in Route Handlers and Server Actions.
- Set `prefetch={true}` on app-owned links to statically generated docs, integrations, and templates so navigation reveals the complete destination immediately.
- Keep package adapters thin. Do not deep-import package internals or edit generated `.source`, `.next`, or `node_modules` files.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.
<!-- END:nextjs-agent-rules -->
