---
"eve": patch
---

Bundle client-safe vendored dependencies in a neutral chunk group so `eve/react` can use the Zod-backed `/eve/v1/info` validator without pulling in Node-only vendored runtime helpers.
