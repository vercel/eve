---
"eve": minor
---

Add estimated token counts to tool calls. `call.requested` carries `inputTokens`, an estimate of the input the model sent, and `call.settled` carries `outputTokens`, an estimate of the output or error the model receives, and for a call that runs as a task, an estimate of the raw task output before `toModelOutput` and the task-result cut. Both are optional, and `CallObservation` exposes them as `inputTokens` and `outputTokens`.
