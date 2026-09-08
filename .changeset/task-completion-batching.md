---
"eve": patch
---

Add opt-in `experimental.batchTaskCompletions` to combine adjacent queued successful sibling completions into one parent turn. Every result is retained without waiting for unfinished tasks; default delivery behavior is unchanged.
