# @eve/video

This published package adds video generation to eve agents through AI SDK and AI Gateway video models, with provider-agnostic video storage and a Vercel Blob adapter. Built with `eve extension build`.

## Boundaries

- Wrap third-party dependencies (`ai`, `@vercel/blob`) in eve-owned types; never re-export raw SDK types in public entry points.
- Keep `extension/lib/storage/` provider-agnostic: core generation and tool code talk only to `VideoStorage`, never directly to `@vercel/blob` except through `default.ts` auto-selection and `vercel-blob.ts`.
- Run all validation, model allowlist checks, input media resolution, and destination availability checks before submitting a paid video generation request.
- Validate all external URLs before fetching or forwarding (block private, loopback, link-local, and metadata hosts) and bound both sandbox input reads and video output downloads.
- Read `extension.config` lazily inside `execute` and thunks so tools re-exported from `@eve/video/tools` without a mount fall back to defaults.
- Import only public `eve/*` entry points.

## Build and test

Run `pnpm --filter @eve/video typecheck`, `build`, `test:unit`, and `test:integration`.
