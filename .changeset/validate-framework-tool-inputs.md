---
"eve": patch
---

Validate every eve-owned tool call before execution or HITL handling. Framework tools now use live Zod schemas, while durable and discovered JSON Schemas are rehydrated into validators so invalid calls are returned to the model for retry.
