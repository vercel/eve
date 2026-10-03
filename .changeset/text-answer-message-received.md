---
"eve": patch
---

A plain-text message that answers a pending `ctx.ask()` question is now recorded as `message.received`, stamped with its delivery id, before the `input.resolved` it produces. Clients rendering from the session stream now show what the person typed, and an optimistic copy of the message reconciles instead of lingering. The answer joins the open turn like a steering message, so the turn's later events carry its delivery id too. Model history is unchanged.
