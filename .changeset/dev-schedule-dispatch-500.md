---
"eve": patch
---

Fix `eve dev`'s one-shot schedule dispatch route (`POST /eve/v1/dev/schedules/:id`) returning a 500 with `Cannot find module '<projectRoot>/src/internal/authored-module-map-loader.ts'`. The route now reuses the module map loader path resolved once at server start instead of re-deriving it from inside the bundled dev server, where that resolution silently broke.
