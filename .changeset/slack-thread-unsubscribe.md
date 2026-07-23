---
"eve": patch
---

Added `ctx.unsubscribe()` to Slack `onMessage` handlers. Unsubscribed threads retain their eve session and history, and an explicit bot mention resubscribes the same session.
