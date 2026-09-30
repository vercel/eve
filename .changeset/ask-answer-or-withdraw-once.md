---
"eve": patch
---

A `ctx.ask()` question now resolves the way the session decided it: an answer that reached the session before its withdrawal resolves the ask as `answered`, even after the signal aborted, so `ask_question` and the channel never disagree. Cancelling a `task()` also reports its pending questions `cancelled`, and question `requestId`s are now `<runId>-ask-<n>` instead of an internal hook token.
