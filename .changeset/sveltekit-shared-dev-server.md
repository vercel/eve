---
"eve": patch
---

`eve/sveltekit` now uses the same eve dev-server startup as `eve/next` and `eve/nuxt`: a three-minute default startup wait configurable with the new `devServerTimeoutMs` plugin option, `[eve:dev]`-prefixed eve output, and startup URL detection that ignores non-local URLs.

Shared dev-server startup keeps locks held by live owners during slow starts and does not remove another owner's replacement lock.
