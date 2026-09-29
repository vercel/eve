---
"eve": patch
---

Isolate extension module instances and configuration per logical mount, including when the same package is mounted more than once. Durable extension state still uses package-scoped keys.
