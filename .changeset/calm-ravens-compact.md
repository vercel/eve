---
"eve": patch
---

Add manual session compaction through custom-channel helpers, the eve HTTP client, and the `eve dev` TUI's `/compact` command. Compaction preserves the session, queues behind an active turn, and does not send synthetic model input.
