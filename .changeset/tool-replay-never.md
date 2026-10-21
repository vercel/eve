---
"eve": patch
---

Add `replay: "never"` to `defineTool`. A tool marked this way doesn't run again when its durable step re-runs after an interruption; the call fails with `TOOL_RECOVERY_REQUIRED` so the model can check before retrying.
