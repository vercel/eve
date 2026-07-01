---
"eve": patch
---

Harden Slack HITL posting against API limits: large approval batches now split across multiple messages instead of exceeding Slack's 50-block cap, and long freeform answers are truncated so the answered-card update cannot fail.
