---
"eve": patch
---

New sessions now claim an address as they start, so racing first messages to a channel address reach one session, keyed sends and `create()` respond without waiting for the session to boot, and a session accepts commands as soon as it is created.

Previously, two unkeyed first messages to the same new address could each get a receipt naming a different session: the losing run forwarded its message and exited, but its caller kept the dead session's ID. A cancel or `end()` sent by session ID before the session finished booting was answered with "no active turn" or "no active session" while the session kept running, and an early send had to retry `409 session_not_ready`. This needs a Workflow world with atomic start hooks: the local world, Vercel Workflow, or `@workflow/world-postgres` 5.1.1 or later. Other worlds keep the previous behavior.

`useEveAgent` and the other framework bindings now send `end()`, `clear()`, and `compact()` called while the store is still creating its session to that session, instead of throwing `SessionNotActiveError`.
