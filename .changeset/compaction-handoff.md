---
"eve": patch
---

After compaction, eve now moves an idle session to a fresh workflow run on the same deployment, so long-running sessions no longer accumulate an ever-growing workflow event log. The session keeps its ID, event stream, continuation addresses, and deadline.
