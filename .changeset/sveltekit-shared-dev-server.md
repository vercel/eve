---
"eve": patch
---

`eve/sveltekit` now uses the same eve dev-server startup as `eve/next` and `eve/nuxt`: a three-minute default startup wait configurable with the new `devServerTimeoutMs` plugin option, `[eve:dev]`-prefixed eve output, and startup URL detection that ignores non-local URLs.
