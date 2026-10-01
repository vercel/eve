---
"eve": patch
---

The first local or remote subagent turn now appears beneath its dispatch span in the same OpenTelemetry trace; persistent follow-up turns still start fresh traces. Conversation IDs also propagate to third-party spans created during model, tool, and memory execution.
