---
"eve": patch
---

Apply steering in the core runtime before a pending model request produces an answer, continuing the same turn with the correction across clients and channels. Preserve executing tools and their results, prevent duplicate in-process model execution on background wakeups, and keep boundary steering after assistant output begins.
