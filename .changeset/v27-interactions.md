---
"eve": minor
---

Approvals, questions, sign-ins, and budget prompts share a nested `Interaction` projection and answers use `{ interactionId, optionId?, text? }`; approval and budget choices are `approve` / `deny`, and tool answers expose a minimized `Principal`. Typed replies answer only the displayed prompt, channels receive `onAnswers`, and CLI/MCP JSON projections omit private sign-in callback URLs.
