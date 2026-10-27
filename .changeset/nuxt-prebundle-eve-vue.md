---
"eve": patch
---

Nuxt apps that call the auto-imported `useEveAgent()` now hydrate in `nuxt dev`. The `eve/nuxt` module pre-bundles `eve/vue` with Vite, which previously served its CommonJS dependencies to the browser unbundled and failed with `does not provide an export named 'getContext'`.
