---
"eve": patch
---

A turn's principal no longer changes while it runs. Only the turn's own principal can answer a pending `ctx.ask()` or `ask_question` by typing, whether a workflow tool, a subagent or a remote agent asked; another person's text waits and runs as their own turn instead of answering the question under the asker's auth. A typed answer updates the claims on `ctx.session.auth.current`, so its `delivery.consumed` hook and the rest of the turn see the request that sent it. Someone else's button answer still settles the request as its responder.
