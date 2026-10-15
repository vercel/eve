---
"eve": patch
---

Initialize shared sandboxes in their nearest owning session before starting built-in agent copies, declared inheriting subagents, or authored workflow `ctx.agent` children. Preserve the owner's sandbox options and durable initialization state with the delegating caller's authentication, and reject inherited access without an initialized owner snapshot.
