---
"eve": patch
---

Make installing eve with npm faster by no longer declaring `next`, `vite`, `@nuxt/schema`, or `dd-trace` as optional peer dependencies. npm downloaded their package metadata, about 75 MB in total, on every install, even when it never installed them.

eve never loads these packages from its own install. `eve/next` and `eve/nuxt` declare their types without them, and the eval reporter loads `dd-trace` from your app. The plugins from `eve/vite`, `eve/sveltekit`, and `eve/tanstack` are now typed by their name alone, so they no longer depend on the `vite` copy your package manager happens to hoist. The integration requirements in the TypeScript API reference are unchanged.
