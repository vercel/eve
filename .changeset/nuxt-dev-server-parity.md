---
"eve": patch
---

`eve/nuxt` now shares the Next.js dev-server startup: it waits up to 180 seconds by default (configurable with the new `devServerTimeoutMs` option), ignores non-local URLs in eve's startup output, and prefixes eve's logs with `[eve:dev]`. Restarting `nuxt dev` no longer leaves eve requests proxied to a stopped dev server.
