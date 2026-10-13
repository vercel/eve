---
"eve": minor
---

Approvals, questions, sign-ins, and the budget prompt are all interactions, answered everywhere with `{ interactionId, optionId?, text? }`. Clients send `send({ answers })`, channels receive `onAnswers`, and the MCP channel's invocations list `interactions` keyed by `interactionId`, replacing `inputResponses` and `requestId`.
