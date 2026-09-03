---
"eve": patch
---

Run each opt-in `sleep` tool call as its own durable workflow. Parallel calls still resume the turn after the longest wait, while sleep now follows the same execution and cancellation lifecycle as other workflow-backed tools.
