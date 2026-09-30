---
"eve": patch
---

Add `eve/server`, whose `sessions.attach(sessionId).stream({ startIndex, follow, signal })` reads a session's durable event stream in process from hooks, tools, schedules, and channel routes, with the same shape as the client and no HTTP round trip.
