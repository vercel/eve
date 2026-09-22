---
"eve": patch
---

Restore the active eve context while session-scoped dynamic tools are recovered, so resolvers that read durable state keep their callbacks after a resumed session.
