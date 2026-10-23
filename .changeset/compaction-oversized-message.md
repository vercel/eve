---
"eve": patch
---

Compaction no longer re-runs on every step when the current user message is most of the context window. The result of a summary is now measured with the provider's own token count for that history, not only eve's character estimate, so a history that is still over the limit is no longer accepted as small enough. A current message that alone takes more than half of the compaction threshold is cut to its newest part. A compaction that frees no space now fails the step with an error.
