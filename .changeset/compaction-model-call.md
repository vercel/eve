---
"eve": patch
---

Context compaction now calls its model the way a step does: it streams the summary, retries transient provider failures with the same policy, and counts the summary call's tokens and cost in the turn and session usage, including session usage limits.
