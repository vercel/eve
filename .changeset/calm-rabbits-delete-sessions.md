---
"eve": patch
---

Add a dedicated built-in-JWT-only framework route that hard-deletes a session
workflow tree. Deployment requires a released `@workflow/world` and provider
World that advertise the new `runTreePurge` capability.
