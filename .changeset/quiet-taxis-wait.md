---
"eve": patch
---

Keep invocations pending while background work they started is outstanding. Scheduled runs no longer publish a premature fallback, and delegated children deliver their final answer after nested task results are available.
