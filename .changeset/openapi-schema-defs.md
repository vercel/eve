---
"eve": patch
---

OpenAPI connection tools no longer reject valid deeply nested input, such as a Notion page title. eve now keeps the spec's referenced schemas under `$defs` instead of copying them inline up to a depth limit, so validation applies at every depth and shared schemas no longer grow exponentially. Thanks @lildesert for reporting this with a minimal reproduction in #3267.
