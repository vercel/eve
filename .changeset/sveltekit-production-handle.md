---
"eve": patch
---

`eve/sveltekit` now exports `createEveHandle()`, a SvelteKit `handle` hook that serves `/eve/v1/**` from the app's own origin in non-Vercel production.

It forwards to `EVE_SVELTEKIT_PRODUCTION_ORIGIN`, or to `http://127.0.0.1:${EVE_SVELTEKIT_PRODUCTION_PORT:-4274}`, while preserving streaming and removing hop-by-hop and stale decoded-response headers.
