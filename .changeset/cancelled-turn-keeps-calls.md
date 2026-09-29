---
"eve": patch
---

Cancelling a turn no longer erases the tool calls it was waiting on from the model's history. Each one stays, answered as cancelled, so in the next turn the model sees that the work was started and stopped instead of redoing a request that looks unanswered.
