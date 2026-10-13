---
"eve": minor
---

Hooks and channel handlers now receive v27 facts. A handler takes `(event, ctx)`, where `event` has `type`, `data`, and `scope`, and `ctx` carries the session, `position`, and `view`, the shared tables as of the commit; a channel's own context is `ctx.channel`, and `ctx.scope` is gone. A hook or channel keyed on a removed v26 event fails when eve loads it and names the replacement, and `*` hooks no longer receive progress records.
