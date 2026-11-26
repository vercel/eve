---
"eve": patch
---

Fix `eveSvelteKit` silently leaving the eve service out of Vercel builds of SvelteKit 3 apps, which build every Vite environment in one pass and run the adapter in a late `buildApp` hook.
