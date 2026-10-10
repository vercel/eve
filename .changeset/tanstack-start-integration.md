---
"eve": patch
---

Add `eve/tanstack`, a Vite plugin that runs an eve agent inside a TanStack Start app: Nitro proxies `/eve/v1/**` to a local eve server in development, and Vercel builds deploy eve as a sibling service. Set `devServerTimeoutMs` to wait longer for a slow eve dev server to start. `eve build` and `eve dev` now always use Nitro's Rolldown builder, so an agent that shares its root with a TanStack Start app no longer fails to start.
