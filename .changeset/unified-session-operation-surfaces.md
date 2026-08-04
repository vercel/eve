---
"eve": minor
---

Replace continuation-token HTTP, client, and channel APIs with explicit ID-addressed sessions and consistent channel-local operations. The eve HTTP API now uses only `/eve/v1/session` routes, clients use `client.sessions.create()` or `.attach()`, and channel authors use `send(address, input)` or `attachSession(id)`.
