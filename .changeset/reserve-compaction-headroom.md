---
"eve": patch
---

Fix repeated context compaction when a large fixed prompt leaves little room for tool results.

Automatic compaction leaves space for the next step and falls back to the model’s full context window when the configured threshold cannot accommodate it.

[Issue #6810](https://github.com/vercel/eve/issues/6810)
