---
"eve": patch
---

Complete durable sessions after 30 days by default, and add `limits.sessionTimeoutMs` to configure or disable the lifetime for each agent. Once an expired session settles, the next qualifying channel message for its continuation starts a fresh session.
