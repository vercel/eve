---
"eve": patch
---

Slack thread helpers now reuse messages loaded within the same inbound handler, while overlapping `thread.refresh()` calls share one request and failed refreshes preserve the last successful snapshot.
