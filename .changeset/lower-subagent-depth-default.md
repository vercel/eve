---
"eve": patch
---

`limits.maxSubagentDepth` now defaults to `1` instead of `3`. Agents that rely on deeper default delegation should set `limits: { maxSubagentDepth: 3 }` (or another value) explicitly.
