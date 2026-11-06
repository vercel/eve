---
"eve": minor
---

Add the `eveVite()` plugin from `eve/vite` to run eve agents alongside any Vite app in development, `vite preview`, and Vercel deployments.

`eveSvelteKit()`, `eveTanStack()`, and the Nuxt module now share its agent discovery and Vercel services, so all of them mount `agents/` workspace members at `/eve/<name>/v1/*`. The SvelteKit plugin no longer sets `EVE_BASE_URL` in the dev server process; set it yourself if your server code reads it to reach the agent.
