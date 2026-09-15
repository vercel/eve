---
"eve": patch
---

Successful deployment handoffs and legacy-session imports now renew the session's original configured timeout duration (30 days by default). Disabled timeouts stay disabled, and failed or skipped handoffs keep the existing deadline.
