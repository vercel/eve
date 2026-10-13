---
"eve": minor
---

A message's tool part is now its call's row: a `tool` part (`EveToolPart`) with the call's `status`, `outcome`, `label`, `input`, `output`, and the latest approval or question about it, instead of the AI SDK's `dynamic-tool` states. An interaction about no call, such as a sign-in, is an `interaction` part, and `toolResultFrom` accepts a settled call row such as `ctx.view.calls[callId]`.
