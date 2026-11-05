---
"eve": patch
---

New sessions now take their channel address as they start, so racing first messages to an address reach one session, and keyed sends and `create()` respond without waiting for the session to boot.

Previously, two unkeyed first messages to the same new address could each get a receipt naming a different session: the losing run forwarded its message and exited, but its caller kept the dead session's ID. A command sent by session ID right after the session starts now reaches it too, instead of being refused while the session boots. This needs a Workflow world with atomic start hooks: the local world, Vercel Workflow, or `@workflow/world-postgres` 5.1.1 or later. Other worlds keep the previous behavior.
