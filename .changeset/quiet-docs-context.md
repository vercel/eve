---
"eve": patch
---

Add `sessionContext` to session creation and frontend hooks. Read the supplied JSON object as `ctx.session.context` in dynamic resolvers, hooks, and tools across turns and workflow steps, including prewarmed sessions. Read the current turn's `clientContext`, as sent, as `ctx.turn.context`.
