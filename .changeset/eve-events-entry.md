---
"eve": patch
---

`eve/events` explicitly exports the v27 catalog, lifecycle tables, guards, selectors, and whole-line `foldEvents`; writer encoders, retention options, and extra folding helpers stay internal. Call labels use `label`, controls require delivery identities, and child deliveries retain per-message caller attribution while unnamed remote streams keep their call-order mapping.
