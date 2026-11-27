---
"eve": patch
---

Add `createEveHandle()` to proxy eve requests through a SvelteKit app's own origin in non-Vercel production.

The hook supports a single `agent/` at `/eve/v1/**` and named `agents/` workspace routes at `/eve/<name>/v1/**`. Configure `agents` to forward each named route to a separate server, or use `origin` or `EVE_SVELTEKIT_PRODUCTION_ORIGIN` for a shared upstream host. The default server is `http://127.0.0.1:4274`, configurable with `EVE_SVELTEKIT_PRODUCTION_PORT`.

Streaming, cancellation, redirects, and cookies are preserved, while hop-by-hop and stale decoded-response headers are removed. Start and manage the eve servers separately; Vercel service routing does not need this hook.
