---
"eve": patch
---

Add `resume()` to `useEveAgent` and the shared agent store so browser clients can replay a durable session and reconnect to an in-flight turn after a reload. Generated web apps now keep the session ID in the URL and restore the conversation from that route.
