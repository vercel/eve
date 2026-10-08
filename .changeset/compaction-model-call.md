---
"eve": patch
---

Context compaction now calls its model the way a step does: it streams the summary, retries transient provider failures with the same policy, and counts the summary call's tokens and cost toward session usage limits. Automatic compaction reports that usage with the turn it ran in. Manual compaction runs between turns, so it counts toward session totals without being added to the next turn's usage.
