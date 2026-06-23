---
"eve": patch
---

Allow GitHub webhook handlers and cross-channel `receive(...)` calls to request turn-scoped structured output with Standard Schema or raw JSON Schema. GitHub webhook turns and scheduled retries can now share one schema-validated `result.completed` contract while keeping sessions in conversation mode.
