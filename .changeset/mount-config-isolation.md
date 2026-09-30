---
"eve": patch
---

Isolate extension module instances and configuration per logical mount, including directory overrides and their subagents, while preserving asset imports and extension-owned dependencies. Durable extension state still uses package-scoped keys.
