---
"eve": patch
---

An expired session is no longer reported as failed when writing its final `session.completed` event fails. Before, channels such as Slack posted a `session.failed` error after they had already handled `session.completed`. Thanks @bisak for reporting this in #5261.
