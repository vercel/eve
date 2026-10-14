---
"eve": patch
---

Keep a session's exact deadline across compaction handoffs. The successor now inherits the deadline the session timer was armed with, instead of one recomputed from the workflow start time, which can differ by a few milliseconds between invocations of the same run.
