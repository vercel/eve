---
"eve": minor
---

A dynamic value's `render` is synchronous, and runs outside the session's context. So does `record`, which reads the conversation with `await ctx.messages()`. Reading session state in either throws: read it in `select`.
