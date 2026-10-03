---
"eve": patch
---

A first turn that is cancelled after its `session.started` preamble, for example by a hook calling `ctx.cancel()` from `turn.started`, no longer drops the session-scoped dynamic instructions that preamble resolved. The cancelled turn still marks the session started, so no later turn resolved them again and the rest of the session ran without them. The session-scoped dynamic model selection was already kept this way.
