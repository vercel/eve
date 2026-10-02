---
"eve": patch
---

eve now runs approved tool calls itself instead of replaying them through the AI SDK, so `session.history` and `ctx.messages` hold each approved call with its result and no longer contain `tool-approval-request` or `tool-approval-response` parts. Sessions checkpointed by an earlier version keep running on their owning deployment.
