---
"eve": patch
---

Add experimental Connect-managed event subscriptions and per-connection webhook receivers. Durable event handlers run independently of conversation sessions; only an explicit `attachSession(...).send(...)` enters a session. Each watch saves its binding before subscribing, and each delivery runs independently under that binding. Subscribe with `ttlMs` in milliseconds or `null` to watch until stopped; `expiresAt` is returned as the calculated deadline. Requires `@vercel/connect@2.5.2` or later.

Return immediately from the durable sleep tool when steering has already interrupted its execution.
