---
"eve": patch
---

Scope authored resolver hooks to relevant import specifiers and reuse filesystem probes for one build. Repeated extensionless misses now perform at most 19 stats once per plugin instance instead of on every resolution.
