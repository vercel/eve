---
"eve": patch
---

Add `eve/server`, whose `sessions.attach(sessionId).stream({ startIndex, follow, signal })` reads a session's durable event stream in process from hooks, tools, schedules, and channel routes, with the same shape as the client and no HTTP round trip. Events carry their absolute `meta.index`, and `follow: false` ends the read at the durable tail observed when it opens.
