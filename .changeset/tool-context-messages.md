---
"eve": patch
---

`ToolContext` now exposes `messages`, the model input for the step that requested the call, so tools can evaluate the conversation that led to them without recording it separately. It matches the `ctx.messages` dynamic resolvers receive at `step.started`.
