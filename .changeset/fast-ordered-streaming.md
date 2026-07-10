---
"eve": patch
---

Keep provider streams moving while durable event writes are in flight. eve now coalesces only adjacent queued text or reasoning appends behind an ordered writer, preserving event order while avoiding one durable round trip per provider delta.
