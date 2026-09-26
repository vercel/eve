---
"eve": minor
---

Workflow tool bodies are now `execute(ctx)` and read their call from `await ctx.receive()`, which carries `input`, `callId`, and `abortSignal`; `ctx.callId` and `ctx.abortSignal` are gone. `ctx.reply(output)` settles the call early so the body can clean up while the conversation continues, and extensions that define workflow tools must be rebuilt.
