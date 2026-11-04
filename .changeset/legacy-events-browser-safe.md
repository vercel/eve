---
"eve": patch
---

`eve/internal/legacy-events` loads in browser bundles again. Since 1.0.0-rc.3 it pulled in `node:async_hooks` and `node:crypto` through the session kernel, which broke client builds that import it.
