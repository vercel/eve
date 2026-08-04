---
"eve": minor
---

Replace continuation-token HTTP, client, and free channel helper APIs with explicit ID-addressed sessions and bound channel addresses. The eve HTTP API now uses only `/eve/v1/session` routes, `client.sessions.create()` or `.attach()`, and `channelAddress(token)` or `attachSession(id)` operation handles.
