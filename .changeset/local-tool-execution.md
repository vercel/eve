---
"eve": patch
---

Local tool calls execute after the model response ends, through the same approval policy, input validation, and telemetry as approved calls. Cancelling a task also stops a run that ignores cancellation, and ending a session stops the workflow tools its turn was waiting on.
