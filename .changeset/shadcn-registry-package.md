---
"eve": patch
---

`eve add` and `eve registry` now use `@shadcn/registry` instead of the full `shadcn` CLI package. The vendored registry bundle shrinks from 9.7 MB to 3.8 MB, and registry items install the same files, env vars, and dependencies as before.
