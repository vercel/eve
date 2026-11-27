---
"eve": minor
---

Add estimated token counts to tool calls, as `inputTokens` on `call.requested` and `outputTokens` on `call.settled`.

`inputTokens` estimates the input the model sent. `outputTokens` estimates the output or error the model receives, and for a call that runs as a task, the raw task output before `toModelOutput` and the task-result cut. Both are optional, and `CallObservation` exposes them as `inputTokens` and `outputTokens`.
